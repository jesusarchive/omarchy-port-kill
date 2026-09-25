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
  "{not json",
  ""
].join("\n")

test("parsePortKill skips log lines and sorts rows by port", () => {
  const rows = M.parsePortKill(output)
  assert.deepEqual(rows.map(row => row.port), [5173, 5174, 5432, 8000])
  assert.equal(rows[0].pid, 4242)
})

test("parsePortKill drops duplicate and incomplete records", () => {
  const rows = M.parsePortKill([
    record({ pid: 7, port: 3000 }),
    record({ pid: 7, port: 3000 }),
    JSON.stringify({ pid: 8 })
  ].join("\n"))
  assert.equal(rows.length, 1)
})

test("menu labels match Port Kill's tray menu", () => {
  const rows = M.parsePortKill(output)
  assert.equal(M.menuLabel(rows[0]), "Kill: Port 5173: node")
  assert.equal(M.menuLabel(rows[2]), "Kill: Port 5432: docker-proxy [Docker: db]")
})

test("processCount deduplicates one process listening on several ports", () => {
  assert.equal(M.processCount(M.parsePortKill(output)), 3)
})

test("statusColor follows Port Kill's icon levels", () => {
  assert.equal(M.statusColor(0), "#00ff00")
  assert.equal(M.statusColor(1), "#ffa500")
  assert.equal(M.statusColor(9), "#ffa500")
  assert.equal(M.statusColor(10), "#ff0000")
})

test("malformed process identifiers and ports are discarded", () => {
  const invalid = [
    { port: "3000oops" }, { port: 0 }, { port: 65536 }, { port: 1.5 },
    { pid: "42oops" }, { pid: 0 }, { pid: -1 }, { pid: 1.5 }
  ]
  assert.deepEqual(M.parsePortKill(invalid.map(record).join("\n")), [])
})

test("non-string names cannot break sorting or menu labels", () => {
  const rows = M.parsePortKill([record({ name: 42 }), record({ pid: 2, name: "node" })].join("\n"))
  assert.equal(rows.length, 2)
  assert.equal(M.menuLabel(rows[0]), "Kill: Port 3000: 42")
})
