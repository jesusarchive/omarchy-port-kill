const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { once } = require("node:events")
const { spawn, spawnSync } = require("node:child_process")
const M = require("../Model.js")

const root = path.resolve(__dirname, "..")
const script = path.join(root, "portkill.sh")
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until(predicate, timeout = 3000, message = "condition") {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error("Timed out waiting for " + message)
    await sleep(20)
  }
}

function writeExecutable(file, lines) {
  fs.writeFileSync(file, ["#!/bin/bash", ...lines].join("\n") + "\n", { mode: 0o755 })
}

// An isolated environment: fake Port Kill binaries, a fake omarchy-shell that
// logs IPC calls, a private lease directory, and a HOME that hides any real
// ~/.local/bin. Only system tools come from /usr/bin.
function fakeEnv(t, { withPortKill = true, withLsof = true, withShell = true, withPython = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portkill-test-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const bin = path.join(dir, "bin")
  const tools = path.join(dir, "tools")
  fs.mkdirSync(bin)
  fs.mkdirSync(tools)
  // /usr/bin has python3 and lsof, so expose only the tools the script uses.
  for (const tool of ["bash", "timeout", "mkdir", "rm", "sleep", "cat", "env", "sort", "grep", "setsid", "flock"]) {
    fs.symlinkSync(spawnSync("which", [tool], { encoding: "utf8" }).stdout.trim(), path.join(tools, tool))
  }
  if (withPython) fs.symlinkSync(spawnSync("which", ["python3"], { encoding: "utf8" }).stdout.trim(), path.join(tools, "python3"))
  const log = path.join(dir, "args.log")
  const ipcLog = path.join(dir, "ipc.log")
  if (withShell) writeExecutable(path.join(bin, "omarchy-shell"), [`printf '%s\\n' "$*" >> '${ipcLog}'`])
  const consolePath = path.join(bin, "port-kill-console")
  if (withPortKill) {
    // Like the real binary: a debug line, then one JSON record for --json.
    writeExecutable(consolePath, [
      `printf '%s\\n' "$*" >> '${log}'`,
      "echo 'DEBUG: Creating ProcessMonitor'",
      `[[ $1 == --json ]] && echo '{"pid":42,"port":3000,"name":"node"}'`,
      "exit 0"
    ])
  }
  if (withLsof) writeExecutable(path.join(bin, "lsof"), [])
  const state = path.join(dir, "state")
  const env = { PATH: `${bin}:${tools}`, HOME: dir, PORT_KILL_STATE_DIR: state }
  const leases = () => {
    try { return fs.readdirSync(path.join(state, "monitors")).sort() } catch { return [] }
  }
  const run = (args, options = {}) => spawnSync("bash", [script, ...args], { encoding: "utf8", env, ...options })
  const start = (args, options = {}) => spawn("bash", [script, ...args], { env, stdio: ["ignore", "pipe", "pipe"], ...options })
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []
  const ipcCalls = () => fs.existsSync(ipcLog) ? fs.readFileSync(ipcLog, "utf8").trim().split("\n") : []
  return { dir, bin, env, state, consolePath, leases, run, start, calls, ipcCalls }
}

// A monitor that stays up until signalled, reporting its PID.
function monitorConsole(env, extra = []) {
  writeExecutable(env.consolePath, [
    "echo \"monitor $$ $*\"",
    ...extra,
    "while :; do sleep 0.05; done"
  ])
}

function tracked(t, env, args = ["launch"]) {
  const child = env.start(args, { detached: true })
  t.after(() => { try { process.kill(-child.pid, "SIGKILL") } catch {} })
  return child
}

// Resolve with the first line, and keep draining so the writer never gets
// SIGPIPE.
function firstLine(stream) {
  return new Promise(resolve => {
    let text = ""
    stream.on("data", chunk => {
      text += chunk
      if (text.includes("\n")) resolve(text.split("\n")[0])
    })
    stream.on("end", () => resolve(text))
  })
}

function watchEvents(t, env, interval = "60") {
  const watch = spawn("bash", [script, "watch", interval], { env: env.env, stdio: ["pipe", "pipe", "pipe"] })
  t.after(() => watch.kill("SIGKILL"))
  const lines = []
  watch.stdout.on("data", chunk => lines.push(...String(chunk).trim().split("\n")))
  const exited = once(watch, "exit")
  const count = n => until(() => lines.includes(`{"count": ${n}, "type": "monitors"}`), 3000, `count ${n}`)
  return { watch, lines, exited, count }
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

test("launch preserves output and exit status with quieter default logging", t => {
  const env = fakeEnv(t)
  writeExecutable(env.consolePath, [
    "env | grep -v '^_=' | sort",
    'printf "console stderr\\n" >&2',
    "exit 7"
  ])
  for (const settings of [{}, { RUST_LOG: "info", LC_ALL: "C", LANG: "C", SHLVL: "3" }]) {
    const options = { encoding: "utf8", env: { ...env.env, ...settings } }
    // Run the console the way a shell would: from bash, with the same variables.
    const direct = spawnSync("bash", ["-c", 'exec "$0"', env.consolePath], {
      ...options, env: { ...options.env, RUST_LOG: options.env.RUST_LOG || "warn" }
    })
    const wrapped = spawnSync("bash", [script, "launch"], options)
    assert.equal(wrapped.status, 7)
    assert.equal(wrapped.status, direct.status)
    assert.equal(wrapped.stdout, direct.stdout)
    assert.equal(wrapped.stderr, direct.stderr)
  }
})

test("launch keeps the terminal for the console", t => {
  const env = fakeEnv(t)
  writeExecutable(env.consolePath, [
    "[[ -t 0 && -t 1 && -t 2 ]] && echo tty || echo no-tty",
    "read -r line && echo \"read $line\""
  ])
  const result = spawnSync("script", ["-qec", `bash ${script} launch`, "/dev/null"], {
    encoding: "utf8", env: { ...env.env, PATH: env.env.PATH + ":/usr/bin" }, input: "hello\n", timeout: 5000
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /tty/)
  assert.doesNotMatch(result.stdout, /no-tty/)
  assert.match(result.stdout, /read hello/)
})

test("launch registers the monitor while it runs and notifies the bar", async t => {
  const env = fakeEnv(t)
  monitorConsole(env)
  const child = tracked(t, env)
  const pid = Number((await firstLine(child.stdout)).split(" ")[1])
  const [lease] = await until(() => env.leases().length && env.leases(), 2000, "lease")
  // The lease names the console process itself.
  assert.equal(Number(lease.split(".")[0]), pid)
  await until(() => env.ipcCalls().some(call => /^jesusarchive\.port-kill\.service started \d+\.\d+$/.test(call)), 3000, "IPC")
  const exited = once(child, "exit")
  process.kill(pid, "SIGTERM")
  assert.deepEqual(await exited, [143, null])
  assert.deepEqual(env.leases(), [])
})

test("launch still runs without the Omarchy shell or Python", t => {
  const env = fakeEnv(t, { withShell: false, withPython: false })
  const result = env.run(["launch"])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Creating ProcessMonitor/)
})

test("Quit preserves backend stderr without dumping the monitor wrapper", async t => {
  const env = fakeEnv(t)
  monitorConsole(env, ['echo "backend diagnostic" >&2'])
  const child = tracked(t, env)
  let stderr = ""
  child.stderr.on("data", chunk => { stderr += chunk })
  await firstLine(child.stdout)
  const closed = once(child, "close")
  const result = env.run(["quit"])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await closed, [143, null])
  assert.equal(stderr, "backend diagnostic\n")
  assert.deepEqual(env.leases(), [])
})

test("Ctrl+C stops the monitor as if run directly and removes its lease", async t => {
  const env = fakeEnv(t)
  for (const [handler, expected] of [
    ["", [null, "SIGINT"]],
    // A console that handles Ctrl+C and exits cleanly.
    ["trap 'echo bye; exit 0' INT", [0, null]]
  ]) {
    monitorConsole(env, handler ? [handler] : [])
    // setsid gives the wrapper its own process group, like a terminal job.
    const child = tracked(t, env)
    await firstLine(child.stdout)
    await until(() => env.leases().length === 1, 2000, "lease")
    const exited = once(child, "exit")
    process.kill(-child.pid, "SIGINT")
    assert.deepEqual(await exited, expected)
    assert.deepEqual(env.leases(), [])
  }
})

test("a crashed monitor's status is passed on and its lease removed", async t => {
  const env = fakeEnv(t)
  monitorConsole(env)
  const child = tracked(t, env)
  let stderr = ""
  child.stderr.on("data", chunk => { stderr += chunk })
  const pid = Number((await firstLine(child.stdout)).split(" ")[1])
  await until(() => env.leases().length === 1, 2000, "lease")
  const exited = once(child, "close")
  process.kill(pid, "SIGKILL")
  assert.deepEqual(await exited, [137, null])
  assert.equal(stderr, "Port Kill monitor exited with status 137\n")
  assert.deepEqual(env.leases(), [])
})

test("a killed wrapper leaves a valid lease the watcher tracks until the monitor exits", async t => {
  const env = fakeEnv(t)
  monitorConsole(env)
  const child = tracked(t, env)
  const pid = Number((await firstLine(child.stdout)).split(" ")[1])
  await until(() => env.leases().length === 1, 2000, "lease")
  process.kill(child.pid, "SIGKILL")
  await once(child, "exit")
  assert.ok(alive(pid))
  const { exited, count } = watchEvents(t, env)
  await count(1)
  process.kill(pid, "SIGKILL")
  await count(0)
  assert.deepEqual(await exited, [0, null])
  assert.deepEqual(env.leases(), [])
})

test("several monitors are tracked independently", async t => {
  const env = fakeEnv(t)
  monitorConsole(env)
  const first = tracked(t, env)
  const second = tracked(t, env, ["run", "port-kill-console", "--ports", "3000"])
  const pids = [Number((await firstLine(first.stdout)).split(" ")[1]), Number((await firstLine(second.stdout)).split(" ")[1])]
  await until(() => env.leases().length === 2, 2000, "two leases")
  const { exited, count } = watchEvents(t, env)
  await count(2)
  process.kill(pids[0], "SIGTERM")
  await count(1)
  assert.equal(env.leases().length, 1)
  process.kill(pids[1], "SIGTERM")
  await count(0)
  assert.deepEqual(await exited, [0, null])
})

test("one-shot commands run directly and never register", t => {
  const env = fakeEnv(t)
  writeExecutable(path.join(env.bin, "port-kill"), [
    'printf "port-kill %s\\n" "$*"', 'echo err >&2', "exit 3"
  ])
  writeExecutable(env.consolePath, [
    'printf "console %s\\n" "$*"', 'echo err >&2', "exit 3"
  ])
  for (const binary of ["port-kill", "port-kill-console"]) {
    for (const args of [["3000"], ["--json"], ["--kill-all"], ["--list"], ["--help"], ["-V"],
      ["--ports", "3000", "--kill-all"], ["--ports"], ["cache", "list"], ["--guard-mode"], ["-vd"]]) {
      const result = env.run(["run", binary, ...args])
      assert.equal(result.status, 3, `${binary} ${args.join(" ")}`)
      assert.equal(result.stdout, `${binary === "port-kill" ? "port-kill" : "console"} ${args.join(" ")}\n`)
      assert.equal(result.stderr, "err\n")
    }
  }
  assert.deepEqual(env.leases(), [])
  assert.deepEqual(env.ipcCalls(), [])
})

test("monitor options register the monitor and are passed through", async t => {
  const env = fakeEnv(t)
  monitorConsole(env)
  for (const args of [[], ["--ports", "3000,5173", "-v"], ["-s", "3000", "-e", "4000", "--docker"], ["--log-level=warn", "--smart-filter"]]) {
    const child = tracked(t, env, ["run", "port-kill-console", ...args])
    const line = await firstLine(child.stdout)
    assert.equal(line.replace(/^monitor \d+ ?/, ""), args.join(" "))
    await until(() => env.leases().length === 1, 2000, "lease")
    const exited = once(child, "exit")
    process.kill(Number(line.split(" ")[1]), "SIGTERM")
    await exited
    assert.deepEqual(env.leases(), [])
  }
})

test("the Bash integration forwards to the real binaries without recursion", async t => {
  const env = fakeEnv(t)
  writeExecutable(path.join(env.bin, "port-kill"), ['printf "real port-kill %s\\n" "$*"', "exit 4"])
  const shell = args => spawnSync("bash", ["-c", `source '${path.join(root, "port-kill.bash")}'; ${args}`], { encoding: "utf8", env: env.env })
  let result = shell("port-kill 3000 --json; echo status=$?")
  assert.equal(result.stdout, "real port-kill 3000 --json\nstatus=4\n")
  assert.equal(shell("type -t port-kill; type -t port-kill-console").stdout, "function\nfunction\n")
  // A monitor started through the function registers.
  monitorConsole(env)
  const child = spawn("bash", ["-c", `source '${path.join(root, "port-kill.bash")}'; port-kill-console --ports 3000`], {
    env: env.env, stdio: ["ignore", "pipe", "pipe"], detached: true
  })
  t.after(() => { try { process.kill(-child.pid, "SIGKILL") } catch {} })
  const line = await firstLine(child.stdout)
  await until(() => env.leases().length === 1, 2000, "lease")
  const exited = once(child, "exit")
  process.kill(Number(line.split(" ")[1]), "SIGTERM")
  await exited
  // With the plugin removed, the functions fall back to the binaries.
  const copy = path.join(env.dir, "port-kill.bash")
  fs.copyFileSync(path.join(root, "port-kill.bash"), copy)
  result = spawnSync("bash", ["-c", `source '${copy}'; port-kill 1; echo status=$?`], { encoding: "utf8", env: env.env })
  assert.equal(result.stdout, "real port-kill 1\nstatus=4\n")
})

test("list prints Port Kill's stdout for the bar to parse", t => {
  const env = fakeEnv(t)
  const result = env.run(["list"])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'DEBUG: Creating ProcessMonitor\n{"pid":42,"port":3000,"name":"node"}\n')
  assert.deepEqual(M.parsePortKill(result.stdout).errors, [])
  // Background commands never register or notify.
  assert.deepEqual(env.leases(), [])
  assert.deepEqual(env.ipcCalls(), [])
})

