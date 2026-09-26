// Runs Service.qml in a private Quickshell instance with a fake Port Kill,
// and drives it the way terminals and the menu do. Needs quickshell and a
// Wayland session, so it is opt-in: PORT_KILL_QML=1 node --test tests/
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const net = require("node:net")
const os = require("node:os")
const path = require("node:path")
const { once } = require("node:events")
const { spawn, spawnSync } = require("node:child_process")

const root = path.resolve(__dirname, "..")
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const hasQs = spawnSync("bash", ["-c", "command -v qs"]).status === 0
const skip = process.env.PORT_KILL_QML !== "1" ? "set PORT_KILL_QML=1 to run"
  : !hasQs || !process.env.WAYLAND_DISPLAY ? "needs quickshell in a Wayland session" : false

async function until(predicate, timeout, message) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error("Timed out waiting for " + message)
    await sleep(50)
  }
}

function writeExecutable(file, lines) {
  fs.writeFileSync(file, ["#!/bin/bash", ...lines].join("\n") + "\n", { mode: 0o755 })
}

const record = (pid, port, name) => JSON.stringify({ pid, port, name, command: name, container_name: null })

function harness(t, { maxAgeMs = 4000, backendMissing = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portkill-qml-"))
  const config = path.join(dir, "config")
  const bin = path.join(dir, "bin")
  const ctl = path.join(dir, "ctl")
  for (const d of [config, bin, ctl]) fs.mkdirSync(d)
  for (const file of ["Service.qml", "LogTerminal.qml", "CommandWatchdog.qml", "Model.js", "Scheduler.js", "portkill.sh", "monitors.py", "terminal_logs.py"]) {
    fs.copyFileSync(path.join(root, file), path.join(config, file))
  }
  fs.writeFileSync(path.join(config, "shell.qml"), fs.readFileSync(path.join(__dirname, "qml", "shell.qml"), "utf8")
    .replace("maxAgeMs: 4000", `maxAgeMs: ${maxAgeMs}`))
  const consolePath = path.join(bin, "port-kill-console")
  // The fake reads its behaviour from ctl/ when it starts, so a slow scan
  // reports the state it began with.
  writeExecutable(consolePath, [
    `ctl='${ctl}'`,
    'printf "%s %s\\n" "$(date +%s%3N)" "$*" >> "$ctl/calls.log"',
    "case ${1:-} in",
    "  --json)",
    '    out=$(cat "$ctl/list.out" 2>/dev/null)',
    '    [[ -f $ctl/list.sleep ]] && sleep "$(<"$ctl/list.sleep")"',
    '    [[ -n $out ]] && printf "%s\\n" "$out"',
    '    exit "$(cat "$ctl/list.exit" 2>/dev/null || echo 0)";;',
    "  --ports|--kill-all)",
    '    [[ -f $ctl/kill.sleep ]] && sleep "$(<"$ctl/kill.sleep")"',
    '    exit "$(cat "$ctl/kill.exit" 2>/dev/null || echo 0)";;',
    '  "")',
    '    echo "monitor $$"',
    "    while :; do sleep 0.05; done;;",
    "esac"
  ])
  writeExecutable(path.join(bin, "lsof"), [])
  // The wrapper's bar notification reaches this instance only.
  writeExecutable(path.join(bin, "omarchy-shell"), [
    '[[ $1 == -q ]] && shift',
    `exec qs ipc -p '${config}' call "$@"`
  ])
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    PORT_KILL_STATE_DIR: path.join(dir, "state"),
    PORT_KILL_CONSOLE: consolePath
  }
  const shellEnv = backendMissing ? { ...env, PORT_KILL_CONSOLE: path.join(dir, "missing") } : env
  const h = {
    dir, config, ctl, env, qs: null, monitors: [],
    set(name, value) { fs.writeFileSync(path.join(ctl, name), String(value)) },
    unset(name) { fs.rmSync(path.join(ctl, name), { force: true }) },
    calls(pattern = "--json") {
      const file = path.join(ctl, "calls.log")
      if (!fs.existsSync(file)) return []
      return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
        .map(line => ({ at: Number(line.split(" ")[0]), args: line.split(" ").slice(1).join(" ") }))
        .filter(call => call.args.startsWith(pattern))
    },
    async start() {
      h.qs = spawn("qs", ["-p", config], { env: shellEnv, stdio: ["ignore", "ignore", "pipe"] })
      h.log = ""
      h.qs.stderr.on("data", chunk => { h.log += chunk })
      await until(() => h.tryState(), 10000, "quickshell to answer")
    },
    async stopShell(signal = "SIGTERM") {
      if (!h.qs || h.qs.exitCode !== null || h.qs.signalCode) return
      const exited = once(h.qs, "exit")
      h.qs.kill(signal)
      await exited
    },
    tryState() {
      const result = spawnSync("qs", ["ipc", "-p", config, "call", "harness", "state"], { encoding: "utf8", env, timeout: 3000 })
      if (result.status !== 0) return null
      try { return JSON.parse(result.stdout) } catch { return null }
    },
    state() {
      const state = h.tryState()
      assert.ok(state, "harness state\n" + h.log)
      return state
    },
    call(fn, ...args) {
      const result = spawnSync("qs", ["ipc", "-p", config, "call", "harness", fn, ...args.map(String)], { encoding: "utf8", env })
      assert.equal(result.status, 0, result.stderr)
    },
    wait(predicate, timeout = 5000, message = "state") {
      return until(() => { const s = h.tryState(); return s && predicate(s) ? s : null }, timeout, message)
    },
    // A monitor started the way the desktop launcher does it.
    async launch() {
      const child = spawn("bash", [path.join(config, "portkill.sh"), "launch"], { env, stdio: ["ignore", "pipe", "ignore"], detached: true })
      h.monitors.push(child)
      const [chunk] = await once(child.stdout, "data")
      child.stdout.resume()
      child.monitorPid = Number(String(chunk).split(" ")[1])
      return child
    },
    // Processes started by the shell, such as the watcher and scans.
    children() {
      if (!h.qs || h.qs.exitCode !== null) return []
      const pids = []
      for (const task of fs.readdirSync(`/proc/${h.qs.pid}/task`)) {
        const text = fs.readFileSync(`/proc/${h.qs.pid}/task/${task}/children`, "utf8").trim()
        if (text) pids.push(...text.split(" ").map(Number))
      }
      return pids.map(pid => {
        try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim() } catch { return "" }
      }).filter(Boolean)
    },
    watchers() {
      return fs.readdirSync("/proc").filter(p => /^\d+$/.test(p)).filter(pid => {
        try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(path.join(config, "monitors.py")) } catch { return false }
      })
    }
  }
  h.set("list.out", record(4242, 3000, "node"))
  t.after(async () => {
    for (const child of h.monitors) { try { process.kill(-child.pid, "SIGKILL") } catch {} }
    await h.stopShell("SIGKILL")
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return h
}

async function stopMonitor(child, signal = "SIGTERM") {
  const exited = once(child, "exit")
  process.kill(child.monitorPid, signal)
  return exited
}

// A listener owned by this test in 8900-8999; nothing else is touched.
async function testListener(port) {
  for (let candidate = port || 8900; candidate <= 8999; candidate++) {
    const server = net.createServer(socket => socket.destroy())
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(candidate, "127.0.0.1", resolve)
      })
      return server
    } catch (error) {
      if (port) throw error
    }
  }
  throw new Error("no free test port")
}

