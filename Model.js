// Parsing and filtering for the Port Killer panel. No QML imports, so the same
// file runs under node for tests (see tests/model.test.js).

var glyph = {
  active: String.fromCodePoint(0xF0318),   // md-lan_connect
  idle: String.fromCodePoint(0xF0317),     // md-lan
  kill: String.fromCodePoint(0xF0159),     // md-close_circle
  killAll: String.fromCodePoint(0xF068C),  // md-skull
  refresh: String.fromCodePoint(0xF0450),  // md-refresh
  open: String.fromCodePoint(0xF059F),     // md-web
  copy: String.fromCodePoint(0xF018F)      // md-content_copy
}

var INTERPRETERS = {
  node: true, nodejs: true, bun: true, deno: true, python: true, python3: true,
  ruby: true, java: true, php: true, perl: true, sh: true, bash: true, zsh: true,
  uv: true, npx: true, pnpm: true, yarn: true, npm: true
}

// "3000, 6000-6002 8000" -> [[3000, 3000], [6000, 6002], [8000, 8000]]
function parseRanges(text) {
  var ranges = []
  var parts = String(text || "").split(/[\s,]+/)
  for (var i = 0; i < parts.length; i++) {
    var m = parts[i].match(/^(\d+)(?:-(\d+))?$/)
    if (!m) continue
    var lo = parseInt(m[1], 10)
    var hi = m[2] ? parseInt(m[2], 10) : lo
    ranges.push(lo <= hi ? [lo, hi] : [hi, lo])
  }
  return ranges
}

function inRanges(port, ranges) {
  for (var i = 0; i < ranges.length; i++) {
    if (port >= ranges[i][0] && port <= ranges[i][1]) return true
  }
  return false
}

function parseList(text) {
  return String(text || "").split(/[\s,]+/).filter(function(s) { return s !== "" }).map(function(s) { return s.toLowerCase() })
}

// "[::1]:631" -> { addr: "::1", port: 631 }; "*:*" -> null
function splitAddress(local) {
  var i = String(local || "").lastIndexOf(":")
  if (i < 0) return null
  var port = parseInt(local.slice(i + 1), 10)
  if (!isFinite(port)) return null
  var addr = local.slice(0, i).replace(/^\[([^\]]*)\]/, "$1")
  return { addr: addr, port: port }
}

// Systemd unit for a socket's cgroup, e.g. "cups.service". User apps live in
// transient app-*.scope units, which say nothing useful, so those are skipped.
function unitFromCgroup(cgroup) {
  var parts = String(cgroup || "").split("/")
  for (var i = parts.length - 1; i >= 0; i--) {
    var p = parts[i]
    if (/\.(service|socket)$/.test(p) && !/^user@\d+\.service$/.test(p) && p.indexOf("app-") !== 0) return p
  }
  return ""
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
  var m
  while ((m = re.exec(line)) !== null) {
    var pid = parseInt(m[2], 10)
    if (pids.indexOf(pid) === -1) pids.push(pid)
    if (names.indexOf(m[1]) === -1) names.push(m[1])
  }
  var uidMatch = line.match(/\buid:(\d+)/)
  var cgroupMatch = line.match(/\bcgroup:(\S+)/)

  return {
    proto: proto,
    addr: local.addr,
    port: local.port,
    pids: pids,
    names: names,
    uid: uidMatch ? parseInt(uidMatch[1], 10) : 0,
    unit: unitFromCgroup(cgroupMatch ? cgroupMatch[1] : "")
  }
}

// Parse scan.sh output into one row per (proto, port, owner), merging the
// IPv4/IPv6 twins that most servers open.
function parseScan(raw) {
  var sockets = []
  var procs = {}
  var users = {}
  var lines = String(raw || "").split("\n")

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    var tag = line.slice(0, 2)
    var rest = line.slice(2)
    if (tag === "S\t") {
      var s = parseSsLine(rest)
      if (s) sockets.push(s)
    } else if (tag === "P\t") {
      var f = rest.split("\t")
      procs[f[0]] = { elapsed: f[1] === "" ? -1 : parseInt(f[1], 10), cwd: f[2] || "", args: f[3] || "" }
    } else if (tag === "U\t") {
      var u = rest.split("\t")
      users[u[0]] = u[1] || ""
    }
  }

  var rows = []
  var byKey = {}
  for (var j = 0; j < sockets.length; j++) {
    var sock = sockets[j]
    var owner = sock.pids.length > 0 ? sock.pids.join(",") : "u" + sock.uid + ":" + sock.unit
    var key = sock.proto + ":" + sock.port + ":" + owner
    var row = byKey[key]
    if (!row) {
      var proc = sock.pids.length > 0 ? (procs[String(sock.pids[0])] || null) : null
      row = {
        key: key,
        proto: sock.proto,
        port: sock.port,
        addresses: [],
        pids: sock.pids,
        name: sock.names.length > 0 ? sock.names[0] : "",
        owned: sock.pids.length > 0,
        uid: sock.uid,
        user: users[String(sock.uid)] || String(sock.uid),
        unit: sock.unit,
        cwd: proc ? proc.cwd : "",
        args: proc ? proc.args : "",
        elapsed: proc ? proc.elapsed : -1
      }
      byKey[key] = row
      rows.push(row)
    }
    if (row.addresses.indexOf(sock.addr) === -1) row.addresses.push(sock.addr)
  }
  return rows
}

