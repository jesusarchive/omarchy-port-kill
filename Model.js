// Parse scan output and format the Port Killer menu. QML loads this file, and
// Node.js runs the same functions in tests.

function splitAddress(local) {
  var i = String(local || "").lastIndexOf(":")
  if (i < 0) return null
  var port = parseInt(local.slice(i + 1), 10)
  if (!isFinite(port)) return null
  var addr = local.slice(0, i).replace(/^\[([^\]]*)\]/, "$1")
  return { addr: addr, port: port }
}

function parseSsLine(line) {
  var tokens = String(line || "").trim().split(/\s+/)
  if (tokens.length < 5) return null
  var proto = "tcp"
  if (/^(tcp|udp)$/.test(tokens[0])) proto = tokens.shift()
  var local = splitAddress(tokens[3])
  if (!local) return null

  var pids = []
  var names = []
  var re = /\("((?:[^"\\]|\\.)*)",pid=(\d+)/g
  var match
  while ((match = re.exec(line)) !== null) {
    var pid = parseInt(match[2], 10)
    if (pids.indexOf(pid) === -1) pids.push(pid)
    if (names.indexOf(match[1]) === -1) names.push(match[1])
  }
  pids.sort(function(a, b) { return a - b })
  return { proto: proto, port: local.port, pids: pids, names: names }
}

// scan.sh emits socket lines tagged S and process identity lines tagged P:
// P<TAB>pid<TAB>start-time<TAB>uid
function parseScan(raw) {
  var sockets = []
  var processes = {}
  var lines = String(raw || "").split("\n")

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    var tag = line.slice(0, 2)
    var rest = line.slice(2)
    if (tag === "S\t") {
      var socket = parseSsLine(rest)
      if (socket && socket.proto === "tcp" && socket.pids.length > 0) sockets.push(socket)
    } else if (tag === "P\t") {
      var fields = rest.split("\t")
      var pid = parseInt(fields[0], 10)
      var startTime = parseInt(fields[1], 10)
      var uid = parseInt(fields[2], 10)
      if (isFinite(pid) && isFinite(startTime) && isFinite(uid)) {
        processes[String(pid)] = {
          pid: pid,
          startTime: startTime,
          uid: uid
        }
      }
    }
  }

  var rows = []
  var byKey = {}
  for (var j = 0; j < sockets.length; j++) {
    var current = sockets[j]
    var targets = []
    for (var p = 0; p < current.pids.length; p++) {
      var process = processes[String(current.pids[p])]
      if (process) targets.push(process)
    }
    if (targets.length === 0) continue

    var targetIds = targets.map(function(target) { return target.pid + ":" + target.startTime })
    var key = current.proto + ":" + current.port + ":" + targetIds.join(",")
    if (byKey[key]) continue

    var row = {
      key: key,
      proto: current.proto,
      port: current.port,
      name: current.names.length > 0 ? current.names[0] : "process",
      targets: targets
    }
    byKey[key] = row
    rows.push(row)
  }

  rows.sort(function(a, b) {
    return a.port - b.port || processLabel(a).localeCompare(processLabel(b))
  })
  return rows
}

function processLabel(row) {
  return row && row.name ? row.name : "process"
}

function menuLabel(row) {
  return row ? "Kill: Port " + row.port + ": " + processLabel(row) : ""
}

function processCount(rows) {
  var seen = {}
  var count = 0
  var source = rows || []
  for (var i = 0; i < source.length; i++) {
    for (var j = 0; j < source[i].targets.length; j++) {
      var target = source[i].targets[j]
      var key = target.pid + ":" + target.startTime
      if (!seen[key]) {
        seen[key] = true
        count++
      }
    }
  }
  return count
}

if (typeof module !== "undefined") {
  module.exports = {
    splitAddress: splitAddress,
    parseSsLine: parseSsLine,
    parseScan: parseScan,
    processLabel: processLabel,
    menuLabel: menuLabel,
    processCount: processCount
  }
}
