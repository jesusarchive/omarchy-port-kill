#!/usr/bin/env bash

# Signal current-user processes listening on one port or across the Port Kill
# development range.
#
#   kill.sh <TERM|KILL> port <port>
#   kill.sh <TERM|KILL> all [start-port] [end-port]
#
# The script scans before every action, then checks process identity and socket
# ownership again before sending a signal. It skips processes owned by other
# users and never signals PID 1.

set -o pipefail
export LC_ALL=C

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-2}"
}

read_process() {
  local stat rest
  IFS= read -r stat <"/proc/$1/stat" 2>/dev/null || return 1
  rest=${stat##*) }
  read -r -a fields <<<"$rest"
  ((${#fields[@]} > 19)) || return 1
  PROCESS_STATE=${fields[0]}
  PROCESS_START=${fields[19]}
}

same_process() {
  local pid=$1 expected_start=$2 expected_uid=$3 actual_uid
  [[ $pid != 1 && -d /proc/$pid ]] || return 1
  actual_uid=$(stat -c %u "/proc/$pid" 2>/dev/null) || return 1
  [[ $actual_uid == "$expected_uid" ]] || return 1
  read_process "$pid" || return 1
  [[ $PROCESS_START == "$expected_start" && $PROCESS_STATE != Z ]]
}

owns_socket() {
  local port=$1 pid=$2
  ss -H -l -n -p -t "sport = :$port" 2>/dev/null \
    | grep -o 'pid=[0-9]*' \
    | cut -d= -f2 \
    | grep -qx "$pid"
}

owns_socket_in_range() {
  local start=$1 end=$2 pid=$3 line port remaining
  while IFS= read -r line; do
    read -r -a fields <<<"$line"
    ((${#fields[@]} >= 5)) || continue
    port=${fields[3]##*:}
    [[ $port =~ ^[0-9]+$ ]] || continue
    ((port >= start && port <= end)) || continue
    remaining=$line
    while [[ $remaining =~ pid=([0-9]+) ]]; do
      [[ ${BASH_REMATCH[1]} == "$pid" ]] && return 0
      remaining=${remaining#*"pid=${BASH_REMATCH[1]}"}
    done
  done < <(ss -H -l -n -p -t 2>/dev/null)
  return 1
}

wait_for_exit() {
  local attempts=$1 pid start uid alive target attempt
  shift
  for ((attempt=0; attempt<attempts; attempt++)); do
    alive=0
    for target in "$@"; do
      IFS=: read -r pid start uid <<<"$target"
      if same_process "$pid" "$start" "$uid"; then alive=1; fi
    done
    ((alive == 0)) && return 0
    sleep 0.1
  done
  return 1
}

signal=${1:-}
[[ $signal == TERM || $signal == KILL ]] || die "Unknown signal: $signal"
shift
(($# > 0)) || die "No action given"

current_uid=$(id -u)
declare -a selected=()
declare -A selected_pids=()
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
action=$1
shift

case $action in
  port)
    (($# == 1)) || die "Usage: kill.sh $signal port <port>"
    target_port=$1
    [[ $target_port =~ ^[0-9]+$ ]] || die "Invalid port: $target_port"
    ((target_port >= 1 && target_port <= 65535)) || die "Invalid port: $target_port"
    range_start=$target_port
    range_end=$target_port
    ;;
  all)
    (($# <= 2)) || die "Usage: kill.sh $signal all [start-port] [end-port]"
    range_start=${1:-2000}
    range_end=${2:-9000}
    [[ $range_start =~ ^[0-9]+$ && $range_end =~ ^[0-9]+$ ]] || die "Invalid port range"
    ((range_start >= 1 && range_end <= 65535 && range_start <= range_end)) || die "Invalid port range"
    ;;
  *)
    die "Unknown action: $action"
    ;;
esac

scan_output=$(bash "$script_dir/scan.sh" "$range_start" "$range_end") || die "Could not scan listening ports" 1
while IFS=$'\t' read -r tag pid start uid; do
  [[ $tag == P ]] || continue
  [[ $pid =~ ^[0-9]+$ && $start =~ ^[0-9]+$ && $uid =~ ^[0-9]+$ ]] || continue
  [[ $pid != 1 && $uid == "$current_uid" ]] || continue
  same_process "$pid" "$start" "$uid" || continue
  if [[ ! -v selected_pids[$pid] ]]; then
    selected_pids[$pid]=1
    selected+=("$pid:$start:$uid")
  fi
done <<<"$scan_output"

if ((${#selected[@]} == 0)); then
  [[ $action == all ]] && exit 0
  die "No current-user process is listening on port $target_port" 3
fi

signalled=0
for target in "${selected[@]}"; do
  IFS=: read -r pid start uid <<<"$target"
  same_process "$pid" "$start" "$uid" || continue
  if [[ $action == port ]]; then
    owns_socket "$target_port" "$pid" || continue
  else
    owns_socket_in_range "$range_start" "$range_end" "$pid" || continue
  fi
  if kill -"$signal" "$pid" 2>/dev/null; then
    signalled=1
  elif same_process "$pid" "$start" "$uid"; then
    die "Not allowed to signal PID $pid" 1
  fi
done
((signalled == 1)) || die "No matching process remained to signal" 3

if [[ $signal == TERM ]]; then
  if ! wait_for_exit 30 "${selected[@]}"; then
    for target in "${selected[@]}"; do
      IFS=: read -r pid start uid <<<"$target"
      same_process "$pid" "$start" "$uid" && kill -KILL "$pid" 2>/dev/null
    done
  fi
fi

if ! wait_for_exit 10 "${selected[@]}"; then
  die "One or more processes did not exit" 1
fi
