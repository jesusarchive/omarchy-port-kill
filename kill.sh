#!/usr/bin/env bash

# Frees a port or signals a set of pids for the Port Killer panel.
#
#   kill.sh port <tcp|udp> <port> <TERM|KILL>
#   kill.sh pids <TERM|KILL> <pid>...
#
# TERM waits up to 3 seconds for the processes to exit, then escalates to KILL.
# `port` resolves the pids at kill time, so a stale scan can't hit a reused pid.
# The panel runs it through pkexec for sockets owned by root or other users.
# PID 1 is never signalled: with socket activation, systemd holds the socket too.

signal_pids() {
  local sig=$1 alive p
  shift
  if ! kill -"$sig" "$@" 2>/dev/null; then
    # Some pids may simply have exited already; only fail if one is still there.
    for p in "$@"; do
      [[ -d /proc/$p ]] && { echo "Not allowed to signal pid $p" >&2; return 1; }
    done
    return 0
  fi
  [[ $sig == KILL ]] && return 0

  for _ in {1..30}; do
    alive=()
    for p in "$@"; do
      kill -0 "$p" 2>/dev/null && alive+=("$p")
    done
    ((${#alive[@]})) || return 0
    sleep 0.1
  done

  kill -KILL "${alive[@]}" 2>/dev/null
  return 0
}

valid_signal() {
  [[ $1 == TERM || $1 == KILL ]] || { echo "Unknown signal: $1" >&2; exit 2; }
}

case ${1:-} in
  port)
    proto=${2:-} port=${3:-} sig=${4:-}
    [[ $proto == tcp || $proto == udp ]] || { echo "Unknown protocol: $proto" >&2; exit 2; }
    [[ $port =~ ^[0-9]+$ ]] || { echo "Invalid port: $port" >&2; exit 2; }
    valid_signal "$sig"

    mapfile -t pids < <(ss -H -l -n -p "-${proto:0:1}" "sport = :$port" \
      | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -un | grep -vx 1)
    ((${#pids[@]})) || { echo "Nothing is listening on $proto/$port anymore" >&2; exit 3; }
    signal_pids "$sig" "${pids[@]}"
    ;;
  pids)
    sig=${2:-}
    valid_signal "$sig"
    shift 2
    for p in "$@"; do
      [[ $p =~ ^[0-9]+$ && $p != 1 ]] || { echo "Invalid pid: $p" >&2; exit 2; }
    done
    (($#)) || { echo "No pids given" >&2; exit 2; }
    signal_pids "$sig" "$@"
    ;;
  *)
    echo "Usage: kill.sh port <tcp|udp> <port> <TERM|KILL> | kill.sh pids <TERM|KILL> <pid>..." >&2
    exit 2
    ;;
esac
