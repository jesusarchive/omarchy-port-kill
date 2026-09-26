# Port Kill for Omarchy

Find and free development ports from the Omarchy bar with
[Port Kill](https://portkill.com/).

![Port Kill menu and terminal](preview.png)

This is an independent integration of [Port Kill](https://github.com/treadiehq/port-kill).
The plugin uses `port-kill-console` to list and stop processes. Choose whether
the bar follows your terminal monitors or stays active whenever the plugin is
enabled. Both modes keep the live status colors.

## Requirements

- [Omarchy Quattro](https://omarchy.org/).
- Port Kill, installed using its [official installer](https://github.com/treadiehq/port-kill#install).
- Python 3.9 or newer with Linux pidfd support, used to track monitors and
  stop them safely.
- `flock` from util-linux, included with Omarchy, to coordinate launches and Quit.
- `lsof`, which Port Kill uses to find listening processes. Install it separately:

  ```bash
  sudo pacman -S lsof
  ```

## Install

```bash
omarchy plugin add https://github.com/jesusarchive/omarchy-port-kill.git --enable
```

Add Port Kill to the app launcher. This replaces an existing Port Kill
launcher entry:

```bash
omarchy tui install "Port Kill" "bash $HOME/.config/omarchy/plugins/jesusarchive.port-kill/portkill.sh launch" float \
  https://raw.githubusercontent.com/treadiehq/port-kill/main/assets/port-kill.png
```

To show the icon when you type `port-kill` or `port-kill-console` in a
terminal, add this line to `~/.bashrc` and open a new terminal:

```bash
source ~/.config/omarchy/plugins/jesusarchive.port-kill/port-kill.bash
```

It defines two shell functions that run Port Kill through the plugin. It does
not replace or wrap the installed binaries, so scripts and other programs are
unaffected. Delete the line to undo it.

## Use

Select Port Kill in the app launcher, or run `port-kill` in a terminal with the
integration above. The terminal shows Port Kill's usual log, and Ctrl+C stops
it as before. Left-click the bar icon to open the menu. Right-click it to
open a terminal with Port Kill activity logs, without changing your settings.
The bar uses Port Kill's default range of ports 2000 through 9000.

![Port Kill menu](assets/menu.png)

- **Kill All Processes** stops processes on ports 2000 through 9000.
- **Kill: Port N: process** asks Port Kill to stop what listens on port N.
- **Quit** stops monitoring, hides the icon, and closes the log TUI and
  registered terminal monitors, including in Always active mode. Development
  processes keep running. Launching Port Kill through the integration, changing
  the monitoring mode, or restarting the plugin starts it again. Quit waits
  for cleanup; a failure keeps the icon and error visible so you can retry.

Kills act on ports, not on the process in the menu row. Port Kill looks up
the port again when the action runs, so it may stop a different process if the
listener changed since the menu was refreshed. Port Kill reports one process per
port, so when several processes share a port, the menu shows one of them.
Stopping a process also closes any other ports it owns. Kill actions run
immediately, without confirmation, and are not retried if they fail or time
out.

### Monitoring modes

Choose **When to monitor** in the plugin settings in the bar editor.
All preferences live in the plugin settings. The popup keeps the port actions, dividers, and Quit:

| Mode | Behavior |
| --- | --- |
| Follow terminal | The default. The icon appears while at least one registered terminal monitor runs, and disappears after the last one exits. No recurring background work runs while inactive. |
| Always active | Monitoring starts when the plugin is enabled. No terminal is required. Closing a terminal does not stop the bar; choosing Quit does. |

Both modes show green when no matching processes are running. Empty results do
not hide the icon. You can change modes without restarting the shell.

The app launcher and the Bash integration register terminal monitors. This
includes no-argument calls and supported monitor options such as `--ports`,
`--start-port`, `--end-port`, `--ignore-*`, `--docker`, and `--verbose`.
One-shot commands such as `port-kill 3000`, `--json`, and `--kill-all` never
register a monitor or activate Follow terminal mode. Programs that invoke the
binary directly without the integration do not register either.

Ctrl+C, closing a terminal, and abrupt exits all remove that monitor. When the
shell starts it checks for registered monitors already running. In Always
active mode monitoring also starts immediately without any registered monitors.

Monitoring never opens a terminal automatically. Right-click the icon to open
Port Kill's activity logs on demand in either mode. If a registered Port Kill
terminal is already open, right-click brings its window forward. Otherwise it
opens one log terminal; repeated right-clicks reuse it. If a registered TUI's
window cannot be identified reliably, the plugin reports that in its tooltip
and avoids opening a duplicate. This can happen with shared terminal servers
or tabs. Commands run outside the plugin integration cannot be tracked. Close the window or press Ctrl+C to dismiss
it; right-click again to reopen it. Closing logs leaves monitoring and any
manually started terminal monitors running.

The plugin closes its log terminal when monitoring becomes inactive or the
plugin unloads. Log terminals run Port Kill's usual activity monitor, with its
own scan loop. They do not activate Follow terminal mode.

The icon's center is green when no processes are found, orange for 1 to 9,
and red for 10 or more. Grey means the list is not current: the first scan is
still running, a dependency is missing, or a scan or action failed or timed
out. Hover over the icon to read why. Kill actions are disabled until a scan
succeeds, during a menu refresh, and until the scan after an action completes.
Failed scans are retried automatically.

The terminal logs process changes, including those made from the menu.
Press Ctrl+C in the terminal to stop the monitor.

![Port Kill terminal log](assets/terminal.png)

## Keyboard controls

| Key | Action |
| --- | --- |
| Up / Down or `k` / `j` | Move through the menu |
| Enter / Space | Activate the selected item |
| `x` | Stop the selected port; does nothing on Kill All or Quit |
| `a` | Stop processes on ports 2000 through 9000 |
| `r` | Refresh the list |
| Tab / Shift+Tab | Switch to the next / previous bar panel |
| Escape | Close the menu |

To toggle the menu from a terminal or a custom shortcut:

```bash
omarchy-shell jesusarchive.port-kill toggle
```

## Settings

Configure these preferences in the plugin settings in the bar editor:

| Setting | Key | Default | Description |
| --- | --- | --- | --- |
| When to monitor | `monitoringMode` | `terminal` | `terminal` follows registered terminal monitors; `always` runs whenever enabled. |
| Check interval | `refreshIntervalSec` | `2` seconds | How often to check listening sockets while active. Accepts 1 to 300 seconds. |

Existing installations keep Follow terminal as the default and their
configured check interval.

The interval changes the bar's check, not Port Kill's terminal monitor.
The check reads the kernel's socket table and does not run Port Kill. The bar runs a full Port
Kill scan when monitoring starts, when you open the menu or press `r`, after an
action, when a listener on ports 2000 through 9000 appears, disappears or is
replaced, and at least once a minute. Socket changes start at most one scan
every 5 seconds, and only one scan runs at a time. Scans time out after 10
seconds and actions after 20.

## How it works

`portkill.sh launch` and the Bash integration start Port Kill in the
foreground of the terminal. Before Port Kill starts, they record its process ID
and start time in `$XDG_RUNTIME_DIR/omarchy-port-kill/monitors/` and notify the
bar. While monitoring is active, the bar runs `monitors.py watch`.
It holds a Linux pidfd for each monitor, so it learns about every exit at once,
including crashes, and checks the socket table in-process. In Follow terminal
mode it exits after the last monitor does. In Always active mode it continues checking sockets with no monitors. Both modes stop the helper
when the plugin is unloaded. `terminal_logs.py` separately owns the optional
log terminal. Its controller starts the backend using the terminal's file
descriptors, watches the display connection, and stops the backend if the
window disappears. Linux parent-death signaling also stops the backend if the
controller dies. Manual monitors carry a session generation so delayed start
notifications cannot undo Quit. Quit uses verified pidfds for TERM followed by
KILL if a monitor refuses to stop. Cancellation forwards termination to the backend
process group and waits for its bounded cleanup.

## Update

```bash
omarchy plugin update jesusarchive.port-kill
```

## Remove

```bash
omarchy plugin remove jesusarchive.port-kill
```

Port Kill and its launcher entry remain installed. The launcher uses the
plugin's script, so remove the entry too or recreate it with `port-kill-console`
as its command. If you added the Bash integration, delete its line from
`~/.bashrc`; until you do, `port-kill` runs the binary directly. To remove
both the launcher and Port Kill:

```bash
omarchy tui remove "Port Kill"
rm ~/.local/bin/port-kill ~/.local/bin/port-kill-console
```

## Development

Run from the repository root with Node.js installed:

```bash
node --test tests/*.test.js
python3 -m unittest discover -s tests -p 'test_*.py'
omarchy plugin validate .
```

Tests use fake binaries, a private monitor directory and loopback listeners
on ports 8900 through 8999. Two opt-in suites need more:

```bash
# The real Port Kill and lsof: lists and stops a listener the test owns.
PORT_KILL_INTEGRATION=1 node --test tests/portkill.test.js
# Service.qml in a private Quickshell instance; needs a Wayland session.
PORT_KILL_QML=1 node --test --test-concurrency=1 tests/service.test.js
```

`python3 tests/measure_cpu.py [seconds]` measures the bar's CPU time with the
real backend while stopped, while a monitor runs, and during listener churn.

## License

[MIT](LICENSE). Port Kill is a separate project by Treadie under the
FSL-1.1-MIT license.