test("list reports backend failures", t => {
  const env = fakeEnv(t)
  writeExecutable(env.consolePath, ["echo partial", "exit 2"])
  const result = env.run(["list"])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /could not list/)
})

test("a hung scan times out and its child processes are stopped", async t => {
  const env = fakeEnv(t)
  const pidFile = path.join(env.dir, "grandchild.pid")
  writeExecutable(env.consolePath, [
    `sleep 60 & echo $! > '${pidFile}'`,
    "trap '' TERM", // ignore the polite request; the kill grace takes over
    "sleep 60"
  ])
  const started = Date.now()
  const result = env.run(["list"], { env: { ...env.env, PORT_KILL_SCAN_TIMEOUT: "1" } })
  const elapsed = Date.now() - started
  assert.equal(result.status, 6)
  assert.match(result.stderr, /did not finish within 1 seconds/)
  assert.ok(elapsed < 5000, `took ${elapsed} ms`)
  const grandchild = Number(fs.readFileSync(pidFile, "utf8"))
  await until(() => !alive(grandchild), 2000, "grandchild to stop")
})

test("a hung action times out and is not retried", t => {
  const env = fakeEnv(t)
  writeExecutable(env.consolePath, [`printf '%s\\n' "$*" >> '${path.join(env.dir, "args.log")}'`, "sleep 60"])
  const result = env.run(["kill", "3000"], { env: { ...env.env, PORT_KILL_ACTION_TIMEOUT: "1" } })
  assert.equal(result.status, 6)
  assert.deepEqual(env.calls(), ["--ports 3000 --kill-all"])
})

