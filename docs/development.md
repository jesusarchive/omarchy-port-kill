# Development and lifecycle

## Source layout

| File | Role |
| --- | --- |
| `Panel.qml` | Icon, tooltip, menu, keyboard actions, and right-click log access. |
| `Service.qml` | Monitoring state, scan and action processes, and Quit. |
| `LogTerminal.qml` | Opens or focuses logs and waits for a closing controller before reopening. |
| `CommandWatchdog.qml` | Escalates a stalled command from TERM to KILL if its wrapper's deadline fails. |
| `Model.js` | Parses Port Kill output and watcher events; builds rows and status colors. |
| `Scheduler.js` | Serializes scans, limits background scan frequency, retries failed scans, and discards obsolete results. |
| `portkill.sh` | Finds Port Kill, registers foreground monitors, and bounds scans and kill commands. |
| `port-kill.bash` | Optional interactive Bash functions for registered launches. |
| `monitors.py` | Tracks monitor identities with pidfds, detects socket changes, and stops registered monitors. |
| `terminal_logs.py` | Focuses an existing TUI or owns a single log window and its backend. |
| `manifest.json` | Plugin metadata and the two settings, monitoring mode and check interval. |

## Monitor registration

### Terminal integration

For shells other than Bash, start a tracked monitor explicitly:

```bash
bash ~/.config/omarchy/plugins/jesusarchive.port-kill/portkill.sh launch
```

The Bash integration defines shell functions without replacing binaries on
PATH. No-argument calls and supported monitor options register a monitor.
These include `--ports`, `--start-port`, `--end-port`, `--ignore-*`, `--docker`,
and `--verbose`. Other invocations pass directly to the binary. See
`starts_monitor` in `portkill.sh` for the full supported option list.

Plugin launcher sessions and newly created right-click log windows default to
`RUST_LOG=warn`. This reduces internal INFO logging while keeping the backend's
normal status output, warnings, and errors. Explicit logging preferences are
respected. The Bash `run` path and existing terminals keep their own logging
behavior. Log windows show Port Kill activity, not the shell's diagnostic log.

Unloading the plugin closes its own log window but leaves manually launched
monitors running. A shell restart discovers their leases. Closing a terminal or
pressing Ctrl+C releases its lease. Removing the Bash source line takes effect
in new shells; already loaded functions fall back to the binary if the plugin
script has been removed.

### Process identities

The launcher and Bash integration record the monitor's PID and Linux process
start time in `$XDG_RUNTIME_DIR/omarchy-port-kill/monitors/`. The fallback runtime
root is `/run/user/$UID`. Each lease contains a session generation. Registration
and Quit share a file lock so a launch receives a consistent generation.

The wrapper sends the lease identity to the service after registration. The
watcher verifies identities and holds a Linux pidfd for each live monitor.
Process exit notifications therefore cover normal exits and crashes without
signaling a reused PID. The shell also discovers registered monitors on startup.

In Follow terminal mode, the watcher exits after the last registered monitor.
There is no recurring background work while inactive. In Always active mode,
the watcher continues checking sockets with no registered monitors. Plugin
unload stops the watcher in both modes.

## Scanning and port actions

The watcher reads socket tables at the configured interval. A change on ports
2000 through 9000 requests a full Port Kill scan. Background requests start at
most one scan every five seconds. Startup, menu opening, explicit refresh, and
completion of an action request an immediate scan. Only one scan runs at a time.
A successful result is refreshed after 60 seconds even without socket changes.
Failed scans retry with exponential backoff from two to 60 seconds.

Scans have a 10-second deadline and port actions a 20-second deadline, followed
by a two-second forced-cleanup grace. QML watchdogs handle wrappers that fail to
exit. Cancellation forwards termination to the backend process group.

Actions invalidate earlier scans. Their results cannot replace the post-action
list. Port actions run immediately and are never retried automatically. They
target ports as resolved by Port Kill when the command runs, not the stored PID
from a menu row.

## Log terminal ownership

Right-click first searches registered monitors and existing log displays for a
Hyprland window. It chooses the nearest window in each process's ancestry, so
an editor ancestor does not take precedence over its terminal. Ambiguous or
unavailable window ownership produces an error instead of an extra TUI.

A file lock prevents simultaneous plugin-created log windows. The controller
launches the configured terminal through `xdg-terminal-exec`. Its display helper
passes terminal file descriptors over a private Unix socket. The controller
starts Port Kill on those descriptors and watches the display connection,
backend, launcher, and the service's stdin. A terminal that never connects times
out after 10 seconds.