test("while stopped the shell runs nothing and never scans", { skip, timeout: 30000 }, async t => {
  const h = harness(t)
  await h.start()
  await until(() => h.children().length === 0, 3000, "startup reconciliation to finish")
  await sleep(3000)
  assert.equal(h.state().active, false)
  assert.deepEqual(h.children(), [])
  assert.deepEqual(h.calls(""), [])
})

test("a launched monitor shows the widget, and its exit hides it and stops polling", { skip, timeout: 30000 }, async t => {
  const h = harness(t)
  await h.start()
  const monitor = await h.launch()
  const state = await h.wait(s => s.active && s.status === "ready", 5000, "active and ready")
  assert.deepEqual(state.rows.map(row => row.key), ["3000:4242"])
  assert.ok(h.children().some(cmd => cmd.includes("monitors.py watch")))
  await stopMonitor(monitor)
  await h.wait(s => !s.active, 3000, "inactive")
  await until(() => h.children().length === 0, 3000, "children to exit")
  const scans = h.calls().length
  await sleep(3000)
  assert.equal(h.calls().length, scans)
  assert.deepEqual(h.children(), [])
})

test("one-shot commands leave the widget hidden", { skip, timeout: 30000 }, async t => {
  const h = harness(t)
  await h.start()
  const script = path.join(h.config, "portkill.sh")
  for (const args of [["run", "port-kill-console", "--json"], ["run", "port-kill-console", "3000"], ["list"], ["kill-all"]]) {
    assert.equal(spawnSync("bash", [script, ...args], { env: h.env, timeout: 5000 }).status, 0, args.join(" "))
  }
  await sleep(1500)
  assert.equal(h.state().active, false)
  // Only the two direct --json runs above; the bar started no scans.
  assert.equal(h.calls().length, 2)
  assert.deepEqual(h.children(), [])
})