test("kill passes one port to Port Kill, which stops every listener on it", t => {
  const env = fakeEnv(t)
  assert.equal(env.run(["kill", "3000"]).status, 0)
  assert.equal(env.run(["kill", "08000"]).status, 0)
  assert.deepEqual(env.calls(), ["--ports 3000 --kill-all", "--ports 8000 --kill-all"])
})

test("kill-all uses Port Kill's default range", t => {
  const env = fakeEnv(t)
  assert.equal(env.run(["kill-all"]).status, 0)
  assert.deepEqual(env.calls(), ["--kill-all"])
})

test("invalid ports never reach Port Kill", t => {
  const env = fakeEnv(t)
  for (const port of ["nope", "70000", "0", "-1", "3000oops", "999999999999999999999999"]) {
    assert.equal(env.run(["kill", port]).status, 2)
  }
  assert.deepEqual(env.calls(), [])
})

test("missing dependencies have their own exit codes", t => {
  assert.equal(fakeEnv(t, { withPortKill: false }).run(["kill-all"]).status, 3)
  assert.equal(fakeEnv(t, { withPortKill: false }).run(["list"]).status, 3)
  assert.equal(fakeEnv(t, { withLsof: false }).run(["list"]).status, 4)
  const noPython = fakeEnv(t, { withPython: false })
  for (const action of ["watch", "quit", "logs-focus"]) {
    const result = noPython.run([action])
    assert.equal(result.status, 3)
    assert.match(result.stderr, /Python 3/)
  }
  const missing = fakeEnv(t, { withPortKill: false }).run(["run", "port-kill"])
  assert.equal(missing.status, 127)
  for (const tool of ["python3", "timeout", "flock"]) {
    const env = fakeEnv(t)
    fs.unlinkSync(path.join(env.dir, "tools", tool))
    const result = env.run(["list"])
    assert.equal(result.status, 3, tool)
    assert.match(result.stderr, new RegExp(tool))
    assert.deepEqual(env.calls(), [], "missing dependency prevents scanning")
  }
})

