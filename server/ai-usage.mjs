// Read-only subscription quota reads for Settings → AI usage.
//
// Installed AI connection apps (apps.json `provides: ai-connection`, contract
// wizard.ai-connection/1) are read first: each one owns its provider's sign-in
// and reports status and usage on its own `/api/connection`. A provider with no
// connection app falls back to the sign-in the host already keeps for its own
// CLIs. Credentials stay inside this process: nothing here writes, refreshes,
// or echoes a token, no endpoint or credential path is reachable from client
// input, and the client only ever receives the normalized shape built below.
//
// Percentages describe rate-limit windows. They are not token counts and not a
// prediction of how much work fits in the remaining allowance.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'

export const AI_USAGE_CACHE_MS = 60_000
// Beyond this a failing provider stops showing its last good numbers at all:
// an hours-old percentage is not honest evidence about the current window.
export const AI_USAGE_STALE_LIMIT_MS = 30 * 60_000
const REQUEST_TIMEOUT_MS = 8_000
const MAX_RESPONSE_BYTES = 256 * 1024
const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
// Mirrors the Codex CLI PathStyle split: ChatGPT backends serve usage at /wham.
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

const SIGNED_OUT = 'signed_out'
const EXPIRED = 'expired'
const UNREACHABLE = 'unreachable'
const PROVIDER_ERROR = 'provider_error'
// Only transport-level failures may keep showing the last good read. An expired
// or missing sign-in is an honest unavailable state, never a stale percentage.
const STALE_ELIGIBLE = new Set([UNREACHABLE, PROVIDER_ERROR])

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)

function readJsonFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch { return null }
}

function clampPercent(value) {
  if (!isFiniteNumber(value)) return null
  return Math.min(100, Math.max(0, value))
}

function isoTime(value) {
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
  }
  // Codex reports resets as epoch seconds.
  if (isFiniteNumber(value) && value > 0) return new Date(value * 1000).toISOString()
  return null
}

function titleFromSlug(value) {
  const cleaned = String(value ?? '').replaceAll('_', ' ').replaceAll('-', ' ').trim()
  if (!cleaned) return ''
  return cleaned.split(/\s+/).map((word) => word[0].toUpperCase() + word.slice(1)).join(' ')
}

// Remaining is floored so a partly used window never reads as a full one.
function usageRow(id, label, usedPercent, resetsAt) {
  const used = clampPercent(usedPercent)
  if (used === null) return null
  return {
    id,
    label,
    usedPercent: Math.round(used * 10) / 10,
    remainingPercent: Math.floor(100 - used),
    resetsAt: isoTime(resetsAt),
  }
}

function unavailable(provider, code, message, plan = null) {
  return { ...provider, status: 'unavailable', plan, fetchedAt: null, limits: [], paid: null, error: { code, message } }
}

async function getJson(fetchImpl, url, headers, timeoutMs, { authFailureExpired = true } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { headers, redirect: 'error', signal: controller.signal })
    // Enforce the cap while consuming the body, not after arrayBuffer() has
    // already allocated an unbounded response from an installed app.
    const chunks = []
    let bytes = 0
    const body = response.body?.getReader()
    if (body) {
      try {
        while (true) {
          const { done, value } = await body.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > MAX_RESPONSE_BYTES) {
            await body.cancel().catch(() => {})
            throw Object.assign(new Error('usage response too large'), { code: PROVIDER_ERROR })
          }
          chunks.push(Buffer.from(value))
        }
      } finally { body.releaseLock() }
    }
    const raw = Buffer.concat(chunks, bytes)
    if (!response.ok) {
      const expired = authFailureExpired && (response.status === 401 || response.status === 403)
      throw Object.assign(new Error(`usage request failed (${response.status})`), { code: expired ? EXPIRED : PROVIDER_ERROR })
    }
    try { return JSON.parse(raw.toString('utf8')) ?? {} }
    catch { throw Object.assign(new Error('usage response was not JSON'), { code: PROVIDER_ERROR }) }
  } finally {
    clearTimeout(timer)
  }
}

/* Claude -------------------------------------------------------------- */

