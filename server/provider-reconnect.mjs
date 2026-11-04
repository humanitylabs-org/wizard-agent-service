// A Wizard chat turn that failed because the AI provider's sign-in expired or is missing
// (Claude Code logged out, ChatGPT/Codex refresh token dead) is not something Retry fixes.
// Hermes reports it on GET /v1/runs/{id} as status 'failed' with the provider's words in
// `error` (or in `output` as "<Provider> rejected your sign-in … Provider said: HTTP 401: …"),
// and closes the transcript with its generic "Your request was not processed" boundary row.
// This module recognises exactly those sign-in failures and names the connection app that
// fixes them, so the shell can show one plain sentence and an Open button.

export const PROVIDER_SIGNED_OUT = 'provider_signed_out'

// Connection apps (wizard-app-store) by provider family. The shell opens the installed app,
// or the Store on it when it isn't installed.
export const RECONNECT_APPS = Object.freeze({
  claude: Object.freeze({ provider: 'claude', appId: 'wizard-claude', name: 'Claude' }),
  chatgpt: Object.freeze({ provider: 'chatgpt', appId: 'wizard-chatgpt', name: 'ChatGPT' }),
})

const CLAUDE_ROUTES = new Set(['claude-subscription-directsdk-experimental', 'anthropic', 'claude'])
const CHATGPT_ROUTES = new Set(['openai-codex', 'codex', 'chatgpt'])

// Strong sign-in failure signals (provider adapters and Hermes' own auth copy).
const CLAUDE_SIGNALS = [
  /Claude Code is installed but has no usable login/i,
  /\bClaudeCodeLoggedOut\b/,
  /OAuth session expired and could not be refreshed/i,
  /\bclaude auth login\b/i,
]
const CHATGPT_SIGNALS = [
  /\bcodex_auth_(?:expired|refresh_failed|missing(?:_access_token|_refresh_token)?)\b/,
  /\bcodex_refresh_failed\b/,
  /ChatGPT\/Codex login looks expired/i,
  /\bcodex login\b/i,
]
// Generic sign-in failures: only trusted on a known Claude/ChatGPT subscription route.
const GENERIC_SIGNALS = [
  /rejected your sign-in/i,
  /\binvalid_grant\b/,
  /\b(?:token_expired|expired_token|refresh_token_reused)\b/,
  /\bHTTP 401\b/,
  /\bFailed to authenticate\b/i,
  /\bauthentication_error\b/,
]
// An API key problem is not a sign-in the connection app can repair; usage limits are not sign-outs.
const NOT_SIGN_IN = [/rejected your API key/i, /\brate[- ]limit/i, /\busage[_ ]limit/i, /\bquota\b/i]

const textOf = (value) => {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  return [value.message, value.code, value.type, value.detail].filter((v) => typeof v === 'string').join(' ')
}

function routeOf(payload, body) {
  const candidates = [payload?.runtime?.provider, payload?.usage?.runtime?.provider,
    payload?.runtime?.requested?.provider, payload?.usage?.runtime?.requested?.provider, body?.provider]
  return candidates.filter((v) => typeof v === 'string').map((v) => v.trim().toLowerCase())
}

/**
 * Which connection app fixes this failed run, or null. `payload` is the Hermes run status,
 * `body` the queued request (it names the provider route when Hermes' failure omits runtime).
 */
export function classifyProviderSignOut(payload, body = null) {
  if (!payload || typeof payload !== 'object' || payload.status !== 'failed') return null
  const text = [textOf(payload.error), textOf(payload.output), textOf(payload.final_response)].join('\n').slice(0, 8000)
  const known = reconnectOf(payload.wizard_reconnect)
  if (known) return known
  if (!text.trim()) return null
  if (CLAUDE_SIGNALS.some((re) => re.test(text))) return RECONNECT_APPS.claude
  if (CHATGPT_SIGNALS.some((re) => re.test(text))) return RECONNECT_APPS.chatgpt
  if (NOT_SIGN_IN.some((re) => re.test(text)) || !GENERIC_SIGNALS.some((re) => re.test(text))) return null
  const routes = routeOf(payload, body)
  if (routes.some((r) => CLAUDE_ROUTES.has(r))) return RECONNECT_APPS.claude
  if (routes.some((r) => CHATGPT_ROUTES.has(r))) return RECONNECT_APPS.chatgpt
  return null
}

export function reconnectMessage(app, installed = true) {
  return installed
    ? `${app.name} sign-in expired`
    : `${app.name} sign-in expired`
}

/** Annotate a failed run payload in place-free fashion: safe_error + wizard_reconnect, or unchanged. */
export function annotateProviderSignOut(payload, body = null) {
  const app = classifyProviderSignOut(payload, body)
  if (!app) return payload
  return {
    ...payload,
    safe_error: reconnectMessage(app),
    wizard_reconnect: { kind: PROVIDER_SIGNED_OUT, provider: app.provider, app_id: app.appId },
  }
}

/** The projected field for one thread, validated (stored payloads are data, never trusted shape). */
export function reconnectOf(value) {
  if (!value || typeof value !== 'object' || value.kind !== PROVIDER_SIGNED_OUT) return null
  const app = RECONNECT_APPS[value.provider]
  return app && value.app_id === app.appId ? app : null
}

/**
 * Decorate projected session rows that carry `wizard_reconnect` with whether the connection app is
 * installed (apps.json) and what it reports right now (its /api/connection status via the AI usage
 * reader). The failed run stays the authority: an app that reads a different sign-in may say it is
 * connected while Hermes is still signed out, so `confirmed` is evidence, never a reason to hide it.
 */
export function decorateReconnect(rows, { installedApps = [], usage = null } = {}) {
  const installed = new Set(installedApps.filter((a) => a && a.status === 'running').map((a) => a.id))
  const providers = Array.isArray(usage?.providers) ? usage.providers : []
  for (const row of rows) {
    const app = reconnectOf(row?.wizard_reconnect)
    if (!app) { if (row && 'wizard_reconnect' in row) delete row.wizard_reconnect; continue }
    const isInstalled = installed.has(app.appId)
    const reading = providers.find((p) => p && p.id === app.provider)
    const code = reading?.error?.code ?? reading?.accounts?.find?.((a) => a?.error)?.error?.code
    row.wizard_reconnect = {
      kind: PROVIDER_SIGNED_OUT,
      provider: app.provider,
      app_id: app.appId,
      app_name: app.name,
      run_id: row.wizard_reconnect.run_id || '',
      installed: isInstalled,
      app_status: !reading ? 'unknown' : (code === 'signed_out' || code === 'expired') ? code : reading.status === 'ok' ? 'connected' : 'unknown',
    }
    row.wizard_safe_error = reconnectMessage(app, isInstalled)
  }
  return rows
}
