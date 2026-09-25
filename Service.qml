import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

Item {
  id: root

  property var settings: ({})
  property var rows: []
  // "stopped" (no Port Kill monitor), "ready", "missing" (no Port Kill),
  // "no-lsof", or "error".
  property string status: "stopped"

  readonly property int refreshIntervalSec: intSetting("refreshIntervalSec", 2, 1, 300)
  readonly property bool ready: status === "ready"
  readonly property bool running: status !== "stopped"
  readonly property bool busy: killProcess.running
  readonly property string portKillScript: localPath("portkill.sh")

  property string _scanOutput: ""
  property string _scanError: ""
  property string _killError: ""
  property string _signature: ""
  property string scanError: ""
  property string actionError: ""
  property int startupChecks: 0
  property bool refreshPending: false

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  function intSetting(name, fallback, min, max) {
    var value = parseInt(String(setting(name, fallback)), 10)
    if (!isFinite(value)) value = fallback
    return Math.max(min, Math.min(max, value))
  }

  function localPath(file) {
    return decodeURIComponent(String(Qt.resolvedUrl(file)).replace(/^file:\/\//, ""))
  }

  function refresh(queueIfBusy) {
    if (scanProcess.running) {
      if (queueIfBusy !== false) refreshPending = true
      return
    }
    refreshPending = false
    _scanOutput = ""
    _scanError = ""
    scanProcess.command = ["bash", portKillScript, "list"]
    scanProcess.running = true
  }

  function applyScan(raw) {
    var next = Model.parsePortKill(raw)
    var signature = JSON.stringify(next.map(function(row) {
      return [row.key, row.name, row.container]
    }))
    if (signature !== _signature) {
      _signature = signature
      rows = next
    }
    scanError = ""
    status = "ready"
    startupChecks = 0
  }

  function applyFailure(exitCode, stderr) {
    if (exitCode !== 5) startupChecks = 0
    status = exitCode === 5 ? "stopped"
      : exitCode === 3 ? "missing"
      : exitCode === 4 ? "no-lsof"
      : "error"
    _signature = ""
    rows = []
    scanError = elide(stderr || "Could not list listening ports")
    if (status === "error") console.warn("Port Kill: " + scanError)
  }

  function kill(row) {
    if (!row) return
    startKill(["bash", portKillScript, "kill", String(row.port)])
  }

  function killAll() {
    startKill(["bash", portKillScript, "kill-all"])
  }

  function quit() {
    startKill(["bash", portKillScript, "quit"])
  }

  function startKill(command) {
    if (killProcess.running) return
    _killError = ""
    actionError = ""
    killProcess.command = command
    killProcess.running = true
  }

  function elide(text) {
    var value = String(text || "").replace(/\s+/g, " ").trim()
    return value.length > 160 ? value.substring(0, 157) + "..." : value
  }

  onSettingsChanged: refresh()

  IpcHandler {
    target: "jesusarchive.port-kill.service"
    function started(): void {
      // The launcher calls before starting the foreground monitor. Retry only
      // during startup so a scan cannot miss the new process and wait 2s.
      root.startupChecks = 20
      root.refresh()
    }
    function refresh(): void { root.refresh() }
  }

  Timer {
    interval: 100
    repeat: true
    running: root.startupChecks > 0
    onTriggered: {
      root.startupChecks--
      root.refresh(false)
    }
  }

  Timer {
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.refresh(false)
  }

  Process {
    id: scanProcess
    running: false
    command: []
    stdout: StdioCollector {
      id: scanStdout
      waitForEnd: true
      onStreamFinished: root._scanOutput = text
    }
    stderr: StdioCollector {
      id: scanStderr
      waitForEnd: true
      onStreamFinished: root._scanError = text
    }
    onExited: function(exitCode) {
      var stdout = String(scanStdout.text || root._scanOutput || "")
      var stderr = String(scanStderr.text || root._scanError || "")
      if (exitCode === 0) root.applyScan(stdout)
      else root.applyFailure(exitCode, stderr)
      if (root.refreshPending) Qt.callLater(root.refresh)
    }
  }

  Process {
    id: killProcess
    running: false
    command: []
    stderr: StdioCollector {
      id: killStderr
      waitForEnd: true
      onStreamFinished: root._killError = text
    }
    onExited: function(exitCode) {
      var stderr = String(killStderr.text || root._killError || "")
      if (exitCode !== 0) {
        root.actionError = root.elide(stderr || "Command exited with code " + exitCode)
        console.warn("Port Kill: " + root.actionError)
      }
      root.refresh()
    }
  }
}
