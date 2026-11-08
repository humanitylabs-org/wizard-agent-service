// Hermes can report an authentication preflight failure as a completed, zero-token
// response without ever writing the user turn. Preserve the saved queue request and
// make this specific terminal transport failure visible as a failure to Wizard.
export function normalizeProviderPreflightFailure(payload) {
  if (!payload || payload.status !== 'completed' || typeof payload.output !== 'string'
      || !payload.output.startsWith('⚠️ Provider authentication failed:')
      || !payload.usage || payload.usage.input_tokens !== 0 || payload.usage.output_tokens !== 0
      || payload.usage.total_tokens !== 0) return payload
  return { ...payload, status: 'failed', last_event: 'run.failed', completed: false,
    safe_error: 'The selected AI provider could not start this request. Your message is saved; retry after access or usage is restored.',
    error: { type: 'provider_preflight_failed', message: 'The selected AI provider could not start this request.' } }
}