test("several monitors, crashes and a missed exit keep the count right", { skip, timeout: 30000 }, async t => {
  const h = harness(t)
  await h.start()
  const first = await h.launch()
  const second = await h.launch()
  await h.wait(s => s.monitorCount === 2, 5000, "two monitors")
  // Kill the wrapper first so nothing reports the exit, then crash the monitor.
  process.kill(first.pid, "SIGKILL")
  await stopMonitor(first, "SIGKILL")
  await h.wait(s => s.monitorCount === 1 && s.active, 3000, "one monitor")
  await stopMonitor(second, "SIGKILL")
  await h.wait(s => !s.active, 3000, "inactive")
})

test("a shell restart finds running monitors and the old watcher exits", { skip, timeout: 40000 }, async t => {
  const h = harness(t)
  await h.start()
  const monitor = await h.launch()
  await h.wait(s => s.active, 5000, "active")
  assert.equal(h.watchers().length, 1)
  await h.stopShell("SIGKILL")
  await until(() => h.watchers().length === 0, 3000, "orphaned watcher to exit")
  // Started while the shell is down: its notification is lost.
  const late = await h.launch()
  await h.start()
  await h.wait(s => s.active && s.monitorCount === 2 && s.status === "ready", 5000, "reconciled")
  await stopMonitor(monitor)
  await stopMonitor(late)
  await h.wait(s => !s.active, 3000, "inactive")
})

test("socket changes trigger scans; queued connections do not; same-port replacement does", { skip, timeout: 60000 }, async t => {
  const h = harness(t, { maxAgeMs: 600000 })
  await h.start()
  await h.launch()
  await h.wait(s => s.status === "ready", 5000, "ready")
  await sleep(2000)
  let scans = h.calls().length

  const server = await testListener()
  const port = server.address().port
  t.after(() => server.close())
  await until(() => h.calls().length > scans, 5000, "scan after new listener")
  await sleep(2000)
  scans = h.calls().length

  // A listener that never accepts, so a connection waits in its queue.
  const holder = spawn("python3", ["-c", [
    "import socket, sys, time",
    "s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
    `s.bind(('127.0.0.1', ${port + 1 <= 8999 ? port + 1 : port - 1})); s.listen(8)`,
    "print('ready', flush=True); time.sleep(60)"
  ].join("\n")], { stdio: ["ignore", "pipe", "inherit"] })
  t.after(() => holder.kill("SIGKILL"))
  await once(holder.stdout, "data")
  await until(() => h.calls().length > scans, 5000, "scan after second listener")
  await sleep(2000)
  scans = h.calls().length
  const client = net.connect(port + 1 <= 8999 ? port + 1 : port - 1, "127.0.0.1")
  t.after(() => client.destroy())
  await once(client, "connect")
  await sleep(3000)
  assert.equal(h.calls().length, scans, "a queued connection is not a change")

  // Replace the first listener on the same port.
  await new Promise(resolve => server.close(resolve))
  const replacement = await testListener(port)
  t.after(() => replacement.close())
  await until(() => h.calls().length > scans, 5000, "scan after replacement")
})

