import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "jesusarchive.port-killer"

  property int cursorIndex: 0

  readonly property int processCount: Model.processCount(ports.rows)
  readonly property int itemCount: ports.rows.length > 0 ? ports.rows.length + 1 : 0
  readonly property color foreground: bar ? bar.barForeground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.5)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property real menuWidth: Math.max(
    Style.space(270),
    Math.min(Style.space(380), menuWidthMetrics.advanceWidth + Style.space(38))
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
    if (itemCount === 0) return
    cursorIndex = Math.max(0, Math.min(itemCount - 1, index))
    scrollCursorIntoView()
  }

  function moveCursor(delta) {
    if (itemCount === 0) return
    setCursor(cursorIndex + delta)
  }

  function cursorItem() {
    return cursorIndex === 0 ? killAllItem : processRepeater.itemAt(cursorIndex - 1)
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
    if (!row || ports.busy) return
    ports.kill(row)
    close()
  }

  function killAll() {
    if (ports.rows.length === 0 || ports.busy) return
    ports.killAll()
    close()
  }

  function activateCursor() {
    if (itemCount === 0) return
    if (cursorIndex === 0) killAll()
    else kill(selectedRow())
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: if (opened) {
    cursorIndex = 0
    menuFlick.contentY = 0
    ports.refresh()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }
  onItemCountChanged: cursorIndex = Math.max(0, Math.min(cursorIndex, Math.max(0, itemCount - 1)))

  Service {
    id: ports
    settings: root.settings
  }

  TextMetrics {
    id: menuWidthMetrics
    text: root.longestMenuLabel()
    font.family: root.fontFamily
    font.pixelSize: Style.font.body
    font.bold: true
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: vertical ? String(root.processCount) : "ports " + root.processCount
    fontSize: Style.font.body
    dimmed: ports.loaded && root.processCount === 0
    tooltipText: root.processCount === 1 ? "1 listening process" : root.processCount + " listening processes"
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) ports.refresh()
      else root.toggle()
    }

  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(root.menuWidth)
    contentHeight: panel.fittedContentHeight(menuColumn.implicitHeight, Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent

      onMoveRequested: function(dx, dy) {
        if (dy !== 0) root.moveCursor(dy)
      }
      onActivateRequested: root.activateCursor()
      onDeleteRequested: root.activateCursor()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(text) {
        if (text === "r") ports.refresh()
        else if (text === "a") root.killAll()
      }

      Flickable {
        id: menuFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: menuColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: menuColumn
          width: menuFlick.width
          spacing: Style.space(4)

          MenuEntry {
            id: killAllItem
            width: parent.width
            visible: ports.rows.length > 0
            label: "Kill All Processes"
            navIndex: 0
            enabled: !ports.busy
            onTriggered: root.killAll()
          }

          PanelSeparator {
            width: parent.width
            visible: ports.rows.length > 0
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
              enabled: !ports.busy
              onTriggered: root.kill(modelData)
            }
          }

          Text {
            textFormat: Text.PlainText
            visible: ports.loaded && ports.rows.length === 0 && ports.lastError === ""
            width: parent.width
            topPadding: Style.space(16)
            bottomPadding: Style.space(16)
            text: "No listening processes"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            horizontalAlignment: Text.AlignHCenter
          }

          Text {
            textFormat: Text.PlainText
            visible: ports.lastError !== ""
            width: parent.width
            leftPadding: Style.space(10)
            rightPadding: Style.space(10)
            topPadding: Style.space(8)
            text: ports.lastError
            color: root.urgent
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
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
    implicitHeight: Style.space(46)
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
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(10)
      textFormat: Text.PlainText
      text: entry.label
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      font.bold: true
      elide: Text.ElideRight
    }
  }
}
