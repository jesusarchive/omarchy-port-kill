const test = require("node:test")
const assert = require("node:assert/strict")
const S = require("../Scheduler.js")

// Drive the scheduler like Service.qml: scan whenever shouldScan() says so.
function harness(options) {
  const s = S.createScheduler(options)
  const h = {
    s,
    now: 0,
    scans: [],
    tick(ms) { h.now += ms },
    maybeScan() {
      if (!S.shouldScan(s, h.now)) return null
      const generation = S.beginScan(s, h.now)
      h.scans.push(h.now)
      return generation
    }
  }
  return h
}

test("nothing is scheduled while inactive", () => {
  const h = harness()
  S.request(h.s, true)
  S.setSignature(h.s, "a")
  assert.equal(S.shouldScan(h.s, 0), false)
  assert.equal(S.nextDelay(h.s, 0), -1)
})

test("activation scans at once, and a quiet period only refreshes at the maximum age", () => {
  const h = harness()
  S.activate(h.s)
  S.setSignature(h.s, "a")
  const gen = h.maybeScan()
  assert.equal(gen !== null, true)
  assert.equal(S.finishScan(h.s, gen, true, h.now), "apply")
  // The signature seen at scan start is accepted; repeating it is not a change.
  S.setSignature(h.s, "a")
  assert.equal(S.nextDelay(h.s, h.now), 60000)
  h.tick(59999)
  assert.equal(h.maybeScan(), null)
  h.tick(1)
  assert.notEqual(h.maybeScan(), null)
})

test("socket changes are rate limited and coalesced during churn", () => {
  const h = harness()
  S.activate(h.s)
  S.setSignature(h.s, "0")
  S.finishScan(h.s, h.maybeScan(), true, h.now)
  // Ten changes a second for twenty seconds.
  for (let i = 1; i <= 200; i++) {
    h.tick(100)
    S.setSignature(h.s, String(i))
    const gen = h.maybeScan()
    if (gen !== null) {
      h.tick(50)
      S.finishScan(h.s, gen, true, h.now)
    }
  }
  const gaps = h.scans.slice(1).map((t, i) => t - h.scans[i])
  assert.ok(gaps.every(gap => gap >= 5000), gaps.join(","))
  assert.ok(h.scans.length <= 5, String(h.scans.length))
  // The last change is still picked up once the churn stops.
  h.tick(5000)
  const gen = h.maybeScan()
  if (gen !== null) S.finishScan(h.s, gen, true, h.now)
  assert.equal(h.s.acceptedSignature, "200")
  assert.equal(h.s.pending, false)
})

test("only one scan runs, and requests during it become one follow-up", () => {
  const h = harness()
  S.activate(h.s)
  const gen = h.maybeScan()
  for (let i = 0; i < 5; i++) S.request(h.s, true)
  assert.equal(S.shouldScan(h.s, h.now), false)
  assert.equal(S.nextDelay(h.s, h.now), -1)
  S.finishScan(h.s, gen, true, h.now)
  assert.notEqual(h.maybeScan(), null)
  assert.equal(h.maybeScan(), null)
  assert.equal(h.scans.length, 2)
})

test("user requests skip the background rate limit", () => {
  const h = harness()
  S.activate(h.s)
  S.finishScan(h.s, h.maybeScan(), true, h.now)
  h.tick(10)
  S.request(h.s, true) // menu opened
  assert.notEqual(h.maybeScan(), null)
})

test("a signature change during a scan triggers another scan", () => {
  const h = harness()
  S.activate(h.s)
  S.setSignature(h.s, "a")
  const gen = h.maybeScan()
  S.setSignature(h.s, "b")
  h.tick(100)
  S.finishScan(h.s, gen, true, h.now)
  assert.equal(h.s.acceptedSignature, "a")
  assert.equal(S.nextDelay(h.s, h.now), 4900)
})

test("failed scans retry with backoff even when sockets never change", () => {
  const h = harness()
  S.activate(h.s)
  S.setSignature(h.s, "same")
  const retries = []
  let gen = h.maybeScan()
  for (let i = 0; i < 7; i++) {
    assert.equal(S.finishScan(h.s, gen, false, h.now), "failed")
    const delay = S.nextDelay(h.s, h.now)
    retries.push(delay)
    h.tick(delay)
    S.setSignature(h.s, "same")
    gen = h.maybeScan()
    assert.notEqual(gen, null)
  }
  assert.deepEqual(retries, [2000, 4000, 8000, 16000, 32000, 60000, 60000])
  assert.equal(S.finishScan(h.s, gen, true, h.now), "apply")
  assert.equal(h.s.failures, 0)
  assert.equal(S.nextDelay(h.s, h.now), 60000)
})

test("an action discards an overlapping scan and rescans after it", () => {
  const h = harness()
  S.activate(h.s)
  const gen = h.maybeScan()
  assert.equal(S.beginAction(h.s), true)
  assert.equal(S.finishScan(h.s, gen, true, h.now), "discard")
  // No scan while the action runs.
  assert.equal(h.maybeScan(), null)
  S.finishAction(h.s)
  const after = h.maybeScan()
  assert.notEqual(after, null)
  assert.equal(S.finishScan(h.s, after, true, h.now), "apply")
})

test("actions are never queued", () => {
  const h = harness()
  S.activate(h.s)
  assert.equal(S.beginAction(h.s), true)
  assert.equal(S.beginAction(h.s), false)
  S.finishAction(h.s)
  assert.equal(S.beginAction(h.s), true)
})

test("deactivation stops scheduling and discards the in-flight scan", () => {
  const h = harness()
  S.activate(h.s)
  const gen = h.maybeScan()
  S.deactivate(h.s)
  assert.equal(S.finishScan(h.s, gen, true, h.now), "discard")
  S.setSignature(h.s, "x")
  S.request(h.s, true)
  assert.equal(h.maybeScan(), null)
  assert.equal(S.nextDelay(h.s, h.now), -1)
})

test("reactivation during an old scan ignores its result", () => {
  const h = harness()
  S.activate(h.s)
  const old = h.maybeScan()
  S.deactivate(h.s)
  S.activate(h.s)
  assert.equal(S.finishScan(h.s, old, true, h.now), "discard")
  assert.equal(h.s.lastSuccessAt, null)
  assert.notEqual(h.maybeScan(), null)
})

test("a stale finish for an unknown scan is ignored", () => {
  const h = harness()
  S.activate(h.s)
  const gen = h.maybeScan()
  assert.equal(S.finishScan(h.s, gen + 99, true, h.now), "discard")
  assert.equal(h.s.scanning, true)
})
