#!/usr/bin/env python3
"""Keep a plugin-owned log terminal tied to the shell's stdin lifetime.

The terminal watches its controller through a pidfd, including when the
terminal launcher detaches or opens its window after monitoring stops.
These logs do not register as a user-started terminal monitor.
"""

import os
import array
import ctypes
import socket
import struct
import time
import uuid
import json
import fcntl
import re
from pathlib import Path
import select
import signal
import subprocess
import sys

# Omarchy watches the plugin directory for changes. A first-time local import
# must not create __pycache__ and reload the shell while opening the terminal.
sys.dont_write_bytecode = True

from monitors import lease_dir, lease_names, open_lease, require_pidfd, start_time


def focus_existing():
    """Find a window belonging to a registered monitor or our log display."""
    directories = [lease_dir(), lease_dir().parent / "log-terminals"]
    chains = []
    for directory in directories:
        for name in lease_names(directory):
            fd = open_lease(Path('/proc'), name)
            if fd is None:
                continue
            ancestors = []
            try:
                pid = int(name.split('.')[0])
                for _ in range(128):
                    if pid <= 1 or pid in ancestors:
                        break
                    ancestors.append(pid)
                    stat = Path(f'/proc/{pid}/stat').read_bytes()
                    pid = int(stat[stat.rindex(b')') + 2:].split()[1])
            except (OSError, ValueError, IndexError):
                pass
            finally:
                os.close(fd)
                if ancestors:
                    chains.append(ancestors)
    if not chains:
        return False
    try:
        result = subprocess.run(['hyprctl', 'clients', '-j'], capture_output=True,
                                text=True, timeout=2, check=True)
        clients = json.loads(result.stdout)
        unique = []
        for ancestors in chains:
            for pid in ancestors:
                matches = [c for c in clients if c.get('pid') == pid
                           and re.fullmatch(r'0x[0-9a-fA-F]+', str(c.get('address', '')))]
                if matches:
                    # Stop at the closest window ancestor. Falling back to
                    # an editor/launcher can focus an unrelated window.
                    if len(matches) == 1:
                        unique.append(matches[0])
                    break
        if not unique:
            raise RuntimeError("Port Kill is already running, but its terminal window cannot be identified. No extra TUI was opened.")
        client = min(unique, key=lambda c: c.get('focusHistoryID', 9999))
        target = 'address:' + client['address']
        focused = subprocess.run(['hyprctl', 'dispatch', 'hl.dsp.focus({ window = "' + target + '" })'],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
        if focused.returncode:
            subprocess.run(['hyprctl', 'dispatch', 'focuswindow', target],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=2, check=True)
        return True
    except (OSError, ValueError, TypeError, subprocess.SubprocessError) as error:
        raise RuntimeError("Could not focus the existing Port Kill terminal. No extra TUI was opened.") from error


def own(binary):
    require_pidfd()
    state = lease_dir().parent
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Keep the descriptor alive for this controller's whole lifetime.
    lock = open(state / "log-terminal.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        focus_existing()
        return 0
    try:
        return own_locked(binary)
    finally:
        lock.close()


def child_setup(parent):
    # This helper has one thread. Set the kernel's parent-death signal before
    # exec, then check for the race where the controller already exited.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
        os._exit(127)
    if os.getppid() != parent:
        os._exit(127)


def stop_backend(child, fd):
    # The leader remains unreaped until all group signals have been sent.
    # Its PID therefore cannot be reused to name an unrelated process group.
    try:
        os.killpg(child.pid, signal.SIGTERM)
        exited = select.poll()
        exited.register(fd, select.POLLIN)
        exited.poll(2000)
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=2)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("The log backend did not stop after SIGKILL") from error


def own_locked(binary):
    if focus_existing():
        return 0
    identity = f"{os.getpid()}.{start_time(Path('/proc'), os.getpid())}"
    address = f"portkill-{os.getuid()}-{uuid.uuid4().hex}"
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    # Linux abstract sockets disappear with their owner and need no pathname.
    server.bind('\0' + address)
    server.listen(1)
    server.setblocking(False)
    poller = select.poll()
    poller.register(sys.stdin.fileno(), select.POLLIN)
    poller.register(server.fileno(), select.POLLIN)
    command = [
        "xdg-terminal-exec", "--app-id=TUI.float", "--title=Port Kill logs", "--",
        sys.executable, str(Path(__file__).resolve()), "display", identity, address,
    ]
    launcher = os.posix_spawnp(command[0], command, os.environ, file_actions=[
        (os.POSIX_SPAWN_OPEN, 0, "/dev/null", os.O_RDONLY, 0o600),
    ])
    launcher_fd = os.pidfd_open(launcher)
    poller.register(launcher_fd, select.POLLIN)
    connection = None
    backend = None
    backend_fd = None
    display_lease = None
    deadline = time.monotonic() + 10

    def interrupted(_signal, _frame):
        raise KeyboardInterrupt

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupted)
    try:
        while True:
            remaining = deadline - time.monotonic() if connection is None else None
            if remaining is not None and remaining <= 0:
                raise RuntimeError("The log terminal did not open within 10 seconds")
            for ready, _ in poller.poll(None if remaining is None else max(1, int(remaining * 1000))):
                if ready == sys.stdin.fileno():
                    if not os.read(ready, 4096):
                        return 0
                elif ready == launcher_fd:
                    _, status = os.waitpid(launcher, 0)
                    if os.waitstatus_to_exitcode(status):
                        raise RuntimeError(f"Terminal launcher exited with code {os.waitstatus_to_exitcode(status)}")
                    poller.unregister(launcher_fd)
                elif ready == server.fileno():
                    connection, _ = server.accept()
                    connection.settimeout(2)
                    pid, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    if uid != os.getuid():
                        raise RuntimeError("Unexpected log terminal owner")
                    descriptors = array.array('i')
                    try:
                        message, ancillary, flags, _ = connection.recvmsg(16, socket.CMSG_SPACE(3 * descriptors.itemsize))
                        for level, kind, data in ancillary:
                            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                                descriptors.frombytes(data[:len(data) - len(data) % descriptors.itemsize])
                        if message != b'terminal' or len(descriptors) != 3 or flags & socket.MSG_CTRUNC:
                            raise RuntimeError("Could not connect the log terminal")
                        directory = lease_dir().parent / 'log-terminals'
                        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
                        display_lease = directory / f"{pid}.{start_time(Path('/proc'), pid)}"
                        display_lease.touch(mode=0o600)
                        parent = os.getpid()
                        # The controller owns the backend. The display only
                        # lends its tty and holds a connection while visible.
                        backend = subprocess.Popen([binary], stdin=descriptors[0],
                            stdout=descriptors[1], stderr=descriptors[2],
                            start_new_session=True, preexec_fn=lambda: child_setup(parent))
                        backend_fd = os.pidfd_open(backend.pid)
                    finally:
                        for fd in descriptors:
                            os.close(fd)
                    poller.unregister(server.fileno())
                    poller.register(connection.fileno(), select.POLLIN)
                    poller.register(backend_fd, select.POLLIN)
                elif ready == backend_fd:
                    # Reap only in cleanup, after group termination.
                    return 0
                elif connection is not None and ready == connection.fileno():
                    # EOF also covers a display killed before Python cleanup.
                    connection.recv(4096)
                    return 0
    except KeyboardInterrupt:
        return 0
    finally:
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            signal.signal(sig, signal.SIG_IGN)
        if backend is not None:
            stop_backend(backend, backend_fd)
        if backend_fd is not None:
            os.close(backend_fd)
        if connection is not None:
            connection.close()
        if display_lease is not None:
            display_lease.unlink(missing_ok=True)
        server.close()
        os.close(launcher_fd)


