// The owner's agent finds and installs Wizard apps itself, through the one `wizard` gateway (wizard_apps actions
// "search" and "install"; agent-bridge.mjs). docs/app-installation-integration.md, "Agent installs".
//
// Authority: this is the owner-agent gateway, not a public API. Only a caller holding the gateway token (the Hermes
// slot; /wizard/mcp refuses anything proxied from off the box) reaches it, and the bridge refuses an install unless
// that authenticated path asked for it. App containers and browsers never hold that token.
// - Search: only what the configured App Index lists (WIZARD_APP_INDEX_URL, else the public index), projected to
//   id/name/summary/jobs/uses. Shell, Agent Service and agent apps are never offered or installed this way.
// - Install: the App Manager lifecycle bridge (server-side WIZARD_APP_MANAGER_TOKEN), the same journaled route the
//   owner's Store uses, with one Idempotency-Key per logical operation. The key is kept only while the outcome is
//   uncertain, so a retry replays instead of installing twice; a definitive answer releases it. An installed but
//   stopped app is started. Success is the bridge's terminal answer plus a status read back from the bridge.
// - Response budget: an MCP client gives up on a tool call after its own timeout (stock Hermes: 120-300 s), and an
//   image pull can take longer. So the caller waits at most `waitMs`; past that it gets `in_progress` with the key,
//   while the real operation runs on, never aborted. A retry for the same app joins that operation (or, once it has
//   finished, gets its outcome); it never starts a second one.
// - operation_key: while an outcome is uncertain the app holds exactly one key, and only that key is accepted (a
//   different one is refused before anything is sent). With nothing held, a caller may pass a key it was given
//   earlier, e.g. after a Service restart cleared this memory: the bridge binds a key to one exact request
//   (idempotency_conflict otherwise), so a supplied key can only replay its own operation.
import { randomBytes } from 'node:crypto'
import { managerOrigin } from './app-lifecycle.mjs'
import { APP_INDEX_URL, createIndexProxy } from './wizard-apps-views.mjs'

export const APP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u
export const OPERATION_KEY = /^[A-Za-z0-9_-]{16,128}$/u
const FORM_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u
const SYSTEM_JOBS = new Set(['shell', 'agent-service', 'agent', 'agent-ui'])
// Kept for a retry only when the bridge may have acted (same list as the Store client, web/core/app-lifecycle-client.js).
const UNCERTAIN = new Set(['operation_unconfirmed', 'terminal_status_unconfirmed', 'projection_refresh_failed', 'completion_unconfirmed', 'invalid_response'])
const PENDING_TTL_MS = 3600_000
const LATE_TTL_MS = 600_000

const text = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max) : '')
const ids = (value) => (Array.isArray(value) ? value.filter((x) => typeof x === 'string' && APP_ID.test(x)).slice(0, 16) : [])

/** A catalogue entry as the agent sees it: no URLs, logos, repos or install sources. */
export function catalogueEntry(app) {
  const id = text(app?.id, 64)
  if (!APP_ID.test(id)) return null
  const provides = ids(app.provides)
  return {
    id, name: text(app.name, 60) || id, summary: text(app.summary, 200), jobs: provides, uses: ids(app.uses),
    system: provides.some((p) => SYSTEM_JOBS.has(p)), test_catalogue: app.qa_fixture === true,
  }
}

/** Flat form values for the app's install form (the bridge checks them against the recipe). */
export function validForm(form) {
  if (form === undefined || form === null) return {}
  if (typeof form !== 'object' || Array.isArray(form) || Object.keys(form).length > 32) return null
  for (const [k, v] of Object.entries(form)) {
    if (!FORM_KEY.test(k)) return null
    if (!(typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 2000))) return null
  }
  return form
}

