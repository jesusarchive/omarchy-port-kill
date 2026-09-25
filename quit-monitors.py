#!/usr/bin/env python3
"""Stop Port Kill monitors through stable Linux process descriptors."""

import os
from pathlib import Path
import select
import signal
import sys
import time


def is_monitor(directory):
    if directory.stat().st_uid != os.geteuid():
        return False
    # Linux truncates comm to 15 characters.
    if directory.joinpath("comm").read_bytes().rstrip(b"\n") not in (
        b"port-kill", b"port-kill-conso"
    ):
        return False
    argv = directory.joinpath("cmdline").read_bytes().split(b"\0")
    return bool(argv[0]) and not any(
        arg in (b"--json", b"--kill-all") for arg in argv[1:]
    )


def quit_monitors(proc_root):
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise RuntimeError("Port Kill needs Python 3.9+ with Linux pidfd support")
    pending = set()
    poller = select.poll()
    try:
        for directory in Path(proc_root).iterdir():
            if not directory.name.isascii() or not directory.name.isdecimal():
                continue
            fd = None
            try:
                # Acquire the stable reference BEFORE inspecting /proc. If the
                # PID is reused during inspection, this descriptor still refers
                # to the exited process and signaling it fails with ESRCH.
                fd = os.pidfd_open(int(directory.name))
                if not is_monitor(directory):
                    continue
                signal.pidfd_send_signal(fd, signal.SIGTERM)
                poller.register(fd, select.POLLIN)
                pending.add(fd)
                fd = None
            except (ProcessLookupError, FileNotFoundError, PermissionError):
                # Processes can exit during discovery; other users are ignored.
                continue
            finally:
                if fd is not None:
                    os.close(fd)

        deadline = time.monotonic() + 2
        while pending:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("Port Kill did not stop")
            for fd, _ in poller.poll(max(1, int(remaining * 1000))):
                poller.unregister(fd)
                pending.remove(fd)
                os.close(fd)
    finally:
        for fd in pending:
            os.close(fd)


if __name__ == "__main__":
    try:
        quit_monitors(os.environ.get("PORT_KILL_PROC_ROOT", "/proc"))
    except (OSError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
