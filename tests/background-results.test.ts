import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createWizardServer, listen } from '../server/service.mjs'

const owned: Array<() => Promise<void>> = []
afterEach(async () => { while (owned.length) await owned.pop()!() })
const status = (state: string) => `Outcome\n[WIZARD_STATUS_V1]{"state":"${state}","ask":"Approve the release"}[/WIZARD_STATUS_V1]`
async function fixture({ count = 205, access = false, history = false, loseAck = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wizard-manual-background-'))
  const at = Date.now() / 1000, finished = at - 3 * 3600
  const rows = new Map<string, any[]>(), sessions: any[] = [], calls: any[] = [], reads: string[] = []
  const wireAttempts: any[] = []
  let canDispatch = true, failHistory = false, slowHistory = false, skew = 0, historyStatus = 500, failLease = false
  const badHistory = new Set<string>()
  const held = new Set<string>()
  for (let i = 0; i < count; i++) {
    const id = i === 101 ? 'wizard-assistant-101' : i === 202 ? 'live_tip_202' : `wizard_manual_${i}`
    const root = i === 202 ? 'wizard_compressed' : id
    sessions.push({ id, _lineage_root_id: root, title: `Background result ${i}`, last_active: finished, message_count: 2, source: 'api_server' })
    rows.set(id, [{ id: i * 10 + 1, role: 'user', content: 'Finish the approved research.', timestamp: finished - 100 },
      { id: i * 10 + 2, role: 'user', content: `[ASYNC DELEGATION BATCH COMPLETE — deleg_manual_${i}] Saved findings: fixture result ${i}.`, display_kind: 'async_delegation_complete', timestamp: finished }])
    if (root !== id) rows.set(root, rows.get(id)!)
  }
  let db: DatabaseSync | undefined
  const historyPath = join(dir, 'history.db')
  if (history) {
    db = new DatabaseSync(historyPath)
    db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, started_at REAL, source TEXT);
      CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER DEFAULT 1, tool_calls TEXT, display_kind TEXT, finish_reason TEXT);
      CREATE TABLE session_turn_leases(conversation_id TEXT PRIMARY KEY, expires_at REAL);
      CREATE TABLE async_delegations(delegation_id TEXT PRIMARY KEY, origin_session_id TEXT, state TEXT, delivery_state TEXT, result_json TEXT, completed_at REAL);`)
    for (const [id, entries] of rows) {
      db.prepare('INSERT OR IGNORE INTO sessions VALUES(?,?,?)').run(id, finished - 100, 'api_server')
      for (const row of entries) db.prepare('INSERT OR IGNORE INTO messages(id,session_id,role,content,timestamp,display_kind) VALUES(?,?,?,?,?,?)').run(row.id, id, row.role, row.content, row.timestamp, row.display_kind || null)
    }
  }
  const upstream = createServer(async (req, res) => {
    const u = new URL(req.url!, 'http://fixture'); reads.push(u.pathname + u.search)
    res.setHeader('Content-Type', 'application/json')
    if (u.pathname === '/v1/capabilities') { res.end(JSON.stringify({ features: { run_submission: true, run_status: true } })); return }
    if (u.pathname === '/api/sessions') {
      res.end(JSON.stringify({ data: sessions.slice(Number(u.searchParams.get('offset') || 0), Number(u.searchParams.get('offset') || 0) + Number(u.searchParams.get('limit') || 100)) })); return
    }
    const msgs = u.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/)
    if (msgs) {
      if (slowHistory) await new Promise(r => setTimeout(r, 250))
      if (badHistory.has(decodeURIComponent(msgs[1]))) { res.statusCode = 500; res.end('{}'); return }
      if (failHistory) { res.statusCode = historyStatus; res.end('{}'); return }
      res.end(JSON.stringify({ data: rows.get(decodeURIComponent(msgs[1])) || [] })); return
    }
    if (u.pathname === '/v1/runs' && req.method === 'POST') {
      const chunks = []; for await (const c of req) chunks.push(c)
      const text = Buffer.concat(chunks).toString()
      wireAttempts.push({ text, key: req.headers['idempotency-key'] })
      if (loseAck && wireAttempts.length > 1) {
        res.end(JSON.stringify({ run_id: 'fixture_run_1', status: 'completed' })); return
      }
      const body = JSON.parse(text); calls.push(body)
      const list = rows.get(body.session_id)!; list.push({ id: 99999 + calls.length, role: 'user', content: body.input, timestamp: at + calls.length })
      if (loseAck) { res.destroy(); return }
      res.end(JSON.stringify({ run_id: `fixture_run_${calls.length}`, status: 'completed', output: 'fixture: original-thread continuation complete' })); return
    }
    if (/^\/v1\/runs\/fixture_run_/.test(u.pathname)) { res.end(JSON.stringify({ run_id: u.pathname.split('/').pop(), status: 'completed', output: 'fixture: original-thread continuation complete' })); return }
    res.statusCode = 404; res.end('{}')
  })
  const origin = `http://127.0.0.1:${(await listen(upstream)).port}`
  let server: ReturnType<typeof createWizardServer>, base: string
  const open = async () => {
    server = createWizardServer({ upstreamOrigin: origin, hermesKey: 'fixture-only', joinedDelegation: 'prefer',
      followThrough: false, hermesStatePath: history ? historyPath : '', sessionDbPath: join(dir, 'absent-state.db'), archivedSessionReader: () => [],
      runQueueStatePath: join(dir, 'queue.db'), runQueuePollIntervalMs: loseAck ? 0 : 25, dispatchHealthReader: () => canDispatch,
      activeSessionReader: () => [], turnHeldReader: () => false, threadTitleStatePath: join(dir, 'titles.json'),
      threadDispositionStatePath: join(dir, 'dispositions.json'), settingsPath: join(dir, 'settings.json'),
      requireAccess: access, accessVerifier: () => false, backgroundResultsRefreshMs: 30,
      backgroundResultsBusyReader: (id: string) => { if (failLease) throw new Error('temporary lease DB busy'); return held.has(id) }, backgroundResultsNow: () => Date.now() + skew, runQueueRetryDelayMs: loseAck ? 60_000 : 25 })
    base = `http://127.0.0.1:${(await listen(server)).port}`
  }
  await open()
  const close = async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) }
  owned.push(async () => { await close(); upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r())); db?.close(); rmSync(dir, { recursive: true, force: true }) })
  return { rows, calls, reads, wireAttempts, sessions, finished, at, held, badHistory, queuePath: join(dir, 'queue.db'), close, open,
    receipt: (sessionId: string, id = 'deleg_saved_receipt') => db!.prepare('INSERT INTO async_delegations VALUES(?,?,?,?,?,?)').run(id, sessionId, 'completed', 'dropped', JSON.stringify({ results: [{ task_index: 0, status: 'completed', summary: 'Saved receipt fixture findings.' }] }), finished),
    advance: (ms: number) => { skew += ms },
    failHistory: (v: boolean) => { failHistory = v },
    deleted: () => { failHistory = true; historyStatus = 404 }, denyHistory: () => { failHistory = true; historyStatus = 403 }, failLease: (v: boolean) => { failLease = v }, slowHistory: (v: boolean) => { slowHistory = v },
    pause: () => { canDispatch = false }, resume: () => { canDispatch = true },
    restart: async () => { await close(); await open() },
    list: async () => {
      for (let n = 0; n < 250; n++) {
        const r = await fetch(`${base}/wizard/background-results`), body = await r.json()
        if (!body.scanning) return { response: r, body }
        await new Promise(r => setTimeout(r, 15))
      }
      throw new Error('discovery did not settle')
    },
    click: async (item: any, overrides = {}) => fetch(`${base}/wizard/background-results/${item.id}/continue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: item.session_id, ...overrides }),
    }),
    base: () => base!,
  }
}
const settled = async (f: any, n: number) => { const deadline = Date.now() + 5000; while (f.calls.length < n && Date.now() < deadline) await new Promise(r => setTimeout(r, 25)); expect(f.calls).toHaveLength(n) }

describe('one-tap Continue for older finished results: actual HTTP + durable queue', () => {
  it('reconciles a lost manual-Continue acknowledgement after restart even when a newer human turn invalidates new dispatch', async () => {
    const f = await fixture({ count: 1, loseAck: true })
    const item = (await f.list()).body.results[0]
    const queued = await (await f.click(item)).json()
    expect(queued.status).toBe('queued')
    expect(f.calls).toHaveLength(1)
    const before = new DatabaseSync(f.queuePath)
    const frozen = before.prepare('SELECT dispatch_attempted,dispatch_body FROM wizard_run_queue').get()!
    expect(frozen.dispatch_attempted).toBe(1)
    expect(frozen.dispatch_body).toBe(f.wireAttempts[0].text)
    before.close()
    f.rows.get('wizard_manual_0')!.push({ id: 200001, role: 'user', content: 'A newer human request', timestamp: f.at + 100 })
    await f.restart()
    const retry = new DatabaseSync(f.queuePath)
    retry.exec('UPDATE wizard_run_queue SET retry_after=0'); retry.close()
    const result = await (await fetch(`${f.base()}/wizard/hermes/v1/runs/${queued.run_id}`)).json()
    expect(result.status).toBe('completed')
    expect(f.calls).toHaveLength(1)
    expect(f.wireAttempts).toHaveLength(2)
    expect(f.wireAttempts[1]).toEqual(f.wireAttempts[0])
    expect(f.calls[0]).not.toHaveProperty('_wizard_background_recovery')
  })
  it('walks past session 100, covers assistant and compressed roots, and never starts work from discovery', async () => {
    const f = await fixture()
    const { body } = await f.list()
    expect(body.results).toHaveLength(205)
    expect(body.results.some((r: any) => r.session_id === 'wizard-assistant-101')).toBe(true)
    expect(body.results.some((r: any) => r.session_id === 'wizard_compressed')).toBe(true)
    expect(f.reads).toContain('/api/sessions?limit=200&offset=200&include_children=false')
    expect(JSON.stringify(body)).not.toContain('Saved findings:')
    expect(body.scan_complete).toBe(true)
    expect(f.calls).toHaveLength(0)
  })
  it('after service restart the same saved result waits, and duplicate clicks admit once in its originating thread', async () => {
    const f = await fixture({ count: 1 }); f.pause()
    const r = (await f.list()).body.results[0]
    await f.restart()
    expect((await f.list()).body.results[0].id).toBe(r.id)
    const clicks = await Promise.all([f.click(r), f.click(r)])
    expect(clicks.map(x => x.status)).toEqual([202, 202])
    const a = await clicks[0].json(), b = await clicks[1].json()
    expect(a.run_id).toBe(b.run_id)
    expect(f.calls).toHaveLength(0)
    await f.restart(); f.resume()
    await settled(f, 1)
    expect(f.calls[0].session_id).toBe('wizard_manual_0')
    expect(f.calls[0].input).toContain('owner pressed Continue')
    expect(f.calls[0]).not.toHaveProperty('_wizard_background_recovery')
    const replay = await f.click(r)
    expect(replay.status).toBe(202)
    expect((await replay.json()).run_id).toBe(a.run_id)
    expect(f.calls).toHaveLength(1)
    expect((await f.list()).body.results).toHaveLength(0)
  })
  it('compressed-root Continue goes to the originating root, not the temporary tip', async () => {
    const f = await fixture()
    const r = (await f.list()).body.results.find((r: any) => r.session_id === 'wizard_compressed')
    expect((await f.click(r)).status).toBe(202)
    await settled(f, 1)
    expect(f.calls[0].session_id).toBe('wizard_compressed')
  })
  it('a newer human turn makes a stale-tab Continue conflict instead of reopening the older task', async () => {
    const f = await fixture({ count: 1 }), r = (await f.list()).body.results[0]
    f.rows.get('wizard_manual_0')!.push({ id: 3, role: 'user', content: 'Stop that; do this new task.', timestamp: f.at })
    expect((await f.click(r)).status).toBe(409)
    expect(f.calls).toHaveLength(0)
  })
  for (const state of ['needs_you', 'check']) it(`preserves an existing ${state} decision`, async () => {
    const f = await fixture({ count: 1 }), r = (await f.list()).body.results[0]
    f.rows.get('wizard_manual_0')!.push({ id: 3, role: 'assistant', content: status(state), timestamp: f.at, finish_reason: 'stop' })
    expect((await f.click(r)).status).toBe(409)
    expect(f.calls).toHaveLength(0)
  })
  it('revalidates a queued continuation at dispatch after restart: a newer human turn wins', async () => {
    const f = await fixture({ count: 1 }); f.pause()
    const r = (await f.list()).body.results[0]
    expect((await f.click(r)).status).toBe(202)
    f.rows.get('wizard_manual_0')!.push({ id: 3, role: 'user', content: 'Leave this work stopped.', timestamp: f.at })
    await f.restart(); f.resume()
    await new Promise(r => setTimeout(r, 150))
    expect(f.calls).toHaveLength(0)
    const result = await (await f.click(r)).json()
    expect(['failed', 'interrupted']).toContain(result.status)
  })
  it('does not project consumed findings or current (<2h) results as a manual gate', async () => {
    const f = await fixture({ count: 2 })
    f.rows.get('wizard_manual_0')![1].timestamp = f.at - 10
    f.rows.get('wizard_manual_1')!.push({ id: 13, role: 'user', content: '[Wizard follow-through] Recovered helper receipt deleg_manual_1\nThe results were consumed.', timestamp: f.at })
    expect((await f.list()).body.results).toHaveLength(0)
    expect(f.calls).toHaveLength(0)
  })
  it('a genuine final answer after a transcript completion consumes it even with a delegation id', async () => {
    const f = await fixture({ count: 1 })
    f.rows.get('wizard_manual_0')!.push({ id: 3, role: 'assistant', content: 'Finished the original request.', finish_reason: 'stop', timestamp: f.finished + 30 })
    expect((await f.list()).body.results).toHaveLength(0)
    expect(f.calls).toHaveLength(0)
  })
  it('normal Chats responds while a cold discovery scan is slow; the manual list also returns scanning immediately', async () => {
    const f = await fixture({ count: 101 }); f.slowHistory(true)
    const before = Date.now()
    // First-page preview enrichment already reads history. Use a subsequent page to isolate discovery's
    // latency; it must stay responsive while the independent cold recovery scan waits on that history.
    const r = await fetch(`${f.base()}/wizard/hermes/api/sessions?limit=100&offset=100`)
    expect(r.status).toBe(200)
    expect(Date.now() - before).toBeLessThan(220)
    const manual = await fetch(`${f.base()}/wizard/background-results`)
    expect((await manual.json()).scanning).toBe(true)
    expect(f.calls).toHaveLength(0)
    f.slowHistory(false); await f.list()
  })
  it('a temporary history failure at dispatch retries when the original thread is readable again', async () => {
    const f = await fixture({ count: 1 }); f.pause()
    const pending = (await f.list()).body.results[0]
    expect((await f.click(pending)).status).toBe(202)
    f.failHistory(true); f.resume()
    await new Promise(r => setTimeout(r, 150))
    expect(f.calls).toHaveLength(0)
    expect((await (await f.click(pending)).json()).status).toBe('queued')
    f.failHistory(false)
    await settled(f, 1)
  })
  it('another queued result in the root hides the remaining manual action', async () => {
    const f = await fixture({ count: 1 }); f.pause()
    f.rows.get('wizard_manual_0')!.push({ id: 3, role: 'user', content: '[ASYNC DELEGATION BATCH COMPLETE — deleg_other] Second saved result.', timestamp: f.finished + 10 })
    const pending = (await f.list()).body.results
    expect(pending).toHaveLength(2)
    expect((await f.click(pending[0])).status).toBe(202)
    expect((await f.list()).body.results).toHaveLength(0)
    expect(f.calls).toHaveLength(0)
  })
  it('a lease on the compressed physical tip prevents a root Continue and is also checked at dispatch', async () => {
    const f = await fixture(); f.pause()
    const pending = (await f.list()).body.results.find((r: any) => r.session_id === 'wizard_compressed')
    f.held.add('live_tip_202')
    expect((await f.click(pending)).status).toBe(409)
    f.held.clear()
    expect((await f.click(pending)).status).toBe(202)
    f.held.add('live_tip_202'); f.resume()
    await new Promise(r => setTimeout(r, 200))
    expect(f.calls).toHaveLength(0)
    // A held lease waits (retryable) instead of failing the owner's Continue for good; nothing dispatches meanwhile.
    expect((await (await f.click(pending)).json()).status).toBe('queued')
    f.held.clear()
    await settled(f, 1)
    expect(f.calls[0].session_id).toBe('wizard_compressed')
    expect(f.calls[0]).not.toHaveProperty('_wizard_background_recovery')
  })
  it('a newer human request written to the logical compression root prevents Continue from its tip', async () => {
    const f = await fixture()
    const pending = (await f.list()).body.results.find((r: any) => r.session_id === 'wizard_compressed')
    // Distinct root/tip feeds model a compaction boundary instead of one shared array.
    f.rows.set('wizard_compressed', [{ id: 88888, role: 'user', content: 'The root moved on.', timestamp: f.at }])
    expect((await f.click(pending)).status).toBe(409)
    expect(f.calls).toHaveLength(0)
  })
  it('a result first seen before two hours becomes manual Continue as it ages without a new message', async () => {
    const f = await fixture({ count: 1 })
    f.rows.get('wizard_manual_0')![1].timestamp = f.at - 3600
    const first = (await f.list()).body
    expect(first.scanning).toBe(false)
    expect(first.scan_complete).toBe(true)
    expect(first.results).toHaveLength(0)
    f.advance(2 * 3600 * 1000)
    expect((await f.list()).body.results).toHaveLength(1)
    expect(f.calls).toHaveLength(0)
  })
  it('Continue deliberately covers sibling saved findings, which disappear after a genuine final answer', async () => {
    const f = await fixture({ count: 1 })
    f.rows.get('wizard_manual_0')!.push({ id: 3, role: 'user', content: '[ASYNC DELEGATION BATCH COMPLETE — deleg_other] Second saved result.', timestamp: f.finished + 10 })
    const pending = (await f.list()).body.results
    expect(pending).toHaveLength(2)
    expect((await f.click(pending[0])).status).toBe(202)
    await settled(f, 1)
    expect(f.calls[0].input).toContain('including any other saved results above')
    f.rows.get('wizard_manual_0')!.push({ id: 100099, role: 'assistant', content: 'All saved findings addressed.', finish_reason: 'stop', timestamp: f.at + 20 })
    expect((await f.list()).body.results).toHaveLength(0)
  })
  it('a deleted canonical thread is terminal rather than retrying forever', async () => {
    const f = await fixture({ count: 1 }); f.pause()
    const pending = (await f.list()).body.results[0]
    expect((await f.click(pending)).status).toBe(202)
    f.deleted(); f.resume()
    await new Promise(r => setTimeout(r, 200))
    expect(f.calls).toHaveLength(0)
    expect((await (await f.click(pending)).json()).status).toBe('failed')
  })
  it('a temporary lease-read failure preserves the queued result for retry', async () => {
    const f = await fixture({ count: 1 }); f.pause()
    const pending = (await f.list()).body.results[0]
    expect((await f.click(pending)).status).toBe(202)
    f.failLease(true); f.resume()
    await new Promise(r => setTimeout(r, 150))
    expect(f.calls).toHaveLength(0)
    expect((await (await f.click(pending)).json()).status).toBe('queued')
    f.failLease(false); await settled(f, 1)
  })
  it('the endpoints are authenticated and arbitrary input is refused', async () => {
    const locked = await fixture({ count: 1, access: true })
    expect((await locked.list()).response.status).toBe(403)
    expect(locked.reads.filter(x => x.startsWith('/api/sessions'))).toHaveLength(0)
    const f = await fixture({ count: 1 }), r = (await f.list()).body.results[0]
    expect((await f.click(r, { input: 'run a different task' })).status).toBe(400)
    expect((await f.click({ ...r, session_id: 'wizard_other' })).status).toBe(409)
    expect(f.calls).toHaveLength(0)
  })
  it('one broken history read leaves another thread recoverable and reports the partial scan honestly', async () => {
    const f = await fixture({ count: 2 }); f.badHistory.add('wizard_manual_0')
    const result = (await f.list()).body
    expect(result.scan_complete).toBe(false)
    expect(result.available).toBe(true)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].session_id).toBe('wizard_manual_1')
    expect((await f.click(result.results[0])).status).toBe(202)
    await settled(f, 1)
    expect(f.calls[0].session_id).toBe('wizard_manual_1')
  })
  it('an upstream history permission failure is temporary503, never a misleading Wizard sign-in prompt', async () => {
    const f = await fixture({ count: 1 }), pending = (await f.list()).body.results[0]
    f.denyHistory()
    expect((await f.click(pending)).status).toBe(503)
    expect(f.calls).toHaveLength(0)
    f.failHistory(false)
    expect((await f.click(pending)).status).toBe(202)
    await settled(f, 1)
  })
  it('a legacy result listed through both root and tip has one stable recovery identity', async () => {
    const f = await fixture({ count: 1 })
    f.rows.get('wizard_manual_0')![1].content = '[ASYNC DELEGATION BATCH COMPLETE] Legacy saved result.'
    f.rows.set('live_tip_0', f.rows.get('wizard_manual_0')!)
    f.sessions.push({ ...f.sessions[0], id: 'live_tip_0', _lineage_root_id: 'wizard_manual_0' })
    const initial = (await f.list()).body.results
    expect(initial).toHaveLength(1)
    f.advance(1000)
    const next = (await f.list()).body.results
    expect(next).toHaveLength(1)
    expect(next[0].id).toBe(initial[0].id)
    expect((await f.click(initial[0])).status).toBe(202)
    await settled(f, 1)
  })
  it('a newer image-only human reply is authoritative even with no text content', async () => {
    const f = await fixture({ count: 1 }), pending = (await f.list()).body.results[0]
    f.rows.get('wizard_manual_0')!.push({ id: 3, role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }], timestamp: f.at })
    expect((await f.click(pending)).status).toBe(409)
    expect(f.calls).toHaveLength(0)
  })
  it('a visible dropped receipt is really read and explicitly continued through the durable queue', async () => {
    const f = await fixture({ count: 1, history: true }); f.receipt('wizard_manual_0')
    const result = (await f.list()).body
    expect(result.scan_complete).toBe(true)
    expect(result.results).toHaveLength(2)
    const transcript = result.results.find((r: any) => r.id === (result.results[0].id))
    // The receipt and transcript have different delegation identities. Their order follows discovery.
    const receipt = result.results[1]
    expect(receipt.id).not.toBe(transcript.id)
    expect((await f.click(receipt)).status).toBe(202)
    await settled(f, 1)
    expect(f.calls[0].input).toContain('[Wizard follow-through] Recovered helper receipt deleg_saved_receipt\n')
    expect(f.calls[0].input).toContain('Saved receipt fixture findings.')
    expect(f.calls[0].session_id).toBe('wizard_manual_0')
  })
  it('object tool payload consumption prevents an already-collected result being offered twice', async () => {
    const f = await fixture({ count: 1 }), pending = (await f.list()).body.results[0]
    f.rows.get('wizard_manual_0')!.push({ id: 3, role: 'tool', content: { delegation_id: 'deleg_manual_0', results: [{ summary: 'Already collected' }] }, timestamp: f.at })
    f.sessions[0].message_count += 1
    f.advance(1000)
    expect((await f.list()).body.results).toHaveLength(0)
    expect((await f.click(pending)).status).toBe(409)
    expect(f.calls).toHaveLength(0)
  })
  it('one unreadable dropped-receipt thread cannot hide a valid transcript result', async () => {
    const f = await fixture({ count: 2, history: true }); f.receipt('wizard_manual_1'); f.badHistory.add('wizard_manual_1')
    const result = (await f.list()).body
    expect(result.available).toBe(true)
    expect(result.scan_complete).toBe(false)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].session_id).toBe('wizard_manual_0')
    expect(f.calls).toHaveLength(0)
  })
  it('a hidden thread receipt does not bypass the owner visibility filter', async () => {
    const f = await fixture({ count: 2, history: true }); f.receipt('wizard_manual_0'); f.sessions[0].hidden = true
    const result = (await f.list()).body
    expect(result.results).toHaveLength(1)
    expect(result.results[0].session_id).toBe('wizard_manual_1')
    expect(f.calls).toHaveLength(0)
  })
  it('a click-time lease read error is retryable503 and starts no model', async () => {
    const f = await fixture({ count: 1 }), pending = (await f.list()).body.results[0]
    f.failLease(true)
    expect((await f.click(pending)).status).toBe(503)
    expect(f.calls).toHaveLength(0)
    f.failLease(false)
    expect((await f.click(pending)).status).toBe(202)
    await settled(f, 1)
  })
})

// Review of 0a12f43 (manual Continue skips the automatic 2 h helper check): the skip's authority is the
// service-written queue continuation, never the body marker a client could send.
describe('manual Continue authority: only the service can mark a run as an owner Continue', () => {
  const queueRow = (f: any) => {
    const db = new DatabaseSync(f.queuePath)
    try { return db.prepare('SELECT status, continuation_json, idempotency_key FROM wizard_run_queue').all() as any[] } finally { db.close() }
  }
  const clientRun = (f: any, raw: string, key: string) => fetch(`${f.base()}/wizard/hermes/v1/runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: raw })
  it('a client run carrying the reserved marker is refused at admission, including duplicate-key JSON', async () => {
    const f = await fixture({ count: 1 }), r = (await f.list()).body.results[0]
    const marker = { id: r.id, source_kind: 'transcript', read_id: r.session_id, boundary: '1', at: 9e12, delegation_id: '', message_id: '' }
    expect((await clientRun(f, JSON.stringify({ session_id: r.session_id, input: 'x', _wizard_background_recovery: marker }), 'wizard-helper-receipt-deleg_manual_0')).status).toBe(400)
    const dup = `{"session_id":"${r.session_id}","input":"x","_wizard_background_recovery":null,"_wizard_background_recovery":${JSON.stringify(marker)}}`
    expect((await clientRun(f, dup, 'client-dup-key')).status).toBe(400)
    await new Promise(r => setTimeout(r, 150))
    expect(queueRow(f)).toHaveLength(0)
    expect(f.calls).toHaveLength(0)
  })
  it('a client run spoofing a helper idempotency key is cancelled at dispatch and never reaches Hermes', async () => {
    const f = await fixture({ count: 1 })
    expect((await clientRun(f, JSON.stringify({ session_id: 'wizard_manual_0', input: 'pretend helper' }), 'wizard-helper-receipt-deleg_manual_0')).status).toBe(202)
    const deadline = Date.now() + 3000
    while (queueRow(f)[0]?.status !== 'cancelled' && Date.now() < deadline) await new Promise(r => setTimeout(r, 25))
    expect(queueRow(f)[0].status).toBe('cancelled')
    expect(f.calls).toHaveLength(0)
  })
  it('the service records its own continuation for an owner Continue', async () => {
    const f = await fixture({ count: 1 }); f.pause()
    const r = (await f.list()).body.results[0]
    expect((await f.click(r)).status).toBe(202)
    expect(JSON.parse(queueRow(f)[0].continuation_json)).toEqual({ kind: 'background-recovery', id: r.id, session_id: r.session_id })
  })
  it('a queued record whose body carries the marker without the service continuation never dispatches', async () => {
    const f = await fixture({ count: 1 }); f.pause()
    const r = (await f.list()).body.results[0]
    expect((await f.click(r)).status).toBe(202)
    await f.close()
    const db = new DatabaseSync(f.queuePath)
    db.prepare("UPDATE wizard_run_queue SET continuation_json = 'null'").run()
    db.close()
    f.resume(); await f.open()
    const deadline = Date.now() + 3000
    while (queueRow(f)[0]?.status !== 'cancelled' && Date.now() < deadline) await new Promise(r => setTimeout(r, 25))
    // Receipt key without a service continuation: the ordinary helper check refuses it (410 -> cancelled).
    expect(queueRow(f)[0].status).toBe('cancelled')
    expect(f.calls).toHaveLength(0)
  })
  it('a service continuation that does not match the body marker fails closed', async () => {
    const f = await fixture({ count: 1 }); f.pause()
    const r = (await f.list()).body.results[0]
    expect((await f.click(r)).status).toBe(202)
    await f.close()
    const db = new DatabaseSync(f.queuePath)
    db.prepare('UPDATE wizard_run_queue SET continuation_json = ?').run(JSON.stringify({ kind: 'background-recovery', id: 'bg_' + '0'.repeat(32), session_id: r.session_id }))
    db.close()
    f.resume(); await f.open()
    const deadline = Date.now() + 3000
    while (queueRow(f)[0]?.status !== 'failed' && Date.now() < deadline) await new Promise(r => setTimeout(r, 25))
    expect(queueRow(f)[0].status).toBe('failed')
    expect(f.calls).toHaveLength(0)
  })
  it('a Continue left launching by a restart is validated and dispatched once, not cancelled', async () => {
    const f = await fixture({ count: 1 }); f.pause()
    const r = (await f.list()).body.results[0]
    expect((await f.click(r)).status).toBe(202)
    await f.close()
    const db = new DatabaseSync(f.queuePath)
    db.prepare("UPDATE wizard_run_queue SET status = 'launching'").run()
    db.close()
    f.resume(); await f.open()
    await settled(f, 1)
    expect(f.calls[0].session_id).toBe('wizard_manual_0')
    expect(f.calls[0].input).toContain('owner pressed Continue')
    expect(f.calls[0]).not.toHaveProperty('_wizard_background_recovery')
  })
})
