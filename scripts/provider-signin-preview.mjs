// Synthetic-only read-only preview for provider sign-in recovery. No live runtime,
// credentials, threads, auth state or write-capable proxy are used.
import { createServer, request as httpRequest } from 'node:http'
import { readFileSync, statSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { resolve, join, extname, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createHermesFixture } from '../server/fixture.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

const web = resolve(process.env.PREVIEW_WEB || '')
if (!process.env.PREVIEW_WEB || !statSync(join(web, 'index.html')).isFile()) throw Error('Set PREVIEW_WEB to the unchanged Wizard shell web directory')
const scratch = mkdtempSync(join(tmpdir(), 'signin-preview-'))
const osHome = join(scratch, 'os'); mkdirSync(osHome)
const fixture = createHermesFixture({ expectedKey: 'synthetic-only-key' })
const upstream = `http://127.0.0.1:${(await listen(fixture)).port}`
const failure = { run_id: 'synthetic-auth-failure', session_id: 'chat-recent', status: 'completed', completed: true,
  output: "No Anthropic credentials found. Run 'hermes auth add anthropic' to sign in, or set ANTHROPIC_TOKEN / ANTHROPIC_API_KEY.",
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }
const app = createWizardServer({ upstreamOrigin: upstream, helmOrigin: upstream, hermesKey: 'synthetic-only-key', requireAccess: false,
  settingsPath: join(scratch, 'settings.json'), wizardOsHome: osHome, hermesStatePath: join(scratch, 'absent.db'),
  runQueueStatePath: join(scratch, 'runs.db'), runQueuePollIntervalMs: 0, activeSessionReader: async () => [], dispatchHealthReader: () => true,
  requireJoinedDelegationCapability: false, skinsStateDir: join(scratch, 'skins'), skins: { relays: [], blossom: 'https://127.0.0.1/offline' },
  fetchImpl: async (url, init) => new URL(url).pathname.startsWith('/v1/runs')
    ? new Response(JSON.stringify(failure), { status: init?.method === 'POST' ? 202 : 200, headers: { 'Content-Type': 'application/json' } }) : fetch(url, init),
})
const appOrigin = `http://127.0.0.1:${(await listen(app)).port}`
const admission = await (await fetch(appOrigin + '/wizard/hermes/v1/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'synthetic-only-notice' },
  body: JSON.stringify({ session_id: 'chat-recent', input: 'Help me plan a quiet weekend.', provider: 'anthropic', model: 'claude-opus-5-5' }) })).json()
if (admission.status !== 'failed') throw Error('Synthetic sign-in failure did not normalize')
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' }
const front = createServer((req, res) => {
  const u = new URL(req.url, 'http://preview')
  res.setHeader('Cache-Control', 'no-store')
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(403); return res.end('Read-only synthetic preview: sending and sign-in changes are disabled.') }
  if (u.pathname === '/') { res.writeHead(302, { Location: '/wizard-os-home/?session=chat-recent&shell=phone' }); return res.end() }
  if (u.pathname === '/__preview/receipt') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ sha: process.env.PREVIEW_SHA || 'working-tree', synthetic: true, readOnly: true, realCredentials: false, run_id: admission.run_id })) }
  if (u.pathname.startsWith('/wizard/')) {
    const proxy = httpRequest(appOrigin + req.url, { method: req.method }, upstream => { res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res) })
    proxy.on('error', () => { res.writeHead(502); res.end() }); return proxy.end()
  }
  if (u.pathname === '/wizard-os-home/data.js' || u.pathname === '/wizard-os-home/summaries.js') {
    res.setHeader('Content-Type', 'application/javascript')
    return res.end(u.pathname.endsWith('/data.js') ? 'window.WIZ_DATA={projects:{},threads:[]};' : 'window.WIZ_SUMMARIES={};')
  }
  let rel = u.pathname.startsWith('/wizard-os-home/') ? u.pathname.slice('/wizard-os-home/'.length) || 'index.html' : null
  // Optional unchanged Troubleshooter document only; all its API actions stay disabled.
  const trouble = u.pathname === '/troubleshoot/' && process.env.PREVIEW_TROUBLESHOOT_WEB
  if (trouble) rel = 'index.html'
  if (rel === null) { res.writeHead(404); return res.end() }
  const root = trouble ? resolve(process.env.PREVIEW_TROUBLESHOOT_WEB) : web
  let file
  try { file = resolve(root, decodeURIComponent(rel)); if (!file.startsWith(root + sep) || rel.split('/').some(part => part.startsWith('.'))) throw Error(); if (!statSync(file).isFile()) throw Error() }
  catch { res.writeHead(404); return res.end() }
  res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream')
  // Unchanged shell CSP: same-origin scripts, no inline shell code.
  if (!trouble) res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
  res.end(readFileSync(file))
})
console.log(`Synthetic-only sign-in preview: http://127.0.0.1:${(await listen(front, '127.0.0.1', Number(process.env.PORT || 0))).port}/wizard-os-home/?session=chat-recent&shell=phone`)
async function stop() { for (const server of [front, app]) { server.closeAllConnections(); await new Promise(done => server.close(done)) }; await fixture.closeFixture(); rmSync(scratch, { recursive: true, force: true }); process.exit(0) }
process.once('SIGINT', stop); process.once('SIGTERM', stop)
