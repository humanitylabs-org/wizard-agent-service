// Browser UI acceptance fixture only. Responses below are synthetic, NOT provider/Hermes runtime proof.
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWizardServer, listen } from '../../server/service.mjs'
const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'incognito-browser-'))
const mainHome = join(root, 'main-home'); mkdirSync(mainHome)
const now = Date.now()/1000, ordinary = { id: 'synthetic-normal', title: 'Normal private chat', source: 'wizard-mobile', started_at: now, last_active: now, message_count: 2, model: 'glm-5-3', latest_message: { role: 'assistant', content: 'Normal private history stays saved.', timestamp: now }, messages: [{ role: 'user', content: 'An ordinary saved request', timestamp: now - 1 }, { role: 'assistant', content: 'Normal private history stays saved.', timestamp: now }] }
const temporary = new Map(), runs = new Map()
let seq = 0
const upstream = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://fixture').pathname
  const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
  let text = ''; for await (const c of req) text += c; const body = text ? JSON.parse(text) : {}
  if (path === '/health') return send(200, { status: 'ok' })
  if (path === '/api/model/options') return send(200, { provider: 'custom', model: 'glm-5-3', providers: [] })
  if (path === '/api/sessions' && req.method === 'POST') { temporary.set(body.id, []); return send(201, { id: body.id }) }
  if (path === '/api/sessions') return send(200, { data: [{ ...ordinary, messages: undefined }], has_more: false })
  if (path === '/v1/runs' && req.method === 'POST') {
    if (!temporary.has(body.session_id)) return send(404, {})
    const messages = temporary.get(body.session_id), run_id = 'synthetic-' + (++seq)
    messages.push({ role: 'user', content: body.input, timestamp: Date.now()/1000 })
    const output = 'Synthetic fixture answer. Your temporary message was: ' + body.input
    messages.push({ role: 'assistant', content: output, timestamp: Date.now()/1000 })
    runs.set(run_id, { run_id, session_id: body.session_id, status: 'completed', output }); return send(202, { run_id, session_id: body.session_id, status: 'running' })
  }
  const events = /^\/v1\/runs\/([^/]+)\/events$/.exec(path)
  if (events && runs.has(events[1])) {
    const run = runs.get(events[1]); res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
    for (const value of [{ event: 'tool.started', tool: 'synthetic_read' }, { event: 'tool.completed', tool: 'synthetic_read' }, { event: 'message.delta', delta: run.output }, { event: 'run.completed' }]) res.write('data: ' + JSON.stringify({ ...value, run_id: run.run_id, session_id: run.session_id }) + '\n\n')
    return res.end()
  }
  if (path.startsWith('/v1/runs/')) return send(runs.has(path.split('/').pop()) ? 200 : 404, runs.get(path.split('/').pop()) || {})
  const m = /^\/api\/sessions\/([^/]+)(\/messages)?$/.exec(path)
  if (m && m[1] === ordinary.id) return send(200, m[2] ? { data: ordinary.messages, has_more: false } : { session: ordinary })
  if (m && temporary.has(m[1])) return send(200, m[2] ? { data: temporary.get(m[1]), has_more: false } : { session: { id: m[1] } })
  send(404, { error: 'synthetic_fixture_only' })
})
const ua = await listen(upstream), origin = `http://127.0.0.1:${ua.port}`
const runtime = { apply: async () => ({ ok: true }), start: async () => ({ ok: true }), stop: async () => ({ ok: true }),
  incognitoStart: async () => ({ origin, key: 'synthetic-ephemeral-api-key-not-real' }), incognitoLease: async () => ({ ok: true }),
  incognitoStop: async (_agent, { session_id }) => { temporary.delete(session_id); for (const [id, r] of runs) if (r.session_id === session_id) runs.delete(id); return { ok: true } } }
const service = createWizardServer({ upstreamOrigin: origin, hermesKey: 'synthetic-main-key', requireAccess: false,
  agentBridge: false, followThrough: false, joinedDelegation: 'off', hermesHome: mainHome,
  uxDir: process.env.QA_UX_DIR, uxPrefix: 'wizard-os-home', wizardOsHome: root,
  appsJsonPath: join(root, 'apps.json'), settingsPath: join(root, 'settings.json'), threadSeenStatePath: join(root, 'seen.json'), agentRuntime: runtime, agentBasePort: 47650 })
const addr = await listen(service, '127.0.0.1', Number(process.env.QA_PORT || 19743)), base = `http://127.0.0.1:${addr.port}`
const response = await fetch(base + '/wizard/v1/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Private', model: { provider: 'tinfoil', model: 'glm-5-3' }, permissions: { preset: 'private' } }) })
if (response.status !== 201) throw new Error('synthetic_agent_create_failed')
const file = join(root, 'agents', 'private', 'agent.json'), agent = JSON.parse(readFileSync(file)); agent.runtime.port = ua.port; writeFileSync(file, JSON.stringify(agent))
console.log(JSON.stringify({ ready: true, mode: 'synthetic-browser-fixture-only', base, root }))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await new Promise(r => service.close(r)); await new Promise(r => upstream.close(r)); rmSync(root, { recursive: true, force: true }); process.exit(0) })
