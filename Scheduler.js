// Decide when the bar runs a full Port Kill scan. Scans are expensive, so
// cheap socket signatures from the watcher trigger them, and this state
// machine serializes, coalesces and rate-limits the requests. QML loads this
// file, and Node.js runs the same functions in tests. Times are milliseconds
// from any monotonic clock.

var DEFAULTS = {
  // Background requests (socket changes) start at most this often.
  minScanGapMs: 5000,
  // Refresh details at least this often while active, because a process can
  // change behind an unchanged socket (for example an inherited listener).
  maxAgeMs: 60000,
  // Failed scans retry with exponential backoff between these bounds.
  retryBaseMs: 2000,
  retryMaxMs: 60000
}

function createScheduler(options) {
  var o = {}
  for (var key in DEFAULTS) o[key] = options && options[key] !== undefined ? options[key] : DEFAULTS[key]
  return {
    options: o,
    active: false,
    scanning: false,
    acting: false,
    // Bumped by actions and deactivation. A scan that started under an older
    // generation describes a state that no longer exists.
    generation: 0,
    scanGeneration: -1,
    pending: false,
    urgent: false,
    lastScanStartedAt: null,
    lastSuccessAt: null,
    failures: 0,
    retryAt: null,
    // Latest socket signature from the watcher, the one captured when the
    // in-flight scan started, and the one behind the last accepted scan.
    signature: null,
    scanSignature: null,
    acceptedSignature: null
  }
}

function activate(s) {
  if (s.active) return
  s.active = true
  s.generation++
  s.lastSuccessAt = null
  s.acceptedSignature = null
  s.failures = 0
  s.retryAt = null
  request(s, true)
}

function deactivate(s) {
  s.active = false
  s.pending = false
  s.urgent = false
  s.failures = 0
  s.retryAt = null
  s.generation++
}

// User-visible requests (activation, menu opening, explicit refresh, after an
// action) are urgent and skip the background rate limit, never the
// one-scan-at-a-time rule.
function request(s, urgent) {
  if (!s.active) return
  s.pending = true
  if (urgent) s.urgent = true
}

function setSignature(s, signature) {
  s.signature = signature
  if (s.active && signature !== s.acceptedSignature) request(s, false)
}

function shouldScan(s, now) {
  if (!s.active || s.scanning || s.acting) return false
  if (s.pending && (s.urgent || s.lastScanStartedAt === null || now - s.lastScanStartedAt >= s.options.minScanGapMs)) return true
  if (s.retryAt !== null && now >= s.retryAt) return true
  return s.lastSuccessAt !== null && s.failures === 0 && now - s.lastSuccessAt >= s.options.maxAgeMs
}

function beginScan(s, now) {
  s.scanning = true
  s.pending = false
  s.urgent = false
  s.retryAt = null
  s.lastScanStartedAt = now
  s.scanGeneration = s.generation
  s.scanSignature = s.signature
  return s.scanGeneration
}

// Returns "apply", "failed" or "discard". Discarded results must not replace
// the displayed rows; a follow-up scan is already requested.
function finishScan(s, generation, ok, now) {
  if (!s.scanning || generation !== s.scanGeneration) return "discard"
  s.scanning = false
  if (!s.active) return "discard"
  if (generation !== s.generation) {
    request(s, true)
    return "discard"
  }
  if (ok) {
    s.failures = 0
    s.retryAt = null
    s.lastSuccessAt = now
    s.acceptedSignature = s.scanSignature
    // Sockets changed while the scan ran.
    if (s.signature !== s.acceptedSignature) request(s, false)
    return "apply"
  }
  s.failures++
  s.retryAt = now + Math.min(s.options.retryMaxMs, s.options.retryBaseMs * Math.pow(2, s.failures - 1))
  return "failed"
}

// Actions are never queued or retried: a second action while one runs is
// refused, and the caller reports it.
function beginAction(s) {
  if (s.acting) return false
  s.acting = true
  s.generation++
  return true
}

function finishAction(s) {
  s.acting = false
  request(s, true)
}

// Milliseconds until shouldScan() can next become true without a new event,
// or -1 when only an event (scan or action exit, signature, request) can.
function nextDelay(s, now) {
  if (!s.active || s.scanning || s.acting) return -1
  var delays = []
  if (s.pending) {
    delays.push(s.urgent || s.lastScanStartedAt === null ? 0 : s.lastScanStartedAt + s.options.minScanGapMs - now)
  }
  if (s.retryAt !== null) delays.push(s.retryAt - now)
  if (s.lastSuccessAt !== null && s.failures === 0) delays.push(s.lastSuccessAt + s.options.maxAgeMs - now)
  if (!delays.length) return -1
  return Math.max(0, Math.min.apply(Math, delays))
}

if (typeof module !== "undefined") {
  module.exports = {
    DEFAULTS: DEFAULTS,
    createScheduler: createScheduler,
    activate: activate,
    deactivate: deactivate,
    request: request,
    setSignature: setSignature,
    shouldScan: shouldScan,
    beginScan: beginScan,
    finishScan: finishScan,
    beginAction: beginAction,
    finishAction: finishAction,
    nextDelay: nextDelay
  }
}
