// Fixed browser operations for the ChatGPT and Claude connection pages (wizard-os spec/browser-trust-shell-intents).
// Not a relay: every operation has one constant upstream path on the installation's OWN WAM-recorded upstream, exact
// argument schemas, a fixed result DTO and the installation's listener credential; never owner credentials, cookies,
// the shell token, redirects or upstream bodies. Provider sign-in URLs never reach the frame: they are kept per
// binding and handed to the shell only through a navigation intent that matches the installed contract.
import { createHash } from 'node:crypto'

const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code, ...extra }) }
const exact = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === [...keys].sort().join(',')
const sha = v => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const OPERATION_KEY = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const JOB_ID = /^[A-Za-z0-9_-]{20,64}$/
const CRED_ID = /^[A-Za-z0-9:._-]{1,128}$/
const LOGIN_ID = /^[A-Za-z0-9_-]{8,64}$/
const AUTH_CODE = /^[A-Za-z0-9_-]{1,2048}#[A-Za-z0-9_-]{1,256}$/
const MAX_UPSTREAM_BYTES = 512 * 1024
const CHANGE_ACTIONS = new Set(['add', 'reconnect', 'remove', 'prefer'])
const JOB_STATUS = new Set(['running', 'succeeded', 'failed', 'cancelled', 'expired', 'needs_review', 'pending'])
const ROW_STATUS = new Set(['ready', 'connected', 'ok', 'renewing', 'expired', 'cooldown', 'exhausted', 'error', 'not_connected', 'coming_soon', 'unknown'])
// Text from the app is data: bounded, single-line, links replaced (no URL reaches the frame from these fields).
const text = (v, n = 200) => typeof v === 'string' ? v.replace(/https?:\/\/\S+/g, '[link]').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n) : ''
const str = (v, n) => typeof v === 'string' ? text(v, n) : null
const num = v => typeof v === 'number' && Number.isFinite(v) ? v : null
const bool = v => v === true
const enumOf = (set, v, d) => set.has(v) ? v : d

/** The installed contract's sign-in page that `url` belongs to, or null. Exact origin + path, listed query names only. */
export function navigationTarget(contract, url) {
  if (typeof url !== 'string' || url.length > 4096) return null
  let u; try { u = new URL(url) } catch { return null }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) return null
  for (const entry of Array.isArray(contract?.navigation) ? contract.navigation : []) {
    let e; try { e = new URL(entry.url) } catch { continue }
    if (u.origin !== e.origin || u.pathname !== e.pathname) continue
    const allowed = new Set(Array.isArray(entry.query) ? entry.query : [])
    const names = [...u.searchParams.keys()]
    if (names.length > 16 || names.some(n => !allowed.has(n)) || new Set(names).size !== names.length) return null
    return entry.id
  }
  return null
}

function projectLimit(l) {
  if (!l || typeof l !== 'object') return null
  return { id: str(l.id, 80) || '', label: str(l.label, 80) || '', usedPercent: num(l.usedPercent), remainingPercent: num(l.remainingPercent),
    resetsAt: typeof l.resetsAt === 'string' && l.resetsAt.length <= 40 ? l.resetsAt : null }
}
function projectUsage(u) {
  if (!u || typeof u !== 'object' || !Array.isArray(u.limits)) return null
  return { limits: u.limits.slice(0, 20).map(projectLimit).filter(Boolean), fetchedAt: typeof u.fetchedAt === 'string' ? u.fetchedAt.slice(0, 40) : null }
}
const projectError = e => e && typeof e === 'object' ? { code: str(e.code, 40) || 'error', message: text(e.message, 300) } : null
function projectAccount(a) {
  if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !CRED_ID.test(a.id)) fail('backend_failed')
  const acts = a.actions && typeof a.actions === 'object' ? a.actions : {}
  return {
    id: a.id, name: str(a.name, 120), source: str(a.source, 40), email: str(a.email, 160), plan: str(a.plan, 40),
    status: enumOf(ROW_STATUS, a.status, 'unknown'), usage: projectUsage(a.usage), usageStatus: str(a.usageStatus, 20),
    error: projectError(a.error), priority: Number.isInteger(a.priority) ? a.priority : null, preferred: bool(a.preferred),
    mirror: a.mirror === 'claude-code' ? 'claude-code' : null,
    credentials: (Array.isArray(a.credentials) ? a.credentials : []).slice(0, 16).filter(c => c && typeof c.id === 'string' && CRED_ID.test(c.id))
      .map(c => ({ id: c.id, name: str(c.name, 80), managed: bool(c.managed) })),
    actions: { reconnect: bool(acts.reconnect), remove: bool(acts.remove), prefer: bool(acts.prefer) },
  }
}
/** The shared accounts page's inventory (pool_server.py GET /api/accounts), as a fixed DTO. */
export function projectInventory(raw) {
  if (!raw || typeof raw !== 'object' || (raw.accounts !== undefined && !Array.isArray(raw.accounts)) || (raw.accounts || []).length > 32) fail('backend_failed')
  const m = raw.management && typeof raw.management === 'object' ? raw.management : {}
  return {
    provider: raw.provider === 'claude' ? 'claude' : 'chatgpt', name: str(raw.name, 40), owner: str(raw.owner, 20),
    accounts: (raw.accounts || []).map(projectAccount), inventoryStatus: str(raw.inventoryStatus, 20),
    actions: { add: bool(raw.actions?.add) },
    management: { contract: str(m.contract, 60), status: str(m.status, 20), message: text(m.message, 300) },
    agent: str(raw.agent, 120), error: projectError(raw.error), alongside: bool(raw.alongside),
    legacyStatus: str(raw.legacyStatus, 20), legacySignin: bool(raw.legacySignin),
    accountCount: Number.isInteger(raw.accountCount) ? raw.accountCount : null,
  }
}

