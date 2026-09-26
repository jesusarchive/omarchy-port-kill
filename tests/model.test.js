const test = require("node:test")
const assert = require("node:assert/strict")
const M = require("../Model.js")

const record = fields => JSON.stringify(Object.assign({
  pid: 1,
  port: 3000,
  command: "node",
  name: "node",
  container_id: null,
  container_name: null,
  command_line: null,
  working_directory: null,
  process_group: null,
  project_name: null
}, fields))

const output = [
  "DEBUG: Creating ProcessMonitor with verbose=false, performance=false",
  record({ pid: 4242, port: 5174, name: "node" }),
  record({ pid: 4242, port: 5173, name: "node" }),
  record({ pid: 500, port: 8000, name: "gunicorn", process_group: "Python" }),
  record({ pid: 900, port: 5432, name: "docker-proxy", container_name: "db" }),
  ""
].join("\n")

test("parsePortKill skips log lines and sorts rows by port", () => {
  const { rows, errors } = M.parsePortKill(output)
  assert.deepEqual(errors, [])
  assert.deepEqual(rows.map(row => row.port), [5173, 5174, 5432, 8000])
  assert.equal(rows[0].pid, 4242)
})

test("empty output and known log lines are a valid empty list", () => {
  for (const raw of ["", "\n", "DEBUG: Creating ProcessMonitor\n", [
    "", "🔄 Update Available!", "==================", "Current version: 0.5.41",
    "Latest version:  0.5.42", "", "📥 To update:",
    "   curl -fsSL https://raw.githubusercontent.com/treadiehq/port-kill/main/install-release.sh | bash",
    "", "🔗 Release notes: https://github.com/treadiehq/port-kill/releases/tag/v0.5.42", ""
  ].join("\n")]) {
    assert.deepEqual(M.parsePortKill(raw), { rows: [], errors: [] })
  }
})

test("parsePortKill drops duplicates and reports incomplete records", () => {
  const { rows, errors } = M.parsePortKill([
    record({ pid: 7, port: 3000 }),
    record({ pid: 7, port: 3000 }),
    JSON.stringify({ pid: 8 })
  ].join("\n"))
  assert.equal(rows.length, 1)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /Incompatible Port Kill record/)
})

test("malformed, incompatible and unknown output is reported, not dropped", () => {
  for (const [raw, pattern] of [
    ["{not json", /Malformed/],
    ['{"unexpected":"schema"}', /Incompatible/],
    ['{"pid":1,"port":3000,"name":{"nested":true}}', /Incompatible/],
    ["[1,2]", /Unrecognized/],
    ["Error: something new", /Unrecognized/]
  ]) {
    const result = M.parsePortKill(raw)
    assert.equal(result.errors.length, 1, raw)
    assert.match(result.errors[0], pattern)
  }
  // A partial list still carries the error, so the bar does not show it as
  // complete.
  const partial = M.parsePortKill([record({ pid: 7 }), "{truncated"].join("\n"))
  assert.equal(partial.rows.length, 1)
  assert.equal(partial.errors.length, 1)
})

test("several PIDs on one port stay separate rows", () => {
  const { rows } = M.parsePortKill([record({ pid: 2, port: 3000 }), record({ pid: 1, port: 3000 })].join("\n"))
  assert.deepEqual(rows.map(row => row.key), ["3000:1", "3000:2"])
})

test("menu labels match Port Kill's tray menu", () => {
  const { rows } = M.parsePortKill(output)
  assert.equal(M.menuLabel(rows[0]), "Kill: Port 5173: node")
  assert.equal(M.menuLabel(rows[2]), "Kill: Port 5432: docker-proxy [Docker: db]")
})

test("processCount deduplicates one process listening on several ports", () => {
  assert.equal(M.processCount(M.parsePortKill(output).rows), 3)
})

test("statusColor follows Port Kill's icon levels", () => {
  assert.equal(M.statusColor(0), "#00ff00")
  assert.equal(M.statusColor(1), "#ffa500")
  assert.equal(M.statusColor(9), "#ffa500")
  assert.equal(M.statusColor(10), "#ff0000")
})

test("malformed process identifiers and ports are reported", () => {
  const invalid = [
    { port: "3000" }, { port: "3000oops" }, { port: 0 }, { port: 65536 }, { port: 1.5 },
    { pid: "42" }, { pid: "42oops" }, { pid: 0 }, { pid: -1 }, { pid: 1.5 }
  ]
  const result = M.parsePortKill(invalid.map(record).join("\n"))
  assert.deepEqual(result.rows, [])
  assert.equal(result.errors.length, invalid.length)
})

test("non-string names are incompatible records", () => {
  const result = M.parsePortKill([record({ name: 42 }), record({ pid: 2, name: "node" })].join("\n"))
  assert.equal(result.rows.length, 1)
  assert.equal(result.errors.length, 1)
})

test("missing names fall back to the command", () => {
  const { rows } = M.parsePortKill(JSON.stringify({ pid: 3, port: 3000, command: "vite" }))
  assert.equal(M.menuLabel(rows[0]), "Kill: Port 3000: vite")
})

test("watcher events are validated", () => {
  assert.deepEqual(M.parseWatcherEvent('{"type":"monitors","count":2}'), { type: "monitors", count: 2 })
  assert.equal(M.parseWatcherEvent('{"type":"sockets","signature":"ab","count":1}').signature, "ab")
  assert.equal(M.parseWatcherEvent('{"type":"sockets","error":"no"}').error, "no")
  for (const line of ["", "nope", "{}", '{"type":"monitors","count":-1}', '{"type":"monitors","count":"1"}', '{"type":"sockets"}']) {
    assert.equal(M.parseWatcherEvent(line), null, line)
  }
})
