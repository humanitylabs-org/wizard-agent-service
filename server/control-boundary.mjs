// Owner identity is not browser authority. Apply before every ordinary control route.
// Machine capability endpoints retain their own token verification, never owner authority.
// strictHost=false (a box that has not opted in to the owner rule: no owner logins, no apps origin) also admits
// this box's Tailscale Serve name (<box>.<tailnet>.ts.net[:port]), which existing installs reach through wizard-ux
// nginx before network.base_url exists. Names an attacker can point at loopback (DNS rebinding) stay refused; a
// browser write still needs an Origin equal to that Host, and cross-site fetches are still refused.
const TAILNET_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9-]+\.ts\.net(?::\d{1,5})?$/u
export function controlBoundary(req, { allowedHosts = [], controlOrigins = [], selfOrigin = '', appsOrigin = '', strictHost = true } = {}) {
  const raw = String(req.headers.host || '').toLowerCase()
  if (!raw || /[\s/@,#?\\]/u.test(raw)) return false
  let host
  try { host = new URL(`http://${raw}`); if (host.host !== raw) return false } catch { return false }
  const authorities = new Set(allowedHosts.map(h => String(h).toLowerCase()))
  for (const origin of [...controlOrigins, selfOrigin]) {
    try { if (origin) authorities.add(new URL(origin).host) } catch { /* invalid configuration grants nothing */ }
  }
  // An isolated app origin never becomes an owner-control origin, even if loopback.
  if (appsOrigin && raw === new URL(appsOrigin).host) return false
  if (!authorities.has(raw) && (strictHost || !TAILNET_HOST.test(raw))) return false
  const site = req.headers['sec-fetch-site']
  const entry = ['GET', 'HEAD'].includes(req.method) && req.headers['sec-fetch-mode'] === 'navigate'
    && req.headers['sec-fetch-dest'] === 'document' && ['/wizard', '/wizard/', '/wizard-os-home', '/wizard-os-home/'].includes(String(req.url || '').split('?')[0])
  // A top-level document load of an entry page carries no authority (no body, no credentials beyond what any
  // link gets) and cross-site entry is already allowed, so a same-site sibling (the Mac front door on another
  // loopback port) gets the same treatment. Fetches, writes and every other path stay same-origin only.
  if (site && !['same-origin', 'none'].includes(site) && !(['cross-site', 'same-site'].includes(site) && entry)) return false
  const origin = req.headers.origin
  if (!origin) return !site || ['GET', 'HEAD'].includes(req.method) // CLI/native; browser writes need Origin
  try {
    const u = new URL(origin)
    const expected = req.socket?.encrypted ? 'https:' : 'http:'
    // HTTPS termination is explicit in the configured canonical control origins.
    const schemes = new Set()
    for (const o of [...controlOrigins, selfOrigin]) { try { const c = new URL(o); if (c.host === raw) schemes.add(c.protocol) } catch {} }
    if (!schemes.size) schemes.add(expected)
    // Unconfigured boxes sit behind a TLS-terminating proxy (Serve), so the browser's https Origin is the same site.
    if (!strictHost) schemes.add('https:')
    return u.origin === origin && !u.username && !u.password && u.host === raw && schemes.has(u.protocol)
  } catch { return false }
}

export function machineCapabilityPath(path) {
  return ['/wizard/mcp', '/wizard/v1/agent-context'].includes(path)
    || /^\/wizard\/v1\/(?:agents|apps)\/[a-z][a-z0-9-]{0,30}\/deliveries$/u.test(path)
}
