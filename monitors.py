#!/usr/bin/env python3
"""Track Port Kill terminal monitors for the bar widget.

portkill.sh registers each monitor it starts with a lease file named
<pid>.<start time> before it execs Port Kill, so the lease names the monitor
process itself. This helper turns leases into pidfds: a pidfd refers to one
process, never to a later process that reuses the PID, and becomes readable
when that process exits, including crashes and exits nobody reported.

    monitors.py watch [interval] Report monitor count and socket changes
    monitors.py quit             Stop registered monitors
    monitors.py sockets          Print the socket signature once

watch prints one JSON object per line. In terminal mode it runs while monitors
exist; in always mode it keeps checking sockets without a terminal:

    {"type": "monitors", "count": 1}
    {"type": "sockets", "signature": "<sha1>", "count": 3}
    {"type": "sockets", "error": "<message>"}

In terminal mode it exits after reporting a count of 0. Both modes exit when
stdin closes because the bar
went away. A "rescan" line on stdin rereads the leases and sockets.
"""

import hashlib
import fcntl
import json
import os
from pathlib import Path
import select
import re
import signal
import sys
import time

# Port Kill's default range, which the bar lists.
PORT_RANGE = (2000, 9000)
TCP_LISTEN = "0A"


def lease_dir():
    base = os.environ.get("PORT_KILL_STATE_DIR")
    if not base:
        runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
        base = os.path.join(runtime, "omarchy-port-kill")
    return Path(base, "monitors")


def proc_root():
    return Path(os.environ.get("PORT_KILL_PROC_ROOT", "/proc"))


def require_pidfd():
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise RuntimeError("Port Kill needs Python 3.9+ with Linux pidfd support")


def start_time(root, pid):
    """Process start time in clock ticks, field 22 of /proc/<pid>/stat."""
    data = root.joinpath(str(pid), "stat").read_bytes()
    # The command name can contain spaces and parentheses; it ends at the last
    # parenthesis, and field 3 follows it.
    return int(data[data.rindex(b")") + 2:].split()[19])


def lease_matches(root, pid, started):
    directory = root.joinpath(str(pid))
    return directory.stat().st_uid == os.geteuid() and start_time(root, pid) == started


def parse_lease(name):
    pid, dot, started = name.partition(".")
    if not dot or not (pid.isascii() and pid.isdecimal() and started.isascii() and started.isdecimal()):
        return None
    return int(pid), int(started)


def open_lease(root, name):
    """Return a pidfd for the process a lease names, or None when it is gone."""
    parsed = parse_lease(name)
    if parsed is None:
        return None
    pid, started = parsed
    try:
        # Acquire the stable reference BEFORE checking the start time. If the
        # PID is reused in between, the check fails; if it is reused later,
        # the descriptor still refers to the original process.
        fd = os.pidfd_open(pid)
    except (ProcessLookupError, PermissionError):
        return None
    try:
        if lease_matches(root, pid, started):
            return fd
    except (OSError, ValueError, IndexError):
        pass
    os.close(fd)
    return None


def remove_lease(directory, name):
    try:
        directory.joinpath(name).unlink()
    except FileNotFoundError:
        pass


def lease_names(directory):
    try:
        return {entry.name for entry in os.scandir(directory) if parse_lease(entry.name)}
    except FileNotFoundError:
        return set()


def socket_entries(net_root=None, ports=PORT_RANGE):
    """Listening TCP sockets in the port range, as sorted identity strings.

    Each entry holds the family, local address, port, owner UID and socket
    inode. Queue sizes and timers are left out, so a pending connection is not
    a change, while a new listener on the same port has a new inode.
    """
    net_root = Path(net_root or os.environ.get("PORT_KILL_NET_ROOT", "/proc/net"))
    entries = []
    for family, name in (("4", "tcp"), ("6", "tcp6")):
        try:
            text = net_root.joinpath(name).read_text()
        except FileNotFoundError:
            if family == "6":  # IPv6 disabled
                continue
            raise
        lines = text.splitlines()
        # tcp names the second address rem_address, tcp6 remote_address.
        header = lines[0].split()[:4] if lines else []
        if header[:2] != ["sl", "local_address"] or header[3:] != ["st"]:
            raise ValueError(f"Unexpected format in {net_root / name}")
        for line in lines[1:]:
            fields = line.split()
            if len(fields) < 10:
                raise ValueError(f"Unexpected line in {net_root / name}: {line.strip()}")
            if fields[3] != TCP_LISTEN:
                continue
            address, _, port = fields[1].rpartition(":")
            port = int(port, 16)
            if ports[0] <= port <= ports[1]:
                entries.append(f"{family} {address} {port} {fields[7]} {fields[9]}")
    entries.sort()
    return entries


def socket_event():
    try:
        entries = socket_entries()
    except (OSError, ValueError) as error:
        return {"type": "sockets", "error": str(error)}
    digest = hashlib.sha1("\n".join(entries).encode()).hexdigest()
    return {"type": "sockets", "signature": digest, "count": len(entries)}