def display(identity, address):
    require_pidfd()
    owner = open_lease(Path('/proc'), identity)
    if owner is None:
        return 0
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)

    def interrupted(_signal, _frame):
        raise KeyboardInterrupt

    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, interrupted)
    try:
        try:
            connection.connect('\0' + address)
        except (ConnectionRefusedError, FileNotFoundError):
            return 0  # Controller exited before the window appeared.
        descriptors = array.array('i', [0, 1, 2])
        connection.sendmsg([b'terminal'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, descriptors)])
        poller = select.poll()
        poller.register(owner, select.POLLIN)
        poller.register(connection.fileno(), select.POLLIN)
        poller.poll()
        return 0
    except KeyboardInterrupt:
        return 0
    finally:
        connection.close()
        os.close(owner)


if __name__ == '__main__':
    try:
        if len(sys.argv) == 2 and sys.argv[1] == 'focus':
            sys.exit(0 if focus_existing() else 1)
        if len(sys.argv) == 3 and sys.argv[1] == 'own':
            sys.exit(own(sys.argv[2]))
        if len(sys.argv) == 4 and sys.argv[1] == 'display':
            sys.exit(display(sys.argv[2], sys.argv[3]))
        print('Usage: terminal_logs.py own <binary> | display <owner> <socket> | focus', file=sys.stderr)
        sys.exit(2)
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
