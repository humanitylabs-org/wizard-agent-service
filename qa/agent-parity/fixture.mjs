import { createServer, request as httpRequest } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../../server/service.mjs'
import { installSupervisorAssets } from '../../server/supervisor-assets.mjs'
import { agentSocketPath } from '../../server/agent-sockets.mjs'
import { PRESETS } from '../../server/agents.mjs'

export const kinds = ['main', 'host-profile', 'container', 'restricted']
// Where scenes live. Agent ingress sockets sit under the scene (<root>/os/agents/<id>/gateway/ingress.sock) and the
// Service refuses socket paths over 103 bytes (agent-sockets.mjs). macOS's per-user $TMPDIR (/var/folders/…/T/) is
// long enough to push them past that, so scenes use /tmp there (resolved, so path comparisons stay exact).
export const sceneTmp = () => process.platform === 'darwin' ? realpathSync('/tmp') : tmpdir()
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLh6wAAAABJRU5ErkJggg==', 'base64')
export const image = `data:image/png;base64,${png.toString('base64')}`
export const owner = { 'X-Wizard-Owner-Proof': 'parity-synthetic-owner-proof-0123456789abcdef' }
export const post = body => ({ method: 'POST', headers: { ...owner, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body) })

// Real Wizard server, synthetic upstream API. Restricted really uses an ingress
// Unix socket; profile really uses /p/<profile>. No production agent is opened.
export async function scene(kind, serverOptions = {}) {
  const supervisorParity = serverOptions.supervisorParity === true
  const followUpParity = serverOptions.followUpParity === true
  // Generated per scene: the main agent's gateway credential when the follow-up gateway is under test.
  const mainMcpToken = `parity-main-mcp-${crypto.randomUUID()}`
  const heavyToken = crypto.randomUUID() + crypto.randomUUID() // generated synthetic loopback capability
  const agentGatewayToken = crypto.randomUUID() + crypto.randomUUID()
  const optionOverrides = { ...serverOptions }
  delete optionOverrides.followUpParity
  delete optionOverrides.supervisorParity
  const root = mkdtempSync(join(sceneTmp(), 'parity-'))
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
  const signin = { ready: false }
  const titleDb = new DatabaseSync(join(root, 'hermes-state.db'))
  titleDb.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, title_source TEXT, started_at REAL,
    source TEXT, model TEXT, ended_at REAL, end_reason TEXT, message_count INTEGER DEFAULT 0,
    parent_session_id TEXT, last_activity_at REAL, pinned INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, finish_reason TEXT, content TEXT, display_kind TEXT, timestamp REAL, active INTEGER DEFAULT 1);
    CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL);`)
  const searchDb = serverOptions.fixtureSearchIndex && kind!=='main' ? new DatabaseSync(join(agentHome,'state.db')) : null
  if(searchDb) searchDb.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,finish_reason TEXT,content TEXT,display_kind TEXT,timestamp REAL); CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT,model TEXT,title TEXT,started_at REAL,ended_at REAL,end_reason TEXT,message_count INTEGER,parent_session_id TEXT,last_activity_at REAL,pinned INTEGER,archived INTEGER,hidden INTEGER)')
  const searchStore=searchDb||titleDb
  if(serverOptions.fixtureSearchIndex) searchStore.exec("CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(content,content='messages',content_rowid='id',tokenize='trigram')")
  let hasSearchIndex=!!serverOptions.fixtureSearchIndex
  // Seed each disposable database in one transaction. Per-row autocommits can
  // block this shared client/server event loop past HTTP's idle keep-alive
  // deadline, making the next pooled request race an expired socket (ECONNRESET).
  const transaction = (db, write) => {
    db.exec('BEGIN')
    try { write(); db.exec('COMMIT') }
    catch (error) { db.exec('ROLLBACK'); throw error }
  }
  const syncMessages = () => {
    transaction(titleDb, () => {
      titleDb.exec('DELETE FROM messages')
      const insert = titleDb.prepare('INSERT INTO messages(session_id,role,finish_reason,content,display_kind,timestamp) VALUES(?,?,?,?,?,?)')
      for (const row of sessions.values()) for (const m of row.messages) insert.run(row.id,m.role,m.finish_reason || (m.role === 'assistant' ? 'stop' : null), typeof m.content === 'string' ? m.content : JSON.stringify(m.content),m.display_kind || (m.role === 'assistant' ? 'final' : null),m.timestamp)
      if (hasSearchIndex && !searchDb) titleDb.exec("INSERT INTO messages_fts_trigram(messages_fts_trigram) VALUES('rebuild')")
    })
    if (searchDb) transaction(searchDb, () => {
      searchDb.exec('DELETE FROM messages; DELETE FROM sessions')
      const putSession=searchDb.prepare('INSERT INTO sessions(id,source,title,started_at,message_count,parent_session_id,last_activity_at,pinned,archived,hidden) VALUES(?,?,?,?,?,?,?,?,?,?)')
      for(const row of sessions.values()) putSession.run(row.id,row.source||'wizard-mobile',row.title||'',row.created_at,row.messages.length,null,row.messages.at(-1)?.timestamp||row.created_at,0,row.archived?1:0,row.hidden?1:0)
      const put=searchDb.prepare('INSERT INTO messages(session_id,role,finish_reason,content,display_kind,timestamp) VALUES(?,?,?,?,?,?)')
      for(const row of titleDb.prepare('SELECT * FROM messages').all()) put.run(row.session_id,row.role,row.finish_reason,row.content,row.display_kind,row.timestamp)
      if (hasSearchIndex) searchDb.exec("INSERT INTO messages_fts_trigram(messages_fts_trigram) VALUES('rebuild')")
    })
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
    const streamRun = run => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        if (!serverOptions.fixtureHoldEvents) return res.end('event: tool.progress\ndata: {"name":"fixture","message":"working"}\n\nevent: run.completed\ndata: {"output":"Fixture reply"}\n\n')
        res.write(`event: run.started\ndata: ${JSON.stringify(run)}\n\n`)
        const timer=setInterval(()=>{if(['completed','failed','cancelled','interrupted'].includes(run.status))res.end(`event: run.${run.status}\ndata: ${JSON.stringify(run)}\n\n`);else res.write(': synthetic heartbeat\n\n')},250)
        res.on('close',()=>clearInterval(timer));return
      }
    if (kind !== 'main' && req.headers.authorization === 'Bearer parity-main-secret' && !url.pathname.startsWith('/p/') && path.startsWith('/api/sessions')) return json(path === '/api/sessions' ? 200 : 404, path === '/api/sessions' ? { data: [], has_more: false } : { error: 'not_found' })
    if (path === '/health') return json(200, { status: 'ok', provider: 'local', model: 'fixture-stt' })
    if (path === '/v1/models') return json(200, { data: [] })
    if (path === '/v1/audio/transcriptions') return json(200, { text: stt.text, model: 'fixture-stt' })
    if (path === '/v1/capabilities') return json(200, { features: {} })
    if (path === '/api/model/options') return json(200, { model: 'fixture-model', provider: 'anthropic', providers: [{ slug: 'anthropic', authenticated: true, models: ['fixture-model', 'fixture-other'] }] })
    const locked = path.match(/^\/api\/sessions\/([^/]+)\/chat\/stream$/)
    if (locked && req.method === 'POST') {
      const sessionId=locked[1],key=req.headers['idempotency-key']
      if(key&&keys.has(key))return streamRun(keys.get(key))
      if([...runs.values()].some(r=>r.session_id===sessionId&&r.status==='running'))return json(409,{error:'session_busy'})
      const run={run_id:`fixture-run-${++sequence}`,session_id:sessionId,status:'running',created_at:Date.now()/1000,runtime:{model:body.model,provider:body.provider,model_lock:'accepted'}}
      runs.set(run.run_id,run);if(key)keys.set(key,run)
      const content=Array.isArray(body.message)?body.message.map(p=>p.type==='text'?p.text:'[screenshot]').join('\n'):body.message
      sessions.get(sessionId)?.messages.push({id:`user-${sequence}`,role:'user',content,timestamp:run.created_at})
      syncMessages();return streamRun(run)
    }
    if (path === '/api/sessions' && req.method === 'POST') {
      const row = { ...body, id: body.id || body.session_id, created_at: Date.now() / 1000, messages: [] }
      sessions.set(row.id, row); titleDb.prepare('INSERT OR REPLACE INTO sessions (id,title,title_source,started_at) VALUES (?, ?, ?, ?)').run(row.id, row.title || '', row.title_source || 'llm', row.created_at); return json(201, { session: row })
    }
    if (path === '/api/sessions') {
      const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 100)
      const rows = [...sessions.values()].filter(row => !(searchDb && row.archived)).map(row => ({ ...row, message_count: row.messages.length, latest_message: row.messages.at(-1), last_active: row.messages.at(-1)?.timestamp || row.created_at }))
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
      syncMessages();return json(202, run)
    }
    const rm = path.match(/^\/v1\/runs\/([^/]+)(?:\/(events|stop|steer|approval|clarify))?$/)
    if (rm) {
      const run = runs.get(rm[1]); if (!run) return json(404, { error: 'not_found' })
      if (rm[2] === 'stop') run.status = 'cancelled'
      if (rm[2] === 'events') return streamRun(run)
      return json(200, rm[2] ? { ok: true } : run)
    }
    return json(404, { error: 'fixture_route_missing', path })
  }
  const upstream = createServer(handler), socket = createServer(handler)
  const upstreamOrigin = `http://127.0.0.1:${(await listen(upstream)).port}`
  // An unrestricted container has a different TCP origin from main. Reusing
  // main's origin would accidentally invoke the main model-lock bridge.
  const containerUpstream = kind === 'container' ? createServer(handler) : null
  const containerPort = containerUpstream ? (await listen(containerUpstream)).port : Number(new URL(upstreamOrigin).port)
  if (kind !== 'main') {
    const runtime = kind === 'host-profile' ? { kind: 'profile', profile: 'parity-profile' } : { kind: 'container', app_id: 'agent-parity-agent', port: containerPort, ...(kind === 'restricted' ? { isolation: 'restricted' } : {}) }
    const preset = PRESETS.find(p => p.id === 'standard')
    writeFileSync(join(folder, 'agent.json'), JSON.stringify({ schema: 1, id, label: 'Parity synthetic agent', harness: 'hermes', privacy: 'standard', appearance: { glyph: 'spark', hue: 45 }, model: { provider: 'anthropic', model: 'fixture-model', allowed_models: ['fixture-model', 'fixture-other'], fallback: false }, permissions: { preset: 'standard', ...preset.permissions }, runtime, created_at: Date.now() / 1000 }))
    writeFileSync(join(folder, 'runtime.key'), 'parity-runtime-secret', { mode: 0o600 })
    writeFileSync(join(folder, 'gateway.key'), agentGatewayToken, { mode: 0o600 })
    if (kind === 'restricted') {
      const gateway = join(folder, 'gateway'); mkdirSync(gateway)
      const socketPath = join(gateway, 'ingress.sock')
      await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(socketPath, resolve) }); chmodSync(socketPath, 0o600)
    }
  }
  if (supervisorParity) installSupervisorAssets(agentHome)
  const options = { ...(supervisorParity ? { agentBridge: true, bridgeWriteSkills: false, mcpToken: mainMcpToken, agentGatewayUrl: 'http://gateway/wizard/mcp', supervisorStatePath: join(root, 'supervisor.sqlite3'), supervisorIntervalMs: 3_600_000, heavyToken } : {}), appsJsonPath:join(root,'apps.json'), upstreamOrigin, sttOrigin: upstreamOrigin, hermesHome, hermesStatePath: kind === 'main' ? join(root, 'hermes-state.db') : '', agentArtifactDir: join(root, 'artifacts'), agentArtifactRoots: [agentHome], threadSeenStatePath: join(root, 'seen.json'), threadTitleStatePath: join(root, 'titles.json'), subjectsPath: join(root, 'subjects.json'), hermesKey: 'parity-main-secret', ownerProof: owner['X-Wizard-Owner-Proof'], requireAccess: false, wizardOsHome: osHome, settingsPath: join(osHome, 'settings.json'), agentBridge: followUpParity || supervisorParity, joinedDelegation: 'off', followThrough: false, requireJoinedDelegationCapability: false,
    runQueueStatePath: join(root, 'queue.sqlite3'), archivedSessionReader: () => [], pendingFirstSendReader: () => [], runQueuePollIntervalMs: 0, activeSessionReader: async () => [], dispatchHealthReader: () => true,
    providerSignInReady: async () => signin.ready,
    mediaRoot: join(root, 'files'), mediaAgentRoot: '/fixture-owner-files', mediaIndexPath: join(root, 'media.json'), uploadStatePath: join(root, 'uploads.sqlite3'), uploadReserveBytes: 0,
    ...(followUpParity ? { mcpToken: mainMcpToken, schedulerStatePath: join(root, 'schedules.sqlite3'), schedulerEnabled: true, schedulerIntervalMs: 3_600_000 } : {}),
    agentRuntime: { place: async (agentId, payload) => { placed.push({ agentId, payload }); return { verified: true, path: `/opt/data/inbox/2026-10-22/${payload.filename}` } } } }
  let wizard, base
  const start = async () => {
    const priorScheduler = process.env.WIZARD_SCHEDULER
    if (followUpParity) process.env.WIZARD_SCHEDULER = '1'
    try { wizard = createWizardServer({ ...options, ...serverOptions, ...optionOverrides }); await wizard.agentSocketsReady; base = `http://127.0.0.1:${(await listen(wizard)).port}` }
    finally { if (priorScheduler === undefined) delete process.env.WIZARD_SCHEDULER; else process.env.WIZARD_SCHEDULER = priorScheduler }
  }
  await start()
  // Synchronous fixture snapshots can outlive a previous socket's keep-alive
  // deadline. A fresh connection avoids ECONNRESET unrelated to the contract.
  const request = (path, init = {}) => { syncMessages(); return fetch(`${base}/wizard/hermes${path}${path.includes('?') ? '&' : '?'}agent=${id}`, { ...init, headers: { ...owner, Connection: 'close', ...init.headers } }) }
  const closeServer = async s => { await new Promise(resolve => { s.closeAllConnections(); s.close(resolve) }); await s.drained }
  return { dropSearchIndex:()=>{ if(hasSearchIndex) searchStore.exec('DROP TABLE messages_fts_trigram'); hasSearchIndex=false }, kind, id, root, seen, sessions, runs, placed, request, media, agentHome, stt, signin, origin: () => base, ownerHeaders: owner,
    // The runtime's own gateway credential and transport, never owner proof: main and unrestricted agents over TCP,
    // a restricted agent only through its own per-agent socket.
    setSupervisorSeal: (privacy, shared) => {
      if (kind === 'main') throw Error('main privacy cannot be changed by this fixture')
      const path = join(folder, 'agent.json'), agent = JSON.parse(readFileSync(path, 'utf8'))
      agent.privacy = privacy; agent.permissions.shared_with_agents = shared
      writeFileSync(path, JSON.stringify(agent))
    },
    supervisor: async (action, args, extraHeaders = {}) => {
      const path = kind === 'main' ? `/wizard/internal/supervisor/${action}` : '/wizard/mcp'
      const token = kind === 'main' ? heavyToken : agentGatewayToken
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extraHeaders }
      const body = JSON.stringify(kind === 'main' ? args : {jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'supervisor_'+action,arguments:args}})
      const normalize = async response => {
        if (kind === 'main' || !response.ok) return response
        const reply = await response.json(), content = reply.result?.content || []
        const value = JSON.parse(content[0]?.text || '{}')
        return new Response(JSON.stringify(value), {status:value.status || 200})
      }
      if (kind !== 'restricted') return normalize(await fetch(`${base}${path}`, { method: 'POST', headers, body }))
      return normalize(await new Promise((resolve, reject) => {
        const req = httpRequest({ socketPath: join(folder, 'gateway', 'gateway.sock'), agent: false, path, method: 'POST', headers }, res => {
          let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk }); res.on('end', () => resolve(new Response(text, { status: res.statusCode, headers: res.headers })))
        })
        req.on('error', reject); req.end(body)
      }))
    },
    gatewayRpc: async (rpc) => {
      const token = kind === 'main' ? mainMcpToken : readFileSync(join(folder, 'gateway.key'), 'utf8')
      const headers = { Authorization: ['Bearer', token].join(' '), 'Content-Type': 'application/json', Accept: 'application/json' }
      if (kind !== 'restricted') return fetch(`${base}/wizard/mcp`, { method: 'POST', headers, body: JSON.stringify(rpc) })
      await wizard.agentSocketsReady
      const { request: unixRequest } = await import('node:http')
      return new Promise((resolve, reject) => {
        const req = unixRequest({ socketPath: agentSocketPath(join(osHome, 'agents'), id), path: '/wizard/mcp', method: 'POST', headers }, res => {
          let data = ''; res.on('data', c => { data += c }); res.on('end', () => resolve({ status: res.statusCode, json: async () => JSON.parse(data) }))
        })
        req.on('error', reject); req.end(JSON.stringify(rpc))
      })
    },
    agentMcp: async (method, params = {}) => {
      syncMessages()
      const headers = { Authorization: `Bearer ${kind === 'main' ? (serverOptions.mcpToken ?? options.mcpToken) : agentGatewayToken}`, 'Content-Type': 'application/json' }
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      if (kind !== 'restricted') return fetch(`${base}/wizard/mcp`, { method: 'POST', headers, body })
      return new Promise((resolve, reject) => {
        const req = httpRequest({ socketPath: join(folder, 'gateway', 'gateway.sock'), agent: false, path: '/wizard/mcp', method: 'POST', headers }, res => {
          let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk }); res.on('end', () => resolve(new Response(text, { status: res.statusCode, headers: res.headers })))
        })
        req.on('error', reject); req.end(body)
      })
    },
    raw: (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { ...owner, Connection: 'close', ...init.headers } }),
    upload: (bytes, filename, mime) => fetch(`${base}/wizard/files/upload`, { method: 'POST', headers: { ...owner, 'Content-Type': 'application/octet-stream', 'X-Wizard-Mime': mime, 'X-Wizard-Filename': filename }, body: bytes }),
    restart: async () => { await closeServer(wizard); await start() },
    close: async () => { await closeServer(wizard); await closeServer(upstream); if (containerUpstream) await closeServer(containerUpstream); if (socket.listening) await closeServer(socket); searchDb?.close(); titleDb.close(); rmSync(root, { recursive: true, force: true }) } }
}
