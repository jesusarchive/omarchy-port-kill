// Parse Port Kill's JSON output and format the menu. QML loads this file, and
// Node.js runs the same functions in tests.

// portkill.sh list prints one Port Kill process record per line.
function parsePortKill(raw) {
  var rows = []
  var seen = {}
  var lines = String(raw || "").split("\n")

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (line.charAt(0) !== "{") continue
    var record
    try {
      record = JSON.parse(line)
    } catch (e) {
      continue
    }
    var port = Number(record.port)
    var pid = Number(record.pid)
    if (!isFinite(port) || port % 1 !== 0 || port < 1 || port > 65535) continue
    if (!isFinite(pid) || pid % 1 !== 0 || pid < 1) continue

    var key = port + ":" + pid
    if (seen[key]) continue
    seen[key] = true
    rows.push({
      key: key,
      port: port,
      pid: pid,
      name: String(record.name || record.command || "process"),
      container: String(record.container_name || "")
    })
  }

  rows.sort(function(a, b) {
    return a.port - b.port || a.name.localeCompare(b.name)
  })
  return rows
}

// Port Kill's own menu label, including its Docker suffix.
function menuLabel(row) {
  if (!row) return ""
  var label = "Kill: Port " + row.port + ": " + row.name
  return row.container ? label + " [Docker: " + row.container + "]" : label
}

function processCount(rows) {
  var seen = {}
  var count = 0
  var source = rows || []
  for (var i = 0; i < source.length; i++) {
    if (!seen[source[i].pid]) {
      seen[source[i].pid] = true
      count++
    }
  }
  return count
}

// Port Kill's status icon: green when idle, orange for 1-9 processes, red for
// 10 or more.
function statusColor(count) {
  if (count <= 0) return "#00ff00"
  if (count <= 9) return "#ffa500"
  return "#ff0000"
}

if (typeof module !== "undefined") {
  module.exports = {
    parsePortKill: parsePortKill,
    menuLabel: menuLabel,
    processCount: processCount,
    statusColor: statusColor
  }
}
