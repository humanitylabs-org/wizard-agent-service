import test from 'node:test'; import assert from 'node:assert/strict'; import { createServer } from 'node:http'
import { proxyToAgent } from '../server/agents-http.mjs'; import { isAllowedProxyRequest, listen } from '../server/service.mjs'
import { projectStatusMarkers } from '../server/thread-status.mjs'

test('a routed agent run read keeps [SILENT] notification output only for the scheduler raw read', async t => {
  const output = '**Disk almost full**\nThales is at 93%.\n[SILENT]'
  const ctx = { isAllowedProxyRequest, mainSecrets: [], isThreadVisible: () => true, projectStatusMarkers,
    registry: { apiKey: () => 'synthetic-agent-key', upstream: agent => `http://${agent.id}.invalid`, threadAgent: a => ({ id: a.id, privacy: 'standard' }), read: id => ({ id, privacy: 'standard' }), pin: () => {} },
    sendJson: (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) },
    fetchAgent: async () => new Response(JSON.stringify({ id: 'run_1', status: 'completed', output }), { headers: { 'Content-Type': 'application/json' } }) }
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://fixture')
    try { await proxyToAgent(ctx, { agent: { id: 'philosopher' }, method: 'GET', upstreamPath: u.pathname, searchParams: u.searchParams, request: req, response: res, rawRunRead: req.headers['x-raw'] === '1' }) }
    catch { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('fixture proxy failed') }
  })
  const address = await listen(server); t.after(() => new Promise(r => server.close(r)))
  const read = async raw => { const r = await fetch(`http://127.0.0.1:${address.port}/v1/runs/run_1`, { headers: raw ? { 'x-raw': '1' } : {} }); const text = await r.text(); try { return JSON.parse(text).output } catch { throw new Error(text.slice(0, 400)) } }
  assert.equal(await read(false), '')
  assert.equal(await read(true), output)
})
