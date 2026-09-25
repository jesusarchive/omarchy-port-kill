const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { once } = require("node:events")
const { spawn, spawnSync } = require("node:child_process")
const M = require("../Model.js")

const script = path.resolve(__dirname, "..", "portkill.sh")

// Any Port Kill monitor on this machine makes "not running" untestable.
const realMonitor = spawnSync("pgrep", ["-x", "port-kill|port-kill-conso"]).status === 0

// A fake Port Kill that logs its arguments and prints a DEBUG line before one
// JSON record, like the real binary. Without arguments it runs as a monitor.
function fakeEnv(t, { withPortKill = true, withLsof = true, monitor = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portkill-test-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const bin = path.join(dir, "bin")
  fs.mkdirSync(bin)
  const log = path.join(dir, "args.log")

  if (withPortKill) {
    fs.writeFileSync(path.join(bin, "port-kill-console"), [
      "#!/bin/bash",
      "if (($# == 0)); then while :; do sleep 1; done; fi",
      `printf '%s\\n' "$*" >> '${log}'`,
      "echo 'DEBUG: Creating ProcessMonitor'",
      `[[ $1 == --json ]] && echo '{"pid":42,"port":3000,"name":"node"}'`,
      "exit 0"
    ].join("\n"), { mode: 0o755 })
  }
  if (withLsof) fs.writeFileSync(path.join(bin, "lsof"), "#!/bin/bash\n", { mode: 0o755 })
  if (withPortKill && monitor) {
    const child = spawn(path.join(bin, "port-kill-console"), [], { stdio: "ignore" })
    t.after(() => child.kill("SIGKILL"))
  }

  // Only the fake binaries are on PATH, and HOME hides any real
  // ~/.local/bin/port-kill-console.
  const env = { PATH: bin, HOME: dir }
  const run = (...args) => spawnSync("/bin/bash", [script, ...args], { encoding: "utf8", env })
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []
  return { run, calls }
}

test("list returns Port Kill's JSON records without log lines", t => {
  const { run } = fakeEnv(t)
  const result = run("list")
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '{"pid":42,"port":3000,"name":"node"}\n')
})

test("kill passes one port to Port Kill", t => {
  const { run, calls } = fakeEnv(t)
  assert.equal(run("kill", "3000").status, 0)
  assert.deepEqual(calls(), ["--ports 3000 --kill-all"])
})

test("kill-all uses Port Kill's default range", t => {
  const { run, calls } = fakeEnv(t)
  assert.equal(run("kill-all").status, 0)
  assert.deepEqual(calls(), ["--kill-all"])
})

test("invalid ports never reach Port Kill", t => {
  const { run, calls } = fakeEnv(t)
  assert.equal(run("kill", "nope").status, 2)
  assert.equal(run("kill", "70000").status, 2)
  assert.deepEqual(calls(), [])
})

test("list reports a stopped Port Kill without calling it", { skip: realMonitor && "a Port Kill monitor is running" }, t => {
  const { run, calls } = fakeEnv(t, { monitor: false })
  assert.equal(run("list").status, 5)
  assert.deepEqual(calls(), [])
})

test("missing Port Kill and missing lsof have their own exit codes", t => {
  const env = fakeEnv(t, { withPortKill: false })
  assert.equal(env.run("kill-all").status, 3)
  assert.equal(fakeEnv(t, { withLsof: false }).run("list").status, 4)
})

// Runs against the real binary when Port Kill and lsof are installed.
const realPortKill = spawnSync("bash", ["-c", 'PATH="$HOME/.local/bin:$PATH"; command -v port-kill-console && command -v lsof'], { encoding: "utf8" })
test("real Port Kill lists and stops a listener", { skip: realPortKill.status !== 0 && "Port Kill or lsof is not installed" }, async t => {
  const monitor = spawn("bash", ["-c", 'PATH="$HOME/.local/bin:$PATH" exec port-kill-console'], { stdio: "ignore" })
  t.after(() => monitor.kill("SIGKILL"))

  const child = spawn(process.execPath, ["-e", [
    "const net = require('node:net')",
    "const server = net.createServer(() => {})",
    "server.listen(0, '127.0.0.1', () => console.log(server.address().port))"
  ].join(";")], { stdio: ["ignore", "pipe", "inherit"] })
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL") })
  const [chunk] = await once(child.stdout, "data")
  const port = Number(String(chunk).trim())

  const list = spawnSync("bash", [script, "list"], { encoding: "utf8" })
  assert.equal(list.status, 0, list.stderr)
  // Port Kill only scans 2000-9000 by default, so an ephemeral port may be
  // outside the list; the kill below targets the port directly.
  if (port >= 2000 && port <= 9000) {
    assert.ok(M.parsePortKill(list.stdout).some(row => row.port === port))
  }

  const kill = spawnSync("bash", [script, "kill", String(port)], { encoding: "utf8" })
  assert.equal(kill.status, 0, kill.stderr)
  await once(child, "exit")
})
