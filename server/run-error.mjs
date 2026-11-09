// Why the last run of a thread failed, in one structured field the shell can name plainly
// (wizard-ux issue 166): `wizard_last_run_error: { code, provider, message }`.
// An expired ChatGPT plan, a usage limit and a dropped connection all end as the same Hermes
// "Your request was not processed" row; only the run's `error` / `output` say which one it was.
// Classified from the provider's HTTP status (401/403 auth, 402 billing, 429 quota) and its
// error body, with the same wording families Hermes' agent/error_classifier.py uses.
// The field only appears on a failed run with provider evidence; ordinary failures get none.
import { classifyProviderSignOut } from './provider-reconnect.mjs'

export const RUN_ERROR_CODES = Object.freeze(['provider_auth', 'provider_billing', 'provider_quota', 'network', 'unknown'])

// Plan ended, payment needed or credit gone: Retry on the same account cannot work.
const BILLING = [
  /\b(?:insufficient[_ ](?:quota|credits?|balance)|credit[_ ]balance|credits? (?:have been |are )?exhausted|no usable credits)\b/i,
  /\bpayment[_ ]required\b/i, /\bbilling(?:[_ ]not[_ ]active| hard limit|_hard_limit)\b/i, /\bhard billing limit\b/i,
  /\bexceeded your current quota\b/i, /\baccount (?:is|has been) deactivated\b/i, /\bplan does not include\b/i,
  /\b(?:subscription|plan) (?:has |is )?(?:ended|expired|inactive|cancel(?:l)?ed|lapsed)\b/i,
  /\bno active (?:subscription|plan)\b/i, /\b(?:balance_depleted|out of funds|budget limit exceeded)\b/i,
  /\b(?:organization|project)_(?:spend|usage)_limit_exceeded\b/i,
]
// A usage or rate limit that resets: Retry later, or another model now.
const QUOTA = [
  /\busage[_ ]limit(?:[_ ]reached)?\b/i, /\bhit your (?:usage )?limit\b/i, /\brate[_ -]?limit/i, /\btoo many requests\b/i,
  /\bresource[_ -]?exhausted\b/i, /\b(?:requests|tokens) per (?:minute|day)\b/i, /\bquota\b/i, /\blimit exceeded\b/i,
]
const AUTH = [
  /\binvalid[_ ]api[_ ]key\b/i, /\brejected your (?:sign-in|API key)\b/i, /\bunauthori[sz]ed\b/i, /\bauthentication[_ ](?:error|failed)\b/i,
  /\bFailed to authenticate\b/i, /\b(?:token[_ ](?:expired|revoked)|expired_token|invalid_grant)\b/i, /\baccess denied\b/i,
]
// The connection to the provider failed before it answered (the account is fine).
const NETWORK = [
  /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b/,
  /\bgetaddrinfo\b/i, /\bsocket hang up\b/i, /\b(?:APIConnectionError|ConnectError|ConnectTimeout|ReadTimeout)\b/,
  /\bconnection (?:error|refused|reset|aborted|timed out)\b/i, /\bnetwork (?:error|is unreachable)\b/i,
  /\bname resolution\b/i, /\b(?:request|read|operation|connect) timed out\b/i, /\bfetch failed\b/i,
]

const textOf = (value) => {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  return [value.message, value.code, value.type, value.detail, typeof value.status === 'number' ? `HTTP ${value.status}` : '']
    .filter((v) => typeof v === 'string' && v).join(' ')
}

function routeOf(payload, body) {
  const candidates = [payload?.runtime?.provider, payload?.usage?.runtime?.provider,
    payload?.runtime?.requested?.provider, payload?.usage?.runtime?.requested?.provider, body?.provider]
  return candidates.find((v) => typeof v === 'string' && v.trim())?.trim().slice(0, 60) || ''
}

// The provider's HTTP status when the error names one ("HTTP 429:", "Error code: 402", "status 401").
function httpStatusOf(text) {
  const m = /\b(?:HTTP|Error code:?|status(?: code)?:?)\s*(\d{3})\b/i.exec(text)
  return m ? Number(m[1]) : 0
}

// The provider's own words, short and without anything token-shaped.
function messageOf(payload) {
  const said = /Provider said:\s*([^\n]+)/.exec(textOf(payload.output))?.[1]
  const raw = said || textOf(payload.error) || ''
  return raw.replace(/\b(?:sk|rk|pk|sess)-[A-Za-z0-9_*-]{8,}/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+){0,2}/g, '[redacted]')
    .replace(/\s+/g, ' ').trim().slice(0, 200)
}

/**
 * `{ code, provider, message }` for a failed run whose provider said why, or null.
 * `payload` is the Hermes run status, `body` the queued request (names the route when runtime is missing).
 * @param {any} payload
 * @param {any} [body]
 */
export function classifyRunError(payload, body = null) {
  if (!payload || typeof payload !== 'object' || payload.status !== 'failed') return null
  // Wizard's own recovery or delivery failures are not provider answers.
  if (payload.error && typeof payload.error === 'object' && /^(?:provider_recovery_failed|provider_preflight_failed)$/.test(String(payload.error.type || ''))) return null
  // A failed run's output can hold a partial answer; only Hermes' failure copy ("… Provider said: …") counts.
  const copy = (v) => { const t = textOf(v); return /Provider said:/.test(t) ? t : '' }
  const text = [textOf(payload.error), copy(payload.output), copy(payload.final_response)].join('\n').slice(0, 8000)
  const signedOut = classifyProviderSignOut(payload, body)
  const provider = routeOf(payload, body) || signedOut?.provider || ''
  const field = (code) => ({ code, provider, message: messageOf(payload) })
  if (signedOut) return field('provider_auth')
  if (!text.trim()) return null
  const status = httpStatusOf(text)
  if (status === 402 || BILLING.some((re) => re.test(text))) return field('provider_billing')
  if (status === 429 || QUOTA.some((re) => re.test(text))) return field('provider_quota')
  if (status === 401 || status === 403 || AUTH.some((re) => re.test(text))) return field('provider_auth')
  if (NETWORK.some((re) => re.test(text))) return field('network')
  // Another provider HTTP error (500, 503, 400 …): the provider answered, but not with a known reason.
  if (status >= 400 && status <= 599) return field('unknown')
  return null
}

/** The projected field, validated (stored or routed payloads are data, never trusted shape). */
export function runErrorOf(value) {
  if (!value || typeof value !== 'object' || !RUN_ERROR_CODES.includes(value.code)) return null
  const one = (x, n) => (typeof x === 'string' ? x : '').replace(/\s+/g, ' ').trim().slice(0, n)
  return { code: value.code, provider: one(value.provider, 60), message: one(value.message, 200) }
}
