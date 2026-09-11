#!/usr/bin/env bash

# Lists listening sockets for the Port Killer panel, one tagged line each:
#
#   S<TAB><ss line>                          every listening TCP/UDP socket
#   P<TAB>pid<TAB>elapsed<TAB>cwd<TAB>args    every process ss could attribute
#   U<TAB>uid<TAB>name                        owner names for socket uids
#
# Model.js parses this. ss only attributes sockets to processes the caller can
# inspect, so rows without a pid belong to root or another user.

set -o pipefail

sockets=$(ss -H -l -n -p -e -t -u) || exit 1
[[ -n $sockets ]] || exit 0

sed 's/^/S\t/' <<<"$sockets"

clean() { tr '\0\t\n' '   ' | sed 's/ *$//'; }

pids=$(grep -o 'pid=[0-9]*' <<<"$sockets" | cut -d= -f2 | sort -un)
if [[ -n $pids ]]; then
  declare -A elapsed
  while read -r pid secs; do
    elapsed[$pid]=$secs
  done < <(ps -o pid=,etimes= -p "${pids//$'\n'/,}")

  for pid in $pids; do
    [[ -r /proc/$pid/cmdline ]] || continue
    cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null | clean)
    args=$(clean 2>/dev/null <"/proc/$pid/cmdline")
    printf 'P\t%s\t%s\t%s\t%s\n' "$pid" "${elapsed[$pid]:-}" "$cwd" "$args"
  done
fi

# ss omits uid:0, so always resolve root alongside the uids it did print.
uids=$( (echo 0; grep -o 'uid:[0-9]*' <<<"$sockets" | cut -d: -f2) | sort -un)
getent passwd $uids | awk -F: '{ printf "U\t%s\t%s\n", $3, $1 }'
exit 0