test("malformed output is reported, and failed scans retry without socket changes", { skip, timeout: 30000 }, async t => {
  const h = harness(t, { maxAgeMs: 600000 })
  await h.start()
  await h.launch()
  await h.wait(s => s.status === "ready" && s.rows.length === 1, 5000, "ready")
  h.set("list.out", record(4242, 3000, "node") + "\n{truncated")
  h.call("open")
  let state = await h.wait(s => s.status === "error", 5000, "error")
  assert.match(state.scanError, /unrecognized Port Kill record.*Malformed/)
  assert.equal(state.stale, true)
  assert.equal(state.canAct, false)
  assert.equal(state.rows.length, 1, "the last good list is kept, not the partial one")
  h.set("list.out", '{"unexpected":"schema"}')
  state = await h.wait(s => /Incompatible/.test(s.scanError), 5000, "retry reporting incompatible record")
  h.set("list.out", "")
  state = await h.wait(s => s.status === "ready", 5000, "recovered")
  assert.deepEqual(state.rows, [], "empty output is a valid empty list")
  h.set("list.exit", "1")
  h.call("open")
  await h.wait(s => s.status === "error", 5000, "backend failure")
  h.unset("list.exit")
  await h.wait(s => s.status === "ready", 5000, "recovered from backend failure by retrying")
})

test("a missing backend is reported", { skip, timeout: 20000 }, async t => {
  const h = harness(t, { backendMissing: true })
  await h.start()
  await h.launch()
  const state = await h.wait(s => s.active && s.status === "missing", 5000, "missing")
  assert.equal(state.canAct, false)
})

test("a hung scan times out, frees the scheduler and recovers", { skip, timeout: 30000 }, async t => {
  const h = harness(t)
  await h.start()
  await h.launch()
  await h.wait(s => s.status === "ready", 5000, "ready")
  h.set("list.sleep", "30")
  h.call("open")
  const started = Date.now()
  const state = await h.wait(s => s.status === "timeout", 8000, "timeout")
  assert.ok(Date.now() - started < 6000)
  assert.match(state.scanError, /did not finish within 1 seconds/)
  h.unset("list.sleep")
  await h.wait(s => s.status === "ready", 5000, "recovered")
})

test("a hung action times out, releases the menu and is not retried", { skip, timeout: 30000 }, async t => {
  const h = harness(t)
  await h.start()
  await h.launch()
  await h.wait(s => s.canAct, 5000, "actions enabled")
  h.set("kill.sleep", "30")
  h.call("kill", 3000)
  await h.wait(s => s.busy, 2000, "busy")
  const state = await h.wait(s => !s.busy, 8000, "action released")
  assert.match(state.actionError, /not retried/)
  await sleep(3000)
  assert.equal(h.calls("--ports 3000").length, 1)
  h.unset("kill.sleep")
  await h.wait(s => s.canAct, 5000, "actions enabled again")
})

