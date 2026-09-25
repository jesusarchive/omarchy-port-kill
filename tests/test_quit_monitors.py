import importlib.util
from pathlib import Path
import os
import signal
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "quit_monitors", Path(__file__).resolve().parents[1] / "quit-monitors.py"
)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class QuitTests(unittest.TestCase):
    def test_exit_after_validation_cannot_signal_replacement(self):
        with tempfile.TemporaryDirectory() as root, subprocess.Popen(["sleep", "30"]) as monitor:
            self.addCleanup(lambda: monitor.poll() is None and monitor.kill())
            Path(root, str(monitor.pid)).mkdir()
            real_open = os.pidfd_open
            descriptors = []

            def acquire(pid):
                fd = real_open(pid)
                descriptors.append(fd)
                return fd

            def validate(directory):
                self.assertEqual(len(descriptors), 1, "Acquire pidfd before validation")
                # Simulate the monitor exiting after its identity was checked.
                monitor.terminate()
                monitor.wait(timeout=2)
                return True

            with patch.object(helper.os, "pidfd_open", side_effect=acquire), \
                 patch.object(helper, "is_monitor", side_effect=validate), \
                 patch.object(helper.signal, "pidfd_send_signal", wraps=signal.pidfd_send_signal) as send:
                helper.quit_monitors(root)
                send.assert_called_once_with(descriptors[0], signal.SIGTERM)
            with self.assertRaises(OSError):
                os.fstat(descriptors[0])

    def test_unsupported_pidfd_fails_without_numeric_pid_fallback(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, "123").mkdir()
            with patch.object(helper.os, "pidfd_open", side_effect=OSError("unsupported")), \
                 patch.object(helper.os, "kill") as kill:
                with self.assertRaises(OSError):
                    helper.quit_monitors(root)
                kill.assert_not_called()


if __name__ == "__main__":
    unittest.main()
