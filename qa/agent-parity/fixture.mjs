import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
export async function scene(kind, serverOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'parity-'))
  const id = kind === 'main' ? 'hermes' : 'parity-agent'
  const osHome = join(root, 'os'), folder = join(osHome, 'agents', id)
  mkdirSync(folder, { recursive: true })
  const seen = [], sessions = new Map(), runs = new Map(), keys = new Map(), placed = []
  const hermesHome = join(root, 'hermes')
  const agentHome = kind === 'host-profile' ? join(hermesHome, 'profiles', 'parity-profile') : kind === 'main' ? join(root, 'main-home') : join(folder, 'home')
  mkdirSync(agentHome, { recursive: true })
  const publicPath = name => ['container', 'restricted'].includes(kind) ? `/opt/data/${name}` : join(agentHome, name)
  const media = { png: publicPath('synthetic.png'), text: publicPath('synthetic.txt') }
  writeFileSync(join(agentHome, 'synthetic.png'), png)
  writeFileSync(join(agentHome, 'synthetic.txt'), 'PARITY_SYNTHETIC_DOCUMENT\n')
  const stt = { text: 'Synthetic voice words.' }
  const titleDb = new DatabaseSync(join(root, 'hermes-state.db'))
  titleDb.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, title_source TEXT, started_at REAL);
    CREATE TABLE messages (session_id TEXT, role TEXT, finish_reason TEXT, content TEXT, display_kind TEXT, timestamp REAL, active INTEGER DEFAULT 1);
    CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL);`)
  const syncMessages = () => {
    titleDb.exec('DELETE FROM messages')
    const insert = titleDb.prepare('INSERT INTO messages(session_id,role,finish_reason,content,display_kind,timestamp) VALUES(?,?,?,?,?,?)')
    for (const row of sessions.values()) for (const m of row.messages) insert.run(row.id,m.role,m.finish_reason || (m.role === 'assistant' ? 'stop' : null), typeof m.content === 'string' ? m.content : JSON.stringify(m.content),m.display_kind || (m.role === 'assistant' ? 'final' : null),m.timestamp)
  }
  writeFileSync(join(root, 'subjects.json'), JSON.stringify({ subjects: ['Parity QA'] }))
  writeFileSync(join(root, 'apps.json'), JSON.stringify({ apps: [{ id:'parity-qa',name:'Synthetic Parity App',view:'/parity/',agent_binding:true }] }))
  let sequence = 0
  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://fixture')
    const path = url.pathname.replace(/^\/p\/parity-profile/, '')
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw && !path.startsWith('/v1/audio/') ? JSON.parse(raw) : null
    seen.push({ path: url.pathname, method: req.method, body, headers: req.headers })
    const json = (status, value, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value)) }
    if (path === '/health') return json(200, { status: 'ok' })
    if (path === '/v1/models') return json(200, { data: [] })
    if (path === '/v1/audio/transcriptions') return json(200, { text: stt.text, model: 'fixture-stt' })
    if (path === '/v1/capabilities') return json(200, { features: {} })
    if (path === '/api/model/options') return json(200, { model: 'fixture-model', provider: 'anthropic', providers: [{ slug: 'anthropic', authenticated: true, models: ['fixture-model', 'fixture-other'] }] })
    if (path === '/api/sessions' && req.method === 'POST') {
      const row = { ...body, id: body.id || body.session_id, created_at: Date.now() / 1000, messages: [] }
      sessions.set(row.id, row); titleDb.prepare('INSERT OR REPLACE INTO sessions VALUES (?, ?, ?, ?)').run(row.id, row.title || '', row.title_source || 'llm', row.created_at); return json(201, { session: row })
    }
    if (path === '/api/sessions') {
      const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 100)
      const rows = [...sessions.values()].map(row => ({ ...row, message_count: row.messages.length, latest_message: row.messages.at(-1), last_active: row.messages.at(-1)?.timestamp || row.created_at }))
      return json(200, { data: rows.slice(offset, offset + limit), has_more: offset + limit < rows.length })
    }
    const sm = path.match(/^\/api\/sessions\/([^/]+)(?:\/(messages|model))?$/)
    if (sm) {
      const row = sessions.get(sm[1]); if (!row) return json(404, { error: 'not_found' })
      if (req.method === 'DELETE') { sessions.delete(sm[1]); return json(200, { ok: true }) }
      if (sm[2] === 'messages') {
        const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 100)
        const rows = url.searchParams.get('order') === 'latest' ? [...row.messages].reverse() : row.messages
        return json(200, { data: url.searchParams.get('order') === 'latest' ? rows.slice(offset, offset + limit).reverse() : rows.slice(offset, offset + limit), has_more: offset + limit < rows.length })
      }
      if (req.method === 'PATCH' || sm[2] === 'model') { Object.assign(row, body); if (typeof body.title === 'string') titleDb.prepare('UPDATE sessions SET title=? WHERE id=?').run(body.title, row.id) }
      return json(200, { session: row })
    }
    if (path === '/v1/runs' && req.method === 'POST') {
      const key = req.headers['idempotency-key']
      if (key && keys.has(key)) return json(202, keys.get(key), { 'Idempotency-Replayed': 'true' })
      if ([...runs.values()].some(r=>r.session_id===body.session_id&&r.status==='running')) return json(409,{error:'session_busy'})
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
  const options = { appsJsonPath:join(root,'apps.json'), upstreamOrigin, sttOrigin: upstreamOrigin, hermesHome, hermesStatePath: kind === 'main' ? join(root, 'hermes-state.db') : '', agentArtifactDir: join(root, 'artifacts'), agentArtifactRoots: [agentHome], threadSeenStatePath: join(root, 'seen.json'), threadTitleStatePath: join(root, 'titles.json'), subjectsPath: join(root, 'subjects.json'), hermesKey: 'parity-main-secret', ownerProof: owner['X-Wizard-Owner-Proof'], requireAccess: false, wizardOsHome: osHome, settingsPath: join(osHome, 'settings.json'), agentBridge: false, joinedDelegation: 'off', followThrough: false, requireJoinedDelegationCapability: false,
    runQueueStatePath: join(root, 'queue.sqlite3'), archivedSessionReader: () => [], pendingFirstSendReader: () => [], runQueuePollIntervalMs: 0, activeSessionReader: async () => [], dispatchHealthReader: () => true,
    mediaRoot: join(root, 'files'), mediaAgentRoot: '/fixture-owner-files', mediaIndexPath: join(root, 'media.json'), uploadStatePath: join(root, 'uploads.sqlite3'), uploadReserveBytes: 0,
    agentRuntime: { place: async (agentId, payload) => { placed.push({ agentId, payload }); return { verified: true, path: `/opt/data/inbox/2026-10-22/${payload.filename}` } } } }
  let wizard, base
  const start = async () => { wizard = createWizardServer({ ...options, ...serverOptions }); base = `http://127.0.0.1:${(await listen(wizard)).port}` }
  await start()
  const request = (path, init = {}) => { syncMessages(); return fetch(`${base}/wizard/hermes${path}${path.includes('?') ? '&' : '?'}agent=${id}`, { ...init, headers: { ...owner, ...init.headers } }) }
  const closeServer = s => new Promise(resolve => { s.closeAllConnections(); s.close(resolve) })
  return { kind, id, root, seen, sessions, runs, placed, request, media, agentHome, stt, origin: () => base, ownerHeaders: owner,
    raw: (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { ...owner, ...init.headers } }),
    upload: (bytes, filename, mime) => fetch(`${base}/wizard/files/upload`, { method: 'POST', headers: { ...owner, 'Content-Type': 'application/octet-stream', 'X-Wizard-Mime': mime, 'X-Wizard-Filename': filename }, body: bytes }),
    restart: async () => { await closeServer(wizard); await start() },
    close: async () => { await closeServer(wizard); await closeServer(upstream); if (socket.listening) await closeServer(socket); titleDb.close(); rmSync(root, { recursive: true, force: true }) } }
}
