// Test harness: runs Service.qml in its own Quickshell instance and exposes
// its state over IPC. tests/service.test.js copies this next to the plugin
// files; it is not part of the plugin.
import QtQuick
import Quickshell
import Quickshell.Io

ShellRoot {
  id: shell

  property var history: []
  property string mode: "terminal"

  function record(event) {
    var next = history.slice()
    next.push({
      at: Date.now(),
      event: event,
      active: ports.active,
      widgetVisible: ports.widgetVisible,
      status: ports.status,
      rows: ports.rows.map(function(row) { return row.key + ":" + row.name })
    })
    history = next
  }

  Service {
    id: ports
    settings: ({ refreshIntervalSec: 1, monitoringMode: shell.mode })
    scanTimeoutSec: 1
    actionTimeoutSec: 1
    watchdogGraceMs: 1000
    scheduleOptions: ({ minScanGapMs: 1500, maxAgeMs: 4000, retryBaseMs: 500, retryMaxMs: 2000 })
    onActiveChanged: shell.record("active")
    onWidgetVisibleChanged: shell.record("visible")
    onStatusChanged: shell.record("status")
    onRowsChanged: shell.record("rows")
    onActionErrorChanged: shell.record("actionError")
  }

  IpcHandler {
    target: "harness"
    function state(): string {
      return JSON.stringify({
        active: ports.active,
        widgetVisible: ports.widgetVisible,
        dependenciesAvailable: ports.dependenciesAvailable,
        monitoringMode: ports.monitoringMode,
        refreshing: ports.refreshing,
        monitorCount: ports.monitorCount,
        status: ports.status,
        stale: ports.stale,
        canAct: ports.canAct,
        busy: ports.busy,
        scanError: ports.scanError,
        actionError: ports.actionError,
        terminalError: ports.terminalError,
        socketError: ports.socketError,
        watchError: ports.watchError,
        rows: ports.rows,
        history: shell.history
      })
    }
    function mode(value: string): void { shell.mode = value }
    function debug(): void { ports.openTerminalLogs() }
    // Exercise a late backend result even when an action bypasses UI gating.
    function forceKill(port: int): void { ports.startAction(["bash", ports.portKillScript, "kill", String(port)]) }
    function open(): void { ports.refresh() }
    function kill(port: int): void { ports.kill({ port: port }) }
    function killAll(): void { ports.killAll() }
    function quit(): void { ports.quit() }
  }
}
