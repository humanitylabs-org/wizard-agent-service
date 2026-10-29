// Synthetic dedicated owner session. This proxy exists only in the staged rig;
// it is NOT a production auth implementation or an unconditional authority proxy.
import https from 'node:https'
import http from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { timingSafeEqual, createHash } from 'node:crypto'
const root = process.argv[2]
if (!root?.startsWith('/srv/work/')) throw Error('forum_staging_only')
const secret = n => readFileSync(`${root}/service-private/${n}`, 'utf8').trim()
const hash = s => createHash('sha256').update(s).digest()
const proof = secret('proof'), session = secret('session')
const server = https.createServer({ key: secret('key.pem'), cert: secret('cert.pem') }, (req, res) => {
  const cookie = /(?:^|;\s*)__Host-sv-owner=([^;]*)/.exec(req.headers.cookie || '')?.[1] || ''
  if (!timingSafeEqual(hash(cookie), hash(session))) { res.writeHead(403, { 'cache-control': 'no-store' }); return res.end('Owner session required') }
  const headers = { ...req.headers }
  // Never accept proof, identity or forwarding assertions from the caller.
  for (const k of Object.keys(headers)) if (/^(x-wizard-|x-forwarded-|cf-access-|tailscale-)/u.test(k) || k === 'authorization') delete headers[k]
  headers['x-wizard-owner-proof'] = proof
  const upstream = http.request({ socketPath: `${root}/service-private/service.sock`, method: req.method, path: req.url, headers }, reply => {
    res.writeHead(reply.statusCode, reply.headers); reply.pipe(res)
  })
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end('Staging service unavailable') })
  req.pipe(upstream)
})
server.listen(0, '127.0.0.1', () => writeFileSync(`${root}/proxy-ready.json`, JSON.stringify({ origin: `https://localhost:${server.address().port}` })))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