const CLAUDE_TIERS = new Map([
  ['default_claude_max_20x', 'Max 20x'],
  ['default_claude_max_5x', 'Max 5x'],
  ['default_claude_pro', 'Pro'],
])
const CLAUDE_SUBSCRIPTIONS = new Map([['max', 'Max'], ['pro', 'Pro'], ['team', 'Team'], ['enterprise', 'Enterprise'], ['free', 'Free']])
// Legacy fields only. `utilization` is already a percentage (8.0 means 8%), so
// it is never rescaled; treating it as a fraction turns 1% used into 100% used.
const CLAUDE_LEGACY_WINDOWS = [
  ['five_hour', 'Session'],
  ['seven_day', 'All models · weekly'],
  ['seven_day_opus', 'Opus · weekly'],
  ['seven_day_sonnet', 'Sonnet · weekly'],
]

function claudePlan(credentials) {
  const tier = String(credentials?.rateLimitTier ?? '').trim()
  if (CLAUDE_TIERS.has(tier)) return CLAUDE_TIERS.get(tier)
  return CLAUDE_SUBSCRIPTIONS.get(String(credentials?.subscriptionType ?? '').trim().toLowerCase()) ?? null
}

function claudeLimitLabel(entry, model) {
  const kind = String(entry?.kind ?? '').trim()
  if (kind === 'session') return model ? `${model} · session` : 'Session'
  if (kind === 'weekly_all') return 'All models · weekly'
  if (kind === 'weekly_scoped') return model ? `${model} · weekly` : 'Scoped · weekly'
  // A limit kind Wizard has not seen yet still belongs on screen, labelled from
  // whatever the provider called it rather than guessed at.
  return model || titleFromSlug(kind) || titleFromSlug(entry?.group) || 'Limit'
}

function claudeLimits(payload) {
  const labelled = Array.isArray(payload?.limits) ? payload.limits : []
  const rows = []
  labelled.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return
    const model = String(entry.scope?.model?.display_name ?? '').trim().slice(0, 40)
    const kind = String(entry.kind ?? '').trim().slice(0, 40)
    const row = usageRow(`${kind || 'limit'}:${model || entry.group || index}`, claudeLimitLabel(entry, model), entry.percent, entry.resets_at)
    if (row) rows.push(row)
  })
  if (rows.length) return rows
  for (const [key, label] of CLAUDE_LEGACY_WINDOWS) {
    const window = payload?.[key]
    if (!window || typeof window !== 'object') continue
    const row = usageRow(key, label, window.utilization, window.resets_at)
    if (row) rows.push(row)
  }
  return rows
}

function claudePaid(payload) {
  const spend = payload?.spend
  if (spend && typeof spend === 'object') {
    const usedMinor = spend.used?.amount_minor
    const limitMinor = spend.limit?.amount_minor
    if (isFiniteNumber(usedMinor) || isFiniteNumber(limitMinor)) {
      return {
        type: 'spend',
        enabled: spend.enabled === true,
        currency: String(spend.limit?.currency ?? spend.used?.currency ?? 'USD').slice(0, 8),
        exponent: isFiniteNumber(spend.limit?.exponent) ? spend.limit.exponent : 2,
        usedMinor: isFiniteNumber(usedMinor) ? Math.round(usedMinor) : null,
        limitMinor: isFiniteNumber(limitMinor) ? Math.round(limitMinor) : null,
        balanceMinor: null,
        unlimited: false,
      }
    }
  }
  // Legacy payloads report the same money in minor units under extra_usage.
  const extra = payload?.extra_usage
  if (extra && typeof extra === 'object' && (isFiniteNumber(extra.used_credits) || isFiniteNumber(extra.monthly_limit))) {
    return {
      type: 'spend',
      enabled: extra.is_enabled === true,
      currency: String(extra.currency ?? 'USD').slice(0, 8),
      exponent: isFiniteNumber(extra.decimal_places) ? extra.decimal_places : 2,
      usedMinor: isFiniteNumber(extra.used_credits) ? Math.round(extra.used_credits) : null,
      limitMinor: isFiniteNumber(extra.monthly_limit) ? Math.round(extra.monthly_limit) : null,
      balanceMinor: null,
      unlimited: false,
    }
  }
  return null
}

