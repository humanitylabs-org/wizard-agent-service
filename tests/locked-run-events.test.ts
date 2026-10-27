import { afterEach, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'

// Model-locked turns run inside Hermes' chat/stream; Hermes 404s /v1/runs/<id>/events for them.
// The Agent Service must serve the live steps it reads from that stream, never proxy the 404.
const servers: Server[] = []
const dirs: string[] = []
const route = { model: 'fixture-model', provider: 'custom:fixture-private' }
const sessionId = 'wizard_events_fixture'
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()) })))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const originFor = async (server: Server) => { servers.push(server); return `http://127.0.0.1:${(await listen(server)).port}` }
const frame = (name: string, p: object) => `event: ${name}\ndata: ${JSON.stringify(p)}\n\n`

async function upstreamFixture() {
  const eventReads: string[] = []
  let release = () => {}
  const gate = new Promise<void>(r => { release = r })
  let finished = false
  const origin = await originFor(createServer(async (req, res) => {
    const path = new URL(req.url || '/', 'http://fixture').pathname
    if (req.method === 'GET' && /^\/v1\/runs\/[^/]+\/events$/.test(path)) {
      eventReads.push(path); res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"not found"}')
    }
    if (req.method === 'GET' && path.startsWith('/v1/runs/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ run_id: 'run_fixture', status: finished ? 'completed' : 'running', session_id: sessionId, runtime: { ...route, model_lock: 'confirmed' } }))
    }
    if (req.method === 'POST' && path.endsWith('/chat/stream')) {
      for await (const _ of req) { /* drain */ }
      const runtime = { model: route.model, provider: route.provider, model_lock: 'accepted' }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(frame('run.started', { run_id: 'run_fixture', runtime }))
      res.write(frame('tool.started', { tool_name: 'terminal', preview: 'df -h', session_id: sessionId, run_id: 'run_fixture', seq: 2 }))
      await gate
      res.write(frame('tool.completed', { tool_name: 'terminal', session_id: sessionId }))
      res.write(frame('assistant.delta', { delta: 'Disk is fine.', session_id: sessionId }))
      finished = true
      return res.end(frame('run.completed', { runtime: { ...runtime, model_lock: 'confirmed' }, messages: [{ role: 'assistant', content: 'x'.repeat(5000) }] }))
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (path === '/v1/capabilities') return res.end(JSON.stringify({ features: { delegation_delivery: { supported: true, modes: ['background', 'join'] }, markdown_rendering: true, run_instructions: true } }))
    return res.end(JSON.stringify({ object: 'list', data: [], sessions: [] }))
  }))
  return { origin, eventReads, release }
}

async function readEvents(url: string, until: (names: string[]) => boolean) {
  const response = await fetch(url, { headers: { Accept: 'text/event-stream' } })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader(), decoder = new TextDecoder()
  let text = ''
  const names = () => [...text.matchAll(/^event: (.+)$/gm)].map(m => m[1])
  while (!until(names())) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  await reader.cancel().catch(() => {})
  return { names: names(), text }
}

for (const queued of [false, true]) {
  it(`streams live tool steps and words for a model-locked run (${queued ? 'queued' : 'direct'})`, async () => {
    const upstream = await upstreamFixture()
    const dir = mkdtempSync(join(tmpdir(), 'wizard-locked-events-')); dirs.push(dir)
    const base = await originFor(createWizardServer({
      requireAccess: false, hermesKey: 'fixture-only', upstreamOrigin: upstream.origin, hermesStatePath: '',
      joinedDelegation: 'require', followThrough: false,
      ...(queued ? { runQueueStatePath: join(dir, 'queue.sqlite3'), runQueuePollIntervalMs: 50 } : {}),
    }))
    const sent = await fetch(`${base}/wizard/hermes/v1/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'events-fixture' },
      body: JSON.stringify({ session_id: sessionId, input: 'check disk', ...route, require_model_lock: true }),
    })
    if (sent.status !== 202) throw new Error(await sent.text())
    const runId = (await sent.json()).run_id
    const url = `${base}/wizard/hermes/v1/runs/${encodeURIComponent(runId)}/events`
    // Before the turn finishes, the running step is already visible.
    const early = await readEvents(url, names => names.includes('tool.started'))
    expect(early.names).toContain('tool.started')
    expect(early.text).toContain('df -h')
    upstream.release()
    const all = await readEvents(url, names => names.includes('run.completed'))
    expect(all.names.filter(n => n !== 'run.queued')).toEqual(['tool.started', 'tool.completed', 'message.delta', 'run.completed'])
    expect(all.text).toContain('Disk is fine.')
    expect(all.text).not.toContain('x'.repeat(5000))
    if (queued) expect(all.text).not.toContain('run_fixture')
    expect(upstream.eventReads).toEqual([])
  }, 15000)
}