export function createAgentAppActions({
  managerUrl = '', managerToken = '', managerHosts = [], indexBase = APP_INDEX_URL, indexFetch = fetch, fetchImpl = fetch,
  now = Date.now, timeoutMs = 900_000, waitMs: defaultWaitMs = 90_000, log = () => {},
} = {}) {
  const origin = managerUrl && managerToken ? managerOrigin(managerUrl, managerHosts) : ''
  const index = createIndexProxy({ base: indexBase || APP_INDEX_URL, fetchImpl: indexFetch, now })
  const pending = new Map() // app id -> { key, action, form, at }: the operation whose outcome is not known yet
  const active = new Map() // app id -> { run, op, late }: the in-flight operation (one per app at a time)
  const finished = new Map() // app id -> { result, at }: an outcome nobody was still waiting for

  async function manager(path, init = {}) {
    const r = await fetchImpl(origin + path, { redirect: 'error', ...init, headers: { Authorization: `Bearer ${managerToken}`, Accept: 'application/json', ...(init.headers || {}) } })
    const raw = await r.text()
    if (raw.length > 4 * 1024 * 1024) throw new Error('too_large')
    let data
    try { data = JSON.parse(raw) } catch { return { r, data: { success: false, error: 'invalid_response' } } }
    return { r, data }
  }

  async function catalogue(query) {
    const q = new URLSearchParams()
    if (query) q.set('q', text(query, 200))
    q.set('limit', '20')
    const res = await index('/search', q)
    if (res.status !== 200) return { error: 'catalogue_unavailable', apps: [] }
    return { apps: (Array.isArray(res.body?.apps) ? res.body.apps : []).map(catalogueEntry).filter(Boolean).slice(0, 20) }
  }

  /** The bridge's installed status for one app: running, stopped, installing..., or missing. */
  async function status(id) {
    const { r, data } = await manager('/api/apps/installed', { signal: AbortSignal.timeout(15_000) })
    if (!r.ok || !Array.isArray(data?.installed)) throw new Error('status_unavailable')
    const row = data.installed.find((x) => x?.info?.urn === `${id}:wizardapps`) // this store's app, not a namesake
    return row ? text(row.app?.status, 24) || 'unknown' : 'missing'
  }

  async function operate(id, action, form, given, op) {
    const held = pending.get(id)
    const same = held?.action === action
    if (same && JSON.stringify(held.form) !== JSON.stringify(form)) return { outcome: 'refused', error: 'operation_pending', key: held.key }
    // A held key for another action (e.g. an install that has since landed stopped) is not reused for this one.
    const key = same ? held.key : (!held && given) || randomBytes(18).toString('base64url')
    pending.set(id, { key, action, form, at: same ? held.at : now() })
    op.key = key
    let r, data
    try {
      ({ r, data } = await manager(`/api/app-lifecycle/${id}:wizardapps/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(action === 'install' ? form : {}), signal: AbortSignal.timeout(timeoutMs),
      }))
    } catch {
      return { outcome: 'uncertain', error: 'reply_lost', key }
    }
    const release = () => { if (pending.get(id)?.key === key) pending.delete(id) }
    if (r.ok && data?.success === true) { release(); return { outcome: 'done', status: text(data.status, 24), replayed: data.replayed === true, key } }
    // A 2xx without a success envelope is not an answer we can trust either way.
    const error = typeof data?.error === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(data.error) ? data.error : (r.ok ? 'invalid_response' : 'app_operation_failed')
    if (UNCERTAIN.has(error)) return { outcome: 'uncertain', error, key }
    release()
    return { outcome: 'failed', error, key }
  }

  /**
   * Install (or start) a catalogue app for the owner's agent. `authenticated` must come from the gateway's own
   * token check. Waits at most `waitMs` for the outcome, else answers `in_progress` and leaves the operation running.
   * Returns { ok, ... } for the bridge to word; never throws for an expected failure.
   */
  async function install({ app, form, operation_key: given } = {}, { authenticated = false, waitMs = defaultWaitMs } = {}) {
    if (!authenticated) return { ok: false, error: 'gateway_token_required' }
    if (!origin) return { ok: false, error: 'app_manager_not_configured' }
    const id = typeof app === 'string' ? app : '' // the literal catalogue id: no trimming or case folding
    if (!APP_ID.test(id)) return { ok: false, error: 'invalid_app' }
    const values = validForm(form)
    if (!values) return { ok: false, error: 'invalid_form' }
    if (given !== undefined && (typeof given !== 'string' || !OPERATION_KEY.test(given))) return { ok: false, error: 'invalid_operation_key' }
    for (const [k, p] of pending) if (now() - p.at > PENDING_TTL_MS) pending.delete(k)
    for (const [k, f] of finished) if (now() - f.at > LATE_TTL_MS) finished.delete(k)
    let job = active.get(id)
    const holding = job?.op.key || pending.get(id)?.key
    if (given !== undefined && holding && given !== holding) return { ok: false, error: 'operation_key_mismatch', key: holding, action: job?.op.action || pending.get(id)?.action }
    if (!job && finished.has(id)) {
      const { result } = finished.get(id)
      finished.delete(id)
      return result
    }
    if (!job) job = start(id, values, given)
    if (!Number.isFinite(waitMs)) return job.run
    let timer
    const result = await Promise.race([job.run, new Promise((r) => { timer = setTimeout(r, Math.max(0, waitMs), null) })])
    clearTimeout(timer)
    if (result) {
      if (finished.get(id)?.result === result) finished.delete(id) // a joined caller got it: report it once
      return result
    }
    job.late = true
    return { ok: false, uncertain: true, error: 'in_progress', key: job.op.key, action: job.op.action || 'install', entry: job.op.entry, sent: Boolean(job.op.key) }
  }

  function start(id, values, given) {
    const op = { key: '', action: '', entry: null }
    const job = { op, late: false }
    job.run = (async () => {
      const found = await catalogue(id)
      if (found.error) return { ok: false, error: found.error }
      const entry = found.apps.find((a) => a.id === id)
      if (!entry) return { ok: false, error: 'not_in_catalogue' }
      if (entry.system) return { ok: false, error: 'system_app', entry }
      op.entry = entry
      let before
      try { before = await status(id) } catch { return { ok: false, error: 'app_manager_unavailable', entry } }
      if (before === 'running') { pending.delete(id); return { ok: true, already: true, status: 'running', entry } }
      const action = before === 'stopped' ? 'start' : 'install'
      if (before !== 'missing' && before !== 'stopped') return { ok: false, error: 'app_busy', status: before, entry }
      op.action = action
      const result = await operate(id, action, action === 'install' ? values : {}, given, op)
      log(JSON.stringify({ event: 'app_action', app: id, action, outcome: result.outcome, error: result.error || '' }))
      if (result.outcome !== 'done') {
        let missing = []
        if (result.error === 'dependencies_required') {
          const installed = await Promise.all(entry.uses.map(async (u) => [u, await status(u).catch(() => 'unknown')]))
          missing = installed.filter(([, s]) => s === 'missing').map(([u]) => u)
        }
        return { ok: false, uncertain: result.outcome === 'uncertain', error: result.error, key: result.key, action, entry, missing }
      }
      // Terminal answer from the bridge; read the status back rather than trusting the envelope alone.
      let after = result.status
      try { after = await status(id) } catch { /* the bridge's own terminal status stands */ }
      return { ok: after === 'running', action, status: after, replayed: result.replayed, entry, error: after === 'running' ? '' : 'not_running' }
    })().catch(() => (op.key
      ? { ok: false, uncertain: true, error: 'operation_unconfirmed', key: op.key, action: op.action, entry: op.entry, missing: [] }
      : { ok: false, error: 'app_manager_unavailable', entry: op.entry }))
      .then((result) => {
        active.delete(id)
        if (job.late) finished.set(id, { result, at: now() }) // the next call for this app reports it
        return result
      })
    active.set(id, job)
    return job
  }

  return { configured: Boolean(origin), catalogue, install }
}
