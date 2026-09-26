import os
import array
import json
from unittest.mock import patch
from pathlib import Path
import select
import signal
import socket
import subprocess
import shutil
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import terminal_logs
from monitors import start_time


class TerminalLogsTests(unittest.TestCase):
    def test_handshake_releases_fds_on_success_and_invalid_messages(self):
        for message, count in ((b'terminal', 3), (b'wrong', 3), (b'terminal', 1), (b'terminal', 4)):
            sender, receiver = socket.socketpair()
            with self.subTest(message=message, count=count), sender, receiver, open('/dev/null') as stream:
                descriptors = array.array('i', [stream.fileno()] * count)
                sender.sendmsg([message], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, descriptors)])
                before = len(os.listdir('/proc/self/fd'))
                if message == b'terminal' and count == 3:
                    with terminal_logs.terminal_descriptors(receiver) as (pid, received):
                        self.assertEqual(pid, os.getpid())
                        for fd in received:
                            os.fstat(fd)
                else:
                    with self.assertRaisesRegex(RuntimeError, 'Could not connect'):
                        with terminal_logs.terminal_descriptors(receiver):
                            self.fail('invalid handshake accepted')
                self.assertEqual(len(os.listdir('/proc/self/fd')), before)

    def test_backend_is_reaped_if_pidfd_creation_fails(self):
        children = []
        popen = subprocess.Popen

        def start_child(*args, **kwargs):
            child = popen(*args, **kwargs)
            children.append(child)
            return child

        with open('/dev/null', 'r+') as stream, \
             patch.object(terminal_logs.subprocess, 'Popen', side_effect=start_child), \
             patch.object(terminal_logs.os, 'pidfd_open', side_effect=OSError('no pidfd')):
            with self.assertRaisesRegex(OSError, 'no pidfd'):
                with terminal_logs.run_backend('/usr/bin/cat', [stream.fileno()] * 3):
                    self.fail('backend started without a pidfd')
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].returncode)
        self.assertFalse(Path(f'/proc/{children[0].pid}').exists())

    def test_launcher_start_failure_closes_listener(self):
        with open('/dev/null') as stream, \
             patch.object(terminal_logs, 'focus_existing', return_value=False), \
             patch.object(terminal_logs.sys, 'stdin', stream), \
             patch.object(terminal_logs.os, 'posix_spawnp', side_effect=FileNotFoundError('no terminal')):
            before = len(os.listdir('/proc/self/fd'))
            with self.assertRaisesRegex(terminal_logs.TerminalUnavailable, 'Could not launch'):
                terminal_logs.own_locked('/usr/bin/cat')
            self.assertEqual(len(os.listdir('/proc/self/fd')), before)

    def test_first_launch_does_not_write_into_plugin_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plugin = root / 'plugin'
            plugin.mkdir()
            for name in ('terminal_logs.py', 'monitors.py'):
                shutil.copy(ROOT / name, plugin / name)
            before = sorted(path.relative_to(plugin) for path in plugin.rglob('*'))
            env = {**os.environ, 'PORT_KILL_STATE_DIR': str(root / 'state')}
            env.pop('PYTHONDONTWRITEBYTECODE', None)
            env.pop('PYTHONPYCACHEPREFIX', None)
            result = subprocess.run(
                [sys.executable, str(plugin / 'terminal_logs.py'), 'focus'],
                env=env, capture_output=True, text=True, timeout=5,
            )
            self.assertEqual(result.returncode, 1, result.stderr)  # No existing TUI.
            self.assertEqual(result.stderr, '')
            self.assertEqual(sorted(path.relative_to(plugin) for path in plugin.rglob('*')), before)

    def start(self, delay=0, ignore_term=False, launch_code=None, rust_log=None):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        directory = Path(tmp.name)
        started = directory / 'started'
        backend = directory / 'backend'
        backend.write_text(
            '#!/bin/bash\n' + ('trap "" TERM\n' if ignore_term else '')
            + f'printf "%s" "${{RUST_LOG-unset}}" > "{directory / "log-level"}"\n'
            + f'echo $$ > "{started}"\nwhile :; do sleep 0.1; done\n'
        )
        backend.chmod(0o755)
        launcher = directory / 'xdg-terminal-exec'
        launcher.write_text('#!/bin/bash\n'
            + (f'exit {launch_code}\n' if launch_code is not None else
               f'while [[ $1 != -- ]]; do shift; done\nshift\nsleep {delay}\nexec "$@"\n'))
        launcher.chmod(0o755)
        environment = {**os.environ, 'PATH': f'{directory}:{os.environ["PATH"]}',
                       'PORT_KILL_STATE_DIR': str(directory / 'state')}
        environment.pop('RUST_LOG', None)
        if rust_log is not None:
            environment['RUST_LOG'] = rust_log
        owner = subprocess.Popen(
            [sys.executable, str(ROOT / 'terminal_logs.py'), 'own', str(backend)],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            env=environment,
        )

        def cleanup():
            if owner.poll() is None:
                owner.kill()
            owner.wait()
            owner.stdin.close()
            owner.stderr.close()
            if started.exists():
                try:
                    os.killpg(int(started.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass
        self.addCleanup(cleanup)
        return owner, started

    def wait_started(self, started):
        deadline = time.monotonic() + 4
        while not started.exists():
            if time.monotonic() > deadline:
                self.fail('log backend did not start')
            time.sleep(0.02)
        return int(started.read_text())

    def wait_exited(self, pid):
        fd = os.pidfd_open(pid)
        try:
            poller = select.poll()
            poller.register(fd, select.POLLIN)
            self.assertTrue(poller.poll(4000), 'log backend outlived its controller')
        finally:
            os.close(fd)

    def test_closing_stdin_stops_owned_terminal(self):
        owner, started = self.start()
        pid = self.wait_started(started)
        owner.stdin.close()
        self.wait_exited(pid)
        self.assertEqual(owner.wait(timeout=2), 0)

    def test_logs_default_to_warnings_and_preserve_explicit_logging(self):
        for requested, expected in ((None, 'warn'), ('debug', 'debug')):
            with self.subTest(requested=requested):
                owner, started = self.start(rust_log=requested)
                self.wait_started(started)
                self.assertEqual((started.parent / 'log-level').read_text(), expected)
                owner.stdin.close()
                self.assertEqual(owner.wait(timeout=3), 0)

    def test_abrupt_controller_exit_stops_term_ignoring_backend(self):
        owner, started = self.start(ignore_term=True)
        pid = self.wait_started(started)
        owner.kill()
        self.wait_exited(pid)
        owner.wait(timeout=2)

    def test_delayed_terminal_does_not_start_after_controller_exits(self):
        owner, started = self.start(delay=0.5)
        owner.stdin.close()
        self.assertEqual(owner.wait(timeout=2), 0)
        time.sleep(0.8)
        self.assertFalse(started.exists())

    def test_terminal_launch_failure_is_reported(self):
        owner, started = self.start(launch_code=7)
        self.assertEqual(owner.wait(timeout=2), 3)
        self.assertIn(b'Terminal launcher exited with code 7', owner.stderr.read())
        self.assertFalse(started.exists())


class TerminalFocusTests(unittest.TestCase):
    def test_focus_uses_closest_window_not_the_recent_editor_ancestor(self):
        with tempfile.TemporaryDirectory() as directory:
            with subprocess.Popen(["sleep", "10"]) as monitor:
                try:
                    state = Path(directory)
                    (state / "monitors").mkdir()
                    (state / "monitors" / f"{monitor.pid}.{start_time(Path('/proc'), monitor.pid)}").touch()
                    clients = [
                        {"pid": os.getpid(), "address": "0x111", "focusHistoryID": 0},
                        {"pid": monitor.pid, "address": "0x222", "focusHistoryID": 1},
                    ]
                    result = subprocess.CompletedProcess([], 0, json.dumps(clients), "")
                    with patch.dict(os.environ, {"PORT_KILL_STATE_DIR": directory}), \
                         patch.object(terminal_logs.subprocess, "run", return_value=result) as run:
                        self.assertTrue(terminal_logs.focus_existing())
                        self.assertIn("address:0x222", run.call_args.args[0][2])
                        # Shared terminal-server PIDs must not fall back to
                        # the unambiguous editor higher in the ancestry.
                        clients.append({"pid": monitor.pid, "address": "0x333", "focusHistoryID": 2})
                        result.stdout = json.dumps(clients)
                        with self.assertRaisesRegex(RuntimeError, "cannot be identified"):
                            terminal_logs.focus_existing()
                finally:
                    monitor.terminate()
