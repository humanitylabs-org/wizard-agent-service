// Browser possession is independent of network ownership. A tailnet identity or a
// reverse-proxy owner proof is shared by every script on the box's web origin.
import { readFileSync } from 'node:fs'
import { sameSecret } from './principals.mjs'

export const SHELL_TOKEN_HEADER = 'x-wizard-shell-token'

export function browserBoundaryFromEnv(env = process.env) {
  if (env.WIZARD_BROWSER_BOUNDARY !== '1') return { enabled: false }
  let token = ''
  try { token = readFileSync(env.WIZARD_SHELL_TOKEN_FILE || '', 'utf8').trim() } catch {
    throw new Error('Browser boundary requires a readable WIZARD_SHELL_TOKEN_FILE')
  }
  return { enabled: true, token }
}

export function createBrowserBoundary({ enabled = false, token = '' } = {}) {
  if (enabled && !/^[a-f0-9]{64}$/.test(token)) throw new Error('Shell token must be 32 random bytes encoded as lowercase hex')
  return Object.freeze({
    enabled: enabled === true,
    // This is an additional gate, NEVER a replacement for the principal/access
    // verifier. Internal and socket-bound agent calls retain their existing scope.
    allows(request, principal, { staticRequest = false, healthRequest = false } = {}) {
      if (!enabled || staticRequest || healthRequest || principal?.kind === 'service' || principal?.kind === 'agent') return true
      // Even possession of a stolen token may not authorize an opaque frame.
      if (request.headers?.origin === 'null' || request.headers?.['sec-fetch-site'] === 'cross-site') return false
      return sameSecret(request.headers?.[SHELL_TOKEN_HEADER], token)
    },
  })
}
