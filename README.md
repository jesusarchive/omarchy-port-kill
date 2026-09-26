# Port Kill for Omarchy

Find and free development ports from the Omarchy bar with
[Port Kill](https://portkill.com/).

![Port Kill bar icon and menu with example development servers](preview.png)

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
- `xdg-terminal-exec` and a configured terminal for right-click logs, plus
  `hyprctl` to focus an existing window. These come with Omarchy.
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
[[ -r "$HOME/.config/omarchy/plugins/jesusarchive.port-kill/port-kill.bash" ]] && source "$HOME/.config/omarchy/plugins/jesusarchive.port-kill/port-kill.bash"
```

It defines two shell functions that run Port Kill through the plugin. It does
not replace or wrap the installed binaries, so scripts and other programs are
unaffected. The guard also avoids a shell startup error if the plugin is removed.
For an already open Bash terminal, run the same line once. Delete it from
`~/.bashrc` and open a new terminal to undo the integration.

For other shells, launch a registered monitor explicitly:

```bash
bash ~/.config/omarchy/plugins/jesusarchive.port-kill/portkill.sh launch
```

## Use

Select Port Kill in the app launcher, or run `port-kill` in a terminal with the
integration above. The terminal shows Port Kill's usual log, and Ctrl+C stops
it as before. Left-click the bar icon to open the menu. Right-click it to
open or focus a terminal with Port Kill activity logs, without changing your settings.
The bar uses Port Kill's default range of ports 2000 through 9000.

![Port Kill bar icon and menu](assets/menu.png)

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
The popup contains port actions, dividers, and Quit. It has no settings or
Open/Close terminal actions.

| Mode | Behavior |
| --- | --- |
| Follow terminal | The default. The icon appears while at least one registered terminal monitor runs, and disappears after the last one exits. No recurring background work runs while inactive. |
| Always active | Monitoring starts when the plugin is enabled. No terminal is required. Closing a terminal does not stop the bar; choosing Quit does. |

While monitoring is active, both modes show green when no matching processes
are running. Empty results do not hide the icon. You can change modes without
restarting the shell.

The app launcher and the Bash integration register terminal monitors. This
includes no-argument calls and supported monitor options such as `--ports`,
`--start-port`, `--end-port`, `--ignore-*`, `--docker`, and `--verbose`.
One-shot commands such as `port-kill 3000`, `--json`, and `--kill-all` never
register a monitor or activate Follow terminal mode. Programs that invoke the
binary directly without the integration do not register either.
Terminal options apply only to that terminal. For example, `--ports 3000`
does not change the bar's range of 2000 through 9000.

Ctrl+C, closing a terminal, and abrupt exits all remove that monitor. When the
shell starts it checks for registered monitors already running. In Always
active mode monitoring also starts immediately without any registered monitors.

### Terminal logs and closing behavior

Monitoring never opens a terminal automatically. Right-click the visible icon
to open Port Kill's activity logs in either mode. There is no Show terminal logs
setting.

If a registered Port Kill terminal is already open, right-click brings its
window forward. Otherwise it opens one log terminal. Repeated right-clicks
reuse it. If the window cannot be identified reliably, the tooltip explains
why and the plugin avoids opening a duplicate. This can happen with shared
terminal servers or tabs. The plugin cannot track commands run outside its
integration.

There are two kinds of terminal. A monitor started through the launcher or
Bash integration activates Follow terminal mode. A log window created by
right-click does not count as a registered monitor and cannot keep that mode
active on its own. Both show Port Kill's usual activity output and run their
own scan loop. They are not a viewer for the shell's internal diagnostic logs.

The app launcher and new right-click log windows default to `RUST_LOG=warn`.
This keeps process-status output, warnings, and errors visible while reducing
internal INFO messages, closer to the macOS app's default output. An explicit
`RUST_LOG` setting is respected. Commands typed through the Bash integration
keep their original logging behavior, as do existing terminals reused by
right-click. The bar menu keeps Omarchy's styling and keyboard controls.

| Action | Follow terminal | Always active |
| --- | --- | --- |
| Close a registered TUI or press Ctrl+C | Monitoring ends after the last registered TUI exits; the icon and any plugin-created log window close. | That TUI stops; monitoring and the icon remain. |
| Close a log window created by right-click | Registered monitors keep running. | Monitoring and the icon remain. |
| Choose Quit | Stops registered TUIs and the plugin-created log window, then hides the icon. | Same behavior; Quit overrides Always active for this session. |
| Reload or re-enable the plugin | Finds any registered monitors still running. | Starts monitoring again without a terminal. |

Quit leaves development servers running. It waits for terminal cleanup before
hiding the icon. If cleanup fails, the icon stays visible with an error and
Quit remains available to retry. A fresh registered launch, a change of
monitoring mode, or a plugin restart clears the stopped session. Changing only
the check interval does not resume it.

Unloading the plugin closes its own log window. Manually started registered
monitors keep running and are found again when the plugin loads.

### Status colors

The icon's center is green when no processes are found, orange for 1 to 9,
and red for 10 or more. Grey means the list is not current: the first scan is
still running, a dependency is missing, or a scan or action failed or timed
out. Hover over the icon to read why. Kill actions are disabled until a scan
succeeds, during a menu refresh, and until the scan after an action completes.
Failed scans are retried automatically. A terminal-opening or focus error
appears in the tooltip without changing the port-status color.

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

## Settings

Configure these preferences in the plugin settings in the bar editor:

| Setting | Key | Default | Description |
| --- | --- | --- | --- |
| When to monitor | `monitoringMode` | `terminal` | `terminal` follows registered terminal monitors; `always` runs whenever enabled. |
| Check interval | `refreshIntervalSec` | `2` seconds | How often to check listening sockets while active. Accepts 1 to 300 seconds. |

An unset monitoring mode uses Follow terminal. Updates preserve an explicitly
selected mode and check interval, including Always active.

The interval changes the bar's check, not Port Kill's terminal monitor.
The check reads the kernel's socket table and does not run Port Kill. The bar
runs a full Port Kill scan when monitoring starts, when you open the menu or
press `r`, after an action, when a listener on ports 2000 through 9000 appears, disappears or is
replaced, and after a minute without a successful scan. Failures use a retry
delay instead. Socket changes start at most one scan every 5 seconds, and only one scan runs at a time. Scans time out after 10
seconds and actions after 20.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| No icon in Follow terminal mode | Start Port Kill through the launcher or Bash integration. In Bash, `type -t port-kill` should print `function`. A one-shot command does not activate monitoring. |
| No icon after Quit in Always active mode | Launch a registered monitor, change monitoring mode, or reload the plugin. Quit deliberately stops the current session. |
| Grey icon or disabled kill actions | Read the tooltip. Check that Port Kill, Python, and `lsof` are available. A refresh disables kill actions until the scan finishes. |
| Right-click cannot find the existing TUI | Bring the existing terminal forward manually. The plugin avoids duplicates when a shared terminal process or tab makes window ownership ambiguous. |
| The log terminal does not open | Read the tooltip and check that `xdg-terminal-exec` can open your configured terminal. Startup times out after 10 seconds; right-click again after fixing the problem. |
| Quit fails | Read the tooltip and retry Quit. The icon stays visible while cleanup needs attention. |

The tooltip reports plugin failures. A desktop crash notification for a terminal
is separate from the Port Kill activity log. Closing a window successfully does
not prove that a terminal crash has been fixed. For development diagnostics and
lifecycle details, see the [developer guide](docs/development.md).

## Update

```bash
omarchy plugin update jesusarchive.port-kill
```

See the [changelog](CHANGELOG.md) for behavior changes. If your existing launcher
runs `port-kill-console` directly, recreate it with the Install command above to
enable tracking. Bash integration is opt-in and must be added separately.

## Remove

```bash
omarchy plugin remove jesusarchive.port-kill
```

Port Kill and its launcher entry remain installed. The launcher uses the
plugin's script, so remove the entry too or recreate it with `port-kill-console`
as its command. If you added the Bash integration, delete its line from
`~/.bashrc` and open a new terminal. Functions already loaded in an existing
shell fall back to the installed binaries once the plugin script is removed.
To remove both the launcher and Port Kill:

```bash
omarchy tui remove "Port Kill"
rm ~/.local/bin/port-kill ~/.local/bin/port-kill-console
```

## Development

See [Development and lifecycle](docs/development.md) for the source layout,
monitor registration, shutdown rules, test commands, and a manual test checklist.

## License

[MIT](LICENSE). Port Kill is a separate project by Treadie under the
FSL-1.1-MIT license.