for (const command of ["list", "kill"]) {
  test(`QML watchdog recovers when the ${command} wrapper ignores termination`, { skip, timeout: 25000 }, async t => {
    const h = harness(t)
    const script = path.join(h.config, "portkill.sh")
    fs.renameSync(script, path.join(h.config, "original.sh"))
    writeExecutable(script, [
      `if [[ $1 == ${command} && -f '${h.ctl}/stall' ]]; then`,
      `  echo attempt >> '${h.ctl}/attempts'`,
      // A single process ignores TERM; only the QML watchdog can stop it.
      `  exec python3 -c 'import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)'`,
      'fi',
      `exec bash '${h.config}/original.sh' "$@"`
    ])
    await h.start()
    h.call("mode", "always")
    await h.wait(s => s.canAct, 5000, "actions enabled")
    h.set("stall", "1")
    h.call(command === "list" ? "open" : "kill", ...(command === "list" ? [] : [3000]))
    await until(() => fs.existsSync(path.join(h.ctl, "attempts")), 2000, "stalled wrapper started")
    h.unset("stall")
    const state = await h.wait(s => command === "list" ? s.status === "timeout" : !s.busy,
      9000, "watchdog timeout")
    assert.match(command === "list" ? state.scanError : state.actionError, /did not finish within/)
    if (command === "kill") assert.match(state.actionError, /not retried/)
    await h.wait(s => s.canAct, 5000, "recovered")
    assert.equal(fs.readFileSync(path.join(h.ctl, "attempts"), "utf8").trim(), "attempt")
  })
}

test("a kill during a scan discards the scan's obsolete result", { skip, timeout: 30000 }, async t => {
  const h = harness(t, { maxAgeMs: 600000 })
  await h.start()
  await h.launch()
  await h.wait(s => s.status === "ready", 5000, "ready")
  h.set("list.out", record(1111, 3000, "obsolete"))
  h.set("list.sleep", "0.8")
  h.call("open")
  await until(() => h.calls().some(call => call.args === "--json" && Date.now() - call.at < 500), 2000, "slow scan to start")
  h.call("forceKill", 3000)
  h.set("list.out", record(2222, 3001, "current"))
  const state = await h.wait(s => s.status === "ready" && s.rows.some(row => row.name === "current"), 8000, "fresh rows")
  assert.ok(!state.history.some(entry => entry.rows.some(row => row.includes("obsolete"))), JSON.stringify(state.history))
  assert.equal(h.calls("--ports 3000").length, 1)
})

test("opening the menu refreshes at once", { skip, timeout: 20000 }, async t => {
  const h = harness(t, { maxAgeMs: 600000 })
  await h.start()
  await h.launch()
  await h.wait(s => s.status === "ready", 5000, "ready")
  await sleep(2000)
  const scans = h.calls().length
  h.call("open")
  await until(() => h.calls().length > scans, 1000, "refresh scan")
  // Quiet sockets and a long maximum age: nothing else runs.
  await sleep(2000)
  assert.equal(h.calls().length, scans + 1)
})

test("Quit stops every registered monitor and hides the widget", { skip, timeout: 20000 }, async t => {
  const h = harness(t)
  await h.start()
  const monitors = [await h.launch(), await h.launch()]
  await h.wait(s => s.monitorCount === 2, 5000, "two monitors")
  const exits = monitors.map(child => once(child, "exit"))
  h.call("quit")
  for (const [code] of await Promise.all(exits)) assert.equal(code, 143)
  await h.wait(s => !s.active, 3000, "inactive")
})

test("always active monitors without a terminal and switching back stops all work", { skip, timeout: 25000 }, async t => {
  const h = harness(t);
  h.set("list.out", "");
  await h.start();
  h.call("mode", "always");
  await h.wait(s => s.active && s.status === "ready" && s.canAct, 6000, "always active without a terminal");
  assert.equal(h.state().monitorCount, 0);
  assert.deepEqual(h.state().rows, []);
  assert.equal(h.watchers().length, 1);
  const monitor = await h.launch();
  await h.wait(s => s.monitorCount === 1, 3000, "terminal tracked");
  await stopMonitor(monitor);
  await h.wait(s => s.monitorCount === 0, 3000, "terminal closed");
  assert.equal(h.state().active, true);
  h.call("mode", "terminal");
  await h.wait(s => !s.active, 3000, "inactive again");
  await until(() => h.children().length === 0, 3000, "all children stopped");
  const scans = h.calls().length;
  await sleep(1500);
  assert.equal(h.calls().length, scans);
});

