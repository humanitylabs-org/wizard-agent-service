// Read-only subscription quota reads for Settings → AI usage.
//
// Both providers are read with the sign-in the host already keeps for its own
// CLIs. Credentials stay inside this process: nothing here writes, refreshes,
// or echoes a token, no endpoint or credential path is reachable from client
// input, and the client only ever receives the normalized shape built below.
//
// Percentages describe rate-limit windows. They are not token counts and not a
// prediction of how much work fits in the remaining allowance.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

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

async function getJson(fetchImpl, url, headers, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { headers, redirect: 'error', signal: controller.signal })
    const raw = Buffer.from(await response.arrayBuffer())
    if (raw.length > MAX_RESPONSE_BYTES) throw Object.assign(new Error('usage response too large'), { code: PROVIDER_ERROR })
    if (!response.ok) {
      const expired = response.status === 401 || response.status === 403
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

function jwtExpiry(token) {
  const segment = String(token).split('.')[1]
  if (!segment) return null
  try {
    const claims = JSON.parse(Buffer.from(segment.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'))
    return isFiniteNumber(claims?.exp) ? claims.exp * 1000 : null
  } catch { return null }
}

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

function codexSource(options) {
  const authPath = resolve(String(options.codexAuthPath ?? resolve(homedir(), '.codex/auth.json')))
  const usageUrl = String(options.codexUsageUrl ?? CODEX_USAGE_URL)
  const identity = { id: 'codex', name: 'ChatGPT' }
  return {
    id: identity.id,
    async read({ fetchImpl, now, timeoutMs }) {
      const tokens = readJsonFile(authPath)?.tokens
      const token = typeof tokens?.access_token === 'string' ? tokens.access_token.trim() : ''
      if (!token) return unavailable(identity, SIGNED_OUT, 'ChatGPT is not signed in on the Wizard host.')
      const expiresAt = jwtExpiry(token)
      // Wizard reads the existing sign-in; it never refreshes or rewrites it.
      if (expiresAt !== null && expiresAt <= now()) {
        return unavailable(identity, EXPIRED, 'ChatGPT sign-in on the Wizard host has expired.')
      }
      const accountId = typeof tokens.account_id === 'string' ? tokens.account_id.trim() : ''
      const payload = await getJson(fetchImpl, usageUrl, {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'codex-cli',
        ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
      }, timeoutMs)
      const plan = titleFromSlug(payload?.plan_type) || null
      return { ...identity, status: 'ok', plan, fetchedAt: new Date(now()).toISOString(), limits: codexLimits(payload, now), paid: codexPaid(payload), error: null }
    },
  }
}

/* Reader --------------------------------------------------------------- */

export function createAiUsageReader(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? (() => Date.now())
  const cacheMs = isFiniteNumber(options.cacheMs) ? options.cacheMs : AI_USAGE_CACHE_MS
  const staleLimitMs = isFiniteNumber(options.staleLimitMs) ? options.staleLimitMs : AI_USAGE_STALE_LIMIT_MS
  const timeoutMs = isFiniteNumber(options.timeoutMs) ? options.timeoutMs : REQUEST_TIMEOUT_MS
  const sources = [claudeSource(options), codexSource(options)]
  const cells = new Map(sources.map((source) => [source.id, { snapshot: null, at: 0, lastGood: null, lastGoodAt: 0, inflight: null }]))

  const attempt = async (source, cell) => {
    let snapshot
    try {
      snapshot = await source.read({ fetchImpl, now, timeoutMs })
    } catch (error) {
      const code = error?.name === 'AbortError' || error?.name === 'TimeoutError' ? UNREACHABLE : (error?.code ?? UNREACHABLE)
      const message = code === EXPIRED
        ? `${source.id === 'claude' ? 'Claude' : 'ChatGPT'} sign-in on the Wizard host has expired.`
        : `Couldn't reach ${source.id === 'claude' ? 'Claude' : 'ChatGPT'}.`
      snapshot = unavailable({ id: source.id, name: source.id === 'claude' ? 'Claude' : 'ChatGPT' }, code, message)
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
    const cell = cells.get(source.id)
    if (cell.snapshot && now() - cell.at < cacheMs) return Promise.resolve(cell.snapshot)
    // One provider request in flight at a time; concurrent views share it.
    if (!cell.inflight) cell.inflight = attempt(source, cell).finally(() => { cell.inflight = null })
    return cell.inflight
  }

  return {
    async read() {
      const providers = await Promise.all(sources.map(readSource))
      return { fetchedAt: new Date(now()).toISOString(), providers }
    },
  }
}
