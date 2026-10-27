import { Transform } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

// Hermes controlled provider-resolution failures can arrive as HTTP 200 / completed.
// Match whole messages, never mentions in an ordinary answer or an owner's words.
// Sources: hermes_cli/runtime_provider.py, auth_codex.py and auth.format_auth_error.
const ANTHROPIC_MISSING = "No Anthropic credentials found. Run 'hermes auth add anthropic' to sign in, or set ANTHROPIC_TOKEN / ANTHROPIC_API_KEY."
const COMMAND = 'hermes (?:-p [a-zA-Z0-9_-]+ )?auth add openai-codex --type oauth'
const REAUTH = '(?: Run `hermes (?:-p [a-zA-Z0-9_-]+ )?model` to re-authenticate\\.)?'
const CODEX_MISSING = new RegExp(`^(?:No Codex credentials stored\\. Run \`${COMMAND}\` to authenticate\\.|Codex auth (?:is missing (?:access_token|refresh_token)|state is missing tokens)\\. Run \`${COMMAND}\` to re-authenticate\\.)${REAUTH}$`)
const CODEX_REFRESH = new RegExp(`^(?:Codex token refresh failed with status (?:401|403)\\.|Codex token refresh failed: [^\\r\\n]+|Codex refresh token was already consumed by another client \\(e\\.g\\. Codex CLI or VS Code extension\\)\\. Run \`codex\` in your terminal to generate fresh tokens, then run \`${COMMAND}\` to re-authenticate\\.) Run \`hermes (?:-p [a-zA-Z0-9_-]+ )?model\` to re-authenticate\\.$`)

export function providerSignInEvents() {
  let pending = ''
  const decoder = new StringDecoder('utf8')
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += decoder.write(chunk)
      let end
      while ((end = pending.indexOf('\n\n')) >= 0) {
        this.push(projectProviderSignInEvent(pending.slice(0, end + 2)))
        pending = pending.slice(end + 2)
      }
      // Same bounded-frame contract as other Wizard SSE projections.
      if (pending.length > 8 * 1024 * 1024) return callback(new Error('provider event too large'))
      callback()
    },
    flush(callback) {
      pending += decoder.end()
      if (pending) this.push(projectProviderSignInEvent(pending))
      callback()
    },
  })
}

export function providerSignInNotice(value, selectedModel = '') {
  if (typeof value !== 'string') return null
  const text = value.trim().replace(/^⚠️ Provider authentication failed: /u, '')
  const provider = text === ANTHROPIC_MISSING ? 'Claude'
    : CODEX_MISSING.test(text) || CODEX_REFRESH.test(text) ? 'ChatGPT' : null
  if (!provider) return null
  const target = provider === 'Claude' && /opus/i.test(selectedModel) ? 'Opus' : provider
  const message = `This message is saved. Sign in to ${provider} and it will send to ${target} on its own.`
  return { provider, message, output: '', href: `/troubleshoot/?provider=${provider.toLowerCase()}` }
}

export function signInNoticeOf(payload) {
  const model = payload?.runtime?.model || payload?.model || ''
  return providerSignInNotice(payload?.output, model) || providerSignInNotice(payload?.final_response, model)
    || providerSignInNotice(typeof payload?.error === 'string' ? payload.error : payload?.error?.message, model)
}

export function normalizeProviderPreflightFailure(payload) {
  if (!payload || !['completed', 'failed'].includes(payload.status)) return payload
  const notice = signInNoticeOf(payload)
  if (notice && !(payload.status === 'completed' && payload.usage && ['input_tokens', 'output_tokens', 'total_tokens'].some(key => Number(payload.usage[key]) > 0))) return { ...payload, status: 'failed', last_event: 'run.failed', completed: false,
    output: notice.output, ...(Object.hasOwn(payload, 'final_response') ? { final_response: notice.output } : {}),
    // The shared diagnosed card owns the only explanation and Sign in action.
    // safe_error would paint a duplicate beside that card.
    safe_error: '',
    error: { type: 'provider_sign_in_expired', message: 'Provider sign-in expired.' },
    wizard_provider_auth: { provider: notice.provider, href: notice.href },
    wizard_reconnect: { kind: 'provider_signed_out', provider: notice.provider.toLowerCase(), app_id: notice.provider === 'Claude' ? 'wizard-claude' : 'wizard-chatgpt' },
  }
  // Other zero-token preflight failures (including quota) are not sign-outs.
  if (payload.status !== 'completed' || typeof payload.output !== 'string'
      || !payload.output.startsWith('⚠️ Provider authentication failed:')
      || !payload.usage || payload.usage.input_tokens !== 0 || payload.usage.output_tokens !== 0
      || payload.usage.total_tokens !== 0) return payload
  return { ...payload, status: 'failed', last_event: 'run.failed', completed: false,
    safe_error: 'The selected AI provider could not start this request. Your message is saved; retry after access or usage is restored.',
    error: { type: 'provider_preflight_failed', message: 'The selected AI provider could not start this request.' } }
}

// Read-only history projection. Preflight never wrote a transcript row: surface its
// service-owned receipt on the newest page, with a stable assistant identity/time.
// Never invent an owner message; the original request remains in the durable queue.
export function projectProviderSignInHistory(result, record, params = new URLSearchParams()) {
  let payload
  try { payload = JSON.parse(result.toString('utf8')) } catch { return result }
  const key = ['data', 'messages', 'items'].find(key => Array.isArray(payload?.[key]))
  if (!key) return result
  payload[key] = payload[key].filter(row => !String(row?.id || '').startsWith('wizard-provider-auth:')).map(row => {
    if (!['assistant', 'system'].includes(row?.role ?? row?.author)) return row
    const notice = providerSignInNotice(row.content)
    return notice ? null : row
  }).filter(Boolean)
  return Buffer.from(JSON.stringify(payload))
}

// SSE frames are buffered by the existing transport. The controlled preflight is
// one message.delta (Hermes did not call a model); ordinary token streams are unchanged.
export function projectProviderSignInEvent(frame) {
  let event = '', data = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    if (line.startsWith('data:')) data += line.slice(5).trimStart()
  }
  let payload
  try { payload = JSON.parse(data) } catch { return frame }
  if (event === 'message.delta') {
    const notice = providerSignInNotice(payload.delta)
    return notice ? `event: ${event}\ndata: ${JSON.stringify({ ...payload, delta: notice.output })}\n\n` : frame
  }
  const normalized = normalizeProviderPreflightFailure(payload)
  return normalized !== payload ? `event: run.failed\ndata: ${JSON.stringify(normalized)}\n\n` : frame
}