function claudeSource(options) {
  const credentialsPath = resolve(String(options.claudeCredentialsPath ?? resolve(homedir(), '.claude/.credentials.json')))
  const usageUrl = String(options.anthropicUsageUrl ?? ANTHROPIC_USAGE_URL)
  const identity = { id: 'claude', name: 'Claude' }
  return {
    id: identity.id,
    async read({ fetchImpl, now, timeoutMs }) {
      const credentials = readJsonFile(credentialsPath)?.claudeAiOauth
      const token = typeof credentials?.accessToken === 'string' ? credentials.accessToken.trim() : ''
      if (!token) return unavailable(identity, SIGNED_OUT, 'Claude is not signed in on the Wizard host.')
      const plan = claudePlan(credentials)
      if (isFiniteNumber(credentials.expiresAt) && credentials.expiresAt <= now()) {
        return unavailable(identity, EXPIRED, 'Claude sign-in on the Wizard host has expired.', plan)
      }
      const payload = await getJson(fetchImpl, usageUrl, {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/2.1.0',
      }, timeoutMs)
      return { ...identity, status: 'ok', plan, fetchedAt: new Date(now()).toISOString(), limits: claudeLimits(payload), paid: claudePaid(payload), error: null }
    },
  }
}

/* ChatGPT / Codex ------------------------------------------------------ */

// The Codex payload names its windows primary/secondary, not by duration: the
// primary window is weekly on some plans and a 5h session on others. The label
// comes from limit_window_seconds so a weekly window is never called a session.
function codexWindowLabel(seconds, key) {
  if (!isFiniteNumber(seconds) || seconds <= 0) return key === 'primary_window' ? 'Primary limit' : 'Secondary limit'
  if (seconds % 604_800 === 0) { const weeks = seconds / 604_800; return weeks === 1 ? 'Weekly' : `${weeks}-week window` }
  if (seconds % 86_400 === 0) { const days = seconds / 86_400; return days === 1 ? 'Daily' : `${days}-day window` }
  if (seconds % 3_600 === 0) return `Session · ${seconds / 3_600}h`
  return `${Math.round(seconds / 60)}m window`
}

function codexLimits(payload, now) {
  const rateLimit = payload?.rate_limit
  if (!rateLimit || typeof rateLimit !== 'object') return []
  const rows = []
  for (const key of ['primary_window', 'secondary_window']) {
    const window = rateLimit[key]
    if (!window || typeof window !== 'object') continue
    const resetsAt = isFiniteNumber(window.reset_at) ? window.reset_at
      : isFiniteNumber(window.reset_after_seconds) ? (now() / 1000) + window.reset_after_seconds
      : null
    const row = usageRow(key, codexWindowLabel(window.limit_window_seconds, key), window.used_percent, resetsAt)
    if (row) rows.push(row)
  }
  return rows
}

function codexPaid(payload) {
  const credits = payload?.credits
  if (!credits || typeof credits !== 'object' || credits.has_credits !== true) return null
  const balance = Number(credits.balance)
  return {
    type: 'credits',
    enabled: true,
    currency: 'USD',
    exponent: 2,
    usedMinor: null,
    limitMinor: null,
    balanceMinor: Number.isFinite(balance) ? Math.round(balance * 100) : null,
    unlimited: credits.unlimited === true,
  }
}

/* ChatGPT accounts ------------------------------------------------------
 *
 * The host may hold more than one ChatGPT subscription: Hermes keeps them as
 * `credential_pool["openai-codex"]` rows in the active profile's auth store,
 * and the Codex CLI keeps its own copy of whichever account it signed in with.
 * Every configured account is read on its own, so one subscription's quota,
 * outage or expiry can never stand in for another's.
 *
 * Nothing here is imported from Hermes: this reads the same files read-only
 * and never refreshes a token, rotates a pool entry or writes the store back.
 */

const CODEX_POOL_PROVIDER = 'openai-codex'
// Token claim namespace used by ChatGPT OAuth tokens, per the Codex CLI.
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth'
// Only the provider's own hosts may be read, whatever a store happens to say.
const CODEX_USAGE_HOSTS = new Set(['chatgpt.com', 'api.openai.com', 'openai.com'])
const CREDENTIAL_ORIGIN_RANK = new Map([['pool', 0], ['store', 1], ['cli', 2]])

