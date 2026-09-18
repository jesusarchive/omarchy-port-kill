import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

Item {
  id: root

  property var settings: ({})
  property var rows: []
  property bool loaded: false

  readonly property int refreshIntervalSec: intSetting("refreshIntervalSec", 5, 2, 300)
  readonly property int startPort: 2000
  readonly property int endPort: 9000
  readonly property bool busy: killProcess.running
  readonly property string scanScript: localPath("scan.sh")
  readonly property string killScript: localPath("kill.sh")

  property string _scanOutput: ""
  property string _scanError: ""
  property string _killError: ""
  property string _signature: ""

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

  function refresh() {
    if (scanProcess.running) return
    _scanOutput = ""
    _scanError = ""
    scanProcess.command = ["bash", scanScript, String(startPort), String(endPort)]
    scanProcess.running = true
  }

  function applyScan(raw) {
    var next = Model.parseScan(raw)
    var signature = JSON.stringify(next.map(function(row) {
      return [row.key, row.name]
    }))
    if (signature !== _signature) {
      _signature = signature
      rows = next
    }
    loaded = true
  }

  function kill(row) {
    if (!row || killProcess.running) return
    startKill(["bash", killScript, "TERM", "port", String(row.port)])
  }

  function killAll() {
    if (killProcess.running) return
    startKill(["bash", killScript, "TERM", "all", String(startPort), String(endPort)])
  }

  function startKill(command) {
    _killError = ""
    killProcess.command = command
    killProcess.running = true
  }

  function elide(text) {
    var value = String(text || "").replace(/\s+/g, " ").trim()
    return value.length > 160 ? value.substring(0, 157) + "..." : value
  }

  onSettingsChanged: refresh()

  Timer {
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.refresh()
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
      else console.warn("Port Killer: " + root.elide(stderr || "Could not list listening ports"))
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
      if (exitCode !== 0) console.warn("Port Killer: " + root.elide(stderr || "Kill command exited with code " + exitCode))
      root.refresh()
    }
  }
}
