// Private access through Tailscale Serve (the Wizard OS default; spec/PRIVATE_ACCESS.md).
//
// Tailscale Serve terminates HTTPS on the owner's tailnet address and forwards each request to this service
// with the signed-in tailnet user in `Tailscale-User-Login`. That header can be trusted only when the request
// really came from Serve, so this verifier accepts a request only when ALL of these hold:
//   - it arrived from a trusted proxy peer: loopback on a bare box, or the container network's gateway when
//     the service runs in a Wizard OS container whose port is published on the box's 127.0.0.1 only;
//   - its Host is exactly the configured tailnet origin;
//   - the asserted user is the box owner (one login, or a short comma list);
//   - writes are same-origin, and cross-site requests are refused except opening the app itself.
// Never put Funnel or another header-forwarding proxy in front of this service.

import { readFileSync } from 'node:fs'

const LOOPBACK = ['127.0.0.1', '::1']

function plainPeer(address) {
  const value = String(address || '')
  return value.startsWith('::ffff:') ? value.slice(7) : value
}

// The default IPv4 gateway of this container (the address the box's published port appears to come from).
export function containerGateway(routeTable = '/proc/net/route') {
  try {
    for (const line of readFileSync(routeTable, 'utf8').split('\n').slice(1)) {
      const [, destination, gateway] = line.trim().split(/\s+/)
      if (destination === '00000000' && /^[0-9A-F]{8}$/i.test(gateway || '') && gateway !== '00000000') {
        return [6, 4, 2, 0].map((i) => parseInt(gateway.slice(i, i + 2), 16)).join('.')
      }
    }
  } catch { /* not Linux or no route table: loopback only */ }
  return ''
}

/**
 * @param {{ origin?: string, logins?: string, proxyPeers?: string[], appPaths?: string[] }} [options]
 */
export function createTailnetAccessVerifier({ origin = '', logins = '', proxyPeers = LOOPBACK, appPaths = ['/wizard', '/wizard/'] } = {}) {
  let url
  try { url = new URL(String(origin || '')) } catch { throw new Error('WIZARD_TAILNET_ORIGIN must be the exact Tailscale HTTPS origin') }
  if (url.protocol !== 'https:' || !/^[a-z0-9.-]+\.ts\.net$/.test(url.hostname) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('WIZARD_TAILNET_ORIGIN must be the exact Tailscale HTTPS origin')
  }
  const owners = String(logins || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean)
  if (!owners.length || owners.some((v) => v.length > 320 || /[\s\x00-\x1f]/.test(v))) {
    throw new Error('WIZARD_TAILNET_LOGIN must name the authorized Tailscale user(s)')
  }
  const peers = new Set(proxyPeers.map(plainPeer).filter(Boolean))
  if (!peers.size) throw new Error('At least one trusted Tailscale Serve proxy peer is required')
  const entryPaths = new Set(appPaths)

  const verify = async (request) => {
    if (!peers.has(plainPeer(request.socket?.remoteAddress))) throw new Error('Trusted Tailscale Serve proxy required')
    const headers = request.headers || {}
    if (headers.host !== url.host) throw new Error('Unexpected Wizard host')
    const asserted = headers['tailscale-user-login']
    const user = typeof asserted === 'string' ? asserted.trim().toLowerCase() : ''
    if (!owners.includes(user)) throw new Error('Authorized tailnet user required')
    const requestOrigin = headers.origin
    if (requestOrigin !== undefined && requestOrigin !== url.origin) throw new Error('Cross-origin request rejected')
    const method = request.method || 'GET'
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && requestOrigin !== url.origin) throw new Error('Same-origin writes required')
    // Opening a shared link is a cross-site document navigation: allow only top-level entry to the app.
    const safeEntry = ['GET', 'HEAD'].includes(method)
      && headers['sec-fetch-mode'] === 'navigate' && headers['sec-fetch-dest'] === 'document'
      && entryPaths.has(String(request.url || '').split('?')[0])
    if (headers['sec-fetch-site'] === 'cross-site' && !safeEntry) throw new Error('Cross-site request rejected')
    return { sub: `tailscale:${user}`, email: user, iss: 'tailscale-serve' }
  }
  // The service passes request-based verifiers the whole request (Cloudflare Access verifiers get the JWT).
  verify.fromRequest = true
  // Explicit verifier configuration, not identity or forwarded headers, defines browser authority.
  verify.controlOrigins = Object.freeze([url.origin])
  return verify
}
