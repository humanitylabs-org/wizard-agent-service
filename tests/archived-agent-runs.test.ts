import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'

// Issue 675 (James, 26 Nov 2026): archived threads came back because every scheduled wake, script-gated check
// and report posted into them re-opened the thread at admission, before anyone knew the answer was [SILENT].
// A silent or agent-started run leaves an archived thread archived; an owner message, or a run that ends
// needing the owner (needs_you), brings it back.
const OWNER = 'fixture-owner-proof-with-32-characters'
const report = (state: string, sentence: string) => `**${sentence}**\n[WIZARD_STATUS_V1]{"state":"${state}","ask":"${sentence}"}[/WIZARD_STATUS_V1]`

let root: string
const servers: any[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wizard-archived-agent-runs-'))
  for (const key of ['HOME', 'HERMES_HOME', 'WIZARD_OS_HOME', 'TMPDIR']) {
    const path = join(root, key.toLowerCase()); mkdirSync(path); vi.stubEnv(key, path)
  }
  vi.stubEnv('WIZARD_SCHEDULER', '0')
})
afterEach(async () => {
  for (const server of servers.splice(0).reverse()) {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await server.drained
  }
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

// A Hermes stand-in that, like the worst case on a box, re-opens a thread whenever a run is posted into it.
// `status` 'running' answers the admission as running and finishes on the first run lookup (real Hermes);
// 'completed' answers the admission already finished.
async function fixture(output: string, status: 'running' | 'completed' = 'running') {
  const sessions = new Map<string, any>(), runs = new Map<string, any>(), patches: any[] = []
  const upstream = createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://fixture.invalid').pathname
    const chunks = []; for await (const c of req) chunks.push(c)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
    const send = (code: number, value: any) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (path === '/api/sessions' && req.method === 'POST') {
      if (sessions.has(body.id)) { send(409, {}); return }
      sessions.set(body.id, { ...body, archived: false }); send(201, body); return
    }
    const session = path.match(/^\/api\/sessions\/([^/]+)$/)
    if (session && req.method === 'GET') { const s = sessions.get(decodeURIComponent(session[1])); send(s ? 200 : 404, s ? { session: s } : {}); return }
    if (session && req.method === 'PATCH') {
      const s = sessions.get(decodeURIComponent(session[1])); if (!s) { send(404, {}); return }
      patches.push({ id: s.id, ...body }); Object.assign(s, body); send(200, { session: s }); return
    }
    if (path === '/v1/runs' && req.method === 'POST') {
      const key = String(req.headers['idempotency-key'])
      const s = sessions.get(body.session_id); if (s) s.archived = false
      if (!runs.has(key)) runs.set(key, { run_id: `fixture_${runs.size}`, session_id: body.session_id, status })
      send(202, { ...runs.get(key), ...(status === 'completed' ? { output } : {}) }); return
    }
    if (path.startsWith('/v1/runs/')) {
      const run = [...runs.values()].find(r => path === `/v1/runs/${r.run_id}`)
      if (!run) { send(404, {}); return }
      run.status = 'completed'; send(200, { ...run, output }); return
    }
    if (path === '/v1/capabilities') { send(200, {}); return }
    if (path === '/api/sessions') { send(200, { data: [...sessions.values()] }); return }
    send(404, {})
  })
  servers.push(upstream)
  const up = await listen(upstream)
  const server: any = createWizardServer({ upstreamOrigin: `http://127.0.0.1:${up.port}`, hermesKey: 'fixture-key', ownerProof: OWNER, requireAccess: false,
    requireJoinedDelegationCapability: false, followThrough: false, wizardOsHome: process.env.WIZARD_OS_HOME,
    runQueueStatePath: join(root, 'queue.sqlite3'), runQueuePollIntervalMs: 0, activeSessionReader: async () => [], dispatchHealthReader: () => true,
    schedulerStatePath: join(root, 'schedules.sqlite3'), schedulerHermesHome: process.env.HERMES_HOME })
  servers.push(server)
  const address = await listen(server)
  const origin = `http://127.0.0.1:${address.port}`
  sessions.set('wizard_origin', { id: 'wizard_origin', title: 'One-week launch plan', archived: true })
  const headers = { 'X-Wizard-Owner-Proof': OWNER, 'Content-Type': 'application/json' }
  const schedules = (path: string, method: string, body?: any) => fetch(`${origin}/wizard/v1/schedules${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
  // Fire one wake of a job into the archived thread and let the run finish, the way a box does.
  const fire = async (job: any) => {
    const created = await (await schedules('', 'POST', { name: 'Launch · Check', when: { every: 60 }, thread: 'wizard_origin', prompt: 'Check the launch plan.', ...job })).json()
    expect((await schedules(`/${created.id}/run`, 'POST')).status).toBe(202)
    await server.scheduler.tick(false)
    const row = server.scheduler.db.prepare('SELECT receipt FROM schedule_occurrences WHERE job_id=?').get(created.id)
    const runId = JSON.parse(row.receipt).run_id
    for (let i = 0; i < 3; i++) await fetch(`${origin}/wizard/hermes/v1/runs/${runId}`, { headers })
    await server.scheduler.refreshRuns()
    return { created, runId }
  }
  const archived = () => sessions.get('wizard_origin').archived
  return { server, origin, headers, sessions, patches, fire, archived }
}

describe('an agent-started run in an archived thread (issue 675)', () => {
  it.each(['running', 'completed'] as const)('a script-gated wake that answers [SILENT] leaves the thread archived (Hermes answers %s)', async status => {
    const f = await fixture('[SILENT]', status)
    await f.fire({ prompt: 'If the gate script says wakeAgent false, reply [SILENT].' })
    expect(f.archived()).toBe(true)
    expect(f.patches.filter(p => p.archived === false)).toEqual([])
  })

  it('an hourly report that needs nothing from the owner leaves the thread archived', async () => {
    const f = await fixture(report('fyi', 'Self-healing: all services healthy'))
    await f.fire({ name: 'Self-healing report' })
    expect(f.archived()).toBe(true)
  })

  it.each(['running', 'completed'] as const)('a scheduled run that ends needing the owner brings the thread back (Hermes answers %s)', async status => {
    const f = await fixture(report('needs_you', 'Pick the launch date'), status)
    await f.fire({})
    expect(f.archived()).toBe(false)
  })

  it('a watcher that answers [SILENT] stays archived; a needs_you answer in the same thread brings it back', async () => {
    const silent = await fixture('[SILENT]')
    await silent.fire({ kind: 'watch' })
    expect(silent.archived()).toBe(true)
    const asks = await fixture(report('needs_you', 'Approve the launch post'))
    await asks.fire({ kind: 'watch' })
    expect(asks.archived()).toBe(false)
  })

  it('a reminder the owner set still comes back when it fires', async () => {
    const f = await fixture('Reminder: send the launch email.')
    await f.fire({ kind: 'remind', when: { once: new Date(Date.now() + 3_600_000).toISOString() }, prompt: 'Send the launch email.' })
    expect(f.archived()).toBe(false)
  })

  it('an owner message still brings the archived thread back at once', async () => {
    const f = await fixture(report('done', 'Drafted'))
    const sent = await fetch(`${f.origin}/wizard/hermes/v1/runs`, { method: 'POST', headers: { ...f.headers, 'Idempotency-Key': 'owner-turn-1' },
      body: JSON.stringify({ session_id: 'wizard_origin', input: 'Please draft the launch email.' }) })
    expect(sent.status).toBe(202)
    expect(f.archived()).toBe(false)
  })
})

// wizard-ux issue 1997 (James, 27 Nov 2026): the owner archives a thread while his own run is still working and
// trusts it to come back when there is news. Archive never stops the run; its visible reply brings the thread back
// to Inbox, and a [SILENT] answer keeps it archived. An archive after the reply has landed stays put.
describe('the owner archives a thread while his own run works (wizard-ux issue 1997)', () => {
  const ownerRun = async (f: Awaited<ReturnType<typeof fixture>>, key: string) => {
    const sent = await fetch(`${f.origin}/wizard/hermes/v1/runs`, { method: 'POST', headers: { ...f.headers, 'Idempotency-Key': key },
      body: JSON.stringify({ session_id: 'wizard_origin', input: 'Please plan the launch week.' }) })
    expect(sent.status).toBe(202)
    return (await sent.json()).run_id as string
  }
  const archive = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const patched = await fetch(`${f.origin}/wizard/hermes/api/sessions/wizard_origin`, { method: 'PATCH', headers: f.headers, body: JSON.stringify({ archived: true }) })
    expect(patched.status).toBe(200)
  }
  const finish = async (f: Awaited<ReturnType<typeof fixture>>, runId: string) => {
    let last: any = null
    for (let i = 0; i < 3; i++) last = await (await fetch(`${f.origin}/wizard/hermes/v1/runs/${runId}`, { headers: f.headers })).json()
    return last
  }

  it('a visible reply brings the thread back to Inbox, and archiving never stopped the run', async () => {
    const f = await fixture(report('done', 'Launch week planned'))
    const runId = await ownerRun(f, 'owner-1997-visible')
    expect(f.archived()).toBe(false)
    await archive(f)
    expect(f.archived()).toBe(true)
    const run = await finish(f, runId)
    expect(run.status).toBe('completed')
    expect(f.archived()).toBe(false)
  })

  it('a [SILENT] reply keeps it archived', async () => {
    const f = await fixture('[SILENT]')
    const runId = await ownerRun(f, 'owner-1997-silent')
    await archive(f)
    const run = await finish(f, runId)
    expect(run.status).toBe('completed')
    expect(f.archived()).toBe(true)
  })

  it('an archive after the reply landed stays archived', async () => {
    const f = await fixture(report('done', 'Launch week planned'))
    const runId = await ownerRun(f, 'owner-1997-after')
    expect((await finish(f, runId)).status).toBe('completed')
    await archive(f)
    await finish(f, runId)
    expect(f.archived()).toBe(true)
  })
})
