import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createAgentRegistry } from '../server/agents.mjs'
import { fetchAgentIngress } from '../server/agent-ingress.mjs'

const roots: string[] = [], servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function root() { const p = mkdtempSync(join(tmpdir(), 'ing-')); roots.push(p); return p }
function record(dir: string, id: string) {
  const folder = join(dir, id)
  mkdirSync(join(folder, 'gateway'), { recursive: true, mode: 0o700 })
  const agent = { schema: 1, id, label: id, harness: 'hermes', privacy: 'standard',
    model: { provider: 'anthropic', model: 'fixture', allowed_models: ['fixture'] },
    permissions: { preset: 'standard' }, runtime: { kind: 'container', app_id: `agent-${id}`, port: 18650, isolation: 'restricted' } }
  writeFileSync(join(folder, 'agent.json'), JSON.stringify(agent))
  writeFileSync(join(folder, 'runtime.key'), `${id}-key`)
  return agent
}
async function api(dir: string, id = 'one') {
  const agent = record(dir, id), path = join(dir, id, 'gateway', 'ingress.sock')
  const seen: string[] = []
  const server = createServer(async (req, res) => {
    seen.push(req.url!)
    const chunks = []; for await (const c of req) chunks.push(c)
    if (req.url === '/hang') return
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:1/' }); res.end(); return }
    if (req.url !== '/health' && req.headers.authorization !== `Bearer ${id}-key`) { res.writeHead(401); res.end(); return }
    res.setHeader('Content-Type', req.url === '/events' ? 'text/event-stream' : 'application/json')
    if (req.url === '/events') { res.write('data: first\n\n'); res.end('data: last\n\n'); return }
    res.end(JSON.stringify(req.url?.startsWith('/api/sessions') ? { data: [{ id: `${id}-session` }], has_more: false } : { id, body: Buffer.concat(chunks).toString() }))
  })
  servers.push(server)
  await new Promise<void>((r, reject) => { server.once('error', reject); server.listen(path, r) })
  chmodSync(path, 0o600)
  return { agent, path, seen }
}
it('restricted registry probes and reads authenticated catalogs over Unix sockets, never injected TCP fetch', async () => {
  const dir = root(), { agent, seen } = await api(dir), tcp = vi.fn(() => { throw Error('TCP forbidden') })
  const registry = createAgentRegistry({ agentsDir: dir, fetchImpl: tcp })
  expect(await registry.status(agent, { fresh: true })).toMatchObject({ status: 'running' })
  await registry.refreshCatalog('one')
  expect(seen.some(p => p.startsWith('/api/sessions?'))).toBe(true)
  expect(tcp).not.toHaveBeenCalled()
})
it('preserves POST body, query and API key; wrong and missing keys fail', async () => {
  const { path } = await api(root())
  const r = await fetchAgentIngress(path, '/echo?q=1', { method: 'POST', headers: { Authorization: 'Bearer one-key' }, body: '{"input":"synthetic"}' })
  expect(await r.json()).toMatchObject({ id: 'one', body: '{"input":"synthetic"}' })
  for (const key of ['', 'two-key']) {
    const denied = await fetchAgentIngress(path, '/echo', { headers: { Authorization: `Bearer ${key}` } })
    expect(denied.status).toBe(401); await denied.text()
  }
})
it('streams event responses without buffering them into JSON', async () => {
  const { path } = await api(root())
  const r = await fetchAgentIngress(path, '/events', { headers: { Authorization: 'Bearer one-key' } })
  expect(r.headers.get('content-type')).toBe('text/event-stream')
  expect(await r.text()).toBe('data: first\n\ndata: last\n\n')
})
it('fails closed for a missing ingress socket, retaining compatibility with old port records', async () => {
  const dir = root(), agent = record(dir, 'one'), tcp = vi.fn()
  const registry = createAgentRegistry({ agentsDir: dir, fetchImpl: tcp })
  expect(await registry.status(agent, { fresh: true })).toMatchObject({ status: 'error' })
  expect(tcp).not.toHaveBeenCalled()
})
it('never uses another agent socket from stored ingress metadata and keeps keys scoped', async () => {
  const dir = root(), one = await api(dir), two = await api(dir, 'two')
  const registry = createAgentRegistry({ agentsDir: dir })
  await expect(async () => registry.fetchAgent({ ...one.agent, runtime: { ...one.agent.runtime, ingress_socket: two.path } }, '/health')).rejects.toThrow('path mismatch')
  const r = await registry.fetchAgent(two.agent, '/echo', { headers: { Authorization: 'Bearer one-key' } })
  expect(r.status).toBe(401); await r.text()
})
it('refuses symlinks and nonprivate ingress inodes', async () => {
  const dir = root(), { path } = await api(dir)
  chmodSync(path, 0o666)
  expect(() => fetchAgentIngress(path, '/health')).toThrow('unsafe')
  chmodSync(path, 0o600)
  const alias = join(dir, 'alias.sock'); symlinkSync(path, alias)
  expect(() => fetchAgentIngress(alias, '/health')).toThrow('unsafe')
})
it('refuses redirect:error and leaves manual redirects un-followed', async () => {
  const { path } = await api(root())
  await expect(fetchAgentIngress(path, '/redirect', { redirect: 'error' })).rejects.toThrow('redirect refused')
  const r = await fetchAgentIngress(path, '/redirect', { redirect: 'manual' })
  expect(r.status).toBe(302); await r.text()
})
it('aborts an in-flight socket request', async () => {
  const { path } = await api(root())
  await expect(fetchAgentIngress(path, '/hang', { signal: AbortSignal.timeout(30) })).rejects.toThrow()
})
it('leaves non-restricted agents on the original TCP client and runtime.port', async () => {
  const dir = root(), agent = record(dir, 'one'), tcp = vi.fn(async () => new Response('{}'))
  const registry = createAgentRegistry({ agentsDir: dir, fetchImpl: tcp })
  const r = await registry.fetchAgent({ ...agent, runtime: { ...agent.runtime, isolation: '' } }, '/health')
  await r.text(); expect(tcp).toHaveBeenCalledWith('http://127.0.0.1:18650/health', {})
})
