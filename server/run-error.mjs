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

// Supported credential families do not need digits. Keep the mixed-character fallback too.
// Allow an underscore before a recognized prefix; arbitrary joined words and unknown secrets remain unproven.
const CREDENTIAL = /(?<![A-Za-z0-9])(?:(?:sk-|rk-|pk-|sess-)[A-Za-z0-9_+/.=*-]+|AIza[A-Za-z0-9_-]+|(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g
const KEYISH = /[A-Za-z0-9][A-Za-z0-9_\-+/=.*]{15,}/g
// Consume whole quoted values (including escaped quotes) before the message is shortened.
const LABELED_SECRET = /(\b(?:(?:api|access|refresh|auth|client)[ _-]?)?(?:key|token|secret|password)(?:[ _-]provided)?["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi
const BEARER = /\bBearer\s+(?!\[redacted\])(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;}\]]+)/gi
// Always consume from an escaped opening quote through the end of this input.
// JSON decoding bounds the input to one complete string; raw trailing prose is discarded.
const ESCAPED_BEARER = /\bBearer\s+\\+["'][\s\S]*/gi
const JSON_STRING = /"(?:\\.|[^"\\])*"/g

function redactBearers(raw) {
  const redact = (value) => value.replace(ESCAPED_BEARER, 'Bearer [redacted]').replace(BEARER, 'Bearer [redacted]')
  // Decode complete JSON string literals first so serialized quotes cannot become
  // token boundaries. Re-encoding preserves the surrounding JSON and explanation.
  const serialized = raw.replace(JSON_STRING, (value) => {
    try {
      const decoded = JSON.parse(value)
      const redacted = redact(decoded)
      return redacted === decoded ? value : JSON.stringify(redacted)
    } catch {
      return value
    }
  })
  return redact(serialized)
}

function messageOf(payload) {
  const said = [payload.output, payload.final_response].map((v) => /Provider said:\s*([^\n]+)/.exec(textOf(v))?.[1]).find(Boolean)
  const raw = said || textOf(payload.error) || ''
  // Redact Bearer values before a label can consume the word Bearer and leave its value.
  return redactBearers(raw)
    .replace(LABELED_SECRET, (_match, label, value) => {
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : ''
      return `${label}${quote}[redacted]${quote}`
    })
    .replace(CREDENTIAL, '[redacted]')
    .replace(KEYISH, (m) => /[A-Za-z]/.test(m) && /\d/.test(m) ? '[redacted]' : m)
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
  const output = copy(payload.output)
  const finalResponse = copy(payload.final_response)
  const text = [textOf(payload.error), output, finalResponse].join('\n').slice(0, 8000)
  // Apply the same evidence boundary to sign-out detection. The reconnect annotation may
  // itself have been inferred from partial prose, so derive this field without it.
  const signedOut = classifyProviderSignOut({
    ...payload,
    output,
    final_response: finalResponse,
    wizard_reconnect: undefined,
  }, body)
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
