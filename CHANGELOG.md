# Changelog

## Unreleased

These changes target plugin version 0.4.0.

### Monitoring and controls

- Keep the icon grey and port actions disabled when dependencies are missing,
  without dependency messages in the menu or tooltip. Right-click does nothing
  while dependencies are missing. Missing dependencies retry in both modes.
- Remove the right-click menu fallback. Repeated clicks during terminal startup
  reuse the pending controller.
- Plugin-opened terminals now default to quieter logging while retaining
  process-status output, warnings, and errors. Explicit logging preferences and
  manually entered commands keep their behavior. The menu retains Omarchy styling.
- Added Follow terminal and Always active modes in plugin settings. Follow
  terminal is the default; saved mode and check-interval choices are preserved.
- Added optional Bash integration and a registered app-launcher command.
  Interactive monitors activate Follow terminal mode; one-shot commands do not.
- Added right-click access to activity logs. Existing registered TUIs receive
  focus; repeated requests reuse the log window. Ambiguous windows report an
  error without opening a duplicate.
- Closing a TUI leaves Always active monitoring running. Quit stops registered
  monitors and the plugin-created log window in either mode, then hides the icon.
  Development servers keep running.
- Kept the status colors, menu dividers, Quit item, and tooltip without an added
  right-click hint. Preferences remain in plugin settings, with no log toggle.

### Lifecycle and failure handling

- Extracted QML log-window control and shared command watchdogs. Split Python
  terminal startup and cleanup into context managers, including cleanup when
  backend pidfd creation fails. Monitoring modes and port actions are unchanged.
- Removed Bash's internal command dump when Quit terminates a registered
  monitor. Backend diagnostics and exit status are preserved; other abnormal
  exits retain a short status message.
- Disabled Python bytecode writes in the log helper. The first right-click no
  longer creates a cache file inside the plugin directory and triggers Omarchy's
  plugin hot reload.
- Replaced monitor process-name matching with registered process identities and
  Linux pidfds. The watcher discovers existing monitors after a shell restart.
- Added session generations so delayed launch notifications cannot undo Quit.
- Quit now waits for cleanup, escalates unresponsive registered monitors from
  TERM to KILL, and keeps failures visible with a retry action.
- Log windows now supervise their backend and clean it up when the display or
  controller exits. Terminal startup has a deadline.
- Window focusing now prefers the nearest terminal ancestor over an editor
  ancestor.
- Added socket-change detection, serialized scans, automatic scan retries,
  command deadlines, and rejection of results made obsolete by an action.
- Added script, scheduler, monitor, terminal, and QML lifecycle regression tests,
  an opt-in real-backend test, and a CPU measurement tool.

A reported kitty shutdown crash was not reproduced in six real terminal close
tests. These changes fix confirmed plugin lifecycle defects; they do not claim
to fix the underlying kitty/Python memory fault. Crash notifications remain
unchanged.