test("mode changes keep an existing terminal active and invalid settings use terminal mode", { skip, timeout: 20000 }, async t => {
  const h = harness(t);
  await h.start();
  const monitor = await h.launch();
  await h.wait(s => s.active && s.status === "ready", 5000, "ready");
  h.call("mode", "always");
  await h.wait(s => s.active && s.monitoringMode === "always", 3000, "always mode");
  h.call("mode", "invalid");
  await h.wait(s => s.monitoringMode === "terminal" && s.monitorCount === 1, 3000, "fallback with terminal");
  assert.equal(h.state().active, true);
  await stopMonitor(monitor);
  await h.wait(s => !s.active, 3000, "last terminal closed");
});

test("a menu refresh and the scan after an action block destructive actions", { skip, timeout: 25000 }, async t => {
  const h = harness(t, { maxAgeMs: 600000 });
  await h.start();
  h.call("mode", "always");
  await h.wait(s => s.canAct, 6000, "initial ready");
  h.set("list.sleep", "0.7");
  h.call("open");
  await h.wait(s => s.refreshing, 2000, "menu scan starts");
  assert.equal(h.state().canAct, false);
  h.call("kill", 3000);
  h.call("killAll");
  assert.equal(h.calls("--ports").length, 0);
  assert.equal(h.calls("--kill-all").length, 0);
  await h.wait(s => s.canAct, 6000, "menu scan ends");
  h.call("kill", 3000);
  await h.wait(s => !s.busy && s.refreshing, 3000, "post-action scan");
  assert.equal(h.state().canAct, false);
  await h.wait(s => s.canAct, 6000, "post-action ready");
  assert.equal(h.calls("--ports").length, 1);
});

test("on-demand logs open once, reopen after closing, and end with the shell", { skip, timeout: 20000 }, async t => {
  const h = harness(t);
  writeExecutable(path.join(h.dir, "bin", "xdg-terminal-exec"), [
    `echo launch >> '${h.ctl}/launches'`,
    'while [[ $# -gt 0 && $1 != -- ]]; do shift; done',
    'shift',
    `"$@" > '${h.ctl}/terminal.log' 2>&1 &`,
    'exit 0'
  ]);
  const pid = () => {
    try { return Number(fs.readFileSync(path.join(h.ctl, "terminal.log"), "utf8").trim().split(" ")[1]); }
    catch { return 0; }
  };
  await h.start();
  h.call("mode", "always");
  assert.equal(pid(), 0);
  await h.wait(s => s.active, 4000, "monitoring active");
  h.call("debug");
  await until(pid, 4000, "debug terminal opened");
  const first = pid();
  h.call("debug");
  await sleep(150);
  assert.equal(fs.readFileSync(path.join(h.ctl, "launches"), "utf8").trim(), "launch");
  process.kill(first, "SIGTERM");
  await until(() => !fs.existsSync(`/proc/${first}`), 4000, "debug terminal manually closed");
  await sleep(150);
  assert.equal(h.state().active, true);
  h.call("debug");
  await until(() => pid() && pid() !== first, 4000, "debug terminal reopened");
  const second = pid();
  h.call("quit");
  await until(() => !fs.existsSync(`/proc/${second}`), 4000, "Quit closes debug terminal");
  await h.wait(s => !s.active && !s.busy, 4000, "Quit completes");
  assert.equal(h.state().monitoringMode, "always");
  await until(() => h.watchers().length === 0 && !h.state().busy, 4000, "Quit stops watcher and action");
  const scans = h.calls().length;
  h.call("open");
  await sleep(300);
  assert.equal(h.calls().length, scans);
  // A newly launched registered monitor explicitly starts the plugin again.
  const resumed = await h.launch();
  await h.wait(s => s.active && s.monitorCount === 1, 4000, "launch after Quit resumes");
  await stopMonitor(resumed);
  await h.wait(s => s.monitorCount === 0, 3000, "resumed terminal closes");
  assert.equal(h.state().active, true);
  h.call("debug");
  await until(() => pid() && pid() !== second, 4000, "debug terminal reopens after Quit");
  const third = pid();
  await h.stopShell("SIGKILL");
  await until(() => !fs.existsSync(`/proc/${third}`), 5000, "debug terminal ended with shell");
});

