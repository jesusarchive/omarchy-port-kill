const test = require("node:test")
const assert = require("node:assert/strict")
const M = require("../Model.js")

const scan = [
  "S\tLISTEN 0 511 0.0.0.0:5173 0.0.0.0:* users:((\"node\",pid=4242,fd=20))",
  "S\tLISTEN 0 511 [::]:5173 [::]:* users:((\"node\",pid=4242,fd=21))",
  "S\tLISTEN 0 511 127.0.0.1:5174 0.0.0.0:* users:((\"node\",pid=4242,fd=22))",
  "S\tLISTEN 0 128 0.0.0.0:8000 0.0.0.0:* users:((\"gunicorn\",pid=500,fd=5),(\"gunicorn\",pid=501,fd=5))",
  "S\tLISTEN 0 4096 127.0.0.1:631 0.0.0.0:*",
  "S\tudp UNCONN 0 0 0.0.0.0:5353 0.0.0.0:* users:((\"avahi\",pid=700,fd=7))",
  "P\t4242\t111111\t1000",
  "P\t500\t222222\t1000",
  "P\t501\t333333\t1000",
  "P\t700\t444444\t1000",
  ""
].join("\n")

test("splitAddress handles IPv4, IPv6, and invalid ports", () => {
  assert.deepEqual(M.splitAddress("127.0.0.1:5173"), { addr: "127.0.0.1", port: 5173 })
  assert.deepEqual(M.splitAddress("[::1]:631"), { addr: "::1", port: 631 })
  assert.equal(M.splitAddress("*:*"), null)
})

test("parseSsLine extracts sorted unique process ids", () => {
  const socket = M.parseSsLine("LISTEN 0 5 0.0.0.0:8000 0.0.0.0:* users:((\"app\",pid=12,fd=3),(\"app\",pid=9,fd=4),(\"app\",pid=12,fd=5))")
  assert.equal(socket.proto, "tcp")
  assert.equal(socket.port, 8000)
  assert.deepEqual(socket.pids, [9, 12])
})

test("parseScan keeps owned TCP rows and merges IPv4 and IPv6 twins", () => {
  const rows = M.parseScan(scan)
  assert.deepEqual(rows.map(row => row.port), [5173, 5174, 8000])
  assert.equal(rows.filter(row => row.port === 5173).length, 1)
  assert.equal(rows.find(row => row.port === 8000).targets.length, 2)
})

test("menu labels stay compact", () => {
  const rows = M.parseScan(scan)
  assert.equal(M.processLabel(rows[0]), "node")
  assert.equal(M.menuLabel(rows[0]), "Kill: Port 5173: node")
  assert.equal(M.processLabel(rows[2]), "gunicorn")
})

test("processCount deduplicates one process listening on several ports", () => {
  assert.equal(M.processCount(M.parseScan(scan)), 3)
})
