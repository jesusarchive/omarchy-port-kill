import QtQuick

// Fallback when the wrapper fails to enforce its own deadline.
Timer {
  id: root

  required property var targetProcess
  required property int deadlineMs
  property int stage: 0
  repeat: false

  signal timedOut()

  function arm() {
    stage = 0
    interval = deadlineMs
    restart()
  }

  onTriggered: {
    if (stage === 0) {
      stage = 1
      targetProcess.signal(15)
      interval = 2000
      restart()
      return
    }
    targetProcess.signal(9)
    timedOut()
  }
}