export function createAiAccountsOperations({ fetchImpl = globalThis.fetch, receipts, timeoutMs = 15000, listenerCredential = () => null } = {}) {
  const inflight = new Set()
  function authHeaders(p) {
    let cred = null
    try { cred = listenerCredential(p) } catch { fail('backend_unavailable') }
    return cred ? { [cred.header]: cred.value } : {}
  }
  // One fixed request on the installation's own upstream. `write` replies are {status, body}: 409 is meaningful.
  async function upstream(p, path, body, { write = false } = {}) {
    if (!p.upstream) fail('backend_unavailable')
    const auth = authHeaders(p)   // before any effect: a missing credential sends nothing
    let r
    try {
      r = await fetchImpl(new URL(path, p.upstream), {
        method: body ? 'POST' : 'GET', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json', 'x-wizard-account-action': '1' } : {}), ...auth },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    } catch (e) { if (write) return { status: 0 }; fail(e?.name === 'TimeoutError' ? 'timeout' : 'backend_unavailable') }
    const raw = await r.text().catch(() => '')
    if (Buffer.byteLength(raw) > MAX_UPSTREAM_BYTES || !String(r.headers.get('content-type') || '').startsWith('application/json')) {
      if (write) return { status: r.status, body: null }
      fail('backend_failed')
    }
    let parsed = null
    try { parsed = JSON.parse(raw) } catch { if (!write) fail('backend_failed') }
    if (write) return { status: r.status, body: parsed }
    if (r.status !== 200) fail(r.status === 404 ? 'not_found' : r.status === 409 ? 'conflict' : 'backend_failed')
    return parsed
  }

  // A job view (account_lifecycle.py view()), with the URL replaced by the contract's sign-in target id.
  function projectJob(p, raw, signin) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !JOB_ID.test(raw.id)) fail('backend_failed')
    const target = raw.url ? navigationTarget(p.browser_contract, raw.url) : null
    if (target) signin?.(`ai:${raw.id}`, target, raw.url)
    return {
      id: raw.id, action: enumOf(new Set([...CHANGE_ACTIONS, 'submit', 'cancel']), raw.action, null),
      status: enumOf(JOB_STATUS, raw.status, 'needs_review'),
      expiresAt: num(raw.expiresAt), userCode: typeof raw.userCode === 'string' && /^[A-Z0-9-]{4,24}$/.test(raw.userCode) ? raw.userCode : null,
      inputRequired: bool(raw.inputRequired), signin: target,
      credentialIds: (Array.isArray(raw.credentialIds) ? raw.credentialIds : []).slice(0, 16).filter(x => typeof x === 'string' && CRED_ID.test(x)),
    }
  }
  const message = d => text(d?.message ?? d?.error, 300)

  // Writes: durable receipt before the effect, the original outcome on an identical replay, `outcome_unknown` when
  // the reply is lost (the page then re-reads; an account change is never retried blind).
  async function once(p, op, args, operationKey, recheck, effect) {
    if (!receipts) fail('unsupported_capability')
    if (typeof operationKey !== 'string' || !OPERATION_KEY.test(operationKey)) fail('bad_request')
    const digest = sha([op, args]), lock = [p.installationId, op, operationKey].join('|')
    if (inflight.has(lock)) fail('busy', { retryable: true })
    inflight.add(lock)
    try {
      const r = receipts.get(p.installationId, op, operationKey)
      if (r && (r.digest !== digest || r.sourceId !== p.sourceId)) fail('conflict')
      if (r?.status === 'succeeded') return r.result
      if (r?.status === 'failed') fail(r.error)
      if (r) fail('outcome_unknown', { outcome: 'unknown', operationKey })
      const base = { installationId: p.installationId, sourceId: p.sourceId, operation: op, operationKey, digest }
      const settle = (status, extra) => receipts.put({ ...base, status, ...extra })
      settle('pending')
      await recheck()   // install/source/grant still current immediately before the effect
      let out
      try { out = await effect() } catch (e) {
        if (['conflict', 'not_found', 'bad_request', 'not_allowed'].includes(e.code)) { try { settle('failed', { error: e.code }) } catch { /* pending stays */ } }
        else { try { settle('unknown') } catch { /* pending stays */ } }
        throw e
      }
      try { settle('succeeded', { result: out }) } catch { fail('outcome_unknown', { outcome: 'unknown', operationKey }) }
      return out
    } finally { inflight.delete(lock) }
  }
  const lost = operationKey => fail('outcome_unknown', { outcome: 'unknown', operationKey })
  async function jobWrite(p, body, operationKey, signin) {
    const res = await upstream(p, '/api/operations', body, { write: true })
    if (res.status === 200 && res.body) return projectJob(p, res.body, signin)
    if (res.status === 409) fail('conflict')
    if (res.status === 403) fail('not_allowed')
    if (res.status === 400 || res.status === 413) fail('bad_request')
    return lost(operationKey)
  }
  async function legacyWrite(p, path, body, operationKey, shape) {
    const res = await upstream(p, '/claude-code/api/claude/' + path, body, { write: true })
    if (!res.body || typeof res.body !== 'object' || ![200, 400, 409, 500, 502].includes(res.status)) return lost(operationKey)
    return shape(res.body)
  }

  const H = {}
  H['ai_accounts.inventory'] = {
    validate(args) { if (!exact(args, [])) fail('bad_request'); return {} },
    async run(p) { return projectInventory(await upstream(p, '/api/accounts')) },
  }
  H['ai_accounts.change'] = {
    // add | reconnect | remove | prefer, on a credential the page listed. `confirmed` is never an app argument:
    // the Service adds it upstream only after consuming the owner's trusted-shell confirmation.
    validate(args) {
      if (!exact(args, ['action', 'target']) || !CHANGE_ACTIONS.has(args.action)) fail('bad_request')
      if (args.action === 'add' ? args.target !== null : (typeof args.target !== 'string' || !CRED_ID.test(args.target))) fail('bad_request')
      return { action: args.action, target: args.target }
    },
    async describe(p, args) {
      const inv = projectInventory(await upstream(p, '/api/accounts'))
      const brand = inv.provider === 'claude' ? 'Claude' : 'ChatGPT'
      const row = inv.accounts.find(a => a.credentials.some(c => c.id === args.target))
      const cred = row?.credentials.find(c => c.id === args.target)
      if (args.action !== 'add' && !row) fail('not_found')
      const who = row ? (row.email || row.name || 'this account') : ''
      return {
        add: { title: `Connect a ${brand} account`, detail: `Starts ${brand}'s own sign-in inside your agent. Your agent keeps the sign-in; the app never sees it.`, danger: false, action: 'Continue' },
        reconnect: { title: `Reconnect ${who}`, detail: `Starts ${brand}'s sign-in again for this account.`, danger: false, action: 'Continue' },
        remove: { title: 'Remove this sign-in?', detail: `${cred?.name || 'Sign-in'} · ${who}. Your agent stops using it.`, danger: true, action: 'Remove' },
        prefer: { title: `Use ${who} first?`, detail: 'Your agent tries this account first and moves to the others when it hits a limit. Nothing signs out.', danger: false, action: 'Use first' },
      }[args.action]
    },
    run(p, args, operationKey, ctx) {
      return once(p, 'ai_accounts.change', args, operationKey, ctx.recheck,
        () => jobWrite(p, { action: args.action, ...(args.target ? { target: args.target } : {}), label: '', confirmed: true }, operationKey, ctx.signin))
    },
  }
  H['ai_accounts.progress'] = {
    validate(args) { if (!exact(args, ['operation']) || typeof args.operation !== 'string' || !JOB_ID.test(args.operation)) fail('bad_request'); return { operation: args.operation } },
    async run(p, args, _k, ctx) { return projectJob(p, await upstream(p, '/api/operations/' + args.operation), ctx.signin) },
  }
  H['ai_accounts.step'] = {
    // A step of an operation that was already confirmed: paste the Claude code, or cancel. Never starts anything.
    validate(args) {
      if (exact(args, ['action', 'operation']) && args.action === 'cancel' && JOB_ID.test(String(args.operation))) return { action: 'cancel', operation: args.operation }
      if (exact(args, ['action', 'operation', 'code']) && args.action === 'submit' && JOB_ID.test(String(args.operation)) && typeof args.code === 'string' && AUTH_CODE.test(args.code)) return { action: 'submit', operation: args.operation, code: args.code }
      fail('bad_request')
    },
    run(p, args, operationKey, ctx) {
      // The receipt keeps a digest only; the pasted code is never stored.
      return once(p, 'ai_accounts.step', { ...args, code: args.code ? sha(args.code) : undefined }, operationKey, ctx.recheck,
        () => jobWrite(p, args, operationKey, ctx.signin))
    },
  }
  // ---- The original Claude Code sign-in page (claude-code/): Connect, code, Cancel, Sign out, Test. ----
  const legacyRow = a => ({ id: str(a?.id, 60) || 'claude', name: str(a?.name, 80), detail: text(a?.detail, 300), status: enumOf(ROW_STATUS, a?.status, 'unknown'), plan: str(a?.plan, 60), account: str(a?.account, 160) })
  const plain = d => ({ ok: d.ok === true, message: message(d) })
  H['claude_code.status'] = {
    validate(args) { if (!exact(args, [])) fail('bad_request'); return {} },
    async run(p) {
      const d = await upstream(p, '/claude-code/api/accounts')
      if (!d || !Array.isArray(d.accounts) || d.accounts.length > 8) fail('backend_failed')
      return { accounts: d.accounts.map(legacyRow) }
    },
  }
  H['claude_code.connect'] = {
    validate(args) { if (!exact(args, [])) fail('bad_request'); return {} },
    async describe() { return { title: 'Connect Claude', detail: 'Starts the official Claude Code sign-in for this Wizard. You paste the code Claude shows you back into the app.', danger: false, action: 'Continue' } },
    run(p, args, operationKey, ctx) {
      return once(p, 'claude_code.connect', args, operationKey, ctx.recheck, () => legacyWrite(p, 'connect', {}, operationKey, d => {
        const loginId = typeof d.login_id === 'string' && LOGIN_ID.test(d.login_id) ? d.login_id : null
        const target = d.ok === true && loginId ? navigationTarget(p.browser_contract, d.url) : null
        if (target) ctx.signin?.(`cc:${loginId}`, target, d.url)
        return { ok: d.ok === true && !!target, loginId: target ? loginId : null, signin: target, message: d.ok === true && !target ? 'Claude gave a sign-in page this app may not open.' : message(d) }
      }))
    },
  }
  H['claude_code.code'] = {
    validate(args) {
      if (!exact(args, ['loginId', 'code']) || typeof args.loginId !== 'string' || !LOGIN_ID.test(args.loginId) || typeof args.code !== 'string' || args.code.length < 1 || args.code.length > 4096 || /\s/.test(args.code.trim())) fail('bad_request')
      return { loginId: args.loginId, code: args.code.trim() }
    },
    run(p, args, operationKey, ctx) {
      return once(p, 'claude_code.code', { loginId: args.loginId, code: sha(args.code) }, operationKey, ctx.recheck,
        () => legacyWrite(p, 'code', { login_id: args.loginId, code: args.code }, operationKey, plain))
    },
  }
  H['claude_code.cancel'] = {
    validate(args) { if (!exact(args, [])) fail('bad_request'); return {} },
    run(p, args, operationKey, ctx) { return once(p, 'claude_code.cancel', args, operationKey, ctx.recheck, () => legacyWrite(p, 'cancel', {}, operationKey, plain)) },
  }
  H['claude_code.logout'] = {
    validate(args) { if (!exact(args, [])) fail('bad_request'); return {} },
    async describe() { return { title: 'Disconnect Claude?', detail: 'Your agents stop using your Claude subscription until you connect again.', danger: true, action: 'Disconnect' } },
    run(p, args, operationKey, ctx) { return once(p, 'claude_code.logout', args, operationKey, ctx.recheck, () => legacyWrite(p, 'logout', {}, operationKey, plain)) },
  }
  H['claude_code.test'] = {
    validate(args) { if (!exact(args, [])) fail('bad_request'); return {} },
    run(p, args, operationKey, ctx) {
      return once(p, 'claude_code.test', args, operationKey, ctx.recheck, () => legacyWrite(p, 'test', {}, operationKey, d => ({
        ...plain(d), seconds: num(d.seconds), model: str(d.model, 80) })))
    },
  }
  return Object.freeze(Object.fromEntries(Object.entries(H).map(([k, v]) => [k, Object.freeze(v)])))
}