The Python controller keeps terminal launch, descriptor validation, and backend
ownership in separate context managers. An `ExitStack` releases acquired
resources on startup failures as well as normal exit.

Closing the window or the service's input stops the backend process group.
Linux parent-death signaling kills the backend if its controller dies abruptly.
The display also watches its owner, including when a terminal launcher detaches.
Plugin-created log windows do not register as manual monitors.

The log helper disables Python bytecode writes before importing local modules.
Omarchy watches the installed plugin directory, so creating `__pycache__` there
would reload the plugin during the first right-click. Runtime state belongs in
the runtime directory, never alongside plugin source files.

## Quit and recovery

Quit stops new scans, cancels current scanning, closes the plugin-created log
window, and advances the session generation before collecting registered
monitors. Verified pidfds receive TERM, then KILL after a two-second grace if
needed. Quit waits up to another two seconds after escalation. It does not
signal development servers or processes discovered merely by name.

The icon stays visible until cleanup succeeds. A failure leaves the error and
Quit retry available, with scanning and port-kill actions stopped. A delayed
start notification from the old session cannot resume monitoring. A fresh
registered launch can resume it only after its identity and generation validate.
Changing monitoring mode or restarting the plugin also clears the stopped state.
Changing only the check interval does not resume a stopped session.

## Settings schema

User preferences are edited through plugin settings in the bar editor. The
manifest stores them as follows:

| Key | Values | Default |
| --- | --- | --- |
| `monitoringMode` | `terminal` or `always` | `terminal` |
| `refreshIntervalSec` | Integer, 1 through 300 | `2` |

There is no terminal-visibility setting. Right-click opens or focuses logs on
demand. The service retries failed scans, but never retries a kill action.

## Automated checks

Run from the repository root on Linux with Node.js and Python installed:

```bash
node --test tests/*.test.js
python3 -m unittest discover -s tests -p 'test_*.py'
bash -n portkill.sh port-kill.bash
python3 -m json.tool manifest.json > /dev/null
omarchy plugin validate .
git diff --check
```

CI runs the Node and Python suites, Bash syntax check, and JSON validation. The
real backend and QML service suites are opt-in and require local dependencies:

```bash
# Needs the real Port Kill and lsof. Stops only a listener created by the test.
PORT_KILL_INTEGRATION=1 node --test tests/portkill.test.js

# Needs Quickshell and a Wayland session. Uses a private shell and fake backend.
PORT_KILL_QML=1 node --test --test-concurrency=1 tests/service.test.js
```

Tests use private state directories and test-owned processes. Listener tests
use loopback ports 8900 through 8999. Abrupt-exit tests use SIGKILL, not SIGSEGV,
to avoid generating intentional core dumps and desktop crash notifications.
Coverage includes missed exit notifications, stale PIDs, late starts after Quit,
TERM-ignoring monitors, failed Quit recovery, duplicate prevention, ambiguous
windows, delayed terminal startup, and controller or display death.

`python3 tests/measure_cpu.py [seconds-per-phase]` measures CPU time in a private
Quickshell instance with the real backend. It compares inactive monitoring,
a registered monitor with quiet sockets, and test-owned listener churn. It
requires Quickshell, a Wayland session, Port Kill, and `lsof`.

## Manual checks

Use test-owned development servers for destructive actions.

1. In Follow terminal mode, launch a registered TUI and confirm the icon appears.
   Close the last registered TUI and confirm the icon disappears.
2. In Always active mode, close all TUIs and confirm the icon remains. Check green
   with no matching processes, orange with one through nine, and red with ten
   or more. A scan or action error should make the center grey.
3. Right-click repeatedly. Confirm one log window opens or an existing registered
   TUI receives focus. Close it and reopen it. Check an ambiguous terminal setup
   reports an error without creating another TUI.
4. Choose Quit in both modes. Confirm registered TUIs close and the icon hides,
   while test development servers keep running. Start a fresh registered TUI and
   confirm monitoring resumes.
5. Reload the plugin with a registered TUI running. Confirm it is rediscovered.
6. Verify menu dividers, Quit, tooltip text, keyboard navigation, and settings.
   Read any crash notification and inspect its executable and timestamp. A
   passing lifecycle test alone does not establish a terminal crash's cause.
