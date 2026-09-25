const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { once } = require("node:events")
const { spawn, spawnSync } = require("node:child_process")
const M = require("../Model.js")

const script = path.resolve(__dirname, "..", "portkill.sh")

// A fake Port Kill that logs its arguments and prints a DEBUG line before one
// JSON record, like the real binary.
async function fakeEnv(t, { withPortKill = true, withLsof = true, monitor = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portkill-test-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const bin = path.join(dir, "bin")
  fs.mkdirSync(bin)
  const log = path.join(dir, "args.log")
  const proc = path.join(dir, "proc")
  fs.mkdirSync(proc)

  if (withPortKill) {
    fs.writeFileSync(path.join(bin, "port-kill-console"), [
      "#!/bin/bash",
      `printf '%s\\n' "$*" >> '${log}'`,
      "echo 'DEBUG: Creating ProcessMonitor'",
      `[[ $1 == --json ]] && echo '{"pid":42,"port":3000,"name":"node"}'`,
      "exit 0"
    ].join("\n"), { mode: 0o755 })
  }
  if (withLsof) fs.writeFileSync(path.join(bin, "lsof"), "#!/bin/bash\n", { mode: 0o755 })
  // The fake monitor is Node renamed to port-kill-console.
  let monitorProcess = null
  if (withPortKill && monitor) {
    monitorProcess = spawn(process.execPath, ["-e", [
      "process.title = 'port-kill-console'",
      "process.on('SIGTERM', () => process.exit(143))",
      "console.log('ready')",
      "setInterval(() => {}, 1000)"
    ].join(";")], { stdio: ["ignore", "pipe", "ignore"] })
    t.after(() => monitorProcess.kill("SIGKILL"))
    await once(monitorProcess.stdout, "data")
    fs.symlinkSync(`/proc/${monitorProcess.pid}`, path.join(proc, String(monitorProcess.pid)))
  }

  // Only the fake binaries are on PATH, and HOME hides any real
  // ~/.local/bin/port-kill-console.
  const env = { PATH: bin, HOME: dir, PORT_KILL_PROC_ROOT: proc }
  const run = (...args) => spawnSync("/bin/bash", [script, ...args], { encoding: "utf8", env })
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []
  return { run, calls, monitor: monitorProcess }
}

test("list returns Port Kill's JSON records without log lines", async t => {
  const { run } = await fakeEnv(t)
  const result = run("list")
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '{"pid":42,"port":3000,"name":"node"}\n')
})

test("kill passes one port to Port Kill", async t => {
  const { run, calls } = await fakeEnv(t)
  assert.equal(run("kill", "3000").status, 0)
  assert.deepEqual(calls(), ["--ports 3000 --kill-all"])
})

test("kill-all uses Port Kill's default range", async t => {
  const { run, calls } = await fakeEnv(t)
  assert.equal(run("kill-all").status, 0)
  assert.deepEqual(calls(), ["--kill-all"])
})

test("invalid ports never reach Port Kill", async t => {
  const { run, calls } = await fakeEnv(t)
  assert.equal(run("kill", "nope").status, 2)
  for (const port of ["70000", "0", "-1", "3000oops", "999999999999999999999999"]) {
    assert.equal(run("kill", port).status, 2)
  }
  assert.deepEqual(calls(), [])
})

test("list reports a stopped Port Kill without calling it", async t => {
  const { run, calls } = await fakeEnv(t, { monitor: false })
  assert.equal(run("list").status, 5)
  assert.deepEqual(calls(), [])
})

test("quit stops the running monitor before returning", async t => {
  const { run, monitor } = await fakeEnv(t)
  const exited = once(monitor, "exit")
  assert.equal(run("quit").status, 0)
  const [code] = await exited
  assert.equal(code, 143)
  assert.equal(run("list").status, 5)
})

test("missing Port Kill and missing lsof have their own exit codes", async t => {
  const env = await fakeEnv(t, { withPortKill: false })
  assert.equal(env.run("kill-all").status, 3)
  assert.equal((await fakeEnv(t, { withLsof: false })).run("list").status, 4)
})

// Opt in to the integration test. It only stops the listener it creates.
const realPortKill = spawnSync("bash", ["-c", 'PATH="$HOME/.local/bin:$PATH"; command -v port-kill-console && command -v lsof'], { encoding: "utf8" })
test("real Port Kill lists and stops a listener", { timeout: 15000, skip: process.env.PORT_KILL_INTEGRATION !== "1" ? "set PORT_KILL_INTEGRATION=1 to run" : realPortKill.status !== 0 && "Port Kill or lsof is not installed" }, async t => {
  const monitor = spawn("bash", ["-c", 'PATH="$HOME/.local/bin:$PATH" exec port-kill-console'], { stdio: "ignore" })
  t.after(() => monitor.kill("SIGKILL"))

  const child = spawn(process.execPath, ["-e", [
    "const net = require('node:net')",
    "const server = net.createServer(() => {})",
    "let port = 8900",
    "server.on('error', e => { if (e.code === 'EADDRINUSE' && port < 8999) server.listen(++port, '127.0.0.1'); else throw e })",
    "server.listen(port, '127.0.0.1', () => console.log(server.address().port))"
  ].join(";")], { stdio: ["ignore", "pipe", "inherit"] })
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL") })
  const [chunk] = await once(child.stdout, "data")
  const port = Number(String(chunk).trim())

  // Wait for the monitor to start before listing.
  let list
  for (let attempt = 0; attempt < 30; attempt++) {
    list = spawnSync("bash", [script, "list"], { encoding: "utf8" })
    if (list.status !== 5) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(list.status, 0, list.stderr)
  assert.ok(M.parsePortKill(list.stdout).some(row => row.port === port && row.pid === child.pid))
  const exited = once(child, "exit")

  const kill = spawnSync("bash", [script, "kill", String(port)], { encoding: "utf8" })
  assert.equal(kill.status, 0, kill.stderr)
  await exited
})

test("leading zero ports are passed as decimal", async t => {
  const { run, calls } = await fakeEnv(t)
  assert.equal(run("kill", "08000").status, 0)
  assert.deepEqual(calls(), ["--ports 8000 --kill-all"])
})

test("usage errors never call the backend", async t => {
  const { run, calls } = await fakeEnv(t)
  for (const args of [[], ["unknown"], ["list", "extra"], ["kill"], ["quit", "extra"], ["kill-all", "extra"]]) {
    assert.equal(run(...args).status, 2)
  }
  assert.deepEqual(calls(), [])
})
