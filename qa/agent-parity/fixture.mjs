import { createServer } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../../server/service.mjs'
import { PRESETS } from '../../server/agents.mjs'

export const kinds = ['main', 'host-profile', 'container', 'restricted']
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLh6wAAAABJRU5ErkJggg==', 'base64')
export const image = `data:image/png;base64,${png.toString('base64')}`
export const owner = { 'X-Wizard-Owner-Proof': 'parity-synthetic-owner-proof-0123456789abcdef' }
export const post = body => ({ method: 'POST', headers: { ...owner, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) })

// Real Wizard server, synthetic upstream API. Restricted really uses an ingress
// Unix socket; profile really uses /p/<profile>. No production agent is opened.
export async function scene(kind) {
  const root = mkdtempSync(join(tmpdir(), 'parity-'))
  const id = kind === 'main' ? 'hermes' : 'parity-agent'
  const osHome = join(root, 'os'), folder = join(osHome, 'agents', id)
  mkdirSync(folder, { recursive: true })
  const seen = [], sessions = new Map(), runs = new Map(), keys = new Map(), placed = []
  let sequence = 0
  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://fixture')
    const path = url.pathname.replace(/^\/p\/parity-profile/, '')
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : null
    seen.push({ path: url.pathname, method: req.method, body, headers: req.headers })
    const json = (status, value, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value)) }
    if (path === '/health') return json(200, { status: 'ok' })
    if (path === '/v1/capabilities') return json(200, { features: {} })
    if (path === '/api/model/options') return json(200, { model: 'fixture-model', provider: 'anthropic', providers: [{ slug: 'anthropic', authenticated: true, models: ['fixture-model', 'fixture-other'] }] })
    if (path === '/api/sessions' && req.method === 'POST') {
      const row = { ...body, id: body.id || body.session_id, created_at: Date.now() / 1000, messages: [] }
      sessions.set(row.id, row); return json(201, { session: row })
    }
    if (path === '/api/sessions') return json(200, { data: [...sessions.values()], has_more: false })
    const sm = path.match(/^\/api\/sessions\/([^/]+)(?:\/(messages|model))?$/)
    if (sm) {
      const row = sessions.get(sm[1]); if (!row) return json(404, { error: 'not_found' })
      if (req.method === 'DELETE') { sessions.delete(sm[1]); return json(200, { ok: true }) }
      if (sm[2] === 'messages') return json(200, { data: row.messages, has_more: false })
      if (req.method === 'PATCH' || sm[2] === 'model') Object.assign(row, body)
      return json(200, { session: row })
    }
    if (path === '/v1/runs' && req.method === 'POST') {
      const key = req.headers['idempotency-key']
      if (key && keys.has(key)) return json(202, keys.get(key), { 'Idempotency-Replayed': 'true' })
      const at = Date.now() / 1000, run = { run_id: `fixture-run-${++sequence}`, session_id: body.session_id, status: 'running', created_at: at }
      runs.set(run.run_id, run); if (key) keys.set(key, run)
      const row = sessions.get(body.session_id)
      if (row) {
        const input = typeof body.input === 'string' ? body.input : body.input[0].content
        const content = Array.isArray(input) ? input.map(p => p.type === 'text' ? p.text : '[screenshot]').join('\n') : input
        row.messages.push({ id: `user-${sequence}`, role: 'user', timestamp: at, content })
      }
      return json(202, run)
    }
    const rm = path.match(/^\/v1\/runs\/([^/]+)(?:\/(events|stop|steer|approval|clarify))?$/)
    if (rm) {
      const run = runs.get(rm[1]); if (!run) return json(404, { error: 'not_found' })
      if (rm[2] === 'stop') run.status = 'cancelled'
      if (rm[2] === 'events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end('event: tool.progress\ndata: {"name":"fixture","message":"working"}\n\nevent: run.completed\ndata: {"output":"Fixture reply"}\n\n') }
      return json(200, rm[2] ? { ok: true } : run)
    }
    return json(404, { error: 'fixture_route_missing', path })
  }
  const upstream = createServer(handler), socket = createServer(handler)
  const upstreamOrigin = `http://127.0.0.1:${(await listen(upstream)).port}`
  if (kind !== 'main') {
    const runtime = kind === 'host-profile' ? { kind: 'profile', profile: 'parity-profile' } : { kind: 'container', app_id: 'agent-parity-agent', port: Number(new URL(upstreamOrigin).port), ...(kind === 'restricted' ? { isolation: 'restricted' } : {}) }
    const preset = PRESETS.find(p => p.id === 'standard')
    writeFileSync(join(folder, 'agent.json'), JSON.stringify({ schema: 1, id, label: 'Parity synthetic agent', harness: 'hermes', privacy: 'standard', appearance: { glyph: 'spark', hue: 45 }, model: { provider: 'anthropic', model: 'fixture-model', allowed_models: ['fixture-model', 'fixture-other'], fallback: false }, permissions: { preset: 'standard', ...preset.permissions }, runtime, created_at: Date.now() / 1000 }))
    writeFileSync(join(folder, 'runtime.key'), 'parity-runtime-secret', { mode: 0o600 })
    writeFileSync(join(folder, 'gateway.key'), 'parity-gateway-secret', { mode: 0o600 })
    if (kind === 'restricted') {
      const gateway = join(folder, 'gateway'); mkdirSync(gateway)
      const socketPath = join(gateway, 'ingress.sock')
      await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(socketPath, resolve) }); chmodSync(socketPath, 0o600)
    }
  }
  const options = { upstreamOrigin, hermesKey: 'parity-main-secret', ownerProof: owner['X-Wizard-Owner-Proof'], requireAccess: false, wizardOsHome: osHome, settingsPath: join(osHome, 'settings.json'), agentBridge: false, joinedDelegation: 'off', followThrough: false, requireJoinedDelegationCapability: false,
    runQueueStatePath: join(root, 'queue.sqlite3'), runQueuePollIntervalMs: 0, activeSessionReader: async () => [], dispatchHealthReader: () => true,
    mediaRoot: join(root, 'files'), mediaAgentRoot: '/fixture-owner-files', mediaIndexPath: join(root, 'media.json'), uploadStatePath: join(root, 'uploads.sqlite3'), uploadReserveBytes: 0,
    agentRuntime: { place: async (agentId, payload) => { placed.push({ agentId, payload }); return { verified: true, path: `/opt/data/inbox/2026-10-22/${payload.filename}` } } } }
  let wizard, base
  const start = async () => { wizard = createWizardServer(options); base = `http://127.0.0.1:${(await listen(wizard)).port}` }
  await start()
  const request = (path, init = {}) => fetch(`${base}/wizard/hermes${path}${path.includes('?') ? '&' : '?'}agent=${id}`, { ...init, headers: { ...owner, ...init.headers } })
  const closeServer = s => new Promise(resolve => { s.closeAllConnections(); s.close(resolve) })
  return { kind, id, root, seen, sessions, runs, placed, request,
    upload: (bytes, filename, mime) => fetch(`${base}/wizard/files/upload`, { method: 'POST', headers: { ...owner, 'Content-Type': 'application/octet-stream', 'X-Wizard-Mime': mime, 'X-Wizard-Filename': filename }, body: bytes }),
    restart: async () => { await closeServer(wizard); await start() },
    close: async () => { await closeServer(wizard); await closeServer(upstream); if (socket.listening) await closeServer(socket); rmSync(root, { recursive: true, force: true }) } }
}
