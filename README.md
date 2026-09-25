# Port Kill for Omarchy

![Port Kill's bar menu next to Port Kill running in a terminal](preview.png)

View and stop development processes from the Omarchy bar with
[Port Kill](https://portkill.com/). Start `port-kill-console` in a terminal
or from the app launcher to show the icon. The menu lists its processes on
ports 2000 through 9000 and lets you stop one port or all of them.

This is an independent integration. Port Kill handles scanning and stopping
processes. This plugin adds the bar
icon and menu; it does not install or start Port Kill for you.

## Requirements

- Omarchy with the shell plugin system.
- [Port Kill](https://portkill.com/), installed with its official installer:

  ```bash
  curl -fsSL https://portkill.com/install | bash
  ```

- `lsof`, which Port Kill uses to find listening processes. Omarchy doesn't
  include it, and Port Kill's installer doesn't install it:

  ```bash
  sudo pacman -S lsof
  ```

Optionally, add Port Kill to the app launcher (Super + Space):

```bash
omarchy tui install "Port Kill" port-kill-console float \
  https://raw.githubusercontent.com/treadiehq/port-kill/main/assets/port-kill.png
```

## Install

```bash
omarchy plugin add https://github.com/jesusarchive/omarchy-port-kill.git --enable
```

After `omarchy plugin update`, run `omarchy restart shell` so the shell loads
every updated file.

## Use

Start Port Kill from a terminal with `port-kill-console`, or pick Port Kill in
the app launcher. The icon appears in the bar within a couple of seconds, and
the terminal prints Port Kill's port status as it changes. Choose `Quit` in the
menu, close the terminal, or press Ctrl+C to stop Port Kill; the icon
disappears with it.

![The Port Kill menu with three development ports](assets/menu.png)

The icon follows Port Kill's status icon. The center is green when nothing is
running, orange for 1 to 9 processes, and red for 10 or more. It turns grey
when a dependency is missing or a command fails; hover it to read the error.

- Left-click the icon to open or close the menu.
- Right-click the icon to refresh the list.
- Choose `Kill All Processes` to stop every process Port Kill finds on ports
  2000 through 9000.
- Choose `Kill: Port N: process` to stop the process on that port.
- Choose `Quit` to stop Port Kill, like Ctrl+C in its terminal.

Keyboard controls follow Omarchy's built-in panels:

| Key | Action |
| --- | --- |
| Up / Down or `k` / `j` | Move through the menu |
| Enter / Space | Activate the selected item |
| `x` | Stop the selected port, with no action on Kill All or Quit |
| `a` | Stop all listed processes |
| `r` | Refresh the list |
| Tab / Shift+Tab | Switch to the next / previous bar panel |
| Escape | Close the menu |

Stopping a port stops the processes listening on it, which also closes any
other ports they own. These actions run immediately, without confirmation.
`Quit` stops your running Port Kill monitors but leaves development processes
running.

The terminal logs changes made from the menu:

![Port Kill's terminal log picking up a kill from the bar](assets/terminal.png)

To open the menu from a keybinding, toggle it over the shell's IPC:

```bash
qs -p /usr/share/omarchy/shell ipc call jesusarchive.port-kill toggle
```

The only setting is `refreshIntervalSec`, which defaults to two seconds, the
same interval as Port Kill's own monitor.

## Disable or remove

```bash
omarchy plugin disable jesusarchive.port-kill
omarchy plugin remove jesusarchive.port-kill
```

Removing the plugin leaves Port Kill installed. To remove Port Kill and its
launcher entry:

```bash
omarchy tui remove "Port Kill"
rm ~/.local/bin/port-kill ~/.local/bin/port-kill-console
```

## Development

```bash
node --test tests/*.test.js
omarchy plugin validate .
```

`portkill.sh` checks for a running Port Kill monitor, then runs
`port-kill-console --json` and returns its records. `Model.js`
parses and formats the records, `Service.qml` polls the backend, and
`Panel.qml` renders the menu using Omarchy's shared panel components.

The default tests use fake binaries and isolated monitor discovery. To test
with installed copies of Port Kill and `lsof`, run:

```bash
PORT_KILL_INTEGRATION=1 node --test tests/*.test.js
```

The integration test starts its own monitor and listener on an available port
between 8900 and 8999, verifies discovery, and stops that listener.

## License

MIT. Port Kill is a separate project by Treadie under the FSL-1.1-MIT license.