test("quit stops registered monitors and leaves everything else running", async t => {
  const env = fakeEnv(t)
  monitorConsole(env)
  const child = tracked(t, env)
  await firstLine(child.stdout)
  await until(() => env.leases().length === 1, 2000, "lease")
  // An unregistered monitor with the same name, like one started before the
  // integration was enabled.
  const other = spawn(env.consolePath, [], { stdio: ["ignore", "pipe", "ignore"] })
  t.after(() => other.kill("SIGKILL"))
  await firstLine(other.stdout)
  const exited = once(child, "exit")
  const result = env.run(["quit"])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(await exited, [143, null])
  assert.equal(other.exitCode, null)
  assert.ok(alive(other.pid))
  assert.deepEqual(env.leases(), [])
  assert.equal(env.run(["quit"]).status, 0)
})

test("quit finds its helper when invoked without a directory", t => {
  const env = fakeEnv(t)
  const result = spawnSync("bash", ["portkill.sh", "quit"], { cwd: root, env: env.env, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
})

test("usage errors never call the backend", t => {
  const env = fakeEnv(t)
  for (const args of [[], ["unknown"], ["list", "extra"], ["kill"], ["quit", "extra"], ["kill-all", "extra"],
    ["launch", "extra"], ["watch", "1", "invalid"], ["run"], ["run", "ls"]]) {
    assert.equal(env.run(args).status, 2, args.join(" "))
  }
  assert.deepEqual(env.calls(), [])
})

// Opt in to the integration test. It only stops the listener it creates.
const realPortKill = spawnSync("bash", ["-c", 'PATH="$HOME/.local/bin:$PATH"; command -v port-kill-console && command -v lsof'], { encoding: "utf8" })
test("real Port Kill lists and stops only a test-owned listener", { timeout: 30000, skip: process.env.PORT_KILL_INTEGRATION !== "1" ? "set PORT_KILL_INTEGRATION=1 to run" : realPortKill.status !== 0 && "Port Kill or lsof is not installed" }, async t => {
  const child = spawn(process.execPath, ["-e", [
    "const net = require('node:net')",
    "const server = net.createServer(() => {})",
    "let port = 8900",
    "server.on('error', e => { if (e.code === 'EADDRINUSE' && port < 8999) server.listen(++port, '127.0.0.1'); else throw e })",
    "server.listen(port, '127.0.0.1', () => console.log(server.address().port))"
  ].join(";")], { stdio: ["ignore", "pipe", "inherit"] })
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL") })
  const port = Number(await firstLine(child.stdout))
  assert.ok(port >= 8900 && port <= 8999)

  const list = spawnSync("bash", [script, "list"], { encoding: "utf8" })
  assert.equal(list.status, 0, list.stderr)
  const parsed = M.parsePortKill(list.stdout)
  assert.deepEqual(parsed.errors, [])
  assert.ok(parsed.rows.some(row => row.port === port && row.pid === child.pid))

  const exited = once(child, "exit")
  const kill = spawnSync("bash", [script, "kill", String(port)], { encoding: "utf8" })
  assert.equal(kill.status, 0, kill.stderr)
  await exited
})

test("cancelling a scan stops the backend and children even when TERM is ignored", { timeout: 8000 }, async t => {
  const env = fakeEnv(t);
  const pids = path.join(env.dir, "pids");
  writeExecutable(env.consolePath, [
    "trap '' TERM",
    `sleep 60 & printf '%s %s\\n' "$$" "$!" > '${pids}'`,
    "wait"
  ]);
  const child = tracked(t, env, ["list"]);
  await until(() => fs.existsSync(pids), 2000, "backend starts");
  const owned = fs.readFileSync(pids, "utf8").trim().split(" ").map(Number);
  t.after(() => { for (const pid of owned) { try { process.kill(pid, "SIGKILL") } catch {} } });
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [143, null]);
  await until(() => owned.every(pid => !alive(pid)), 2000, "cancelled children to stop");
});
