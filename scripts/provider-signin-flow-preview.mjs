// Interactive synthetic-only recovery rig: real Service + real Troubleshooter, fake providers.
import { createServer, request as httpRequest } from 'node:http'
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs'
import { resolve, join, extname, sep } from 'node:path'
import { createHermesFixture } from '../server/fixture.mjs'
import { createWizardServer, listen } from '../server/service.mjs'
const web = resolve(process.env.PREVIEW_WEB || ''), state = resolve(process.env.PREVIEW_STATE || '')
if (!process.env.PREVIEW_WEB || !statSync(join(web, 'index.html')).isFile() || !process.env.PREVIEW_STATE) throw Error('Set isolated PREVIEW_WEB and PREVIEW_STATE')
mkdirSync(state, { recursive: true }); const osHome = join(state, 'os'); mkdirSync(osHome, { recursive: true })
const validFile = join(state, 'signed-in'), signedIn = () => existsSync(validFile)
const fixture = createHermesFixture({ expectedKey: 'synthetic-only-key', empty: true })
const upstream = `http://127.0.0.1:${(await listen(fixture)).port}`
const at = new Date().toISOString(), session = { id: 'chat-recent', title: 'STAGING · Claude sign-in recovery', source: 'wizard-mobile', model: 'claude-opus-5-5', provider: 'anthropic', updated_at: at, wizard_last_user_at: at }
fixture.fixture.sessions.push(session); fixture.fixture.messages.set(session.id, [{ id: 'staging-intro', role: 'assistant', content: 'STAGING · This is a simulated Claude Opus chat. Type a message below to try the sign-in failure and recovery. No real account is used.', created_at: at }])
const runs = new Map(), admissions = [], modelRuns = []
const failureText = "No Anthropic credentials found. Run 'hermes auth add anthropic' to sign in, or set ANTHROPIC_TOKEN / ANTHROPIC_API_KEY."
const reply = 'STAGING · Claude Opus (simulated): Your sign-in is working again. I received your original message and can reply now.'
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const app = createWizardServer({ upstreamOrigin: upstream, helmOrigin: upstream, hermesKey: 'synthetic-only-key', requireAccess: false,
  settingsPath: join(state, 'settings.json'), appsJsonPath: join(state, 'apps.json'), wizardOsHome: osHome, hermesStatePath: join(state, 'absent.db'),
  providerSignInReady: async provider => provider === 'claude' && signedIn(),
  runQueueStatePath: join(state, 'runs.db'), runQueuePollIntervalMs: 150, activeSessionReader: async () => [], dispatchHealthReader: () => true,
  requireJoinedDelegationCapability: false, skinsStateDir: join(state, 'skins'), skins: { relays: [], blossom: 'https://127.0.0.1/offline' },
  fetchImpl: async (url, init = {}) => {
    if (new URL(url).origin !== upstream) throw Error('Synthetic rig refused non-fixture upstream')
    const path = new URL(url).pathname
    if ((path === '/v1/runs' || path === '/api/sessions/chat-recent/chat/stream') && init.method === 'POST') {
      const body = JSON.parse(init.body); if (!body.input) body.input = body.message
      const id = `synthetic-${admissions.length + 1}`
      admissions.push({ id, session_id: session.id, input: body.input, provider: body.provider, model: body.model, require_model_lock: body.require_model_lock === true, signedIn: signedIn() })
      if (body.provider !== 'anthropic' || body.model !== 'claude-opus-5-5') return jsonResponse({ error: 'This staging thread only supports Claude Opus.' }, 422)
      const list = fixture.fixture.messages.get(session.id)
      if (!list.some(m => m.role === 'user' && JSON.stringify(m.content) === JSON.stringify(body.input))) list.push({ id: `user-${id}`, role: 'user', content: body.input, created_at: new Date().toISOString() })
      const run = { run_id: id, session_id: session.id, status: 'completed', completed: true, output: signedIn() ? reply : failureText,
        usage: { input_tokens: signedIn() ? 1 : 0, output_tokens: signedIn() ? 1 : 0, total_tokens: signedIn() ? 2 : 0 }, runtime: { model: body.model, provider: body.provider, model_lock: 'confirmed' } }
      runs.set(id, run)
      if (signedIn()) { modelRuns.push({ run_id: id, provider: body.provider, model: body.model, synthetic: true }); list.push({ id: `assistant-${id}`, role: 'assistant', content: reply, model: body.model, created_at: new Date().toISOString() }) }
      session.updated_at = new Date().toISOString()
      if (path.endsWith('/chat/stream')) return new Response(`event: run.started\ndata: ${JSON.stringify({ run_id: id, runtime: { model: body.model, provider: body.provider, model_lock: 'accepted' } })}\n\nevent: run.completed\ndata: ${JSON.stringify(run)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
      return jsonResponse(run, 202)
    }
    const match = path.match(/^\/v1\/runs\/([^/]+)(\/events)?$/)
    if (match && runs.has(match[1])) {
      const run = runs.get(match[1])
      return match[2] ? new Response(`event: message.delta\ndata: ${JSON.stringify({ delta: run.output })}\n\nevent: run.completed\ndata: ${JSON.stringify(run)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }) : jsonResponse(run)
    }
    if (path === '/api/model/options') return jsonResponse({ options: [{ value: 'claude-opus-5-5', name: 'Claude Opus', provider: 'anthropic' }] })
    return fetch(url, init)
  },
})
const appOrigin = `http://127.0.0.1:${(await listen(app)).port}`, troubleOrigin = `http://127.0.0.1:${Number(process.env.PREVIEW_TROUBLESHOOT_PORT || 9505)}`
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' }
function proxy(req, res, origin) {
  const up = httpRequest(origin + req.url, { method: req.method, headers: { ...req.headers, host: new URL(origin).host } }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res) })
  up.on('error', () => { res.writeHead(502); res.end('Staging dependency unavailable') }); req.pipe(up)
}
const sendJson = (res, body) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)) }
// Synthetic Tailscale local API: keeps unrelated network warnings out of the scenario.
const socket = join(state, 'absent.sock'); rmSync(socket, { force: true })
const tailnet = createServer((_req, res) => sendJson(res, { BackendState: 'Running', Self: { DNSName: 'staging-wizard.', TailscaleIPs: ['127.0.0.1'] } }))
await new Promise(done => tailnet.listen(socket, done))
const front = createServer((req, res) => {
  const u = new URL(req.url, 'http://preview'); res.setHeader('Cache-Control', 'no-store')
  if (u.pathname === '/') { res.writeHead(302, { Location: '/wizard-os-home/?session=chat-recent&shell=phone' }); return res.end() }
  if (u.pathname === '/__preview/receipt') return sendJson(res, { sha: process.env.PREVIEW_SHA || 'working-tree', troubleshooterSha: process.env.PREVIEW_TROUBLESHOOT_SHA, synthetic: true, readOnly: false, realCredentials: false, signedIn: signedIn(), admissions, modelRuns })
  // The real Troubleshooter's agent-reply probe calls only this fake loopback Hermes.
  if (u.pathname === '/v1/chat/completions') return sendJson(res, { choices: [{ message: { content: signedIn() ? 'OK' : 'No Anthropic credentials found. Claude sign-in expired.' } }] })
  if (u.pathname === '/health') return sendJson(res, { status: 'ok', version: 'STAGING' })
  if (u.pathname === '/wizard-claude/api/staging-signin' && req.method === 'POST') {
    writeFileSync(validFile, 'synthetic login valid\n', { mode: 0o600 }); return sendJson(res, { staging: true, connected: true })
  }
  if (u.pathname === '/wizard-claude/' && req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html')
    return res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>STAGING · Claude Connect</title><style>body{margin:0;padding:24px;font:16px system-ui;background:var(--wz-base,#0b0d12);color:var(--wz-text,#e8eaf0)}button{font:inherit;min-height:48px;border:0;border-radius:12px;padding:12px 24px;background:var(--wz-accent,#e8eaf0);color:var(--wz-base,#0b0d12)}p{line-height:1.5}</style><h1>Claude · Connect</h1><p>STAGING · Simulated sign-in. No account, password or real login is used.</p><p id="status">${signedIn() ? 'Signed in (simulated). Return to Fix Wizard. Your waiting message sends on its own.' : 'Claude’s sign-in has expired.'}</p><button id="signin">Sign in</button><script src="/wizard-claude/staging.js"></script><script src="/wizard-os-home/core/app-client.js"></script>`)
  }
  if (u.pathname === '/wizard-claude/staging.js') {
    res.setHeader('Content-Type', 'application/javascript')
    return res.end(`document.getElementById('signin').onclick=async function(){this.disabled=true;const r=await fetch('/wizard-claude/api/staging-signin',{method:'POST'});if(!r.ok)throw Error('Staging sign-in failed');document.getElementById('status').textContent='Signed in (simulated). Return to Fix Wizard. Your waiting message sends on its own.';this.textContent='Signed in';};`)
  }
  if (u.pathname.startsWith('/troubleshoot/')) {
    if (req.method === 'POST' && !['/troubleshoot/api/repair', '/troubleshoot/api/engine', '/troubleshoot/api/repair/stop'].includes(u.pathname)) { res.writeHead(405); return res.end('Not part of this synthetic scenario') }
    return proxy(req, res, troubleOrigin)
  }
  if (u.pathname.startsWith('/wizard/')) {
    // Devices in this throwaway scenario must not adopt another tester's desk.
    if (u.pathname.startsWith('/wizard/v1/workspaces')) { res.writeHead(404); return res.end('{"error":"staging_has_no_shared_workspaces"}') }
    if (u.pathname === '/wizard/v1/schedules') return sendJson(res, { schedules: [] })
    if (u.pathname === '/wizard/v1/apps') return sendJson(res, { apps: [{ id: 'wizard-claude', name: 'Claude', url: '/wizard-claude/', source: 'apps.json', view: { mode: 'original', url: '/wizard-claude/' } }] })
    return proxy(req, res, appOrigin)
  }
  if (u.pathname === '/wizard-os-home/data.js' || u.pathname === '/wizard-os-home/summaries.js') {
    res.setHeader('Content-Type', 'application/javascript'); return res.end(u.pathname.endsWith('/data.js') ? 'window.WIZ_DATA={projects:{},threads:[]};' : 'window.WIZ_SUMMARIES={};')
  }
  const rel = u.pathname.startsWith('/wizard-os-home/') ? u.pathname.slice('/wizard-os-home/'.length) || 'index.html' : null
  if (rel === null || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); return res.end() }
  let file
  try { file = resolve(web, decodeURIComponent(rel)); if (!file.startsWith(web + sep) || rel.split('/').some(p => p.startsWith('.'))) throw Error(); if (!statSync(file).isFile()) throw Error() }
  catch { res.writeHead(404); return res.end() }
  res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream')
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
  res.end(readFileSync(file))
})
console.log(`Synthetic interactive preview: http://127.0.0.1:${(await listen(front, '127.0.0.1', Number(process.env.PORT || 0))).port}/wizard-os-home/?session=chat-recent&shell=phone`)
async function stop() { for (const server of [front, app, tailnet]) { server.closeAllConnections(); await new Promise(done => server.close(done)) }; await fixture.closeFixture(); process.exit(0) }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
