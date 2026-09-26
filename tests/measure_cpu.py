#!/usr/bin/env python3
"""Measure the bar's CPU use with the real Port Kill backend.

Runs Service.qml in a private Quickshell instance with default timings and
reports CPU time (user + system) separately from elapsed time for three
phases: no monitor running, a monitor running with quiet sockets, and a
monitor running while test-owned listeners on ports 8900-8999 open and close.

The monitor is the real port-kill-console started through portkill.sh, under
a different process name so an installed older version of the plugin does
not react to it. It only monitors; nothing is killed. Scans are read-only.

    python3 tests/measure_cpu.py [seconds per phase]
"""

import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
TICK = os.sysconf("SC_CLK_TCK")
SHELL_QML = """import QtQuick
import Quickshell
import Quickshell.Io

ShellRoot {
  Service { id: ports }
  IpcHandler {
    target: "harness"
    function state(): string { return JSON.stringify({ active: ports.active, status: ports.status }) }
  }
}
"""


def stat_ticks(pid):
    """(own CPU, reaped children's CPU) in clock ticks."""
    data = Path(f"/proc/{pid}/stat").read_text()
    fields = data[data.rindex(")") + 2:].split()
    return int(fields[11]) + int(fields[12]), int(fields[13]) + int(fields[14])


def live_descendants(pid):
    """CPU ticks of processes still running under pid (not yet reaped)."""
    total = 0
    stack = [pid]
    while stack:
        parent = stack.pop()
        for task in Path(f"/proc/{parent}/task").iterdir():
            try:
                children = task.joinpath("children").read_text().split()
            except OSError:
                continue
            for child in map(int, children):
                try:
                    total += sum(stat_ticks(child)[:1])
                except OSError:
                    continue
                stack.append(child)
    return total


def sample(pid):
    own, reaped = stat_ticks(pid)
    return own, reaped, live_descendants(pid)


def cpu_ms(before, after):
    own = (after[0] - before[0]) * 1000 / TICK
    # Reaped children plus the change in still-running children.
    children = ((after[1] - before[1]) + (after[2] - before[2])) * 1000 / TICK
    return own, children


def qs_state(config):
    result = subprocess.run(["qs", "ipc", "-p", str(config), "call", "harness", "state"],
                            capture_output=True, text=True, timeout=5)
    return json.loads(result.stdout) if result.returncode == 0 and result.stdout.strip() else None


def wait_for(predicate, timeout, what):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.1)
    raise RuntimeError("Timed out waiting for " + what)


def churn(stop):
    """Open and close a test-owned listener every 0.5 s."""
    port = 8900
    while not stop.is_set():
        sock = socket.socket()
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
            sock.listen(1)
            stop.wait(0.5)
        except OSError:
            pass
        finally:
            sock.close()
        port = 8900 if port >= 8999 else port + 1


def main():
    seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 60
    real = shutil.which("port-kill-console", path=f"{Path.home()}/.local/bin:{os.environ['PATH']}")
    if not real:
        sys.exit("port-kill-console is not installed")
    work = Path(tempfile.mkdtemp(prefix="portkill-measure-"))
    config = work / "config"
    config.mkdir()
    for name in ["Service.qml", "Model.js", "Scheduler.js", "portkill.sh", "monitors.py"]:
        shutil.copy(ROOT / name, config / name)
    config.joinpath("shell.qml").write_text(SHELL_QML)
    bin_dir = work / "bin"
    bin_dir.mkdir()
    # Count scans without changing what runs.
    scans = work / "scans.log"
    wrapper = bin_dir / "port-kill-console"
    wrapper.write_text(f"""#!/bin/bash
start=$(date +%s%N)
'{real}' "$@"
status=$?
[[ $1 == --json ]] && echo "$start $(date +%s%N)" >> '{scans}'
exit $status
""")
    wrapper.chmod(0o755)
    # The monitor: the real console under another name.
    monitor_bin = bin_dir / "pk-measure-console"
    monitor_bin.symlink_to(real)
    shell_cmd = bin_dir / "omarchy-shell"
    shell_cmd.write_text(f"#!/bin/bash\n[[ $1 == -q ]] && shift\nexec qs ipc -p '{config}' call \"$@\"\n")
    shell_cmd.chmod(0o755)
    env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}",
           "PORT_KILL_STATE_DIR": str(work / "state"), "PORT_KILL_CONSOLE": str(wrapper)}

    qs = subprocess.Popen(["qs", "-p", str(config)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    monitor = None
    stop = threading.Event()
    results = {}
    try:
        wait_for(lambda: qs_state(config), 15, "quickshell")
        time.sleep(2)

        def phase(name):
            count = len(scans.read_text().splitlines()) if scans.exists() else 0
            before, started = sample(qs.pid), time.monotonic()
            monitor_before = stat_ticks(monitor.pid)[0] if monitor else 0
            time.sleep(seconds)
            after, elapsed = sample(qs.pid), time.monotonic() - started
            own, children = cpu_ms(before, after)
            lines = scans.read_text().splitlines()[count:] if scans.exists() else []
            durations = [(int(b) - int(a)) / 1e6 for a, b in (line.split() for line in lines)]
            results[name] = {
                "elapsed_s": round(elapsed, 1),
                "bar_cpu_ms": round(own + children, 1),
                "shell_own_cpu_ms": round(own, 1),
                "children_cpu_ms": round(children, 1),
                "bar_percent_of_one_core": round((own + children) / (elapsed * 10), 2),
                "full_scans": len(durations),
                "scan_elapsed_ms_median": round(sorted(durations)[len(durations) // 2], 1) if durations else None,
                "monitor_cpu_ms": round((stat_ticks(monitor.pid)[0] - monitor_before) * 1000 / TICK, 1) if monitor else None,
            }
            print(name, json.dumps(results[name]), flush=True)

        phase("stopped")
        # Start the renamed monitor the way the launcher does, with
        # PORT_KILL_CONSOLE pointing at it.
        monitor_env = {**env, "PORT_KILL_CONSOLE": str(monitor_bin)}
        wrapper_proc = subprocess.Popen(["bash", str(config / "portkill.sh"), "launch"], env=monitor_env,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        wait_for(lambda: (qs_state(config) or {}).get("status") == "ready", 30, "first scan")
        leases = list((work / "state" / "monitors").iterdir())
        monitor = type("Monitor", (), {"pid": int(leases[0].name.split(".")[0])})
        time.sleep(2)
        phase("active_quiet")
        thread = threading.Thread(target=churn, args=(stop,), daemon=True)
        thread.start()
        phase("active_churn")
        stop.set()
        thread.join()
        os.killpg(wrapper_proc.pid, signal.SIGTERM)
        wrapper_proc.wait(timeout=5)
        wait_for(lambda: (qs_state(config) or {}).get("active") is False, 10, "inactive")
        time.sleep(2)
        monitor = None
        phase("stopped_again")
    finally:
        stop.set()
        qs.terminate()
        qs.wait(timeout=5)
        shutil.rmtree(work, ignore_errors=True)
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