class Watcher:
    def __init__(self, interval, out=sys.stdout, stdin=sys.stdin, always=False):
        require_pidfd()
        self.interval = interval
        self.always = always
        self.out = out
        self.stdin = stdin
        self.directory = lease_dir()
        self.root = proc_root()
        self.poller = select.poll()
        self.leases = {}  # lease name -> pidfd
        self.names = {}  # pidfd -> lease name
        self.last = {}

    def emit(self, event):
        # Only report changes; the bar keeps the last value of each type.
        if self.last.get(event["type"]) == event:
            return
        self.last[event["type"]] = event
        self.out.write(json.dumps(event, sort_keys=True) + "\n")
        self.out.flush()

    def forget(self, fd, remove=True):
        name = self.names.pop(fd)
        del self.leases[name]
        self.poller.unregister(fd)
        os.close(fd)
        if remove:
            remove_lease(self.directory, name)

    def sync(self):
        names = lease_names(self.directory)
        # A removed lease means its wrapper saw the monitor exit.
        for name in set(self.leases) - names:
            self.forget(self.leases[name], remove=False)
        for name in names - set(self.leases):
            fd = open_lease(self.root, name)
            if fd is None:
                remove_lease(self.directory, name)
                continue
            self.leases[name] = fd
            self.names[fd] = name
            self.poller.register(fd, select.POLLIN)

    def report(self):
        self.emit({"type": "monitors", "count": len(self.leases)})
        if self.leases or self.always:
            self.emit(socket_event())

    def run(self):
        try:
            stdin_fd = self.stdin.fileno()
            self.poller.register(stdin_fd, select.POLLIN)
        except (AttributeError, OSError, ValueError):
            stdin_fd = None
        buffered = b""
        self.sync()
        self.report()
        next_probe = time.monotonic() + self.interval
        try:
            while self.leases or self.always:
                timeout = max(0, next_probe - time.monotonic())
                changed = False
                for fd, mask in self.poller.poll(max(1, int(timeout * 1000))):
                    if fd == stdin_fd:
                        chunk = os.read(stdin_fd, 4096)
                        if not chunk:
                            # The bar closed our stdin: it exited or restarted.
                            return 0
                        buffered += chunk
                        *lines, buffered = buffered.split(b"\n")
                        if any(line.strip() == b"rescan" for line in lines):
                            self.sync()
                            self.emit(socket_event())
                            changed = True
                    elif fd in self.names:
                        # A pidfd is readable once its process has exited.
                        self.forget(fd)
                        changed = True
                if time.monotonic() >= next_probe:
                    # Also catches leases added without a notification.
                    self.sync()
                    self.emit(socket_event())
                    next_probe = time.monotonic() + self.interval
                    changed = True
                if changed:
                    self.emit({"type": "monitors", "count": len(self.leases)})
            return 0
        finally:
            for fd in list(self.names):
                self.forget(fd, remove=False)


def valid_generation(value):
    return bool(re.fullmatch(r"[a-zA-Z0-9._-]{1,128}", value))


def verify_start(name, generation):
    """Only a live lease created after this Quit may resume the widget."""
    if parse_lease(name) is None or not valid_generation(generation):
        return False
    fd = open_lease(proc_root(), name)
    if fd is None:
        return False
    try:
        if (lease_dir() / name).read_text().strip() != generation:
            return False
        poller = select.poll()
        poller.register(fd, select.POLLIN)
        return not poller.poll(0)
    except FileNotFoundError:
        return False
    finally:
        os.close(fd)


def quit_monitors(generation=None):
    require_pidfd()
    directory = lease_dir()
    root = proc_root()
    directory.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    pending = set()
    poller = select.poll()
    try:
        # Registration and the Quit snapshot share a lock. A concurrent
        # launch belongs unambiguously to either the old or the new session.
        with (directory.parent / "registration.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if generation is not None:
                if not valid_generation(generation):
                    raise ValueError("Invalid monitor generation")
                temporary = directory.parent / f"generation.{os.getpid()}"
                temporary.write_text(generation + "\n")
                temporary.replace(directory.parent / "generation")
            for name in sorted(lease_names(directory)):
                fd = open_lease(root, name)
                if fd is None:
                    remove_lease(directory, name)
                    continue
                pending.add(fd)
                poller.register(fd, select.POLLIN)
        # Escalate only through the verified pidfds, never by process name or
        # a reused numeric PID. Development servers are not registered here.
        for sig, grace in ((signal.SIGTERM, 2), (signal.SIGKILL, 2)):
            for fd in pending:
                try:
                    signal.pidfd_send_signal(fd, sig)
                except ProcessLookupError:
                    pass
            deadline = time.monotonic() + grace
            while pending:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                for fd, _ in poller.poll(max(1, int(remaining * 1000))):
                    poller.unregister(fd)
                    pending.remove(fd)
                    os.close(fd)
            if not pending:
                return
        raise RuntimeError("Port Kill did not stop")
    finally:
        for fd in pending:
            os.close(fd)


def main(argv):
    action = argv[1] if len(argv) > 1 else ""
    if action == "watch" and len(argv) <= 4:
        mode = argv[3] if len(argv) == 4 else "terminal"
        if mode not in ("terminal", "always"):
            raise ValueError("mode must be terminal or always")
        interval = float(argv[2]) if len(argv) >= 3 else 5.0
        if not 0.05 <= interval <= 300:
            raise ValueError("interval must be between 0.05 and 300 seconds")
        return Watcher(interval, always=mode == "always").run()
    if action == "verify-start" and len(argv) == 4:
        return 0 if verify_start(argv[2], argv[3]) else 1
    if action == "quit" and len(argv) in (2, 3):
        quit_monitors(argv[2] if len(argv) == 3 else None)
        return 0
    if action == "sockets" and len(argv) == 2:
        for entry in socket_entries():
            print(entry)
        return 0
    print("Usage: monitors.py watch [interval] [terminal|always] | quit | sockets", file=sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except (OSError, RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
