import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

Item {
  id: root

  property var settings: ({})

  property var rows: []
  readonly property var ownedRows: rows.filter(function(row) { return row.owned })
  readonly property var systemRows: showSystemPorts ? rows.filter(function(row) { return !row.owned }) : []
  property bool loaded: false
  property string actionStatus: ""
  property string lastError: ""

  readonly property int refreshIntervalSec: intSetting("refreshIntervalSec", 5, 2, 300)
  readonly property bool showSystemPorts: setting("showSystemPorts", true) === true
  readonly property bool busy: killProcess.running
  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string scanScript: localPath("scan.sh")
  readonly property string killScript: localPath("kill.sh")

  property string _scanOutput: ""
  property string _scanError: ""
  property string _killOutput: ""
  property string _killError: ""
  property string _pendingLabel: ""
  property string _signature: ""

  onSettingsChanged: {
    _signature = ""
    refresh()
  }

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  function intSetting(name, fallback, min, max) {
    var n = parseInt(String(setting(name, fallback)), 10)
    if (!isFinite(n)) n = fallback
    return Math.max(min, Math.min(max, n))
  }

  function localPath(file) {
    return decodeURIComponent(String(Qt.resolvedUrl(file)).replace(/^file:\/\//, ""))
  }

  function refresh() {
    if (scanProcess.running) return
    _scanOutput = ""
    _scanError = ""
    scanProcess.command = ["bash", scanScript]
    scanProcess.running = true
  }

  function applyScan(raw) {
    var next = Model.applyFilters(Model.parseScan(raw), {
      includeUdp: setting("includeUdp", false) === true,
      ports: setting("ports", ""),
      ignorePorts: setting("ignorePorts", ""),
      ignoreProcesses: setting("ignoreProcesses", "")
    })
    // Reassigning rebuilds every row delegate, so skip scans that changed
    // nothing visible (uptime is compared at display granularity).
    var signature = JSON.stringify(next.map(function(row) {
      return [row.key, row.addresses, row.cwd, row.args, row.user, Model.formatElapsed(row.elapsed)]
    }))
    if (signature !== _signature) {
      _signature = signature
      rows = next
    }
    loaded = true
    lastError = ""
  }

  function findOwned(port) {
    var p = parseInt(String(port), 10)
    for (var i = 0; i < ownedRows.length; i++) {
      if (ownedRows[i].port === p) return ownedRows[i]
    }
    return null
  }

  // Ports you own are signalled directly; anything else goes through pkexec,
  // which raises the Omarchy polkit dialog.
  function kill(row, force) {
    if (!row || killProcess.running) return
    var sig = force ? "KILL" : "TERM"
    var command = ["bash", killScript, "port", row.proto, String(row.port), sig]
    if (!row.owned) command = ["pkexec"].concat(command)
    var target = Model.rowLabel(row) + " on :" + row.port
    run(command, (force ? "Force killing " : "Killing ") + target + "…", (force ? "Force killed " : "Killed ") + target)
  }

  function killAllOwned(force) {
    if (killProcess.running || ownedRows.length === 0) return
    var pids = []
    for (var i = 0; i < ownedRows.length; i++) {
      for (var j = 0; j < ownedRows[i].pids.length; j++) {
        var pid = String(ownedRows[i].pids[j])
        if (pids.indexOf(pid) === -1) pids.push(pid)
      }
    }
    var target = pids.length + (pids.length === 1 ? " process" : " processes")
    run(["bash", killScript, "pids", force ? "KILL" : "TERM"].concat(pids),
      (force ? "Force killing " : "Killing ") + target + "…", (force ? "Force killed " : "Killed ") + target)
  }

  function run(command, label, doneLabel) {
    _killOutput = ""
    _killError = ""
    _pendingLabel = doneLabel
    actionStatus = label
    lastError = ""
    killProcess.command = command
    killProcess.running = true
  }

  function elide(text) {
    var value = String(text || "").replace(/\s+/g, " ").trim()
    return value.length > 140 ? value.substring(0, 137) + "…" : value
  }

  Timer {
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Timer {
    id: actionStatusTimer
    interval: 2500
    onTriggered: root.actionStatus = ""
  }

  Process {
    id: scanProcess
    running: false
    command: []
    stdout: StdioCollector { id: scanStdout; waitForEnd: true; onStreamFinished: root._scanOutput = text }
    stderr: StdioCollector { id: scanStderr; waitForEnd: true; onStreamFinished: root._scanError = text }
    onExited: function(exitCode) {
      var stdout = String(scanStdout.text || root._scanOutput || "")
      var stderr = String(scanStderr.text || root._scanError || "")
      if (exitCode === 0) root.applyScan(stdout)
      else root.lastError = root.elide(stderr || "Could not list listening ports (is iproute2 installed?)")
    }
  }

  Process {
    id: killProcess
    running: false
    command: []
    stdout: StdioCollector { id: killStdout; waitForEnd: true; onStreamFinished: root._killOutput = text }
    stderr: StdioCollector { id: killStderr; waitForEnd: true; onStreamFinished: root._killError = text }
    onExited: function(exitCode) {
      var stderr = String(killStderr.text || root._killError || "")
      if (exitCode === 0) {
        root.actionStatus = root._pendingLabel
        actionStatusTimer.restart()
      } else {
        root.actionStatus = ""
        // pkexec: 126 = dialog dismissed, 127 = not authorized.
        if (exitCode === 126 || exitCode === 127) root.lastError = "Authentication cancelled"
        else root.lastError = root.elide(stderr || "Kill failed (exit " + exitCode + ")")
      }
      root.refresh()
    }
  }
}
