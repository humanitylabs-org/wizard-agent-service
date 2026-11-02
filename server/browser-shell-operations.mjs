// Shell-owned typed operations (wizard-os spec/browser-trust-shell-intents §6, default-off). The trusted shell document
// itself needs a few facts that today it reads straight from an app's own listener; under the listener gate that
// listener answers only the Service adapter, so the shell asks the Service for ONE fixed, reduced answer instead.
// Not the app-frame path: no binding, no frame, no app-supplied operation id reaches here. Callable only by the owner
// principal on a request the browser boundary admitted (shell token, same-origin, not a frame). Not a relay: one
// constant upstream path on the WAM-recorded installation, its listener credential, a fixed result shape; never
// owner credentials, cookies, the shell token, redirects or upstream bodies.
import { projectInventory } from './browser-ai-accounts.mjs'

const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code, ...extra }) }
const exact = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === [...keys].sort().join(',')
const MAX_UPSTREAM_BYTES = 512 * 1024
// The Claude subscription slot's installation (WAM `slots`); a different app id or a second copy is never read.
const CLAUDE_APP = 'wizard-claude', CLAUDE_SLOT = 'claude-subscription'

/** Only what the chat model picker uses (web/core/chat-models.js): which accounts exist, their state and their
 *  session/weekly meters. No email, name, plan, credential ids, actions, error text or management details.
 *  `raw` already passed projectInventory (shape, bounds, credential ids); statuses keep the picker's own vocabulary. */
const PICKER_STATUS = new Set(['ready', 'ok', 'connected', 'exhausted', 'rate_limited', 'renewing', 'expired', 'cooldown', 'error', 'not_connected', 'coming_soon'])
const pct = v => typeof v === 'number' && Number.isFinite(v) ? v : null
export function projectPickerAccounts(raw) {
  const keep = new Set(['session:session', 'weekly_all:weekly'])
  return {
    accounts: (raw.accounts || []).map(a => {
      const u = a.usage && typeof a.usage === 'object' && Array.isArray(a.usage.limits) ? a.usage : null
      return {
        id: a.id === 'legacy-claude-code' ? 'legacy-claude-code' : 'account', source: a.source === 'legacy-claude-code' ? 'legacy-claude-code' : 'pool',
        status: PICKER_STATUS.has(a.status) ? a.status : 'unknown',
        usage: u ? { fetchedAt: typeof u.fetchedAt === 'string' ? u.fetchedAt.slice(0, 40) : null,
          limits: u.limits.slice(0, 20).filter(l => l && keep.has(l.id)).map(l => ({ id: l.id, usedPercent: pct(l.usedPercent), remainingPercent: pct(l.remainingPercent) })) } : null,
      }
    }),
  }
}

// The Notifications slot's installation; the shell's Chats bell and the skin-host inbox read and mark through it.
const NOTIFICATIONS_APP = 'notifications', NOTIFICATIONS_SLOT = 'notifications'
const MARK_KEYS = ['read', 'flag', 'archived']

