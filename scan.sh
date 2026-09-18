#!/usr/bin/env bash

# List TCP listeners owned by the current user in the requested port range.
# Port Kill defaults to development ports 2000 through 9000. Model.js parses
# two tagged record types:
#
#   S<TAB><ss line>
#   P<TAB>pid<TAB>start-time<TAB>uid

set -o pipefail
export LC_ALL=C

start_port=${1:-2000}
end_port=${2:-9000}

[[ $start_port =~ ^[0-9]+$ && $end_port =~ ^[0-9]+$ ]] || {
  printf 'Invalid port range\n' >&2
  exit 2
}
((start_port >= 1 && end_port <= 65535 && start_port <= end_port)) || {
  printf 'Invalid port range\n' >&2
  exit 2
}

process_start_time() {
  local stat rest
  IFS= read -r stat <"/proc/$1/stat" || return 1
  rest=${stat##*) }
  read -r -a fields <<<"$rest"
  ((${#fields[@]} > 19)) || return 1
  printf '%s\n' "${fields[19]}"
}

sockets=$(ss -H -l -n -p -t) || exit 1
[[ -n $sockets ]] || exit 0

declare -A socket_pids=()
while IFS= read -r line; do
  read -r -a fields <<<"$line"
  ((${#fields[@]} >= 5)) || continue
  port=${fields[3]##*:}
  [[ $port =~ ^[0-9]+$ ]] || continue
  ((port >= start_port && port <= end_port)) || continue

  printf 'S\t%s\n' "$line"
  remaining=$line
  while [[ $remaining =~ pid=([0-9]+) ]]; do
    pid=${BASH_REMATCH[1]}
    socket_pids[$pid]=1
    remaining=${remaining#*"pid=$pid"}
  done
done <<<"$sockets"

current_uid=$(id -u)
for pid in "${!socket_pids[@]}"; do
  [[ $pid =~ ^[0-9]+$ && $pid != 1 ]] || continue
  [[ -r /proc/$pid/stat ]] || continue
  uid=$(stat -c %u "/proc/$pid" 2>/dev/null) || continue
  [[ $uid == "$current_uid" ]] || continue
  start_time=$(process_start_time "$pid") || continue
  printf 'P\t%s\t%s\t%s\n' "$pid" "$start_time" "$uid"
done
