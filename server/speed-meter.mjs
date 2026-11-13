import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

// Only static route words survive: never retain thread/run ids, filenames or query strings.
const identities = new Set(['sessions', 'runs', 'agents', 'threads', 'agent-heavy', 'background-results', 'attachments', 'devices'])
const routeWords = new Set(('api wizard v1 v2 sessions messages runs events agents health list-cache check window search titles title status cancel stop retry saved-retry steer approve approvals files attachments audio voice transcribe recovery-receipt settings models options usage devices heavy agent-heavy submit background-results continue threads attention seen read archive unarchive preferences ui-preferences apps capabilities mcp inbox notifications schedules supervisor helpers').split(' '))
// Keep fixed single-word Wizard v1 endpoints separate instead of merging unrelated
// bootstrap/network probes and local workspace polls into /wizard/v1/:id.
const wizardV1Routes = new Set('bootstrap workspaces setup system-jobs pages skins my-skin provider-recovery agent-options agent-context app-bindings user-files uploads shares'.split(' '))
export function routeTemplate(url) {
  try {
    const parts = new URL(url, 'http://wizard.local').pathname.split('/')
    return parts.map((part, index) => !part ? part
      : index === 3 && parts[1] === 'wizard' && parts[2] === 'v1' && wizardV1Routes.has(part) ? part
      : identities.has(parts[index - 1]) || !routeWords.has(part) ? ':id' : part).join('/')
  }
  catch { return '/:invalid' }
}
const header = value => String(value ?? '').replace(/[\x00-\x20\x7f]/g, '').slice(0, 160)

// Background work (queue ticks, the scheduler, the list cache, the photo copier...) is not a request, so
// a stall it causes would otherwise blame whichever routes happened to be waiting (issue 499). Each
// piece registers under a fixed name; a stall then lists everything that ran during it.
const workRunning = new Map()
const workEnded = []
let workToken = 0
const WORK_ENDED_KEEP = 256
export function beginWork(name, { now = () => performance.now() } = {}) {
  const token = ++workToken
  workRunning.set(token, { name: String(name), at: now() })
  let finished = false
  return () => {
    if (finished) return
    finished = true
    const entry = workRunning.get(token)
    workRunning.delete(token)
    if (!entry) return
    workEnded.push({ name: entry.name, at: entry.at, ended: now() })
    if (workEnded.length > WORK_ENDED_KEEP) workEnded.splice(0, workEnded.length - WORK_ENDED_KEEP)
  }
}
/** Runs `run()` as named background work; a returned promise keeps it registered until it settles. */
export function trackWork(name, run, options) {
  const done = beginWork(name, options)
  let result
  try { result = run() } catch (error) { done(); throw error }
  if (result && typeof result.then === 'function') return Promise.resolve(result).finally(done)
  done()
  return result
}
// Names (work and request routes) that were running at any moment in (from, to].
export function workDuring(from, to, requests = []) {
  const names = new Map()
  const add = (name, at, ended) => { if (at <= to && ended > from) names.set(name, (names.get(name) || 0) + 1) }
  for (const entry of workRunning.values()) add(entry.name, entry.at, Infinity)
  for (const entry of workEnded) add(entry.name, entry.at, entry.ended)
  for (const entry of requests) add(entry.name, entry.at, entry.ended ?? Infinity)
  return [...names].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([name]) => name)
}
export const STALL_CHECK_MS = 250
export const STALL_KEEP = 5
export const STALL_NAMES = 8

