# Port Kill for Omarchy

An Omarchy bar plugin for [Port Kill](https://github.com/treadiehq/port-kill).
See which processes are using development ports, stop them from the menu,
and open the terminal monitor with a right-click.

![Port Kill bar icon and menu with example development servers](preview.png)

## Requirements

- [Omarchy Quattro](https://omarchy.org/) with a configured terminal.
- Port Kill, installed using its [official installer](https://github.com/treadiehq/port-kill#install).
- Python 3.9 or newer with Linux pidfd support.
- `flock`, `xdg-terminal-exec`, and `hyprctl`, included with Omarchy.
- `lsof`, installed separately:

  ```bash
  sudo pacman -S lsof
  ```

## Install

```bash
omarchy plugin add https://github.com/jesusarchive/omarchy-port-kill.git --enable
```

By default, **Always active** monitors ports and shows the icon without a
terminal. Right-click the icon to open logs. The launcher and Bash integration
below are optional. Set up either one if you choose **Follow terminal** in
[Settings](#settings).

### App launcher

Add a launcher entry, replacing any existing entry named Port Kill:

```bash
omarchy tui install "Port Kill" "bash $HOME/.config/omarchy/plugins/jesusarchive.port-kill/portkill.sh launch" float \
  https://raw.githubusercontent.com/treadiehq/port-kill/main/assets/port-kill.png
```

### Bash integration

This optional integration lets the plugin track Port Kill monitors you start
by typing `port-kill` or `port-kill-console` in Bash. In **Follow terminal**
mode, those sessions keep the bar icon active. It also lets right-click reuse
a terminal you started yourself.

Add this line to `~/.bashrc` so each new Bash terminal loads the integration:

```bash
[[ -r "$HOME/.config/omarchy/plugins/jesusarchive.port-kill/port-kill.bash" ]] && source "$HOME/.config/omarchy/plugins/jesusarchive.port-kill/port-kill.bash"
```

`[[ -r ... ]]` checks that the integration file exists and is readable.
`&& source ...` loads it into the current shell only when that check succeeds,
so removing the plugin will not cause an error when you open a terminal.

The file defines Bash functions for `port-kill` and `port-kill-console`.
They call your installed binaries with the arguments you provide and notify
the plugin when a monitor starts or exits. Loading the file does not launch a
monitor; that happens when you run one of the commands.

Open a new terminal after saving `~/.bashrc`, or run the same line once in an
existing Bash terminal. To remove the integration, delete the line from
`~/.bashrc` and open a new terminal.

## Use

Left-click the icon to open the menu. Right-click to open activity logs or
focus an existing Port Kill terminal. Repeated right-clicks reuse that window.
During a refresh, right-click still opens logs.
Right-click does nothing when required dependencies are missing.

![Port Kill terminal monitor](assets/terminal.png)

| Menu item | Action |
| --- | --- |
| Kill All Processes | Stop processes listening on ports 2000 through 9000. |
| Kill: Port N: process | Ask Port Kill to free that port. |
| Quit | Stop monitoring, close terminals tracked by the plugin, and hide the icon. Development servers keep running. |

Kill actions run immediately, without confirmation or automatic retries.
They target the processes using the port at that moment. Stopping a process
also closes any other ports it owns.

The icon's center is green for no processes, orange for 1 to 9, and red for
10 or more. Grey indicates startup, a monitoring error, or a failed port action.
Hover over the icon for details. Kill actions are unavailable while the list is
refreshing or invalid.

## Settings

Configure the plugin with Omarchy's bar settings commands:

| Setting | Options |
| --- | --- |
| When to monitor | **Always active** (default) monitors without a terminal. **Follow terminal** monitors while a tracked Port Kill terminal is running. |
| Check interval | How often the bar checks for port changes. Default: **2 seconds**; range: 1 to 300. |

Switch to **Always active**:

```bash
omarchy bar set jesusarchive.port-kill monitoringMode always
```

Switch to **Follow terminal**:

```bash
omarchy bar set jesusarchive.port-kill monitoringMode terminal
```

Changes are saved and take effect immediately. In Follow terminal mode, the
icon stays hidden until you start Port Kill through the launcher or Bash integration.

Closing the last tracked terminal stops Follow terminal mode. In Always active
mode, closing a terminal leaves monitoring and the icon running. A separate log
window opened by right-click does not keep Follow terminal mode active on its own.

Quit stops either mode. To resume, launch Port Kill through an integration
above, change monitoring mode, or reload the plugin. If Quit fails, the icon
stays visible with an error so you can retry.

Commands such as `port-kill 3000`, `port-kill --json`, and `port-kill --kill-all`
run once and do not activate Follow terminal mode. Filters such as `--ports 3000` apply
only to that terminal. The bar continues to use ports 2000 through 9000.

## Keyboard controls

| Key | Action |
| --- | --- |
| Up / Down or `k` / `j` | Move through the menu |
| Enter / Space | Activate the selected item |
| `r` | Refresh the list |
| Tab / Shift+Tab | Switch to the next / previous bar panel |
| Escape | Close the menu |

## Troubleshooting

- Missing dependencies leave the icon grey and port actions disabled. Check the
  requirements above. Actions become available when dependencies are restored.
  Follow terminal mode still needs a tracked terminal to be active.
- If right-click does not open logs, check your terminal and
  `port-kill-console` installation. An existing terminal that cannot be
  identified reports an error rather than opening a duplicate.
- If an action fails, read the tooltip, check the requirements, and retry once
  the list has refreshed.

## Update

```bash
omarchy plugin update jesusarchive.port-kill
```

Saved settings are preserved.
If an older launcher runs `port-kill-console` directly, recreate it using the
command above to enable terminal tracking.

## Remove

```bash
omarchy plugin remove jesusarchive.port-kill
```

If you added the Bash integration, remove its line from `~/.bashrc` and open a
new terminal. The launcher depends on the plugin, so remove it too:

```bash
omarchy tui remove "Port Kill"
```

Port Kill itself remains installed and can still be used from a terminal.

## Development

See the [developer guide](docs/development.md) for implementation details,
advanced terminal setup, and tests.

## License

[MIT](LICENSE). Port Kill is a separate project by Treadie under the
FSL-1.1-MIT license.
