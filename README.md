# Port Killer for Omarchy

An Omarchy bar menu for finding and stopping processes that listen on
development ports.

It copies the compact menu layout from
[treadiehq/port-kill](https://github.com/treadiehq/port-kill) and uses Omarchy
shell components.

## What it does

- Lists TCP listeners owned by the current user on ports 2000 through 9000,
  matching Port Kill's default range.
- Shows one menu item per port.
- Kills the process on one selected port or all matching processes in the
  scanned range.
- Sends SIGTERM, waits up to three seconds, then sends SIGKILL if needed.
- Checks the process identity and socket ownership again before sending a
  signal.

It only handles TCP listeners owned by the current user. It does not use
`pkexec`, open URLs, or manage containers and services.

## Install

```bash
omarchy plugin add https://github.com/jesusarchive/omarchy-port-killer.git --enable
```

The widget lands in the right section of the bar. Move it with:

```bash
omarchy bar move jesusarchive.port-killer --section <left|center|right>
```

For a manual install, copy this folder to
`~/.config/omarchy/plugins/jesusarchive.port-killer/`. Then run
`omarchy plugin enable jesusarchive.port-killer`.

## Use

- Left-click `ports N` in the bar to open or close the menu.
- Right-click `ports N` to refresh the list.
- Choose `Kill All Processes` to kill all matching processes immediately.
- Choose `Kill: Port N: process` to kill the process listening on that port.
- Use the arrow keys or `j` and `k` to move, and Enter to select.
- Press `a` for kill all, `r` to refresh, or Escape to close.

The only setting is `refreshIntervalSec`, which defaults to five seconds.

## Safety model

The menu reads the current socket list. Each kill action scans again before
`kill.sh` sends a signal. The script checks that:

- the PID is not 1
- the UID matches the current user
- the process start time has not changed
- the process still owns the selected listening socket

Single-port kill scans that port again. Kill all rescans the full 2000 through
9000 range. Both actions deduplicate processes that listen on several ports.

The scripts never use `eval`, interpolate a command string, or run as root.

## Development

```bash
node --test tests/
omarchy plugin validate .
```

QML renders the panel. JavaScript parses the scan output and formats the menu.
The Bash scripts inspect `ss` and `/proc`, then send the signals.

## License

MIT
