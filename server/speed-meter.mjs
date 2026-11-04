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

/** Observational only; one bounded route map and one 60-second event-loop window per server. */
export function createSpeedMeter({ windowMs = 60_000, maxRoutes = 256, now = () => performance.now() } = {}) {
  const delay = monitorEventLoopDelay({ resolution: 20 })
  delay.enable()
  const routes = new Map()
  let started = now(), previous = performance.eventLoopUtilization(), completed = null
  const sample = () => {
    const current = performance.eventLoopUtilization()
    const elapsed = now() - started
    return { window_ms: Math.round(elapsed), delay_p50_ms: delay.count ? delay.percentile(50) / 1e6 : 0,
      delay_p99_ms: delay.count ? delay.percentile(99) / 1e6 : 0,
      utilization: performance.eventLoopUtilization(current, previous).utilization }
  }
  const timer = setInterval(() => {
    completed = sample(); previous = performance.eventLoopUtilization(); started = now(); delay.reset()
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
      return () => {
        if (finished) return
        finished = true
        // Choose at completion, not entry: concurrent requests must share the same bound.
        const bucket = routes.has(key) || routes.size < maxRoutes - 1 ? key : '[overflow]'
        const row = routes.get(bucket) || { count: 0, total_ms: 0, samples: [], next: 0 }
        const elapsed = now() - at
        row.samples[row.next] = elapsed; row.next = (row.next + 1) % 256
        row.count++; row.total_ms += elapsed; routes.set(bucket, row)
      }
    },
    stats: () => ({ event_loop: completed || sample(), routes: Object.fromEntries([...routes].map(([key, row]) => {
      const sorted = [...row.samples].sort((a, b) => a - b)
      return [key, { count: row.count, total_ms: row.total_ms, sample_count: sorted.length, p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0 }]
    })) }),
    close() { clearInterval(timer); delay.disable() },
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
