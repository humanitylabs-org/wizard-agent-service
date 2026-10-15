// Hermes v0.22.1 public HTTP contract. No authority over Hermes state.
export function upstreamError(status, raw, retryAfter) {
  let payload
  try { payload = JSON.parse(String(raw)) } catch { payload = null }
  const error = payload?.error
  return Object.assign(new Error(typeof error?.message === 'string' ? error.message : 'Hermes request failed'), {
    status, code: typeof error?.code === 'string' ? error.code : '',
    upstreamError: error && typeof error === 'object' ? error : undefined,
    retryAfter,
  })
}

export function retryDelaySeconds(value, fallback, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 128) return fallback
  const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : (Date.parse(value) - now) / 1000
  // A finite server delay is never shortened; absurd/unparseable dates aren't timers.
  return Number.isFinite(seconds) && seconds >= 0 ? Math.max(fallback, seconds) : fallback
}

export function admissionFailure(error) {
  const code = error?.code
  const messages = {
    permission_denied: 'This conversation belongs to another Hermes surface. Continue there; Wizard cannot send into it.',
    idempotency_key_conflict: 'This reply conflicts with an earlier delivery. It was not sent again.',
    admission_conflict: 'Hermes could not identify this admission safely. It was not sent again.',
  }
  return messages[code] || null
}

export function validateRecoveryIdentity(body, current) {
  if (!body || Object.keys(body).sort().join(',') !== 'admission_id,execution_generation'
      || typeof body.admission_id !== 'string' || !Number.isSafeInteger(body.execution_generation)) {
    throw Object.assign(new Error('invalid_params'), { status: 400, code: 'invalid_params' })
  }
  // Do not require status=unknown here: upstream accepts an exact repeat of a committed receipt.
  if (body.admission_id !== current.admission_id || body.execution_generation !== current.execution_generation) {
    throw Object.assign(new Error('stale_generation'), { status: 409, code: 'stale_generation' })
  }
}
