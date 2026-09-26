import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model
import "Scheduler.js" as Scheduler

Item {
  id: root

  property var settings: ({})
  property var rows: []
  property bool active: false
  property bool stoppedByUser: false
  property bool quitting: false
  property bool quitCommandDone: false
  property string quitError: ""
  property string quitGeneration: ""
  property string pendingStart: ""
  property string checkingGeneration: ""
  property int monitorCount: 0
  // "starting" (no scan yet), "ready", "missing" (no Port Kill), "no-lsof",
  // "timeout" or "error". After a failure, rows keep the last good scan.
  property string status: "starting"
  property string scanError: ""
  property string actionError: ""
  property string terminalError: ""
  property string socketError: ""
  property string watchError: ""
  property var lastScanAt: null

  readonly property string monitoringMode: setting("monitoringMode", "terminal") === "always" ? "always" : "terminal"
  readonly property bool alwaysActive: monitoringMode === "always"
  property bool initialized: false
  property bool refreshRequired: true
  readonly property bool refreshing: scanProcess.running
  readonly property int refreshIntervalSec: intSetting("refreshIntervalSec", 2, 1, 300)
  readonly property bool ready: status === "ready"
  readonly property bool stale: !ready && lastScanAt !== null
  readonly property bool busy: acting || quitting
  // Kills act on ports as Port Kill sees them when the action runs, so only
  // offer them while the displayed list is current.
  readonly property bool canAct: active && !stoppedByUser && ready && !busy && !refreshing && !refreshRequired && !socketError && !watchError
  readonly property string portKillScript: localPath("portkill.sh")

  // Deadlines passed to portkill.sh. The watchdogs below only fire if the
  // script itself fails to enforce them.
  property int scanTimeoutSec: 10
  property int actionTimeoutSec: 20
  property int watchdogGraceMs: 5000

  // Scheduler timings; tests shorten them.
  property var scheduleOptions: ({})
  property var schedule: Scheduler.createScheduler(scheduleOptions)
  property int scanGeneration: -1
  property bool scanAbandoned: false
  property bool acting: false
  property bool actionAbandoned: false
  property bool watcherRescanRequested: false
  property bool watcherRestarting: false
  property int watcherFailures: 0
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

  function elide(text) {
    var value = String(text || "").replace(/\s+/g, " ").trim()
    return value.length > 160 ? value.substring(0, 157) + "..." : value
  }

  // Monitor tracking

  // Called at shell startup, when a monitor starts and on explicit refresh.
  // A running watcher rereads its leases; otherwise start one, which reports
  // the monitors and exits at once when there are none.
  function reconcile() {
    if (stoppedByUser) return
    if (watcher.running) {
      watcherRescanRequested = true
      watcher.write("rescan\n")
      return
    }
    watcherRescanRequested = false
    watcher.command = ["bash", portKillScript, "watch", String(refreshIntervalSec), monitoringMode]
    watcher.running = true
  }

  function handleWatcherLine(line) {
    if (stoppedByUser) return
    var event = Model.parseWatcherEvent(line)
    if (!event) {
      console.warn("Port Kill: unexpected watcher output: " + elide(line))
      return
    }
    watcherFailures = 0
    watchError = ""
    if (event.type === "monitors") {
      monitorCount = event.count
      setActive(alwaysActive || event.count > 0)
    } else if (event.error !== undefined) {
      socketError = elide(event.error)
      console.warn("Port Kill: " + socketError)
    } else {
      socketError = ""
      Scheduler.setSignature(schedule, event.signature)
      pump()
    }
  }

  function setActive(value) {
    if (stoppedByUser) value = false
    if (value === active && value === schedule.active) return
    active = value
    refreshRequired = true
    if (value) {
      Scheduler.activate(schedule, Date.now())
      pump()
      return
    }
    logTerminal.close()
    Scheduler.deactivate(schedule)
    // Stop background work now; the result would be discarded anyway.
    if (scanProcess.running) scanProcess.signal(15)
    // Keep the cancellation watchdog until the child has actually exited.
    scheduleTimer.stop()
    rows = []
    _signature = ""
    status = "starting"
    scanError = ""
    actionError = ""
    socketError = ""
    lastScanAt = null
  }

  function watcherExited(exitCode, stderr) {
    if (stoppedByUser) return
    if (watcherRestarting) {
      watcherRestarting = false
      reconcile()
      return
    }
    if (exitCode === 0 && !watcherRescanRequested && !active) return
    if (exitCode === 0) {
      // A monitor registered while the watcher was exiting, or the watcher
      // lost its input. Either way, look again.
      reconcile()
      return
    }
    watcherFailures++
    watchError = elide(stderr || "Monitor tracking exited with code " + exitCode)
    console.warn("Port Kill: " + watchError)
    if (watcherFailures <= 5) {
      watcherRetry.interval = 1000 * Math.pow(2, watcherFailures - 1)
      watcherRetry.restart()
    } else {
      // Without tracking there is no way to know when monitors exit. Hide
      // rather than leave an icon that may never go away; the next monitor
      // start tries again.
      if (alwaysActive) {
        // Keep errors visible and retry at a bounded rate in always mode.
        watcherRetry.interval = 60000
        watcherRetry.restart()
      } else {
        watcherFailures = 0
        setActive(false)
      }
    }
  }

  // Scans

  function refresh() {
    refreshRequired = true
    Scheduler.request(schedule, true)
    pump()
  }

  function pump() {
    scheduleTimer.stop()
    var now = Date.now()
    if (!scanProcess.running && Scheduler.shouldScan(schedule, now)) {
      startScan(now)
      return
    }
    var delay = Scheduler.nextDelay(schedule, now)
    if (delay >= 0) {
      scheduleTimer.interval = Math.max(1, delay)
      scheduleTimer.start()
    }
  }

  function startScan(now) {
    scanGeneration = Scheduler.beginScan(schedule, now)
    scanAbandoned = false
    scanProcess.environment = { "PORT_KILL_SCAN_TIMEOUT": String(scanTimeoutSec) }
    scanProcess.command = ["bash", portKillScript, "list"]
    scanProcess.running = true
    scanWatchdog.arm()
  }

  function finishScan(exitCode, stdout, stderr) {
    scanWatchdog.stop()
    var parsed = exitCode === 0 ? Model.parsePortKill(stdout) : null
    var ok = parsed !== null && parsed.errors.length === 0
    var outcome = Scheduler.finishScan(schedule, scanGeneration, ok, Date.now())
    if (outcome === "apply") {
      applyRows(parsed.rows)
      status = "ready"
      scanError = ""
      lastScanAt = new Date()
      // A menu request queued during this scan still requires its follow-up.
      refreshRequired = schedule.pending
    } else if (outcome === "failed") {
      status = exitCode === 3 ? "missing"
        : exitCode === 4 ? "no-lsof"
        : exitCode === 6 || exitCode === -1 ? "timeout"
        : "error"
      if (parsed && parsed.errors.length) {
        scanError = elide(parsed.errors.length + " unrecognized Port Kill record"
          + (parsed.errors.length === 1 ? "" : "s") + ". " + parsed.errors[0])
      } else {
        scanError = elide(stderr || "Could not list listening ports")
      }
      console.warn("Port Kill: " + scanError)
    }
    pump()
  }

  function applyRows(next) {
    // Keep the same array while nothing visible changed, so the menu does not
    // rebuild its rows.
    var signature = JSON.stringify(next.map(function(row) {
      return [row.key, row.name, row.container]
    }))
    if (signature !== _signature) {
      _signature = signature
      rows = next
    }
  }

  // Actions

  // Port Kill stops the listeners it finds on this port when the action
  // runs, which may include processes other than row.pid.
  function kill(row) {
    if (!row || !canAct) return
    startAction(["bash", portKillScript, "kill", String(row.port)])
  }

  function killAll() {
    if (!canAct) return
    startAction(["bash", portKillScript, "kill-all"])
  }

  function openTerminalLogs() {
    if (quitting || !active) return
    logTerminal.open()
  }

  function quit() {
    if (busy) return
    quitting = true
    stoppedByUser = true
    quitCommandDone = false
    quitError = ""
    quitGeneration = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2)
    pendingStart = ""
    logTerminal.close()
    watcherRetry.stop()
    watcherRestarting = false
    watcherRescanRequested = false
    if (watcher.running) watcher.signal(15)
    Scheduler.deactivate(schedule)
    scheduleTimer.stop()
    if (scanProcess.running) scanProcess.signal(15)
    // Keep the icon until both kinds of terminal have actually stopped.
    startAction(["bash", portKillScript, "quit-session", quitGeneration])
  }

  function finishQuit() {
    if (!quitting || !quitCommandDone || logTerminal.running) return
    quitting = false
    if (quitError) {
      actionError = quitError
      // Remain visible with the error and a working Quit retry. No scans or
      // destructive port actions run while this session is stopped.
    } else {
      setActive(false)
      monitorCount = 0
    }
    checkPendingStart()
  }

  function monitorStarted(identity) {
    if (!/^\d+\.\d+$/.test(identity)) return
    if (!stoppedByUser) {
      reconcile()
      return
    }
    pendingStart = identity
    checkPendingStart()
  }

  function checkPendingStart() {
    if (quitting || acting || verifyStartProcess.running || !pendingStart) return
    checkingGeneration = quitGeneration
    verifyStartProcess.command = ["bash", portKillScript, "verify-start", pendingStart, checkingGeneration]
    pendingStart = ""
    verifyStartProcess.running = true
  }

  // Actions are destructive, so a failed or timed-out action is reported,
  // never retried.
  function startAction(command) {
    if (actionProcess.running || !Scheduler.beginAction(schedule)) {
      actionError = "Another Port Kill action is still running"
      return
    }
    acting = true
    refreshRequired = true
    actionAbandoned = false
    actionError = ""
    actionProcess.environment = { "PORT_KILL_ACTION_TIMEOUT": String(actionTimeoutSec) }
    actionProcess.command = command
    actionProcess.running = true
    actionWatchdog.arm()
  }

  function finishAction(exitCode, stderr) {
    actionWatchdog.stop()
    if (exitCode !== 0) {
      actionError = elide(exitCode === 6 || exitCode === -1
        ? (stderr || "Port Kill did not finish in time") + ". It was not retried."
        : stderr || "Command exited with code " + exitCode)
      console.warn("Port Kill: " + actionError)
    }
    acting = false
    Scheduler.finishAction(schedule)
    if (quitting) {
      quitCommandDone = true
      if (exitCode !== 0) quitError = actionError
      finishQuit()
    } else {
      pump()
    }
  }

  function restartWatcher() {
    if (!initialized || stoppedByUser) return
    watcherRetry.stop()
    watcherFailures = 0
    setActive(alwaysActive || monitorCount > 0)
    if (watcher.running) {
      watcherRestarting = true
      watcher.signal(15)
    } else {
      reconcile()
    }
  }
  onRefreshIntervalSecChanged: restartWatcher()
  onMonitoringModeChanged: {
    if (quitting) return
    stoppedByUser = false
    restartWatcher()
  }
  Component.onCompleted: {
    initialized = true
    setActive(alwaysActive)
    reconcile()
  }

  IpcHandler {
    target: "jesusarchive.port-kill.service"
    // portkill.sh calls this after registering a monitor.
    function started(identity: string): void { root.monitorStarted(identity) }
    function refresh(): void {
      root.reconcile()
      root.refresh()
    }
  }

  Timer {
    id: scheduleTimer
    repeat: false
    onTriggered: root.pump()
  }

  Timer {
    id: watcherRetry
    repeat: false
    onTriggered: root.reconcile()
  }

  CommandWatchdog {
    id: scanWatchdog
    targetProcess: scanProcess
    deadlineMs: (root.scanTimeoutSec + 2) * 1000 + root.watchdogGraceMs
    onTimedOut: {
      root.scanAbandoned = true
      root.finishScan(-1, "", "Port Kill did not finish within " + root.scanTimeoutSec + " seconds")
    }
  }

  CommandWatchdog {
    id: actionWatchdog
    targetProcess: actionProcess
    deadlineMs: (root.actionTimeoutSec + 2) * 1000 + root.watchdogGraceMs
    onTimedOut: {
      root.actionAbandoned = true
      root.finishAction(-1, "Port Kill did not finish within " + root.actionTimeoutSec + " seconds")
    }
  }

  Process {
    id: verifyStartProcess
    running: false
    onExited: function(exitCode) {
      if (exitCode === 0 && !root.quitting && root.stoppedByUser
          && root.checkingGeneration === root.quitGeneration) {
        root.stoppedByUser = false
        root.actionError = ""
        root.restartWatcher()
      }
      root.checkPendingStart()
    }
  }

  LogTerminal {
    id: logTerminal
    scriptPath: root.portKillScript
    onErrorReported: function(message) { root.terminalError = root.elide(message) }
    onFinished: function(exitCode, stderr) {
      if (exitCode !== 0 && root.quitting) {
        root.terminalError = root.elide(stderr || "Could not close the log terminal")
        root.quitError = root.terminalError
      }
      root.finishQuit()
    }
  }

  Process {
    id: watcher
    running: false
    command: []
    // The watcher exits when this pipe closes, so it cannot outlive the shell.
    stdinEnabled: true
    stdout: SplitParser {
      onRead: function(line) { root.handleWatcherLine(line) }
    }
    stderr: StdioCollector {
      id: watcherStderr
      waitForEnd: true
    }
    onExited: function(exitCode) {
      root.watcherExited(exitCode, String(watcherStderr.text || ""))
    }
  }

  Process {
    id: scanProcess
    running: false
    command: []
    stdout: StdioCollector {
      id: scanStdout
      waitForEnd: true
    }
    stderr: StdioCollector {
      id: scanStderr
      waitForEnd: true
    }
    onExited: function(exitCode) {
      if (root.scanAbandoned) {
        root.scanAbandoned = false
        root.pump()
        return
      }
      root.finishScan(exitCode, String(scanStdout.text || ""), String(scanStderr.text || ""))
    }
  }

  Process {
    id: actionProcess
    running: false
    command: []
    stderr: StdioCollector {
      id: actionStderr
      waitForEnd: true
    }
    onExited: function(exitCode) {
      if (root.actionAbandoned) {
        root.actionAbandoned = false
        root.pump()
        return
      }
      root.finishAction(exitCode, String(actionStderr.text || ""))
    }
  }
}
