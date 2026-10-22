// Test-only bridge: existing synthetic HTTP runtimes still exercise real, mode-checked Unix ingress.
// This module is never imported by production Service code.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

export function fixtureAgentSockets(options) {
  const agentsDir = options.agentsDir || join(options.wizardOsHome, 'agents')
  const peers = new Set()
  const fetchImpl = options.fetchImpl || fetch
  const prepare = async id => {
    let agent
    try { agent = JSON.parse(readFileSync(join(agentsDir, id, 'agent.json'), 'utf8')) } catch { return }
    if (!agent.runtime?.private_client) return
    const dir = join(agentsDir, id, 'gateway'), socketPath = join(dir, 'ingress.sock')
    if (existsSync(socketPath)) return // Dedicated socket tests own their explicit runtime.
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700)
    const server = createServer(async (req, res) => {
      try {
        let body = ''; for await (const chunk of req) body += chunk
        // Re-read: fixture lifecycle callbacks can change a synthetic runtime's port.
        const current = JSON.parse(readFileSync(join(agentsDir, id, 'agent.json'), 'utf8'))
        const origin = options.agentUpstreamMode === 'network' ? current.runtime.api : `http://127.0.0.1:${current.runtime.port}`
        const response = await fetchImpl(new URL(req.url, origin).href, { method: req.method,
          headers: req.headers, ...(body ? { body } : {}), redirect: 'error' })
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()))
      } catch { res.writeHead(503); res.end('{"error":"fixture_runtime_unavailable"}') }
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
    chmodSync(socketPath, 0o600); peers.add(server)
  }
  const runtime = { ...options.agentRuntime }
  for (const action of ['apply', 'start']) if (typeof runtime[action] === 'function') {
    const original = runtime[action]
    runtime[action] = async (...args) => { const result = await original(...args); await prepare(args[0]); return result }
  }
  return {
    runtime,
    attach(server) {
      const originalListen = server.listen
      server.listen = function (...args) {
        let ids = []; try { ids = readdirSync(agentsDir) } catch {}
        Promise.all(ids.map(prepare)).then(() => originalListen.apply(server, args), error => server.emit('error', error))
        return server
      }
      server.once('close', () => { for (const peer of peers) { peer.closeAllConnections(); peer.close() } peers.clear() })
      return server
    },
  }
}
