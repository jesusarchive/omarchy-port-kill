#!/usr/bin/env bash

# Run Port Kill for the bar widget. Port Kill does the port scan and the
# SIGTERM/SIGKILL sequence; this script finds the binary, registers terminal
# monitors so the bar can show its icon, and bounds background commands.
#
#   portkill.sh launch                  Run a registered port-kill-console monitor
#   portkill.sh run <binary> [args...]  Run port-kill or port-kill-console; register
#                                       it only when the arguments start a monitor
#   portkill.sh list                    Print one scan's stdout
#   portkill.sh kill <port>
#   portkill.sh kill-all
#   portkill.sh quit                    Stop registered monitors
#   portkill.sh watch [interval] [mode] Report monitors and socket changes
#   portkill.sh logs                    Own a log terminal until stdin closes
#
# Exit codes: 0 ok, 1 Port Kill failed, 2 usage, 3 Port Kill or Python
# missing, 4 lsof missing, 6 Port Kill timed out.

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-2}"
}

script_dir=.
[[ ${BASH_SOURCE[0]} == */* ]] && script_dir=${BASH_SOURCE[0]%/*}

# Port Kill's installer puts its binaries in ~/.local/bin. Search there without
# exporting a changed PATH, so the console inherits the caller's environment.
find_binary() {
  PATH="$HOME/.local/bin:$PATH" type -P "$1"
}

require_backend() {
  port_kill=${PORT_KILL_CONSOLE:-$(find_binary port-kill-console)}
  [[ -n $port_kill && -x $port_kill ]] || die "Port Kill is not installed" 3
  command -v lsof >/dev/null || die "Port Kill needs lsof" 4
}

# Background commands get a deadline. timeout signals its whole process
# group, so lsof children stop with Port Kill. Scans keep stdout for the bar;
# actions discard it.
#
#   run_bounded <seconds> <keep|drop> <failure message> <args...>
run_bounded() {
  local limit=$1 output=$2 message=$3 status
  shift 3
  if [[ $output == keep ]]; then
    LC_ALL=C RUST_LOG=error timeout --kill-after=2s "$limit" "$port_kill" "$@" 2>/dev/null &
  else
    LC_ALL=C RUST_LOG=error timeout --kill-after=2s "$limit" "$port_kill" "$@" >/dev/null 2>&1 &
  fi
  local bounded_pid=$!
  # Quickshell signals this wrapper on cancellation. Forward to timeout,
  # which owns the backend process group and enforces its kill grace.
  trap 'trap "" TERM HUP INT; kill -TERM "$bounded_pid" 2>/dev/null; wait "$bounded_pid"; exit 143' TERM HUP INT
  wait "$bounded_pid"
  status=$?
  trap - TERM HUP INT
  ((status == 124 || status == 137)) && die "Port Kill did not finish within $limit seconds" 6
  ((status == 0)) || die "$message" 1
}

state_dir() {
  printf '%s\n' "${PORT_KILL_STATE_DIR:-${XDG_RUNTIME_DIR:-/run/user/$UID}/omarchy-port-kill}"
}

notify_bar() {
  local attempt
  # A shell that is starting answers "not ready" and reconciles on its own
  # once it is up, so a few quick retries cover the gap.
  for attempt in 1 2 3; do
    omarchy-shell jesusarchive.port-kill.service "$@" >/dev/null 2>&1 && return
    sleep 0.5
  done
}

# Monitor options accepted by Port Kill 0.5. Everything else, including
# positional ports, --json, --kill-all, --list and help, is a one-shot
# command and runs unregistered.
starts_monitor() {
  while (($#)); do
    case $1 in
      -c|--console|-v|--verbose|-d|--docker|-P|--show-pid|--smart-filter|--performance|--show-context) ;;
      -s|--start-port|-e|--end-port|-p|--ports|--ignore-ports|--ignore-processes|--ignore-patterns|--ignore-groups|--only-groups|--log-level|--preset)
        (($# >= 2)) || return 1
        shift
        ;;
      --start-port=*|--end-port=*|--ports=*|--ignore-ports=*|--ignore-processes=*|--ignore-patterns=*|--ignore-groups=*|--only-groups=*|--log-level=*|--preset=*) ;;
      *) return 1 ;;
    esac
    shift
  done
}

# Run a monitor in the foreground and register it while it runs. A subshell
# writes a lease with its own PID and start time and then execs Port Kill, so
# the lease names the monitor process. It keeps the terminal, environment and
# signals; the parent only waits, removes the lease and passes on the status.
run_monitor() {
  command -v flock >/dev/null || die "Port Kill needs flock to track monitors" 3
  local binary=$1 leases status signal=""
  shift
  leases=$(state_dir)/monitors
  if ! mkdir -p -m 700 "$leases" 2>/dev/null; then
    exec "$binary" "$@"
  fi
  # Record terminal signals instead of dying before cleanup. exec resets these
  # handlers, so Port Kill still receives the signals with default handling.
  trap 'signal=INT' INT
  trap 'signal=TERM' TERM
  trap 'signal=HUP' HUP
  # Bash otherwise prints the entire subshell when Quit terminates it.
  # Silence only that parent-shell notice; the backend keeps the real stderr.
  local monitor_stderr
  exec {monitor_stderr}>&2
  {
    (
      stat=$(<"/proc/$BASHPID/stat")
      read -ra fields <<<"${stat##*) }"
      lease=$leases/$BASHPID.${fields[19]}
      {
        flock -x 9 || exit 1
        generation_file=$(state_dir)/generation
        generation=""
        [[ -r $generation_file ]] && generation=$(<"$generation_file")
        printf '%s\n' "$generation" >"$lease"
      } 9>"$(state_dir)/registration.lock"
      # Detach the notification so it neither delays Port Kill nor becomes its
      # child.
      (notify_bar started "${lease##*/}" </dev/null >/dev/null 2>&1 &)
      # Undo this script's own SHLVL increment.
      if ((SHLVL > 1)); then
        export SHLVL=$((SHLVL - 1))
      else
        unset SHLVL
      fi
      exec "$binary" "$@"
    ) 2>&"$monitor_stderr" {monitor_stderr}>&-
    status=$?
  } 2>/dev/null
  exec {monitor_stderr}>&-
  case $status in
    129|130|143) ;; # Expected HUP, Ctrl+C, or Quit.
    *) ((status > 128)) && printf 'Port Kill monitor exited with status %s\n' "$status" >&2 ;;
  esac
  cleanup_leases "$leases"
  # When Port Kill died from the terminal's signal, die from it too, as the
  # shell would report for Port Kill run directly.
  if [[ -n $signal ]] && ((status == 128 + $(kill -l "$signal"))); then
    trap - "$signal"
    kill -s "$signal" "$$"
  fi
  exit "$status"
}

