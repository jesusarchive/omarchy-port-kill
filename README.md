# Port Killer for Omarchy

![Port Killer's bar menu next to Port Kill running in a terminal](preview.png)

An Omarchy bar menu for [Port Kill](https://portkill.com/). Run Port Kill from
a terminal or the app launcher, and its status icon appears in the bar, as it
does in the macOS status bar. The terminal shows Port Kill's live log; the bar
menu lists the processes it finds on development ports and stops them.

Port Kill does the scanning and killing. This plugin gives it the same compact
menu it has on macOS, built from Omarchy shell components.

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
omarchy plugin add https://github.com/jesusarchive/omarchy-port-killer.git --enable
```

After `omarchy plugin update`, run `omarchy-restart-shell` so the shell loads
every updated file.

## Use

Start Port Kill from a terminal with `port-kill-console`, or pick Port Kill in
the app launcher. The icon appears in the bar within a couple of seconds, and
the terminal prints Port Kill's port status as it changes. Choose `Quit` in the
menu, close the terminal, or press Ctrl+C to stop Port Kill; the icon
disappears with it.

![Port Kill's terminal log picking up a kill from the bar](assets/terminal.png)

![The Port Killer menu with three development ports](assets/menu.png)

The icon follows Port Kill's status icon. The center is green when nothing is
running, orange for 1 to 9 processes, and red for 10 or more. It turns grey
if `port-kill-console` or `lsof` is missing; hover it to see which.

- Left-click the icon to open or close the menu.
- Right-click the icon to refresh the list.
- Choose `Kill All Processes` to stop every process Port Kill finds on ports
  2000 through 9000.
- Choose `Kill: Port N: process` to stop the process on that port.
- Choose `Quit` to stop Port Kill, like Ctrl+C in its terminal.
- Use the arrow keys or `j` and `k` to move, and Enter or Delete to select.
- Press `a` for kill all, `r` to refresh, or Escape to close.

To open the menu from a keybinding, toggle it over the shell's IPC:

```bash
qs -p /usr/share/omarchy/shell ipc call jesusarchive.port-killer toggle
```

The only setting is `refreshIntervalSec`, which defaults to two seconds, the
same interval as Port Kill's own monitor.

## Disable or remove

```bash
omarchy plugin disable jesusarchive.port-killer
omarchy plugin remove jesusarchive.port-killer
```

Removing the plugin leaves Port Kill installed. To remove Port Kill and its
launcher entry:

```bash
omarchy tui remove "Port Kill"
rm ~/.local/bin/port-kill ~/.local/bin/port-kill-console
```

## Development

```bash
node --test tests/
omarchy plugin validate .
```

`portkill.sh` checks for a running Port Kill monitor, then runs
`port-kill-console --json` and returns its records. `Model.js`
parses them and formats the menu, and `Panel.qml` renders it. The tests use a
fake Port Kill, plus one live test that runs when Port Kill and `lsof` are
installed.

## License

MIT. Port Kill is a separate project by Treadie under the FSL-1.1-MIT license.
