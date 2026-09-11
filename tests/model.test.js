// Run with: node --test tests/
const test = require("node:test")
const assert = require("node:assert/strict")
const M = require("../Model.js")

const scan = [
  "S\ttcp LISTEN 0 4096 127.0.0.1:631 0.0.0.0:* ino:12907 sk:1001 cgroup:/system.slice/system-cups.slice/cups.service <->",
  "S\ttcp LISTEN 0 4096 [::1]:631 [::]:* ino:12906 sk:100a cgroup:/system.slice/system-cups.slice/cups.service v6only:1 <->",
  "S\ttcp LISTEN 0 511 0.0.0.0:5173 0.0.0.0:* users:((\"node\",pid=4242,fd=20)) uid:1000 ino:1 sk:1 cgroup:/user.slice/user-1000.slice/user@1000.service/app.slice/app-graphical.slice/kitty-1-0.scope <->",
  "S\ttcp LISTEN 0 511 [::]:5173 [::]:* users:((\"node\",pid=4242,fd=21)) uid:1000 ino:2 sk:2 cgroup:/user.slice/user-1000.slice/user@1000.service/app.slice/app-graphical.slice/kitty-1-0.scope v6only:1 <->",
  "S\ttcp LISTEN 0 128 0.0.0.0:8000 0.0.0.0:* users:((\"gunicorn\",pid=500,fd=5),(\"gunicorn\",pid=501,fd=5)) uid:1000 ino:3 sk:3 <->",
  "S\ttcp LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:* uid:974 ino:7735 sk:1005 cgroup:/system.slice/systemd-resolved.service <->",
  "S\tudp UNCONN 0 0 0.0.0.0:5353 0.0.0.0:* uid:967 ino:10045 sk:3001 cgroup:/system.slice/avahi-daemon.service <->",
  "S\tudp UNCONN 0 0 [fe80::37d8:8cb:4d8a:cff0]%wlp0s20f3:546 [::]:* ino:27881 sk:3006 cgroup:/system.slice/NetworkManager.service v6only:1 <->",
  "P\t4242\t3725\t/home/me/Work/app\t/home/me/.local/share/mise/installs/node/26/bin/node /home/me/Work/app/node_modules/.bin/vite --port 5173 --host",
  "P\t500\t90\t/home/me/api\t/usr/bin/python3 -m gunicorn app:app",
  "U\t0\troot",
  "U\t967\tavahi",
  "U\t974\tsystemd-resolve",
  "U\t1000\tme",
  ""
].join("\n")

test("parseRanges handles singles, ranges, reversed ranges and junk", () => {
  assert.deepEqual(M.parseRanges("3000, 6000-6002 8000,abc,9-7"), [[3000, 3000], [6000, 6002], [8000, 8000], [7, 9]])
  assert.deepEqual(M.parseRanges(""), [])
})

test("splitAddress strips brackets and keeps interface scopes", () => {
  assert.deepEqual(M.splitAddress("[::1]:631"), { addr: "::1", port: 631 })
  assert.deepEqual(M.splitAddress("127.0.0.53%lo:53"), { addr: "127.0.0.53%lo", port: 53 })
  assert.deepEqual(M.splitAddress("[fe80::1]%wlp0s20f3:546"), { addr: "fe80::1%wlp0s20f3", port: 546 })
  assert.deepEqual(M.splitAddress("*:22"), { addr: "*", port: 22 })
  assert.equal(M.splitAddress("*:*"), null)
})

test("parseSsLine without a Netid column defaults to tcp", () => {
  const s = M.parseSsLine("LISTEN 0 5 0.0.0.0:8765 0.0.0.0:* users:((\"python3\",pid=9,fd=3))")
  assert.equal(s.proto, "tcp")
  assert.equal(s.port, 8765)
  assert.deepEqual(s.pids, [9])
})

test("parseScan merges IPv4/IPv6 twins and attaches process details", () => {
  const rows = M.parseScan(scan)
  const vite = rows.filter(r => r.port === 5173)
  assert.equal(vite.length, 1)
  assert.deepEqual(vite[0].addresses, ["0.0.0.0", "::"])
  assert.equal(vite[0].owned, true)
  assert.equal(vite[0].cwd, "/home/me/Work/app")
  assert.equal(vite[0].elapsed, 3725)

  const cups = rows.filter(r => r.port === 631)
  assert.equal(cups.length, 1)
  assert.equal(cups[0].owned, false)
  assert.equal(cups[0].unit, "cups.service")
  assert.equal(cups[0].user, "root")

  const gunicorn = rows.find(r => r.port === 8000)
  assert.deepEqual(gunicorn.pids, [500, 501])

  const resolved = rows.find(r => r.port === 53)
  assert.equal(resolved.user, "systemd-resolve")
})

test("applyFilters: udp off by default, include/ignore ranges, ignored names", () => {
  const rows = M.parseScan(scan)
  assert.deepEqual(M.applyFilters(rows, {}).map(r => r.port), [53, 631, 5173, 8000])
  assert.deepEqual(M.applyFilters(rows, { includeUdp: true }).map(r => r.port), [53, 546, 631, 5173, 5353, 8000])
  assert.deepEqual(M.applyFilters(rows, { ports: "1024-65535" }).map(r => r.port), [5173, 8000])
  assert.deepEqual(M.applyFilters(rows, { ignorePorts: "53,600-700" }).map(r => r.port), [5173, 8000])
  assert.deepEqual(M.applyFilters(rows, { ignoreProcesses: "Gunicorn, cups" }).map(r => r.port), [53, 5173])
})

test("display helpers", () => {
  const rows = M.parseScan(scan)
  const vite = rows.find(r => r.port === 5173)
  assert.equal(M.shortCommand(vite), "node vite --port 5173 …")
  assert.equal(M.rowTitle(vite), "node vite --port 5173 …")
  assert.equal(M.rowCaption(vite, "/home/me"), "~/Work/app  ·  pid 4242  ·  up 1h  ·  0.0.0.0, ::")
  assert.equal(M.rowTitle(rows.find(r => r.port === 631)), "cups")
  assert.equal(M.rowCaption(rows.find(r => r.port === 631), "/home/me"), "root  ·  127.0.0.1, ::1")
  const mdns = M.parseScan(scan).find(r => r.port === 5353)
  assert.equal(M.rowCaption(mdns, "/home/me"), "avahi  ·  UDP  ·  0.0.0.0")
  assert.equal(M.prettyPath("/home/meow", "/home/me"), "/home/meow")
  assert.equal(M.formatElapsed(59), "59s")
  assert.equal(M.formatElapsed(172800), "2d")
})