const digest = (value) => createHash('sha256').update(String(value)).digest('hex')
const trimmed = (value) => typeof value === 'string' ? value.trim() : ''
const arrayOf = (value) => Array.isArray(value) ? value : []

function jwtClaims(token) {
  const segment = String(token).split('.')[1]
  if (!segment) return {}
  try {
    const claims = JSON.parse(Buffer.from(segment.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'))
    return claims && typeof claims === 'object' ? claims : {}
  } catch { return {} }
}

// Mirrors get_default_hermes_root(): a profile home <root>/profiles/<name>
// falls back to <root>'s store, which is exactly what Hermes itself reads. No
// other profile's store is ever opened.
function hermesStorePaths(options) {
  const explicitHome = trimmed(options.hermesHome) || trimmed(process.env.HERMES_HOME)
  const nativeRoot = resolve(homedir(), '.hermes')
  const home = explicitHome ? resolve(explicitHome) : nativeRoot
  const root = home === nativeRoot || home.startsWith(`${nativeRoot}/`) ? nativeRoot
    : basename(dirname(home)) === 'profiles' ? dirname(dirname(home))
    : home
  const store = options.hermesAuthPath ? resolve(String(options.hermesAuthPath)) : resolve(home, 'auth.json')
  const fallback = options.hermesGlobalAuthPath ? resolve(String(options.hermesGlobalAuthPath))
    : root === home ? '' : resolve(root, 'auth.json')
  return { store, fallback: fallback === store ? '' : fallback }
}

// Same precedence as Hermes' read_credential_pool(): the active profile wins
// whenever it has any row of its own; the root store is a read-only fallback.
function codexPoolRows(options) {
  const { store, fallback } = hermesStorePaths(options)
  const active = readJsonFile(store)
  const rows = arrayOf(active?.credential_pool?.[CODEX_POOL_PROVIDER]).filter((row) => row && typeof row === 'object')
  if (rows.length) return { rows, storeTokens: active?.providers?.[CODEX_POOL_PROVIDER]?.tokens ?? null }
  const shared = fallback ? readJsonFile(fallback) : null
  return {
    rows: arrayOf(shared?.credential_pool?.[CODEX_POOL_PROVIDER]).filter((row) => row && typeof row === 'object'),
    storeTokens: active?.providers?.[CODEX_POOL_PROVIDER]?.tokens ?? null,
  }
}

// Account identity comes from the token's own claims, so the same subscription
// reached through a pool row, the auth store and the CLI collapses into one
// account while separate subscriptions stay separate.
function codexCandidate({ token, accountId = '', origin, priority, fallbackKey, label = '' }) {
  const claims = jwtClaims(token)
  const auth = claims[OPENAI_AUTH_CLAIM] && typeof claims[OPENAI_AUTH_CLAIM] === 'object' ? claims[OPENAI_AUTH_CLAIM] : {}
  const account = trimmed(auth.chatgpt_account_id) || trimmed(accountId) || trimmed(claims.sub)
  return {
    token: trimmed(token),
    origin,
    priority,
    label,
    // An unidentifiable credential keys on itself rather than merging with
    // another one whose account is equally unknown.
    accountKey: digest(account ? `account:${account}` : `credential:${fallbackKey}`),
    accountId: trimmed(auth.chatgpt_account_id) || trimmed(accountId),
    issuedAt: isFiniteNumber(claims.iat) ? claims.iat * 1000 : 0,
    expiresAt: isFiniteNumber(claims.exp) ? claims.exp * 1000 : null,
    baseUrl: '',
  }
}

function codexCandidates(options) {
  const { rows, storeTokens } = codexPoolRows(options)
  const candidates = rows.map((row, index) => ({
    ...codexCandidate({
      token: row.access_token,
      origin: 'pool',
      priority: isFiniteNumber(row.priority) ? row.priority : index,
      fallbackKey: `pool:${trimmed(row.id) || index}`,
      label: trimmed(row.label),
    }),
    baseUrl: trimmed(row.base_url),
  }))
  const extras = []
  const cliTokens = readJsonFile(resolve(String(options.codexAuthPath ?? resolve(homedir(), '.codex/auth.json'))))?.tokens
  if (trimmed(storeTokens?.access_token)) {
    extras.push(codexCandidate({ token: storeTokens.access_token, accountId: storeTokens.account_id, origin: 'store', priority: Number.MAX_SAFE_INTEGER, fallbackKey: 'store' }))
  }
  if (trimmed(cliTokens?.access_token)) {
    extras.push(codexCandidate({ token: cliTokens.access_token, accountId: cliTokens.account_id, origin: 'cli', priority: Number.MAX_SAFE_INTEGER, fallbackKey: 'cli' }))
  }
  if (!candidates.length) return extras
  // With a configured pool, the pool is the list of subscriptions. A CLI or
  // singleton copy only joins the account it already belongs to, where it may
  // still win on freshness; it never invents an extra account.
  const known = new Set(candidates.map((candidate) => candidate.accountKey))
  return candidates.concat(extras.filter((extra) => known.has(extra.accountKey)))
}

// Freshest usable credential per account: an unexpired token always beats an
// expired one, then the most recently issued. Wizard never refreshes, so the
// newest copy on disk is the best this process may do.
function preferredCandidate(group, now) {
  const usable = group.filter((candidate) => candidate.token && (candidate.expiresAt === null || candidate.expiresAt > now))
  const ranked = (usable.length ? usable : group).slice().sort((a, b) =>
    b.issuedAt - a.issuedAt || (CREDENTIAL_ORIGIN_RANK.get(a.origin) ?? 9) - (CREDENTIAL_ORIGIN_RANK.get(b.origin) ?? 9))
  return ranked[0]
}

function codexAccounts(options, now) {
  const grouped = new Map()
  for (const candidate of codexCandidates(options)) {
    const group = grouped.get(candidate.accountKey)
    if (group) { group.push(candidate); continue }
    grouped.set(candidate.accountKey, [candidate])
  }
  const accounts = [...grouped.entries()]
    .map(([accountKey, group]) => ({
      accountKey,
      priority: Math.min(...group.map((candidate) => candidate.priority)),
      credential: preferredCandidate(group, now),
    }))
    .sort((a, b) => a.priority - b.priority || a.accountKey.localeCompare(b.accountKey))
  const single = accounts.length <= 1
  return accounts.map((account, index) => ({
    ...account,
    // Stable, safe and human-orderable: never a raw account id, token or email.
    id: index === 0 ? 'codex' : `codex-${index + 1}`,
    name: single ? 'ChatGPT' : `ChatGPT ${index + 1}`,
    accountTag: account.accountKey.slice(0, 6),
  }))
}

function codexUsageUrl(options, baseUrl) {
  const configured = trimmed(options.codexUsageUrl)
  if (configured) return configured
  // Mirrors the Codex CLI PathStyle split, but only for the provider's own
  // hosts: a store value can never point this read somewhere else.
  try {
    const parsed = new URL(baseUrl)
    if (parsed.protocol !== 'https:' || !CODEX_USAGE_HOSTS.has(parsed.hostname)) return CODEX_USAGE_URL
    const path = parsed.pathname.replace(/\/+$/, '').replace(/\/codex$/, '')
    return `${parsed.origin}${path}${path.includes('/backend-api') ? '/wham' : '/api/codex'}/usage`
  } catch { return CODEX_USAGE_URL }
}

function codexAccountSource(account, options) {
  const identity = { id: account.id, name: account.name, accountTag: account.accountTag }
  const usageUrl = codexUsageUrl(options, account.credential?.baseUrl ?? '')
  return {
    id: identity.id,
    name: identity.name,
    // Carried on the source so a thrown provider failure still says which
    // subscription needs attention, exactly as a signed-out one does.
    accountTag: identity.accountTag,
    async read({ fetchImpl, now, timeoutMs }) {
      const credential = account.credential
      if (!credential?.token) return unavailable(identity, SIGNED_OUT, `${identity.name} is not signed in on the Wizard host.`)
      // Wizard reads the existing sign-in; it never refreshes or rewrites it.
      if (credential.expiresAt !== null && credential.expiresAt <= now()) {
        return unavailable(identity, EXPIRED, `${identity.name} sign-in on the Wizard host has expired.`)
      }
      const payload = await getJson(fetchImpl, usageUrl, {
        Authorization: `Bearer ${credential.token}`,
        Accept: 'application/json',
        'User-Agent': 'codex-cli',
        ...(credential.accountId ? { 'ChatGPT-Account-Id': credential.accountId } : {}),
      }, timeoutMs)
      const plan = titleFromSlug(payload?.plan_type) || null
      return { ...identity, status: 'ok', plan, fetchedAt: new Date(now()).toISOString(), limits: codexLimits(payload, now), paid: codexPaid(payload), error: null }
    },
  }
}

// No pool and no sign-in at all is still one honest ChatGPT row.
function codexSources(options, now) {
  const accounts = codexAccounts(options, now)
  if (!accounts.length) return [codexAccountSource({ id: 'codex', name: 'ChatGPT', accountTag: null, credential: null }, options)]
  return accounts.map((account) => codexAccountSource(account, options))
}

/* AI connection apps ----------------------------------------------------
 *
 * Decision #61: each provider is its own connection app. The app answers a
 * read-only `GET /api/connection` (never a token) and this reader maps it onto
 * the provider row shape the shell already renders. The URL comes only from
 * apps.json, pinned to the app's own loopback or container address; no request
 * input reaches it.
 */

export const AI_CONNECTION_CONTRACT = 'wizard.ai-connection/1'
const AI_CONNECTION_PROVIDES = 'ai-connection'
const CONNECTION_ERROR_CODES = new Set([SIGNED_OUT, EXPIRED, UNREACHABLE, PROVIDER_ERROR])
const CONNECTION_STATUS_CODES = new Map([['not_connected', SIGNED_OUT], ['expired', EXPIRED], ['error', PROVIDER_ERROR]])
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
// A connection app for one of these providers replaces the matching host-file reader.
const CLAUDE_PROVIDERS = new Set(['claude'])
const CODEX_PROVIDERS = new Set(['chatgpt', 'codex', 'openai-codex'])
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/u

const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, max) : ''

function originOf(value) {
  try {
    const parsed = new URL(String(value ?? ''))
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password ? parsed : null
  } catch { return null }
}

/**
 * Where this service reaches an app's `/api/connection`. 'local' (the default,
 * and what alongside boxes need: the service runs with host networking) uses the
 * loopback origin of `view.local` or `health`. 'internal' (service in its own
 * container on the apps' network) uses the origin of `mcp.internal`, whose host
 * must be the app id. Anything else is refused rather than followed.
 */
export function aiConnectionUrl(app, address = 'local') {
  const id = app?.id
  if (typeof id !== 'string' || !SLUG.test(id)) return ''
  if (address === 'internal') {
    const internal = originOf(app?.mcp?.internal)
    return internal && internal.hostname === id ? `${internal.origin}/api/connection` : ''
  }
  for (const candidate of [app?.view?.local, app?.health]) {
    const parsed = originOf(candidate)
    if (parsed && LOOPBACK_HOSTS.has(parsed.hostname)) return `${parsed.origin}/api/connection`
  }
  return ''
}

// The provider row id comes from apps.json (`<provider>-subscription` or
// `<provider>-api-key`, else the app id), so the row and its cache stay put
// even while the app is unreachable.
function connectionProvider(provides, id) {
  for (const job of provides) {
    const match = /^([a-z0-9][a-z0-9-]*?)-(subscription|api-key)$/u.exec(job)
    if (match && SLUG.test(match[1])) return match[1]
  }
  return id
}

export function aiConnectionApps(registry, address = 'local') {
  const byProvider = new Map()
  const apps = (Array.isArray(registry?.apps) ? registry.apps : [])
    .filter((app) => app && typeof app === 'object')
    .sort((a, b) => text(a.id, 64).localeCompare(text(b.id, 64)))
  for (const app of apps) {
    if (app.status !== 'running') continue
    const provides = Array.isArray(app.provides) ? app.provides.filter((job) => typeof job === 'string' && SLUG.test(job)) : []
    if (!provides.includes(AI_CONNECTION_PROVIDES)) continue
    const url = aiConnectionUrl(app, address)
    if (!url) continue
    const appId = app.id
    const provider = connectionProvider(provides, appId)
    if (byProvider.has(provider)) continue
    byProvider.set(provider, { appId, provider, name: text(app.name, 40) || titleFromSlug(provider), url })
  }
  return [...byProvider.values()]
}

function connectionLimits(usage) {
  const rows = []
  for (const [index, entry] of arrayOf(usage?.limits).entries()) {
    if (!entry || typeof entry !== 'object') continue
    const row = usageRow(text(entry.id, 80) || `limit:${index}`, text(entry.label, 60) || 'Limit', entry.usedPercent, entry.resetsAt)
    if (row) rows.push(row)
    if (rows.length >= 20) break
  }
  return rows
}

function connectionPaid(paid) {
  if (!paid || typeof paid !== 'object') return null
  const minor = (value) => isFiniteNumber(value) ? Math.round(value) : null
  return {
    type: paid.type === 'credits' ? 'credits' : 'spend',
    enabled: paid.enabled === true,
    currency: text(paid.currency, 8) || 'USD',
    exponent: isFiniteNumber(paid.exponent) ? Math.min(6, Math.max(0, Math.round(paid.exponent))) : 2,
    usedMinor: minor(paid.usedMinor),
    limitMinor: minor(paid.limitMinor),
    balanceMinor: minor(paid.balanceMinor),
    unlimited: paid.unlimited === true,
  }
}

export function connectionRow(identity, payload, now) {
  if (!payload || typeof payload !== 'object' || payload.contract !== AI_CONNECTION_CONTRACT || payload.provider !== identity.id) {
    return unavailable(identity, PROVIDER_ERROR, `${identity.name} app answered with an unknown contract.`)
  }
  const plan = text(payload.plan, 40) || null
  const reported = payload.error && typeof payload.error === 'object' ? payload.error : null
  const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage : null
  // An auth failure revokes cached usage even if the app also supplied an old
  // connected snapshot. Only transport/provider failures can be stale.
  const authCode = CONNECTION_STATUS_CODES.get(payload.status) ?? reported?.code
  if (authCode === SIGNED_OUT || authCode === EXPIRED) {
    return unavailable(identity, authCode, text(reported?.message, 200) || `${identity.name} needs reconnecting.`, plan)
  }
  if (payload.status === 'connected' && usage) {
    const row = {
      ...identity,
      status: 'ok',
      plan,
      fetchedAt: isoTime(usage.fetchedAt) ?? new Date(now()).toISOString(),
      limits: connectionLimits(usage),
      paid: connectionPaid(usage.paid),
      error: null,
    }
    // The app is serving its own last good read through a provider outage.
    if (reported) {
      const code = CONNECTION_ERROR_CODES.has(reported.code) ? reported.code : UNREACHABLE
      return { ...row, status: 'stale', error: { code, message: text(reported.message, 200) || `Couldn't reach ${identity.name}.` } }
    }
    return row
  }
  if (payload.status === 'connected' && !reported) {
    // Signed in, but this provider has no usage API: connected, nothing to chart.
    return { ...identity, status: 'ok', plan, fetchedAt: null, limits: [], paid: null, error: null }
  }
  const code = CONNECTION_ERROR_CODES.has(reported?.code) ? reported.code : (CONNECTION_STATUS_CODES.get(payload.status) ?? PROVIDER_ERROR)
  const fallback = code === SIGNED_OUT ? `${identity.name} is not connected.`
    : code === EXPIRED ? `${identity.name} sign-in has expired.`
    : `Couldn't reach ${identity.name}.`
  return unavailable(identity, code, text(reported?.message, 200) || fallback, plan)
}

function connectionSource(app) {
  const identity = { id: app.provider, name: app.name }
  return {
    id: identity.id,
    name: identity.name,
    // Its own cache cell: switching between a host reader and an app never
    // carries one source's last good numbers into the other.
    cacheKey: `app:${app.appId}:${app.provider}`,
    async read({ fetchImpl, now, timeoutMs }) {
      const payload = await getJson(fetchImpl, app.url, { Accept: 'application/json' }, timeoutMs, { authFailureExpired: false })
      return connectionRow(identity, payload, now)
    },
  }
}

function readConnectionApps(options) {
  const path = trimmed(options.appsJsonPath)
  if (!path) return []
  const registry = readJsonFile(resolve(path))
  return registry ? aiConnectionApps(registry, options.aiConnectionAddress === 'internal' ? 'internal' : 'local') : []
}

/* Reader --------------------------------------------------------------- */

const cellKey = (source) => source.cacheKey ?? source.id

export function createAiUsageReader(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? (() => Date.now())
  const cacheMs = isFiniteNumber(options.cacheMs) ? options.cacheMs : AI_USAGE_CACHE_MS
  const staleLimitMs = isFiniteNumber(options.staleLimitMs) ? options.staleLimitMs : AI_USAGE_STALE_LIMIT_MS
  const timeoutMs = isFiniteNumber(options.timeoutMs) ? options.timeoutMs : REQUEST_TIMEOUT_MS
  const claude = claudeSource(options)
  const cells = new Map()
  // Accounts are re-enumerated once per cache window, not pinned at startup:
  // a subscription added to the pool appears on the next refresh, and one
  // removed stops being read, without restarting Wizard or re-reading the
  // store on every request.
  let enumerated = { sources: [], at: 0 }

  const sourcesNow = () => {
    if (enumerated.sources.length && now() - enumerated.at < cacheMs) return enumerated.sources
    // Installed connection apps first; a host-file reader runs only for a
    // provider no connection app covers, so host-signed-in boxes keep working.
    const apps = readConnectionApps(options)
    const covered = new Set(apps.map((app) => app.provider))
    const hostClaude = [...CLAUDE_PROVIDERS].some((id) => covered.has(id)) ? [] : [claude]
    const hostCodex = [...CODEX_PROVIDERS].some((id) => covered.has(id)) ? [] : codexSources(options, now())
    enumerated = { sources: [...hostClaude, ...hostCodex, ...apps.map(connectionSource)], at: now() }
    const live = new Set(enumerated.sources.map(cellKey))
    for (const id of [...cells.keys()]) if (!live.has(id)) cells.delete(id)
    return enumerated.sources
  }

  const cellFor = (source) => {
    const existing = cells.get(cellKey(source))
    if (existing) return existing
    const created = { snapshot: null, at: 0, lastGood: null, lastGoodAt: 0, inflight: null }
    cells.set(cellKey(source), created)
    return created
  }

  const attempt = async (source, cell) => {
    let snapshot
    try {
      snapshot = await source.read({ fetchImpl, now, timeoutMs })
    } catch (error) {
      // One account's failure is its own: it never replaces another account's
      // numbers and never removes it from the list.
      const code = error?.name === 'AbortError' || error?.name === 'TimeoutError' ? UNREACHABLE : (error?.code ?? UNREACHABLE)
      const name = source.name ?? 'Claude'
      const message = code === EXPIRED
        ? `${name} sign-in on the Wizard host has expired.`
        : `Couldn't reach ${name}.`
      snapshot = unavailable({ id: source.id, name, accountTag: source.accountTag ?? null }, code, message)
    }
    if (snapshot.status === 'ok') {
      cell.lastGood = snapshot
      cell.lastGoodAt = now()
    } else if (STALE_ELIGIBLE.has(snapshot.error?.code) && cell.lastGood && now() - cell.lastGoodAt <= staleLimitMs) {
      // Last known valid data, clearly marked: the countdowns freeze client-side
      // so a frozen window never implies the provider replenished it.
      snapshot = { ...cell.lastGood, status: 'stale', error: snapshot.error }
    } else {
      cell.lastGood = null
    }
    cell.snapshot = snapshot
    cell.at = now()
    return snapshot
  }

  const readSource = (source) => {
    const cell = cellFor(source)
    if (cell.snapshot && now() - cell.at < cacheMs) return Promise.resolve(cell.snapshot)
    // One provider request in flight at a time; concurrent views share it.
    if (!cell.inflight) cell.inflight = attempt(source, cell).finally(() => { cell.inflight = null })
    return cell.inflight
  }

  return {
    async read() {
      const providers = await Promise.all(sourcesNow().map(readSource))
      return { fetchedAt: new Date(now()).toISOString(), providers }
    },
  }
}