# Remove leases of exited monitors, including this wrapper's. The watcher
# also removes them, and ignores any whose PID now names another process.
cleanup_leases() {
  local lease pid
  for lease in "$1"/*.*; do
    [[ -e $lease ]] || continue
    pid=${lease##*/}
    pid=${pid%%.*}
    [[ -r /proc/$pid/stat ]] && continue
    rm -f "$lease"
  done
}

action=${1:-}
case $action in
  logs-focus)
    (($# == 1)) || die "Usage: portkill.sh logs-focus"
    exec python3 "$script_dir/terminal_logs.py" focus
    ;;
  logs)
    (($# == 1)) || die "Usage: portkill.sh logs"
    require_backend
    command -v python3 >/dev/null || die "Port Kill needs Python 3 for terminal logs" 3
    command -v xdg-terminal-exec >/dev/null || die "Port Kill needs xdg-terminal-exec to open a terminal" 3
    exec python3 "$script_dir/terminal_logs.py" own "$port_kill"
    ;;
  launch)
    (($# == 1)) || die "Usage: portkill.sh launch"
    require_backend
    run_monitor "$port_kill"
    ;;
  run)
    (($# >= 2)) || die "Usage: portkill.sh run <port-kill|port-kill-console> [args...]"
    [[ $2 == port-kill || $2 == port-kill-console ]] || die "Usage: portkill.sh run <port-kill|port-kill-console> [args...]"
    binary=$(find_binary "$2") || die "$2 is not installed" 127
    shift 2
    starts_monitor "$@" || exec "$binary" "$@"
    run_monitor "$binary" "$@"
    ;;
  list)
    (($# == 1)) || die "Usage: portkill.sh list"
    require_backend
    # The bar parses stdout, including Port Kill's log lines, and reports
    # anything it does not recognize.
    run_bounded "${PORT_KILL_SCAN_TIMEOUT:-10}" keep "Port Kill could not list ports" --json
    ;;
  kill)
    (($# == 2)) || die "Usage: portkill.sh kill <port>"
    port=$2
    [[ $port =~ ^[0-9]{1,5}$ ]] || die "Invalid port: $port"
    port=$((10#$port))
    ((port >= 1 && port <= 65535)) || die "Invalid port: $2"
    require_backend
    run_bounded "${PORT_KILL_ACTION_TIMEOUT:-20}" drop "Port Kill could not stop port $port" --ports "$port" --kill-all
    ;;
  kill-all)
    (($# == 1)) || die "Usage: portkill.sh kill-all"
    require_backend
    run_bounded "${PORT_KILL_ACTION_TIMEOUT:-20}" drop "Port Kill could not stop all processes" --kill-all
    ;;
  verify-start)
    (($# == 3)) || die "Usage: portkill.sh verify-start <lease> <generation>"
    exec python3 "$script_dir/monitors.py" verify-start "$2" "$3"
    ;;
  quit-session)
    (($# == 2)) || die "Usage: portkill.sh quit-session <generation>"
    exec python3 "$script_dir/monitors.py" quit "$2"
    ;;
  quit | watch)
    if [[ $action == quit ]]; then
      (($# == 1)) || die "Usage: portkill.sh quit"
    else
      (($# <= 3)) || die "Usage: portkill.sh watch [interval] [terminal|always]"
      [[ ${3:-terminal} == terminal || ${3:-terminal} == always ]] || die "Invalid monitoring mode: $3"
    fi
    command -v python3 >/dev/null || die "Port Kill needs Python 3 to track monitors" 3
    shift
    exec python3 "$script_dir/monitors.py" "$action" "$@"
    ;;
  *)
    die "Unknown action: $action"
    ;;
esac
