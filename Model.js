// Parse Port Kill's JSON output and format the menu. QML loads this file, and
// Node.js runs the same functions in tests.

// Lines Port Kill 0.5 prints on stdout besides its records: a debug line and
// the update notice. Anything else is reported rather than guessed at.
var KNOWN_LOG_LINES = [
  /^DEBUG: /,
  /^🔄 Update Available!$/,
  /^=+$/,
  /^Current version: /,
  /^Latest version: /,
  /^📥 To update:$/,
  /^curl .*install-release\.sh \| bash$/,
  /^🔗 Release notes: /
]

function isKnownLogLine(line) {
  for (var i = 0; i < KNOWN_LOG_LINES.length; i++) {
    if (KNOWN_LOG_LINES[i].test(line)) return true
  }
  return false
}

function isInteger(value, min, max) {
  return typeof value === "number" && value % 1 === 0 && value >= min && value <= max
}

function optionalString(value) {
  return value === undefined || value === null || typeof value === "string"
}

// portkill.sh list prints Port Kill's stdout: one process record per line,
// mixed with log lines. Returns { rows, errors }. Empty output is a valid
// empty list; malformed or incompatible records are errors, and callers must
// not present a list that has errors as complete.
function parsePortKill(raw) {
  var rows = []
  var errors = []
  var seen = {}
  var lines = String(raw || "").split("\n")

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (line === "") continue
    if (line.charAt(0) !== "{") {
      if (!isKnownLogLine(line)) errors.push("Unrecognized Port Kill output: " + line)
      continue
    }
    var record
    try {
      record = JSON.parse(line)
    } catch (e) {
      errors.push("Malformed Port Kill record: " + line)
      continue
    }
    if (!record || typeof record !== "object" || Array.isArray(record)
        || !isInteger(record.port, 1, 65535) || !isInteger(record.pid, 1, 4194304)
        || !optionalString(record.name) || !optionalString(record.command)
        || !optionalString(record.container_name)) {
      errors.push("Incompatible Port Kill record: " + line)
      continue
    }

    var key = record.port + ":" + record.pid
    if (seen[key]) continue
    seen[key] = true
    rows.push({
      key: key,
      port: record.port,
      pid: record.pid,
      name: record.name || record.command || "process",
      container: record.container_name || ""
    })
  }

  rows.sort(function(a, b) {
    return a.port - b.port || a.name.localeCompare(b.name) || a.pid - b.pid
  })
  return { rows: rows, errors: errors }
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

function statusColor(count) {
  if (count <= 0) return "#00ff00"
  if (count <= 9) return "#ffa500"
  return "#ff0000"
}

// Watcher events are one JSON object per line. Returns null for anything else.
function parseWatcherEvent(line) {
  var event
  try {
    event = JSON.parse(String(line || ""))
  } catch (e) {
    return null
  }
  if (!event || typeof event !== "object") return null
  if (event.type === "monitors" && isInteger(event.count, 0, 1e9)) return event
  if (event.type === "sockets" && (typeof event.signature === "string" || typeof event.error === "string")) return event
  return null
}

if (typeof module !== "undefined") {
  module.exports = {
    parsePortKill: parsePortKill,
    parseWatcherEvent: parseWatcherEvent,
    menuLabel: menuLabel,
    processCount: processCount,
    statusColor: statusColor
  }
}