test("right-click reuses a manually started Port Kill terminal", { skip, timeout: 15000 }, async t => {
  const h = harness(t);
  await h.start();
  const manual = await h.launch();
  await h.wait(s => s.active && s.monitorCount === 1, 4000, "manual monitor");
  writeExecutable(path.join(h.dir, "bin", "hyprctl"), [
    `if [[ $1 == clients ]]; then echo '[{"pid":${manual.monitorPid},"address":"0x123abc","focusHistoryID":0}]';`,
    `else printf '%s\\n' "$*" >> '${h.ctl}/focused'; fi`
  ]);
  writeExecutable(path.join(h.dir, "bin", "xdg-terminal-exec"), [
    `touch '${h.ctl}/duplicate'`
  ]);
  h.call("debug");
  await until(() => fs.existsSync(path.join(h.ctl, "focused")), 3000, "existing terminal focused");
  assert.match(fs.readFileSync(path.join(h.ctl, "focused"), "utf8"), /address:0x123abc/);
  assert.equal(fs.existsSync(path.join(h.ctl, "duplicate")), false);
  assert.ok(fs.existsSync(`/proc/${manual.monitorPid}`));
  await stopMonitor(manual);
});

test("ambiguous terminal windows do not open duplicates or stop monitoring", { skip, timeout: 15000 }, async t => {
  const h = harness(t);
  await h.start();
  h.call("mode", "always");
  const manual = await h.launch();
  await h.wait(s => s.canAct && s.monitorCount === 1, 5000, "monitor ready");
  writeExecutable(path.join(h.dir, "bin", "hyprctl"), [
    `echo '[{"pid":${manual.monitorPid},"address":"0x123abc"},{"pid":${manual.monitorPid},"address":"0x456def"}]'`
  ]);
  writeExecutable(path.join(h.dir, "bin", "xdg-terminal-exec"), [
    `touch '${h.ctl}/duplicate'`
  ]);
  h.call("debug");
  await h.wait(s => s.terminalError.includes("cannot be identified"), 3000, "ambiguity reported");
  assert.equal(fs.existsSync(path.join(h.ctl, "duplicate")), false);
  assert.equal(h.state().actionError, "");
  assert.equal(h.state().active, true);
  assert.equal(h.state().canAct, true);
  await stopMonitor(manual);
  await h.wait(s => s.monitorCount === 0, 3000, "manual terminal closed");
  assert.equal(h.state().active, true);
});

test("late start notifications cannot undo Quit, but a fresh launch can", { skip, timeout: 20000 }, async t => {
  const h = harness(t);
  await h.start(); h.call("mode", "always");
  const old = await h.launch();
  await h.wait(s => s.canAct && s.monitorCount === 1);
  const identity = fs.readdirSync(path.join(h.dir, "state", "monitors"))[0];
  h.call("quit");
  await h.wait(s => !s.active && !s.busy, 5000, "Quit completed");
  const r = spawnSync("qs", ["ipc", "-p", h.config, "call", "jesusarchive.port-kill.service", "started", identity], {env:h.env, encoding:"utf8"});
  assert.equal(r.status, 0, r.stderr);
  await sleep(300);
  assert.equal(h.state().active, false);
  assert.equal(h.watchers().length, 0);
  const current = await h.launch();
  await h.wait(s => s.active && s.monitorCount === 1, 4000, "fresh launch resumed");
  await stopMonitor(current);
  await h.wait(s => s.monitorCount === 0);
  assert.equal(h.state().active, true);
});