// A window this slow or this busy logs one `[event-loop]` line naming the routes that used it, so a
// freeze names its own cause in the journal (issue 497) instead of needing a live CPU profile.
export const LAG_LOG_DELAY_MS = 1000
export const LAG_LOG_UTILIZATION = 0.9
export function lagLine(window, windowRoutes, inFlight, { top = 5, stalls = [], waiting = 0 } = {}) {
  if (!(window.delay_max_ms >= LAG_LOG_DELAY_MS || window.utilization >= LAG_LOG_UTILIZATION)) return ''
  const busiest = [...windowRoutes].sort((a, b) => b[1].total_ms - a[1].total_ms).slice(0, top)
    .map(([key, row]) => { const [method, route] = JSON.parse(key === '[overflow]' ? '["","[overflow]"]' : key); return { method, route, count: row.count, total_ms: Math.round(row.total_ms) } })
  const round = value => Math.round(value * 10) / 10
  return `[event-loop] ${JSON.stringify({ window_ms: window.window_ms, delay_p99_ms: round(window.delay_p99_ms),
    delay_max_ms: round(window.delay_max_ms), utilization: Math.round(window.utilization * 100) / 100, in_flight: inFlight, ...(waiting > 0 ? { waiting } : {}), busiest,
    ...(stalls.length ? { stalls: stalls.map(stall => ({ blocked_ms: Math.round(stall.blocked_ms), running: stall.running })) } : {}) })}`
}

