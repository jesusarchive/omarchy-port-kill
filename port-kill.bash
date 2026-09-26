# Opt-in Bash integration: typing port-kill or port-kill-console in an
# interactive shell shows the bar icon while the monitor runs. Source it from
# ~/.bashrc; delete that line to undo.
#
# These are shell functions, not files on PATH, so scripts and other programs
# keep running Port Kill directly, and portkill.sh finds the real binary with
# a PATH search that functions cannot shadow. One-shot commands such as
# `port-kill 3000` or `port-kill --json` run unchanged and never show the icon.

__omarchy_port_kill_script=${BASH_SOURCE[0]%/*}
[[ $__omarchy_port_kill_script == "${BASH_SOURCE[0]}" ]] && __omarchy_port_kill_script=.
__omarchy_port_kill_script="$(cd "$__omarchy_port_kill_script" && pwd)/portkill.sh"

__omarchy_port_kill_run() {
  if [[ -f $__omarchy_port_kill_script ]]; then
    bash "$__omarchy_port_kill_script" run "$@"
  else
    # The plugin was removed; behave as if this file was never sourced.
    command "$@"
  fi
}

port-kill() { __omarchy_port_kill_run port-kill "$@"; }
port-kill-console() { __omarchy_port_kill_run port-kill-console "$@"; }
