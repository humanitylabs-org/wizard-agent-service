// Owner identity is not browser authority. Apply before every ordinary control route.
// Machine capability endpoints retain their own token verification, never owner authority.
export function controlBoundary(req, { allowedHosts = [], controlOrigins = [], selfOrigin = '', appsOrigin = '' } = {}) {
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
  if (!authorities.has(raw)) return false
  const site = req.headers['sec-fetch-site']
  if (site && !['same-origin', 'none'].includes(site)) return false
  const origin = req.headers.origin
  if (!origin) return !site || ['GET', 'HEAD'].includes(req.method) // CLI/native; browser writes need Origin
  try {
    const u = new URL(origin)
    const expected = req.socket?.encrypted ? 'https:' : 'http:'
    // HTTPS termination is explicit in the configured canonical control origins.
    const schemes = new Set([expected])
    for (const o of controlOrigins) { try { const c = new URL(o); if (c.host === raw) schemes.add(c.protocol) } catch {} }
    return u.origin === origin && !u.username && !u.password && u.host === raw && schemes.has(u.protocol)
  } catch { return false }
}

export function machineCapabilityPath(path) {
  return ['/wizard/mcp', '/wizard/v1/agent-context'].includes(path)
    || /^\/wizard\/v1\/(?:agents|apps)\/[a-z][a-z0-9-]{0,30}\/deliveries$/u.test(path)
}
