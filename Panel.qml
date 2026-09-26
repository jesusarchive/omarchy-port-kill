import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "jesusarchive.port-kill"
  ipcTarget: "jesusarchive.port-kill"

  property int cursorIndex: 0

  readonly property int processCount: Model.processCount(ports.rows)
  readonly property int itemCount: ports.rows.length + 2
  readonly property int quitIndex: itemCount - 1
  // Grey means the list is not current: the first scan is pending, the last
  // one failed, or an action failed.
  readonly property bool hasError: !ports.ready || ports.actionError !== "" || ports.socketError !== "" || ports.watchError !== ""
  readonly property color foreground: bar ? bar.barForeground : Color.foreground
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  // The menu clips its rows; keep them 1px inside so the cursor border on the
  // edge rows isn't clipped at fractional display scales.
  readonly property int edgeInset: 1
  readonly property real menuHeight: menuColumn.implicitHeight + edgeInset * 2
  // Row metrics follow Omarchy's tray menus.
  readonly property int rowHeight: Style.space(30)
  readonly property int labelInset: Style.space(28)
  readonly property real menuWidth: Math.max(
    Style.space(232),
    Math.min(Style.space(380), menuWidthMetrics.advanceWidth + labelInset + Style.space(10) + panel.padding * 2 + edgeInset * 2)
  )

  function longestMenuLabel() {
    var longest = "Kill All Processes"
    for (var i = 0; i < ports.rows.length; i++) {
      var label = Model.menuLabel(ports.rows[i])
      if (label.length > longest.length) longest = label
    }
    return longest
  }

  function selectedRow() {
    if (cursorIndex < 1 || cursorIndex > ports.rows.length) return null
    return ports.rows[cursorIndex - 1]
  }

  function setCursor(index) {
    cursorIndex = Math.max(0, Math.min(itemCount - 1, index))
    scrollCursorIntoView()
  }

  function moveCursor(delta) {
    setCursor(cursorIndex + delta)
  }

  function cursorItem() {
    if (cursorIndex === 0) return killAllItem
    if (cursorIndex === quitIndex) return quitItem
    return processRepeater.itemAt(cursorIndex - 1)
  }

  function scrollCursorIntoView() {
    var item = cursorItem()
    if (!item) return
    Qt.callLater(function() {
      if (!item) return
      var top = item.mapToItem(menuFlick.contentItem, 0, 0).y
      var bottom = top + item.height
      var margin = Style.space(6)
      var maxY = Math.max(0, menuFlick.contentHeight - menuFlick.height)
      if (top < menuFlick.contentY + margin) menuFlick.contentY = Math.max(0, top - margin)
      else if (bottom > menuFlick.contentY + menuFlick.height - margin)
        menuFlick.contentY = Math.min(maxY, bottom + margin - menuFlick.height)
    })
  }

  function kill(row) {
    if (!row || !ports.canAct) return
    ports.kill(row)
    close()
  }

  function killAll() {
    if (!ports.canAct) return
    ports.killAll()
    close()
  }

  function quit() {
    if (ports.busy) return
    ports.quit()
    close()
  }

  function activateCursor() {
    if (cursorIndex === 0) killAll()
    else if (cursorIndex === quitIndex) quit()
    else kill(selectedRow())
  }

  function tooltip() {
    var time = ports.lastScanAt ? Qt.formatTime(ports.lastScanAt, "HH:mm:ss") : ""
    var staleNote = ports.stale ? " Showing the list from " + time + "." : ""
    if (ports.terminalError) return ports.terminalError
    if (ports.actionError) return ports.actionError
    if (ports.watchError) return ports.watchError + staleNote
    if (ports.status === "missing") return "Port Kill is not installed"
    if (ports.status === "no-lsof") return "Port Kill needs lsof"
    if (ports.status === "timeout" || ports.status === "error") return ports.scanError + staleNote
    if (ports.status === "starting") return "Checking ports..."
    if (ports.refreshing) return "Refreshing ports... Last checked " + time + "."
    var text = processCount === 0 ? "No development processes running"
      : processCount + (processCount === 1 ? " development process running" : " development processes running")
    return ports.socketError ? text + ". Change detection failed: " + ports.socketError : text
  }

  visible: ports.active
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: if (opened) {
    cursorIndex = 0
    menuFlick.contentY = 0
    ports.refresh()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }
  onVisibleChanged: if (!visible && opened) close()
  onItemCountChanged: cursorIndex = Math.max(0, Math.min(cursorIndex, Math.max(0, itemCount - 1)))

  Service {
    id: ports
    settings: root.settings
  }

  TextMetrics {
    id: menuWidthMetrics
    text: root.longestMenuLabel()
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    iconComponent: Component {
      Item {
        Rectangle {
          anchors.centerIn: parent
          width: Math.round(parent.height * 0.72)
          height: width
          color: "#ffffff"

          Rectangle {
            anchors.centerIn: parent
            width: Math.round(parent.width * 0.32)
            height: width
            color: root.hasError ? "#808080" : Model.statusColor(root.processCount)
          }
        }
      }
    }
    tooltipText: root.tooltip()
    onPressed: function(mouseButton) {
      if (mouseButton === Qt.RightButton) ports.openTerminalLogs()
      else if (mouseButton === Qt.LeftButton) root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    padding: Style.space(8)
    borderSpec: Border.flat(Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.45), Math.max(1, Style.space(2)))
    contentWidth: panel.fittedContentWidth(root.menuWidth)
    contentHeight: panel.fittedContentHeight(root.menuHeight, Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent

      onMoveRequested: function(dx, dy) {
        if (dy !== 0) root.moveCursor(dy)
      }
      onActivateRequested: root.activateCursor()
      onDeleteRequested: root.kill(root.selectedRow())
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(text) {
        if (text === "r" || text === "R") ports.refresh()
        else if (text === "a" || text === "A") root.killAll()
      }

      Flickable {
        id: menuFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: root.menuHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: menuColumn
          x: root.edgeInset
          y: root.edgeInset
          width: menuFlick.width - root.edgeInset * 2
          spacing: 0

          MenuEntry {
            id: killAllItem
            width: parent.width
            label: "Kill All Processes"
            navIndex: 0
            enabled: ports.canAct
            onTriggered: root.killAll()
          }

          PanelSeparator {
            visible: ports.rows.length > 0
            width: parent.width
            foreground: root.foreground
          }

          Repeater {
            id: processRepeater
            model: ports.rows
            MenuEntry {
              required property var modelData
              required property int index
              width: parent.width
              label: Model.menuLabel(modelData)
              navIndex: index + 1
              enabled: ports.canAct
              onTriggered: root.kill(modelData)
            }
          }

          PanelSeparator {
            width: parent.width
            foreground: root.foreground
          }

          MenuEntry {
            id: quitItem
            width: parent.width
            label: "Quit"
            navIndex: root.quitIndex
            enabled: !ports.busy
            onTriggered: root.quit()
          }
        }
      }

    }
  }

  component MenuEntry: CursorSurface {
    id: entry
    property string label: ""
    property int navIndex: 0
    signal triggered()

    hasCursor: root.cursorIndex === navIndex
    foreground: root.foreground
    implicitHeight: root.rowHeight
    opacity: enabled ? 1 : 0.45

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: entry.enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
      onEntered: if (entry.enabled) root.setCursor(entry.navIndex)
      onClicked: if (entry.enabled) entry.triggered()
    }

    Text {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: root.labelInset
      anchors.rightMargin: Style.space(10)
      textFormat: Text.PlainText
      text: entry.label
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      elide: Text.ElideRight
    }
  }
}
