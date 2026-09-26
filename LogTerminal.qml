import QtQuick
import Quickshell.Io

// Wait for a closing controller before reopening; two controllers must not overlap.
Item {
  id: root

  required property string scriptPath
  readonly property bool running: terminalProcess.running
  property bool requested: false

  signal errorReported(string message)
  signal finished(int exitCode, string stderr)

  function missingDependency(exitCode) {
    return exitCode === 3 || exitCode === 4
  }

  function open() {
    if (terminalProcess.running && terminalProcess.stdinEnabled) {
      if (!focusProcess.running) {
        errorReported("")
        focusProcess.running = true
      }
      return
    }
    requested = true
    updateRequest()
  }

  function close() {
    requested = false
    updateRequest()
  }

  function updateRequest() {
    if (requested) {
      if (!terminalProcess.running) {
        errorReported("")
        terminalProcess.stdinEnabled = true
        terminalProcess.running = true
      }
    } else if (terminalProcess.running) {
      // Closing stdin ends the controller and its display.
      terminalProcess.stdinEnabled = false
    }
  }

  Process {
    id: focusProcess
    running: false
    command: ["bash", root.scriptPath, "logs-focus"]
    stderr: StdioCollector { id: focusStderr; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0 && !root.missingDependency(exitCode) && focusStderr.text)
        root.errorReported(String(focusStderr.text))
    }
  }

  Process {
    id: terminalProcess
    running: false
    command: ["bash", root.scriptPath, "logs"]
    stdinEnabled: true
    stderr: StdioCollector { id: terminalStderr; waitForEnd: true }
    onExited: function(exitCode) {
      var stderr = String(terminalStderr.text || "")
      if (exitCode !== 0 && !root.missingDependency(exitCode) && root.requested)
        root.errorReported(stderr || "Could not open the log terminal")
      // A request can arrive while the previous controller is closing.
      if (!stdinEnabled && root.requested) Qt.callLater(root.updateRequest)
      else root.requested = false
      root.finished(exitCode, stderr)
    }
  }
}