/** Observational only; one bounded route map and one 60-second event-loop window per server. */
export function createSpeedMeter({ windowMs = 60_000, maxRoutes = 256, stallCheckMs = STALL_CHECK_MS, now = () => performance.now(), log = line => console.log(line) } = {}) {
  const delay = monitorEventLoopDelay({ resolution: 20 })
  delay.enable()
  const routes = new Map()
  let windowRoutes = new Map(), inFlight = 0, waiting = 0, stalls = []
  // Requests running now plus those that ended recently, kept by route name only, for stall attribution.
  const requestsRunning = new Map(), requestsEnded = []
  let requestToken = 0, lastCheck = now()
  // A timer that fires late by a second or more means something held the event loop for that long:
  // remember what was running in that gap, so the window's `[event-loop]` line names it.
  const checkStall = () => {
    // The block may have begun just after the previous check, so the gap since that check (not the
    // lateness alone) is what decides; `blocked_ms` reports the lateness, the part known to be blocked.
    const at = now(), gap = at - lastCheck, blocked = Math.max(0, gap - stallCheckMs)
    const lastCheckBefore = lastCheck
    lastCheck = at
    if (!(gap >= LAG_LOG_DELAY_MS)) return null
    const stall = { blocked_ms: blocked, running: workDuring(lastCheckBefore, at, [...requestsRunning.values(), ...requestsEnded]).slice(0, STALL_NAMES) }
    stalls.push(stall)
    stalls.sort((a, b) => b.blocked_ms - a.blocked_ms)
    if (stalls.length > STALL_KEEP) stalls.length = STALL_KEEP
    return stall
  }
  const stallTimer = stallCheckMs > 0 ? setInterval(checkStall, stallCheckMs) : null
  stallTimer?.unref?.()
  let started = now(), previous = performance.eventLoopUtilization(), completed = null
  const sample = () => {
    const current = performance.eventLoopUtilization()
    const elapsed = now() - started
    return { window_ms: Math.round(elapsed), delay_p50_ms: delay.count ? delay.percentile(50) / 1e6 : 0,
      delay_p99_ms: delay.count ? delay.percentile(99) / 1e6 : 0,
      delay_max_ms: delay.count ? delay.max / 1e6 : 0,
      utilization: performance.eventLoopUtilization(current, previous).utilization }
  }
  const timer = setInterval(() => {
    completed = sample()
    try { const line = lagLine(completed, windowRoutes, inFlight, { stalls, waiting }); if (line) log(line) } catch { /* observational only */ }
    previous = performance.eventLoopUtilization(); started = now(); delay.reset(); windowRoutes = new Map(); stalls = []
  }, windowMs)
  timer.unref?.()
  return {
    begin(request) {
      const at = now()
      const key = JSON.stringify([request.method || 'GET', routeTemplate(request.url || '/'),
        /HeadlessChrome/i.test(String(request.headers?.['user-agent'] || '')) ? 'HeadlessChrome' : 'other',
        header(request.headers?.host), header(request.headers?.['x-forwarded-host']),
        header(String(request.headers?.forwarded || '').match(/(?:^|[;,])\s*host="?([^";,\s]+)/i)?.[1])])
      let finished = false
      inFlight++
      const token = ++requestToken
      const [method, route] = JSON.parse(key)
      const name = `${method} ${route}`
      let running = { name, at }, idleMs = 0, idleSince = null
      requestsRunning.set(token, running)
      const endSegment = () => {
        requestsRunning.delete(token)
        requestsEnded.push({ ...running, ended: now() })
        if (requestsEnded.length > WORK_ENDED_KEEP) requestsEnded.splice(0, requestsEnded.length - WORK_ENDED_KEEP)
      }
      const idleEnd = () => {
        if (idleSince === null || finished) return
        idleMs += now() - idleSince; idleSince = null; waiting--
        running = { name, at: now() }; requestsRunning.set(token, running)
      }
      const done = () => {
        if (finished) return
        if (idleSince !== null) { idleMs += now() - idleSince; idleSince = null; waiting-- }
        else endSegment()
        finished = true
        inFlight--
        // Choose at completion, not entry: concurrent requests must share the same bound.
        const bucket = routes.has(key) || routes.size < maxRoutes - 1 ? key : '[overflow]'
        const row = routes.get(bucket) || { count: 0, total_ms: 0, samples: [], next: 0 }
        const elapsed = Math.max(0, now() - at - idleMs)
        row.samples[row.next] = elapsed; row.next = (row.next + 1) % 256
        row.count++; row.total_ms += elapsed; routes.set(bucket, row)
        const windowRow = windowRoutes.get(bucket) || { count: 0, total_ms: 0 }
        windowRow.count++; windowRow.total_ms += elapsed; windowRoutes.set(bucket, windowRow)
      }
      // A long-poll parked on a promise (workspace sync waits up to 25 s for another device) holds no event-loop
      // time: that wait is left out of the route's total_ms and of stall attribution (issue 503), so the
      // `[event-loop]` line names the routes that really used the loop.
      done.idle = (promise) => {
        if (finished || idleSince !== null) return promise
        endSegment(); idleSince = now(); waiting++
        Promise.resolve(promise).then(idleEnd, idleEnd)
        return promise
      }
      return done
    },
    stats: () => ({ event_loop: completed || sample(), routes: Object.fromEntries([...routes].map(([key, row]) => {
      const sorted = [...row.samples].sort((a, b) => a - b)
      return [key, { count: row.count, total_ms: row.total_ms, sample_count: sorted.length, p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0 }]
    })) }),
    checkStall,
    close() { clearInterval(timer); if (stallTimer) clearInterval(stallTimer); delay.disable() },
  }
}

// Per-queue rate limit, so a stuck poll cannot become its own source of load.
export function createSlowTickLogger(queue, { now = () => performance.now(), log = line => console.log(line) } = {}) {
  let last = -Infinity
  return started => {
    const at = now(), duration = at - started
    if (duration > 50 && at - last >= 60_000) {
      last = at
      log(`[queue-speed] ${JSON.stringify({ queue, duration_ms: Math.round(duration) })}`)
    }
  }
}

// One `[startup]` line per process: how long each startup step took, in ms since the process began, so a
// slow restart (one the health check reads as failed) says which step was slow (issue 499).
// `overlapping` holds steps that run alongside the others (the run queue's recovery starts inside
// create), each with its own duration, so they never steal time from the sequential steps.
export function startupLine(marks, overlapping = {}) {
  const out = {}
  let previous = 0
  for (const [step, at] of marks) {
    if (!Number.isFinite(at)) continue
    out[`${step}_ms`] = Math.round(at - previous)
    previous = at
  }
  out.total_ms = Math.round(previous)
  for (const [step, ms] of Object.entries(overlapping)) if (Number.isFinite(ms)) out[`${step}_ms`] = Math.round(ms)
  return `[startup] ${JSON.stringify(out)}`
}
