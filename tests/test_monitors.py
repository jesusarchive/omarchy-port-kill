import importlib.util
import io
import json
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("monitors", ROOT / "monitors.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def lease_name(pid):
    return f"{pid}.{helper.start_time(Path('/proc'), pid)}"


class StateDir:
    """An isolated lease directory for one test."""

    def __init__(self, test):
        self.tmp = tempfile.TemporaryDirectory()
        test.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        self.leases = self.path / "monitors"
        self.leases.mkdir()
        patcher = patch.dict(os.environ, {"PORT_KILL_STATE_DIR": str(self.path)})
        patcher.start()
        test.addCleanup(patcher.stop)

    def register(self, pid):
        name = lease_name(pid)
        self.leases.joinpath(name).touch()
        return name

    def names(self):
        return sorted(p.name for p in self.leases.iterdir())


def sleeper(test, seconds=30):
    child = subprocess.Popen(["sleep", str(seconds)])

    def stop():
        if child.poll() is None:
            child.kill()
        child.wait()

    test.addCleanup(stop)
    return child


class WatchProcess:
    """monitors.py watch in a subprocess, read line by line."""

    def __init__(self, test, interval="0.1", env=None):
        self.proc = subprocess.Popen(
            [sys.executable, str(ROOT / "monitors.py"), "watch", interval],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={**os.environ, **(env or {})}, text=True,
        )
        test.addCleanup(self.close)

    def event(self, timeout=3):
        ready, _, _ = select.select([self.proc.stdout], [], [], timeout)
        if not ready:
            raise AssertionError("watcher printed nothing")
        line = self.proc.stdout.readline()
        if not line:
            raise AssertionError("watcher exited: " + self.proc.stderr.read())
        return json.loads(line)

    def until(self, predicate, timeout=3):
        deadline = time.monotonic() + timeout
        while True:
            event = self.event(max(0.01, deadline - time.monotonic()))
            if predicate(event):
                return event

    def send(self, text):
        self.proc.stdin.write(text)
        self.proc.stdin.flush()

    def close(self):
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait()
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            stream.close()


class LeaseTests(unittest.TestCase):
    def test_lease_opens_only_for_the_named_process(self):
        child = sleeper(self)
        fd = helper.open_lease(Path("/proc"), lease_name(child.pid))
        self.assertIsNotNone(fd)
        os.close(fd)
        # A different start time is a different process that reused the PID.
        started = helper.start_time(Path("/proc"), child.pid)
        self.assertIsNone(helper.open_lease(Path("/proc"), f"{child.pid}.{started + 1}"))

    def test_invalid_and_exited_leases_are_rejected(self):
        child = subprocess.Popen(["true"])
        name = lease_name(child.pid)
        child.wait()
        for bad in [name, "abc.1", "12", "12.", ".12", "١٢.3"]:
            self.assertIsNone(helper.open_lease(Path("/proc"), bad), bad)

    def test_start_time_handles_spaces_and_parentheses_in_names(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, "7").mkdir()
            fields = ["S"] + [str(n) for n in range(4, 22)] + ["987654"] + ["0"] * 30
            Path(root, "7", "stat").write_text("7 (a) b (c)) " + " ".join(fields) + "\n")
            self.assertEqual(helper.start_time(Path(root), 7), 987654)


class QuitTests(unittest.TestCase):
    def test_quit_stops_registered_monitors_and_waits(self):
        state = StateDir(self)
        monitors = [sleeper(self), sleeper(self)]
        unrelated = sleeper(self)
        for monitor in monitors:
            state.register(monitor.pid)
        helper.quit_monitors()
        for monitor in monitors:
            self.assertEqual(monitor.wait(timeout=1), -signal.SIGTERM)
        self.assertIsNone(unrelated.poll())

    def test_quit_removes_stale_leases_and_succeeds_without_monitors(self):
        state = StateDir(self)
        child = subprocess.Popen(["true"])
        name = lease_name(child.pid)
        child.wait()
        state.leases.joinpath(name).touch()
        helper.quit_monitors()
        self.assertEqual(state.names(), [])

    def test_exit_after_validation_cannot_signal_replacement(self):
        state = StateDir(self)
        monitor = sleeper(self)
        state.register(monitor.pid)
        real_open = os.pidfd_open
        descriptors = []

        def acquire(pid):
            fd = real_open(pid)
            descriptors.append(fd)
            return fd

        def validate(root, pid, started):
            self.assertEqual(len(descriptors), 1, "Acquire pidfd before validation")
            # Simulate the monitor exiting after its identity was checked.
            monitor.terminate()
            monitor.wait(timeout=2)
            return True

        with patch.object(helper.os, "pidfd_open", side_effect=acquire), \
             patch.object(helper, "lease_matches", side_effect=validate), \
             patch.object(helper.signal, "pidfd_send_signal", wraps=signal.pidfd_send_signal) as send:
            helper.quit_monitors()
            send.assert_called_once_with(descriptors[0], signal.SIGTERM)
        with self.assertRaises(OSError):
            os.fstat(descriptors[0])

    def test_unsupported_pidfd_fails_without_numeric_pid_fallback(self):
        StateDir(self).register(sleeper(self).pid)
        with patch.object(helper.os, "pidfd_open", side_effect=OSError("unsupported")), \
             patch.object(helper.os, "kill") as kill:
            with self.assertRaises(OSError):
                helper.quit_monitors()
            kill.assert_not_called()

    def test_missing_pidfd_support_is_reported(self):
        StateDir(self)
        with patch.object(helper.signal, "pidfd_send_signal", create=True), \
             patch.object(helper, "hasattr", create=True, side_effect=lambda obj, name: False):
            with self.assertRaisesRegex(RuntimeError, "pidfd"):
                helper.quit_monitors()


class StartGenerationTests(unittest.TestCase):
    def test_resume_requires_matching_generation_and_live_identity(self):
        state = StateDir(self)
        monitor = sleeper(self)
        name = state.register(monitor.pid)
        state.leases.joinpath(name).write_text("before-quit\n")
        self.assertFalse(helper.verify_start(name, "after-quit"))
        state.leases.joinpath(name).write_text("after-quit\n")
        self.assertTrue(helper.verify_start(name, "after-quit"))
        self.assertFalse(helper.verify_start("../generation", "after-quit"))
        monitor.terminate()
        monitor.wait()
        self.assertFalse(helper.verify_start(name, "after-quit"))

    def test_quit_advances_generation_and_keeps_other_processes_alive(self):
        state = StateDir(self)
        unregistered = sleeper(self)
        helper.quit_monitors("new-session")
        self.assertEqual(state.path.joinpath("generation").read_text().strip(), "new-session")
        self.assertIsNone(unregistered.poll())


class WatchTests(unittest.TestCase):
    def test_no_monitors_reports_zero_and_exits_at_once(self):
        StateDir(self)
        watch = WatchProcess(self, interval="60")
        self.assertEqual(watch.event(), {"type": "monitors", "count": 0})
        self.assertEqual(watch.proc.wait(timeout=2), 0)

    def test_multiple_monitors_crashes_and_last_exit(self):
        state = StateDir(self)
        first, second = sleeper(self), sleeper(self)
        state.register(first.pid)
        state.register(second.pid)
        # A long interval proves exits are events, not polling.
        watch = WatchProcess(self, interval="60")
        self.assertEqual(watch.event(), {"type": "monitors", "count": 2})
        self.assertEqual(watch.event()["type"], "sockets")
        first.send_signal(signal.SIGKILL)  # a crash nobody reports
        first.wait()
        start = time.monotonic()
        self.assertEqual(watch.event(), {"type": "monitors", "count": 1})
        self.assertLess(time.monotonic() - start, 1)
        second.kill()
        second.wait()
        self.assertEqual(watch.event(), {"type": "monitors", "count": 0})
        self.assertEqual(watch.proc.wait(timeout=2), 0)
        # Leases of exited monitors are removed.
        self.assertEqual(state.names(), [])

    def test_rescan_picks_up_new_monitors_immediately(self):
        state = StateDir(self)
        first = sleeper(self)
        state.register(first.pid)
        watch = WatchProcess(self, interval="60")
        self.assertEqual(watch.event()["count"], 1)
        watch.event()  # sockets
        second = sleeper(self)
        state.register(second.pid)
        watch.send("rescan\n")
        self.assertEqual(watch.until(lambda e: e["type"] == "monitors"), {"type": "monitors", "count": 2})

    def test_missed_notification_is_caught_by_the_periodic_check(self):
        state = StateDir(self)
        first = sleeper(self)
        state.register(first.pid)
        watch = WatchProcess(self, interval="0.2")
        self.assertEqual(watch.event()["count"], 1)
        second = sleeper(self)
        state.register(second.pid)  # no rescan request
        self.assertEqual(watch.until(lambda e: e["type"] == "monitors"), {"type": "monitors", "count": 2})

    def test_stale_and_reused_leases_are_ignored_and_removed(self):
        state = StateDir(self)
        live = sleeper(self)
        state.register(live.pid)
        exited = subprocess.Popen(["true"])
        stale = lease_name(exited.pid)
        exited.wait()
        state.leases.joinpath(stale).touch()
        # The live process under a start time it never had: a reused PID.
        reused = f"{live.pid}.{helper.start_time(Path('/proc'), live.pid) + 5}"
        state.leases.joinpath(reused).touch()
        watch = WatchProcess(self, interval="60")
        self.assertEqual(watch.event(), {"type": "monitors", "count": 1})
        self.assertEqual(state.names(), [lease_name(live.pid)])

    def test_closing_stdin_stops_the_watcher(self):
        state = StateDir(self)
        state.register(sleeper(self).pid)
        watch = WatchProcess(self, interval="60")
        watch.event()
        watch.proc.stdin.close()
        self.assertEqual(watch.proc.wait(timeout=2), 0)

    def test_monitor_exit_before_watch_starts_is_reconciled(self):
        state = StateDir(self)
        child = sleeper(self)
        state.register(child.pid)
        child.kill()
        child.wait()
        watch = WatchProcess(self)
        self.assertEqual(watch.event(), {"type": "monitors", "count": 0})


TCP_HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
TCP6_HEADER = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"


def tcp_line(n, address, port, state="0A", queue="00000000:00000000", uid=1000, inode=100):
    return (f"   {n}: {address}:{port:04X} 00000000:0000 {state} {queue} 00:00000000 00000000 "
            f"{uid:>5}        0 {inode} 1 0000000000000000 100 0 0 10 0\n")


class SocketSignatureTests(unittest.TestCase):
    def net(self, tcp, tcp6=None):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        Path(directory.name, "tcp").write_text(TCP_HEADER + "".join(tcp))
        if tcp6 is not None:
            Path(directory.name, "tcp6").write_text(TCP6_HEADER + "".join(tcp6))
        return directory.name

    def signature(self, tcp, tcp6=None):
        with patch.dict(os.environ, {"PORT_KILL_NET_ROOT": self.net(tcp, tcp6)}):
            return helper.socket_event()

    def test_ignores_queues_order_other_states_and_ports_outside_the_range(self):
        base = [tcp_line(0, "0100007F", 3000, inode=1), tcp_line(1, "0100007F", 5173, inode=2)]
        changed = [
            tcp_line(0, "0100007F", 5173, inode=2, queue="00000000:00000003"),
            tcp_line(1, "0100007F", 3000, inode=1),
            tcp_line(2, "0100007F", 3000, state="01", inode=9),  # established
            tcp_line(3, "0100007F", 22, inode=10),
            tcp_line(4, "0100007F", 9001, inode=11),
        ]
        self.assertEqual(self.signature(base), self.signature(changed))
        self.assertEqual(self.signature(base)["count"], 2)

    def test_replacement_listener_on_the_same_port_changes_the_signature(self):
        before = self.signature([tcp_line(0, "0100007F", 3000, inode=1)])
        after = self.signature([tcp_line(0, "0100007F", 3000, inode=2)])
        self.assertNotEqual(before["signature"], after["signature"])

    def test_ipv6_shared_and_multiple_sockets_are_distinct_entries(self):
        v6 = "00000000000000000000000001000000"
        event = self.signature(
            [tcp_line(0, "0100007F", 3000, inode=1), tcp_line(1, "0100007F", 3000, inode=2)],
            [tcp_line(0, v6, 3000, inode=3), tcp_line(1, v6, 3001, inode=4)],
        )
        self.assertEqual(event["count"], 4)
        without_v6 = self.signature([tcp_line(0, "0100007F", 3000, inode=1), tcp_line(1, "0100007F", 3000, inode=2)], [])
        self.assertNotEqual(event["signature"], without_v6["signature"])

    def test_missing_tcp6_is_allowed_but_malformed_files_are_errors(self):
        self.assertIn("signature", self.signature([tcp_line(0, "0100007F", 3000)]))
        self.assertIn("error", self.signature(["garbage\n"]))
        with tempfile.TemporaryDirectory() as empty, patch.dict(os.environ, {"PORT_KILL_NET_ROOT": empty}):
            self.assertIn("error", helper.socket_event())


def free_test_port(family=socket.AF_INET, host="127.0.0.1"):
    """A port in 8900-8999 that this test can bind, and the bound socket."""
    for port in range(8900, 9000):
        sock = socket.socket(family, socket.SOCK_STREAM)
        try:
            sock.bind((host, port))
            return sock
        except OSError:
            sock.close()
    raise unittest.SkipTest("no free test port between 8900 and 8999")


class RealSocketTests(unittest.TestCase):
    """Loopback listeners owned by the test; nothing else is touched."""

    def entries_for(self, port):
        return [e for e in helper.socket_entries() if e.split()[2] == str(port)]

    def test_same_port_replacement_is_detected_and_queued_connections_are_not(self):
        server = free_test_port()
        port = server.getsockname()[1]
        server.listen(4)
        first = self.entries_for(port)
        self.assertEqual(len(first), 1)
        client = socket.create_connection(("127.0.0.1", port))
        self.addCleanup(client.close)
        time.sleep(0.05)
        self.assertEqual(self.entries_for(port), first, "a pending connection is not a change")
        client.close()
        server.close()
        replacement = socket.socket()
        self.addCleanup(replacement.close)
        replacement.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        replacement.bind(("127.0.0.1", port))
        replacement.listen(4)
        second = self.entries_for(port)
        self.assertEqual(len(second), 1)
        self.assertNotEqual(first, second)

    def test_ipv6_and_multiple_sockets_per_process(self):
        if not socket.has_ipv6 or not Path("/proc/net/tcp6").exists():
            self.skipTest("IPv6 is unavailable")
        v4 = free_test_port()
        port = v4.getsockname()[1]
        self.addCleanup(v4.close)
        v6 = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        self.addCleanup(v6.close)
        v6.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        try:
            v6.bind(("::1", port))
        except OSError:
            self.skipTest("::1 is unavailable")
        v4.listen(1)
        v6.listen(1)
        families = sorted(e.split()[0] for e in self.entries_for(port))
        self.assertEqual(families, ["4", "6"])


if __name__ == "__main__":
    unittest.main()