export function createShellOperations({ resolveInstallation, listenerCredential = () => null, fetchImpl = globalThis.fetch, timeoutMs = 4000, notifications = null } = {}) {
  async function claudeAccounts() {
    const p = resolveInstallation?.(CLAUDE_APP)
    // No Claude app (or not the slot's current provider, or not running): the picker shows no Claude note, as today.
    if (!p || p.status !== 'running' || p.providers?.[CLAUDE_SLOT] !== true || !p.upstream) return { state: 'absent' }
    let cred = null
    try { cred = listenerCredential(p) } catch { return { state: 'unavailable' } }
    let r
    try {
      r = await fetchImpl(new URL('/api/accounts', p.upstream), { method: 'GET', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json', ...(cred ? { [cred.header]: cred.value } : {}) } })
    } catch { return { state: 'unavailable' } }
    const raw = await r.text().catch(() => '')
    if (r.status === 404) return { state: 'absent' }
    if (r.status !== 200 || Buffer.byteLength(raw) > MAX_UPSTREAM_BYTES || !String(r.headers.get('content-type') || '').startsWith('application/json')) return { state: 'unavailable' }
    let parsed
    try { parsed = JSON.parse(raw); projectInventory(parsed) } catch { return { state: 'unavailable' } }
    // The installation must still be the same one after the read (update/uninstall/slot change mid-flight).
    const q = resolveInstallation?.(CLAUDE_APP)
    if (!q || q.installationId !== p.installationId || q.sourceId !== p.sourceId || q.providers?.[CLAUDE_SLOT] !== true) return { state: 'absent' }
    return { state: 'ok', ...projectPickerAccounts(parsed) }
  }
  // Shell bell (web/core/notif-bell.js): the count, the inbox items and the owner's marks, through the SAME typed
  // notifications operations the opaque frame uses (projection, compare-and-set marks, durable receipts), on the
  // Notifications slot's current installation and its listener credential. Before this the bell fetched
  // /notifications/api/* straight from the shell document, which the listener gate refuses (rehearsal, wizard-os 389).
  const notificationsInstallation = () => {
    const p = resolveInstallation?.(NOTIFICATIONS_APP)
    return p && p.status === 'running' && p.providers?.[NOTIFICATIONS_SLOT] === true && p.upstream ? p : null
  }
  const sameInstallation = p => async () => {
    const q = resolveInstallation?.(NOTIFICATIONS_APP)
    if (!q || q.installationId !== p.installationId || q.sourceId !== p.sourceId || q.providers?.[NOTIFICATIONS_SLOT] !== true) fail('conflict')
  }
  async function notificationsRead(view, limit) {
    const p = notificationsInstallation()
    if (!p || !notifications) return { state: 'absent' }
    try { return { state: 'ok', ...(await notifications.inbox(p, { view, limit })) } } catch { return { state: 'unavailable' } }
  }
  async function notificationsCount() {
    const r = await notificationsRead('inbox', 1)
    return r.state === 'ok' ? { state: 'ok', counts: r.counts } : r
  }
  async function notificationsItems() {
    const r = await notificationsRead('all', 200)
    return r.state === 'ok' ? { state: 'ok', counts: r.counts, items: r.items } : r
  }
  async function notificationsMark(args) {
    const p = notificationsInstallation()
    if (!p || !notifications) return { state: 'absent' }
    try {
      return { state: 'ok', ...(await notifications.mark(p, { items: args.items, marks: args.marks }, args.operationKey, sameInstallation(p))) }
    } catch (e) {
      if (e?.code === 'bad_request') throw e
      return { state: 'failed', error: ['conflict', 'not_found', 'busy', 'outcome_unknown', 'unsupported_capability'].includes(e?.code) ? e.code : 'backend_failed' }
    }
  }
  const markArgs = args => {
    if (!exact(args, ['items', 'marks', 'operationKey']) || !Array.isArray(args.items) || args.items.length < 1 || args.items.length > 200) fail('bad_request')
    const m = args.marks
    if (!m || typeof m !== 'object' || Array.isArray(m) || !Object.keys(m).length || Object.keys(m).some(k => !MARK_KEYS.includes(k) || typeof m[k] !== 'boolean')) fail('bad_request')
    if (typeof args.operationKey !== 'string') fail('bad_request')   // item ids, revisions and key format: the typed operation
  }
  const none = args => { if (!exact(args, [])) fail('bad_request') }
  const OPS = Object.freeze({
    'models.claude_accounts': { validate: none, run: claudeAccounts },
    'notifications.count': { validate: none, run: notificationsCount },
    'notifications.items': { validate: none, run: notificationsItems },
    'notifications.mark': { validate: markArgs, run: notificationsMark },
  })
  return Object.freeze({
    has: op => Object.hasOwn(OPS, op),
    async call(request) {
      if (!exact(request, ['operation', 'args']) || typeof request.operation !== 'string' || !Object.hasOwn(OPS, request.operation)) fail('bad_request')
      OPS[request.operation].validate(request.args)
      return OPS[request.operation].run(request.args)
    },
  })
}

/** POST /wizard/v1/browser-shell/call. The global browser-boundary gate already required the shell token and refused
 *  Origin:null, cross-site and frame requests; this route additionally requires the owner principal and refuses any
 *  request that still looks like it came from a frame or another site. */
export async function browserShellHttp(request, response, url, { enabled, principal, access, operations, readBody, send }) {
  if (url.pathname !== '/wizard/v1/browser-shell/call') return false
  const reply = (status, value) => send(response, status, value, { 'Cache-Control': 'no-store' })
  if (!enabled || !operations) { reply(404, { error: 'not_found' }); return true }
  if (principal.kind !== 'owner' || !access) { reply(403, { error: 'owner_required' }); return true }
  const h = request.headers
  if (String(h.origin ?? '').trim().toLowerCase() === 'null' || (h['sec-fetch-site'] !== undefined && h['sec-fetch-site'] !== 'same-origin')
    || ['iframe', 'frame', 'embed', 'object'].includes(h['sec-fetch-dest'])) { reply(403, { error: 'shell_only' }); return true }
  if (request.method !== 'POST') { reply(405, { error: 'method_not_allowed' }); return true }
  try {
    const body = JSON.parse((await readBody(request, 4096)).toString('utf8'))
    reply(200, await operations.call(body))
  } catch (e) {
    reply(e.code === 'bad_request' || e instanceof SyntaxError ? 400 : 502, { error: e.code === 'bad_request' || e instanceof SyntaxError ? 'bad_request' : 'backend_failed' })
  }
  return true
}
