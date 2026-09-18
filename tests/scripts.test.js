const test = require("node:test")
const assert = require("node:assert/strict")
const { once } = require("node:events")
const { spawn, spawnSync } = require("node:child_process")
const path = require("node:path")
const M = require("../Model.js")

const root = path.resolve(__dirname, "..")

async function startServer() {
  const child = spawn(process.execPath, ["-e", [
    "const net = require('node:net')",
    "const server = net.createServer(() => {})",
    "server.listen(0, '127.0.0.1', () => console.log(server.address().port))"
  ].join(";")], { stdio: ["ignore", "pipe", "inherit"] })
  const [chunk] = await once(child.stdout, "data")
  return { child, port: Number(String(chunk).trim()) }
}

function scanRows() {
  const result = spawnSync("bash", [path.join(root, "scan.sh"), "1", "65535"], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return M.parseScan(result.stdout)
}

function cleanup(child) {
  if (child && child.exitCode === null) child.kill("SIGKILL")
}

test("single-port kill rescans the port and terminates its listener", async t => {
  const { child, port } = await startServer()
  t.after(() => cleanup(child))

  const row = scanRows().find(candidate => candidate.port === port)
  assert.ok(row, "listener was not found")
  assert.equal(row.targets[0].pid, child.pid)

  const result = spawnSync("bash", [path.join(root, "kill.sh"), "TERM", "port", String(port)], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  await once(child, "exit")
})

test("kill all rescans its range and terminates current listeners", async t => {
  const { child, port } = await startServer()
  t.after(() => cleanup(child))

  const result = spawnSync("bash", [path.join(root, "kill.sh"), "TERM", "all", String(port), String(port)], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  await once(child, "exit")
})

test("kill rejects invalid ports and ranges", () => {
  const malformed = spawnSync("bash", [path.join(root, "kill.sh"), "TERM", "port", "nope"], { encoding: "utf8" })
  assert.equal(malformed.status, 2)

  const badRange = spawnSync("bash", [path.join(root, "kill.sh"), "TERM", "all", "9000", "2000"], { encoding: "utf8" })
  assert.equal(badRange.status, 2)
  assert.match(badRange.stderr, /Invalid port range/)
})
