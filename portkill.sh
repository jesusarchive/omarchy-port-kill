#!/usr/bin/env bash

# Run Port Kill's console binary for the bar widget. Port Kill does the port
# scan and the SIGTERM/SIGKILL sequence; this script only finds the binary,
# checks for running monitors, filters JSON output, and notifies the bar
# when the visible console starts or exits.
#
#   portkill.sh list
#   portkill.sh kill <port>
#   portkill.sh kill-all
#   portkill.sh quit
#   portkill.sh launch
#
# Exit codes: 0 ok, 1 Port Kill failed, 2 usage, 3 Port Kill missing,
# 4 lsof missing, 5 no Port Kill monitor running.

# Port Kill's installer puts its binaries here.
export PATH="$HOME/.local/bin:$PATH"

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-2}"
}

# Port Kill runs as a monitor when started from a terminal or the launcher.
# One-shot calls, including the ones this script makes, don't count. Prints the
# monitors' PIDs and fails when there are none.
monitor_pids() {
  local dir comm arg found=1
  local -a argv
  # Tests supply a private proc directory containing only their own monitor.
  for dir in "${PORT_KILL_PROC_ROOT:-/proc}"/[0-9]*; do
    [[ -O $dir ]] || continue
    IFS= read -r comm 2>/dev/null <"$dir/comm" || continue
    # The kernel truncates comm to 15 characters.
    [[ $comm == port-kill || $comm == port-kill-conso ]] || continue
    mapfile -d '' -t argv 2>/dev/null <"$dir/cmdline" || continue
    # Exited processes that haven't been reaped yet have an empty cmdline.
    ((${#argv[@]} > 0)) || continue
    for arg in "${argv[@]:1}"; do
      [[ $arg == --json || $arg == --kill-all ]] && continue 2
    done
    printf '%s\n' "${dir##*/}"
    found=0
  done
  return "$found"
}

require_backend() {
  port_kill=${PORT_KILL_CONSOLE:-$(command -v port-kill-console)}
  [[ -n $port_kill && -x $port_kill ]] || die "Port Kill is not installed" 3
  command -v lsof >/dev/null || die "Port Kill needs lsof" 4
}

# Only background commands override logging and locale. The visible console
# inherits the caller's environment and writes directly to the terminal.
run_background() {
  LC_ALL=C RUST_LOG=error "$port_kill" "$@"
}

notify_bar() {
  omarchy-shell -q jesusarchive.port-kill.service "$1" >/dev/null 2>&1 || true
}

action=${1:-}
case $action in
  launch)
    (($# == 1)) || die "Usage: portkill.sh launch"
    require_backend
    trap 'notify_bar refresh' EXIT
    notify_bar started
    "$port_kill"
    exit "$?"
    ;;
  list)
    (($# == 1)) || die "Usage: portkill.sh list"
    monitor_pids >/dev/null || die "Port Kill is not running" 5
    require_backend
    output=$(run_background --json 2>/dev/null) || die "Port Kill could not list ports" 1
    # Port Kill can mix log lines with its JSON records.
    while IFS= read -r line; do
      if [[ $line == "{"* ]]; then
        printf '%s\n' "$line"
      fi
    done <<<"$output"
    ;;
  kill)
    (($# == 2)) || die "Usage: portkill.sh kill <port>"
    port=$2
    [[ $port =~ ^[0-9]{1,5}$ ]] || die "Invalid port: $port"
    port=$((10#$port))
    ((port >= 1 && port <= 65535)) || die "Invalid port: $2"
    require_backend
    run_background --ports "$port" --kill-all >/dev/null 2>&1 || die "Port Kill could not stop port $port" 1
    ;;
  kill-all)
    (($# == 1)) || die "Usage: portkill.sh kill-all"
    require_backend
    run_background --kill-all >/dev/null 2>&1 || die "Port Kill could not stop all processes" 1
    ;;
  quit)
    (($# == 1)) || die "Usage: portkill.sh quit"
    command -v python3 >/dev/null || die "Port Kill needs Python 3 to stop monitors safely" 3
    script_dir=.
    [[ ${BASH_SOURCE[0]} == */* ]] && script_dir=${BASH_SOURCE[0]%/*}
    exec python3 "$script_dir/quit-monitors.py"
    ;;
  *)
    die "Unknown action: $action"
    ;;
esac