test("Quit waits for TERM-ignoring monitors and escalates only registered processes", { skip, timeout: 20000 }, async t => {
  const h = harness(t);
  const binary = h.env.PORT_KILL_CONSOLE;
  fs.writeFileSync(binary, fs.readFileSync(binary,"utf8").replace('echo "monitor $$"', () => 'trap "" TERM\n    echo "monitor $$"'));
  const unrelated = spawn("sleep", ["60"]);
  t.after(() => unrelated.kill());
  await h.start(); h.call("mode", "always");
  const monitor = await h.launch();
  assert.ok(Number.isInteger(monitor.monitorPid));
  await h.wait(s => s.canAct && s.monitorCount === 1);
  h.call("quit");
  assert.equal(h.state().active, true);
  assert.equal(h.state().canAct, false);
  await h.wait(s => !s.active && !s.busy, 6000, "forced monitor shutdown");
  assert.equal(fs.existsSync(`/proc/${monitor.monitorPid}`), false);
  assert.equal(h.state().actionError, "");
  assert.equal(unrelated.exitCode, null);
});

test("failed Quit keeps the error and retry visible", { skip, timeout: 20000 }, async t => {
  const h = harness(t);
  await h.start(); h.call("mode", "always");
  const monitor = await h.launch();
  await h.wait(s => s.canAct && s.monitorCount === 1);
  const script = path.join(h.config,"portkill.sh");
  const original = fs.readFileSync(script,"utf8");
  fs.writeFileSync(script, original.replace('  quit-session)', '  quit-session)\n    echo "Test shutdown failure" >&2; exit 1'));
  h.call("quit");
  await h.wait(s => !s.busy && s.actionError, 4000, "shutdown error");
  assert.equal(h.state().active, true);
  assert.equal(h.state().canAct, false);
  assert.ok(fs.existsSync(`/proc/${monitor.monitorPid}`));
  fs.writeFileSync(script, original);
  h.call("quit");
  await h.wait(s => !s.active && !s.busy, 5000, "successful retry");
  assert.equal(fs.existsSync(`/proc/${monitor.monitorPid}`), false);
});

test("an abruptly killed log display leaves no backend and can be reopened", { skip, timeout: 20000 }, async t => {
  const h = harness(t);
  writeExecutable(path.join(h.dir,"bin","xdg-terminal-exec"), [
    'while [[ $# -gt 0 && $1 != -- ]]; do shift; done', 'shift',
    `"$@" > '${h.ctl}/terminal.log' 2>&1 &`, 'exit 0'
  ]);
  await h.start();
  h.call("mode", "always");
  await h.wait(s => s.active, 4000, "monitoring active");
  h.call("debug");
  const log = path.join(h.ctl,"terminal.log");
  const backendPid = () => { try { return Number(fs.readFileSync(log,"utf8").trim().split(" ")[1]); } catch { return 0; } };
  await until(backendPid, 4000, "log backend");
  const pid = backendPid();
  const display = Number(fs.readdirSync(path.join(h.dir,"state","log-terminals"))[0].split(".")[0]);
  process.kill(display, "SIGKILL");
  await until(() => !fs.existsSync(`/proc/${pid}`), 4000, "orphan prevented");
  assert.equal(h.state().active, true);
  await sleep(100);
  h.call("debug");
  await until(() => backendPid() && backendPid() !== pid, 4000, "replacement log backend");
});
