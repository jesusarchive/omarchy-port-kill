#!/usr/bin/env bash

# Run Port Kill's console binary for the bar widget. Port Kill does the port
# scan and the SIGTERM/SIGKILL sequence; this script only finds the binary,
# checks that a Port Kill monitor is running, and strips log noise from the
# JSON output.
#
#   portkill.sh list
#   portkill.sh kill <port>
#   portkill.sh kill-all
#
# Exit codes: 0 ok, 1 Port Kill failed, 2 usage, 3 Port Kill missing,
# 4 lsof missing, 5 no Port Kill monitor running.

export LC_ALL=C
export RUST_LOG=error
# Port Kill's installer puts its binaries here.
export PATH="$HOME/.local/bin:$PATH"

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-2}"
}

# Port Kill runs as a monitor when started from a terminal or the launcher.
# One-shot calls, including the ones this script makes, don't count.
monitor_running() {
  local dir comm arg
  local -a argv
  for dir in /proc/[0-9]*; do
    IFS= read -r comm <"$dir/comm" 2>/dev/null || continue
    # The kernel truncates comm to 15 characters.
    [[ $comm == port-kill || $comm == port-kill-conso ]] || continue
    mapfile -d '' -t argv <"$dir/cmdline" 2>/dev/null || continue
    # Exited processes that haven't been reaped yet have an empty cmdline.
    ((${#argv[@]} > 0)) || continue
    for arg in "${argv[@]:1}"; do
      [[ $arg == --json || $arg == --kill-all ]] && continue 2
    done
    return 0
  done
  return 1
}

action=${1:-}
case $action in
  list)
    (($# == 1)) || die "Usage: portkill.sh list"
    monitor_running || die "Port Kill is not running" 5
    ;;
  kill)
    (($# == 2)) || die "Usage: portkill.sh kill <port>"
    port=$2
    [[ $port =~ ^[0-9]+$ ]] && ((port >= 1 && port <= 65535)) || die "Invalid port: $port"
    ;;
  kill-all)
    (($# == 1)) || die "Usage: portkill.sh kill-all"
    ;;
  *)
    die "Unknown action: $action"
    ;;
esac

port_kill=${PORT_KILL_CONSOLE:-$(command -v port-kill-console)}
[[ -n $port_kill && -x $port_kill ]] || die "Port Kill is not installed" 3
command -v lsof >/dev/null || die "Port Kill needs lsof" 4

case $action in
  list)
    output=$("$port_kill" --json 2>/dev/null) || die "Port Kill could not list ports" 1
    # Port Kill prints a DEBUG line to stdout before the JSON records.
    while IFS= read -r line; do
      [[ $line == "{"* ]] && printf '%s\n' "$line"
    done <<<"$output"
    ;;
  kill)
    "$port_kill" --ports "$port" --kill-all >/dev/null 2>&1 || die "Port Kill could not stop port $port" 1
    ;;
  kill-all)
    "$port_kill" --kill-all >/dev/null 2>&1 || die "Port Kill could not stop all processes" 1
    ;;
esac
