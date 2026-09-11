import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "jesusarchive.port-killer"
  ipcTarget: "jesusarchive.port-killer"
  manageIpc: false

  property int cursorIndex: 0
  property string cursorKey: ""
  property bool cursorActive: false

  // Pending confirmation: { all: bool, row: object|null, force: bool }
  property var confirmAction: null
  readonly property bool confirmOpen: confirmAction !== null

  readonly property var navRows: ports.ownedRows.concat(ports.systemRows)
  readonly property int ownedCount: ports.ownedRows.length
  readonly property bool hideWhenEmpty: setting("hideWhenEmpty", false) === true
  readonly property string home: Quickshell.env("HOME") || ""

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  function heroMeta() {
    if (!ports.loaded) return "Scanning…"
    var parts = [ownedCount + " yours"]
    if (ports.showSystemPorts) parts.push(ports.systemRows.length + " system")
    return parts.join(" · ")
  }

  function selectedRow() {
    if (navRows.length === 0) return null
    return navRows[Math.max(0, Math.min(cursorIndex, navRows.length - 1))]
  }

  function setCursor(index) {
    cursorActive = true
    cursorIndex = Math.max(0, Math.min(navRows.length - 1, index))
    var row = selectedRow()
    cursorKey = row ? row.key : ""
    scrollCursorIntoView()
  }

  // Rows are rebuilt on every scan; keep the cursor on the same socket if it
  // survived, otherwise clamp it to the list.
  function restoreCursor() {
    for (var i = 0; i < navRows.length; i++) {
      if (navRows[i].key === cursorKey) { cursorIndex = i; return }
    }
    cursorIndex = Math.max(0, Math.min(cursorIndex, navRows.length - 1))
    var row = selectedRow()
    cursorKey = row ? row.key : ""
  }

  function rowItem(index) {
    if (index < ownedCount) return ownedRepeater.itemAt(index)
    return systemRepeater.itemAt(index - ownedCount)
  }

  function scrollCursorIntoView() {
    var item = rowItem(cursorIndex)
    if (!panelFlick || !item) return
    Qt.callLater(function() {
      if (!item) return
      var margin = Style.space(6)
      var top = item.mapToItem(panelFlick.contentItem, 0, 0).y
      var bottom = top + item.height
      var maxY = Math.max(0, panelFlick.contentHeight - panelFlick.height)
      if (top < panelFlick.contentY + margin) panelFlick.contentY = Math.max(0, top - margin)
      else if (bottom > panelFlick.contentY + panelFlick.height - margin) panelFlick.contentY = Math.min(maxY, bottom + margin - panelFlick.height)
    })
  }

  function moveCursor(dy) {
    if (navRows.length === 0) return
    if (!cursorActive) { setCursor(0); return }
    setCursor(cursorIndex + dy)
  }

  function askKill(row, force) {
    if (!row || ports.busy) return
    confirmDialog.selectedIndex = 1
    confirmAction = { all: false, row: row, force: force === true }
  }

  function askKillAll(force) {
    if (ownedCount === 0 || ports.busy) return
    confirmDialog.selectedIndex = 1
    confirmAction = { all: true, row: null, force: force === true }
  }

  function confirmMessage() {
    var a = confirmAction
    if (!a) return ""
    if (a.all) {
      var n = ownedCount
      return (a.force ? "Force kill " : "Stop ") + "all " + n + (n === 1 ? " process" : " processes") + " listening on your ports?"
    }
    var verb = a.force ? "Force kill " : "Stop "
    var text = verb + Model.rowLabel(a.row) + " on " + a.row.proto.toUpperCase() + " :" + a.row.port + "?"
    if (!a.row.owned) text += "\nOwned by " + a.row.user + " — you'll be asked for your password."
    return text
  }

  function confirm() {
    var a = confirmAction
    confirmAction = null
    if (!a) return
    if (a.all) ports.killAllOwned(a.force)
    else ports.kill(a.row, a.force)
  }

  function cancelConfirm() { confirmAction = null }

  function openInBrowser(row) {
    if (!row || row.proto !== "tcp") return
    Qt.openUrlExternally("http://localhost:" + row.port)
    close()
  }

  function copyUrl(row) {
    if (!row || row.proto !== "tcp") return
    var url = "http://localhost:" + row.port
    Quickshell.execDetached(["wl-copy", url])
    ports.actionStatus = "Copied " + url
  }

  visible: !(hideWhenEmpty && ownedCount === 0 && !opened)
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: if (opened) {
    cursorActive = false
    confirmAction = null
    if (panelFlick) panelFlick.contentY = 0
    ports.refresh()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }
  onNavRowsChanged: restoreCursor()

  Service {
    id: ports
    settings: root.settings
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { ports.refresh(); return "ok" }
    function list(): string { return JSON.stringify(ports.rows) }
    // Scripting hook: stops the process on one of your own TCP ports, no dialog.
    function kill(port: string): string {
      var row = ports.findOwned(port)
      if (!row) return "not found"
      ports.kill(row, false)
      return "ok"
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.ownedCount > 0 && !vertical ? Model.glyph.active + " " + root.ownedCount : (root.ownedCount > 0 ? Model.glyph.active : Model.glyph.idle)
    dimmed: root.ownedCount === 0
    tooltipText: root.opened ? "" : (root.ownedCount === 1 ? "1 listening port" : root.ownedCount + " listening ports")
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) ports.refresh()
      else if (buttonCode === Qt.MiddleButton && root.ownedCount > 0) {
        root.open()
        Qt.callLater(function() { root.askKillAll(false) })
      }
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
    contentWidth: panel.fittedContentWidth(Style.space(420))
    // Leave room for the confirmation card even when the list is short.
    contentHeight: panel.fittedContentHeight(Math.max(column.implicitHeight, root.confirmOpen ? Style.space(170) : 0), Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent

      onMoveRequested: function(dx, dy) {
        if (root.confirmOpen) {
          if (dx !== 0) confirmDialog.selectedIndex = confirmDialog.selectedIndex === 0 ? 1 : 0
          return
        }
        root.moveCursor(dy)
      }
      onActivateRequested: {
        if (root.confirmOpen) {
          if (confirmDialog.selectedIndex === 0) root.cancelConfirm()
          else root.confirm()
        } else if (root.cursorActive) {
          root.askKill(root.selectedRow(), false)
        } else {
          root.moveCursor(1)
        }
      }
      onDeleteRequested: if (!root.confirmOpen && root.cursorActive) root.askKill(root.selectedRow(), false)
      onCloseRequested: root.confirmOpen ? root.cancelConfirm() : root.close()
      onTabRequested: function(direction) {
        if (root.confirmOpen) confirmDialog.selectedIndex = confirmDialog.selectedIndex === 0 ? 1 : 0
        else root.switchPanel(direction)
      }
      onTextKey: function(t) {
        if (root.confirmOpen) {
          if (t === "y" || t === "Y") root.confirm()
          else if (t === "n" || t === "N") root.cancelConfirm()
          return
        }
        if (t === "r") ports.refresh()
        else if (t === "a") root.askKillAll(false)
        else if (t === "A") root.askKillAll(true)
        else if (t === "K") root.askKill(root.selectedRow(), true)
        else if (t === "o") root.openInBrowser(root.selectedRow())
        else if (t === "c") root.copyUrl(root.selectedRow())
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: panelFlick.width
          spacing: Style.space(12)

          PanelHero {
            id: hero
            width: parent.width
            title: "Ports"
            meta: root.heroMeta()
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconOpacity: root.ownedCount > 0 ? 1.0 : 0.5
            iconComponent: Component {
              Text {
                textFormat: Text.PlainText
                text: root.ownedCount > 0 ? Model.glyph.active : Model.glyph.idle
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.display
              }
            }
            trailingControl: Component {
              Row {
                spacing: Style.space(4)
                PanelActionButton {
                  iconText: Model.glyph.refresh
                  tooltipText: "Refresh  (r)"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  onClicked: ports.refresh()
                }
                PanelActionButton {
                  iconText: Model.glyph.killAll
                  tooltipText: "Stop all your ports  (a)"
                  foreground: root.foreground
                  hoverColor: root.urgent
                  fontFamily: root.fontFamily
                  enabled: root.ownedCount > 0 && !ports.busy
                  onClicked: root.askKillAll(false)
                }
              }
            }
          }

          Text {
            textFormat: Text.PlainText
            visible: ports.actionStatus !== "" || ports.lastError !== ""
            width: parent.width
            text: ports.actionStatus !== "" ? ports.actionStatus : ports.lastError
            color: ports.lastError !== "" && ports.actionStatus === "" ? root.urgent : root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          PanelSectionHeader {
            text: "YOUR PORTS"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          Text {
            textFormat: Text.PlainText
            visible: ports.loaded && root.ownedCount === 0
            width: parent.width
            text: "Nothing of yours is listening."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            horizontalAlignment: Text.AlignHCenter
          }

          Column {
            visible: root.ownedCount > 0
            width: parent.width
            spacing: Style.space(6)

            Repeater {
              id: ownedRepeater
              model: ports.ownedRows
              PortRow {
                required property var modelData
                required property int index
                width: parent.width
                row: modelData
                navIndex: index
              }
            }
          }

          PanelSeparator {
            visible: ports.showSystemPorts && ports.systemRows.length > 0
            foreground: root.foreground
          }

          PanelSectionHeader {
            visible: ports.showSystemPorts && ports.systemRows.length > 0
            text: "SYSTEM PORTS"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          Column {
            visible: ports.systemRows.length > 0
            width: parent.width
            spacing: Style.space(6)

            Repeater {
              id: systemRepeater
              model: ports.systemRows
              PortRow {
                required property var modelData
                required property int index
                width: parent.width
                row: modelData
                navIndex: root.ownedCount + index
              }
            }
          }

          Text {
            textFormat: Text.PlainText
            width: parent.width
            text: "↵ stop · K force · a stop all · o open · c copy · r refresh"
            color: root.dim
            opacity: 0.8
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            horizontalAlignment: Text.AlignHCenter
            elide: Text.ElideRight
          }
        }
      }

      ConfirmDialog {
        id: confirmDialog
        anchors.fill: parent
        z: 10
        opened: root.confirmOpen
        message: root.confirmMessage()
        confirmText: root.confirmAction && root.confirmAction.force ? "Kill" : "Stop"
        fontFamily: root.fontFamily
        onCanceled: root.cancelConfirm()
        onConfirmed: root.confirm()
      }
    }
  }

  component PortRow: CursorSurface {
    id: portRow
    property var row: null
    property int navIndex: 0

    hasCursor: root.cursorActive && !root.confirmOpen && root.cursorIndex === navIndex
    foreground: root.foreground
    implicitHeight: rowContent.implicitHeight + Style.spacing.rowPaddingX

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      acceptedButtons: Qt.LeftButton | Qt.MiddleButton
      cursorShape: Qt.PointingHandCursor
      onEntered: root.setCursor(portRow.navIndex)
      onClicked: function(mouse) {
        if (mouse.button === Qt.MiddleButton) root.copyUrl(portRow.row)
        else root.openInBrowser(portRow.row)
      }
    }

    RowLayout {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(6)
      spacing: Style.space(10)

      Text {
        textFormat: Text.PlainText
        text: ":" + (portRow.row ? portRow.row.port : "")
        color: portRow.row && portRow.row.owned ? root.foreground : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.heading
        font.bold: true
        Layout.preferredWidth: Style.space(64)
        Layout.alignment: Qt.AlignVCenter
      }

      ColumnLayout {
        id: rowContent
        Layout.fillWidth: true
        spacing: Style.space(1)

        Text {
          textFormat: Text.PlainText
          Layout.fillWidth: true
          text: Model.rowTitle(portRow.row)
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
        }

        Text {
          textFormat: Text.PlainText
          Layout.fillWidth: true
          text: Model.rowCaption(portRow.row, root.home)
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }

      PanelActionButton {
        iconText: Model.glyph.kill
        tooltipText: portRow.row && portRow.row.owned ? "Stop  (↵)" : "Stop as root  (↵)"
        foreground: root.foreground
        hoverColor: root.urgent
        fontFamily: root.fontFamily
        enabled: !ports.busy
        Layout.alignment: Qt.AlignVCenter
        onClicked: root.askKill(portRow.row, false)
      }
    }
  }
}