function applyFilters(rows, options) {
  var opts = options || {}
  var include = parseRanges(opts.ports)
  var ignore = parseRanges(opts.ignorePorts)
  var ignoreNames = parseList(opts.ignoreProcesses)

  var out = rows.filter(function(row) {
    if (row.proto === "udp" && !opts.includeUdp) return false
    if (include.length > 0 && !inRanges(row.port, include)) return false
    if (inRanges(row.port, ignore)) return false
    var name = String(row.name || "").toLowerCase()
    var unit = String(row.unit || "").toLowerCase().replace(/\.(service|socket)$/, "")
    if (ignoreNames.indexOf(name) !== -1 || (unit !== "" && ignoreNames.indexOf(unit) !== -1)) return false
    return true
  })
  out.sort(function(a, b) { return a.port - b.port || (a.proto < b.proto ? -1 : a.proto > b.proto ? 1 : 0) })
  return out
}

function basename(path) {
  var s = String(path || "").replace(/\/+$/, "")
  var i = s.lastIndexOf("/")
  return i < 0 ? s : s.slice(i + 1)
}

// "/usr/bin/node /home/me/app/node_modules/.bin/vite --port 3000" -> "node vite --port 3000"
function shortCommand(row) {
  var args = String(row && row.args || "").trim()
  if (args === "") return row && row.name ? row.name : ""
  var tokens = args.split(/\s+/).map(function(t) {
    return t.indexOf("/") !== -1 && t.charAt(0) !== "-" ? basename(t) : t
  })
  var head = INTERPRETERS[tokens[0]] ? tokens.slice(0, 4) : tokens.slice(0, 3)
  var text = head.join(" ")
  if (tokens.length > head.length) text += " …"
  return text
}

function prettyPath(path, home) {
  var p = String(path || "")
  var h = String(home || "").replace(/\/+$/, "")
  if (h !== "" && (p === h || p.indexOf(h + "/") === 0)) return "~" + p.slice(h.length)
  return p
}

function formatElapsed(seconds) {
  var s = Number(seconds)
  if (!isFinite(s) || s < 0) return ""
  if (s < 60) return Math.floor(s) + "s"
  if (s < 3600) return Math.floor(s / 60) + "m"
  if (s < 86400) return Math.floor(s / 3600) + "h"
  return Math.floor(s / 86400) + "d"
}

// What is listening: the command for your processes, the unit for system ones.
function rowTitle(row) {
  if (!row) return ""
  if (!row.owned) return row.unit !== "" ? row.unit.replace(/\.service$/, "") : "unknown process"
  return shortCommand(row)
}

// Where it runs from and who owns it, most useful first since it elides right.
function rowCaption(row, home) {
  if (!row) return ""
  var bits = []
  if (row.owned) {
    var cwd = prettyPath(row.cwd, home)
    if (cwd !== "" && cwd !== "/") bits.push(cwd)
    bits.push("pid " + row.pids.join(", "))
    var up = formatElapsed(row.elapsed)
    if (up !== "") bits.push("up " + up)
  } else {
    bits.push(row.user)
  }
  if (row.proto !== "tcp") bits.push(row.proto.toUpperCase())
  bits.push(row.addresses.join(", "))
  return bits.join("  ·  ")
}

function rowLabel(row) {
  if (!row) return ""
  if (row.owned) return (row.name || "process") + " (pid " + row.pids.join(", ") + ")"
  return row.unit !== "" ? row.unit : row.user + "'s process"
}

// Node test hook; QML's JS engine has no `module`.
if (typeof module !== "undefined") {
  module.exports = {
    glyph: glyph, parseRanges: parseRanges, inRanges: inRanges, splitAddress: splitAddress,
    unitFromCgroup: unitFromCgroup, parseSsLine: parseSsLine, parseScan: parseScan,
    applyFilters: applyFilters, shortCommand: shortCommand, prettyPath: prettyPath,
    formatElapsed: formatElapsed, rowTitle: rowTitle, rowCaption: rowCaption, rowLabel: rowLabel
  }
}
