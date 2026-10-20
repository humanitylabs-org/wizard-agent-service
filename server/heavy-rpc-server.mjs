// Optional host-side SSH transport for a minimal Agent Service container.
// No job authority or queue lives here: stable job IDs and state live in the
// service/remote SQLite stores, so restarting this bridge cannot repeat a build.
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { heavySshTransport } from './heavy-queue.mjs'

export function createHeavyRpcServer({ token, transport }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('heavy RPC token required')
  return createServer(async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
    const supplied = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''))
    const expected = Buffer.from(token)
    if (req.method !== 'POST' || req.url !== '/rpc' || req.headers.origin || req.headers['sec-fetch-site']
      || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(403, { error: 'forbidden' })
    try {
      let raw = ''; let bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > 32768) return reply(413, { error: 'too_large' })
        raw += chunk.toString('utf8')
      }
      const value = JSON.parse(raw)
      if (!['submit', 'status', 'cancel'].includes(value.action) || !/^heavy_[0-9a-f]{32}$/.test(value.job_id)) return reply(400, { error: 'invalid_rpc' })
      reply(200, await transport(value))
    } catch { reply(503, { error: 'worker_unavailable' }) }
  })
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const server = createHeavyRpcServer({ token: process.env.WIZARD_HEAVY_TOKEN,
    transport: heavySshTransport({ host: process.env.WIZARD_HEAVY_SSH_HOST,
      script: process.env.WIZARD_HEAVY_REMOTE_SCRIPT, root: process.env.WIZARD_HEAVY_REMOTE_ROOT,
      lock: process.env.WIZARD_HEAVY_REMOTE_LOCK, python: process.env.WIZARD_HEAVY_REMOTE_PYTHON || '/opt/homebrew/bin/python3' }) })
  server.listen(Number(process.env.WIZARD_HEAVY_RPC_PORT || 18788), '127.0.0.1', () => console.log('Heavy SSH bridge listening on loopback'))
}
