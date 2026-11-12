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

// Owner media the shell shows with <img>, <video>, <audio> or opens as a download: content-addressed chat
// attachments and saved files. Such loads cannot carry a header, so the gate admits them without the token only
// when the browser itself says the load is passive media (or a navigation) started by a same-origin document.
// Scripts cannot set Sec-Fetch-*; a sandboxed (opaque) frame's loads are cross-site; fetch() is dest 'empty' with
// mode 'cors'/'same-origin' and still needs the token. Bytes only, never a listing: the id must be known.
const PASSIVE_MEDIA_PATH = /^\/wizard\/(?:attachments\/[0-9a-f]{32}|files\/(?:wf|drop)_[0-9a-f]{32}\/content)$/u
const PASSIVE_MEDIA_DEST = new Set(['image', 'video', 'audio', 'track'])
export function passiveMediaPath(method, pathname) {
  return (method === 'GET' || method === 'HEAD') && PASSIVE_MEDIA_PATH.test(String(pathname || ''))
}
function passiveMediaLoad(headers = {}) {
  const one = name => (typeof headers[name] === 'string' ? headers[name].trim().toLowerCase() : undefined)
  if (one('sec-fetch-site') !== 'same-origin') return false
  if (headers.origin !== undefined && String(headers.origin).trim().toLowerCase() === 'null') return false
  const mode = one('sec-fetch-mode')
  const dest = one('sec-fetch-dest')
  if (mode === 'no-cors') return PASSIVE_MEDIA_DEST.has(dest)
  // A link the owner opens or downloads in the top window (a frame load is dest 'iframe').
  if (mode === 'navigate') return dest === 'document' || dest === 'empty'
  return false
}

export function createBrowserBoundary({ enabled = false, token = '' } = {}) {
  if (enabled && !/^[a-f0-9]{64}$/.test(token)) throw new Error('Shell token must be 32 random bytes encoded as lowercase hex')
  return Object.freeze({
    enabled: enabled === true,
    // This is an additional gate, NEVER a replacement for the principal/access
    // verifier. Internal and socket-bound agent calls retain their existing scope.
    allows(request, principal, { staticRequest = false, healthRequest = false, machineRequest = false, mediaRequest = false } = {}) {
      if (!enabled || staticRequest || healthRequest) return true
      // Machine credentials cannot be used to turn an ordinary browser request
      // into an internal call. Browser Fetch Metadata is not script-settable.
      // Node's fetch adds Sec-Fetch-Mode:cors but no Site/Dest; preserve those
      // existing machine clients. A real browser cannot suppress Sec-Fetch-Site.
      if (principal?.kind === 'service' || principal?.kind === 'agent' || machineRequest) {
        return !['origin', 'sec-fetch-site', 'sec-fetch-dest'].some(name => request.headers?.[name] !== undefined)
      }
      if (mediaRequest && principal?.kind === 'owner' && passiveMediaLoad(request.headers)) return true
      // Even possession of a stolen token may not authorize an opaque frame.
      const origin = String(request.headers?.origin ?? '').trim().toLowerCase()
      const site = request.headers?.['sec-fetch-site']
      if (origin === 'null' || (site !== undefined && site !== 'same-origin')) return false
      if (['iframe', 'frame', 'embed', 'object'].includes(request.headers?.['sec-fetch-dest'])) return false
      return sameSecret(request.headers?.[SHELL_TOKEN_HEADER], token)
    },
  })
}
