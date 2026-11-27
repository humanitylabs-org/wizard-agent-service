// Issue 607: the Sent log. One row per capture, written before the router runs; the owner's reply rules; fallback to
// a visible thread when the router is missing, fails or is unsure; typed first messages keep would_route; the nightly
// check flags rows with no final state. Switch off (wizard/agent-inbox): no row, every Sent route is 404.
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SentLog, SENT_FINAL_MS, SENT_LINK_MS, SENT_REPEAT_MS } from '../server/sent-log.mjs'
import { replyRules, routeUtterance, taskWords } from '../server/voice-router.mjs'
import { AgentInboxStore } from '../server/agent-inbox.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

const dirs: string[] = [], servers: any[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(r))))
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }))
})
const home = () => { const d = mkdtempSync(join(tmpdir(), 'sent-log-')); dirs.push(d); return d }
const clock = (start = Date.parse('2026-11-25T10:00:00Z')) => { const c = { at: start, now: () => c.at }; return c }

describe('reply rules (whole phrases the owner says to the Wizard)', () => {
  const intent = (t: string) => replyRules(t).intent
  it('no-reply phrases come first and mean background', () => {
    for (const t of ['Note to self call mom', 'note to self: call mom', 'Note: the car needs gas', 'No reply, book the dentist', 'Book the dentist, no reply needed', 'Just do it: clean up my downloads', 'Sort out the insurance, just do it'])
      expect([t, intent(t)]).toEqual([t, 'dump'])
    expect(replyRules('Note to self call mom').rules[0]).toBe('no_reply:note to self')
    // Before a wants-reply word in the same take.
    expect(intent('Note to self: tell me about it later')).toBe('dump')
  })
  it('wants-reply phrases and short questions keep a visible thread', () => {
    for (const t of ['Research flights to Lisbon and reply', 'Look into flights, tell me what you find', 'Answer me this: is it raining', "Let's talk about the trip", 'Walk me through the budget', 'Explain to me how solar works', 'What time is it in Tokyo?', 'reply to me when done', 'Research flights and keep replying with updates', 'Look into it and send me replies as you go'])
      expect([t, intent(t)]).toEqual([t, 'agent'])
  })
  it('words inside a task are never a reply rule', () => {
    expect(intent('Draft a reply to Sam')).toBe('dump')
    expect(replyRules('Draft a reply to Sam').rules).toEqual(['task_verb'])
    for (const t of ['Reply to Sam saying yes', 'Check why there is no reply from Sam', 'Send a reply to the landlord'])
      expect(replyRules(t).rules.some(r => r.startsWith('wants_reply') || r.startsWith('no_reply'))).toBe(false)
  })
  it('urgent / priority and tags', () => {
    expect(replyRules('Urgent: call the bank about the card')).toMatchObject({ urgent: true, rules: ['urgent:urgent'] })
    expect(replyRules('Sort out the car insurance, high priority')).toMatchObject({ urgent: true, intent: 'dump' })
    expect(replyRules('What is my priority list for today?').urgent).toBe(false)
    expect(replyRules('Plan the trip #travel hashtag Lisbon')).toMatchObject({ tags: ['travel', 'lisbon'], intent: 'dump' })
    expect(taskWords('Note to self call mom #family')).toBe('call mom')
  })
})

describe('routeUtterance: how a take is decided', () => {
  const router = { url: 'http://router.test/v1/chat/completions', model: 'fast' }
  const answering = (content: any, calls: any[] = []) => async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] })) }
  it('no-reply words dump without asking the model, also with no router', async () => {
    const calls: any[] = []
    const r = await routeUtterance({ input: { text: 'Note to self call mom' }, settings: {}, router: null, fetchImpl: answering({ route: 'agent' }, calls), dump: true })
    expect(r.cmd).toMatchObject({ route: 'dump', title: 'Call mom' })
    expect(r.why).toMatchObject({ decided_by: 'owner_words', rules: ['no_reply:note to self'] })
    expect(calls).toHaveLength(0)
  })
  it('the model says unsure: a visible thread, decided by fallback, with its confidence', async () => {
    const r = await routeUtterance({ input: { text: 'Sam and the garden thing' }, settings: {}, router, fetchImpl: answering({ route: 'unsure', confidence: 0.3 }), dump: true })
    expect(r.cmd.route).toBe('agent')
    expect(r.why).toMatchObject({ decided_by: 'fallback', rules: ['unsure'], confidence: 0.3 })
  })
  it('the model answers nothing usable: fallback, a visible thread', async () => {
    const r = await routeUtterance({ input: { text: 'Sam and the garden thing' }, settings: {}, router, fetchImpl: answering({ nonsense: 1 }), dump: true })
    expect([r.cmd.route, r.why.decided_by]).toEqual(['agent', 'fallback'])
  })
  it('an earlier correction of the same words wins over the task heuristics, never over his reply words', async () => {
    const correction = { id: 'ex_0123456789abcdef', wanted: 'agent' }
    const r = await routeUtterance({ input: { text: 'Research a new phone' }, settings: {}, router, fetchImpl: answering({ route: 'dump' }), dump: true, correction })
    expect([r.cmd.route, r.why.decided_by, r.why.correction_id]).toEqual(['agent', 'correction', 'ex_0123456789abcdef'])
    const quiet = await routeUtterance({ input: { text: 'Research a new phone, no reply' }, settings: {}, router, fetchImpl: answering({ route: 'agent' }), dump: true, correction })
    expect(quiet.cmd.route).toBe('dump')
  })
  it('the model decides when the words do not; a router that hangs past the timeout throws', async () => {
    const r = await routeUtterance({ input: { text: 'The insurance thing with the car' }, settings: {}, router, fetchImpl: answering({ route: 'dump', title: 'Car insurance', confidence: 0.9 }), dump: true })
    expect([r.cmd.route, r.why.decided_by, r.why.confidence]).toEqual(['dump', 'model', 0.9])
    const hang = (_u: string, init: any) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    await expect(routeUtterance({ input: { text: 'The insurance thing' }, settings: {}, router, fetchImpl: hang as any, dump: true, timeoutMs: 20 })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(routeUtterance({ input: { text: 'The insurance thing' }, settings: {}, router: null, dump: true })).rejects.toMatchObject({ status: 404 })
  })
})

describe('the Sent log store', () => {
  it('one row per capture, newest first, paged; the same key or the same words within a minute is one row', () => {
    const c = clock(), log = new SentLog('', { now: c.now })
    const a = log.open({ text: 'Book the dentist', idempotency_key: 'take-1' }).row
    expect(log.open({ text: 'Book the dentist', idempotency_key: 'take-1' })).toMatchObject({ created: false, row: { id: a.id } })
    c.at += 1000
    const b = log.open({ text: 'Call mom' }).row
    expect(log.open({ text: 'call mom.' }).row.id).toBe(b.id)
    c.at += SENT_REPEAT_MS
    const b2 = log.open({ text: 'Call mom' }).row
    expect(b2.id).not.toBe(b.id)
    expect(log.list().rows.map(r => r.id)).toEqual([b2.id, b.id, a.id])
    expect(log.list({ limit: 1, before: b2.id })).toEqual({ rows: [expect.objectContaining({ id: b.id })], next: b.id })
    expect(() => log.open({ text: '  ' })).toThrow()
    expect(log.finish(a.id, { route: 'dump', decided_by: 'owner_words', rules: ['no_reply:note'], record_id: 'inbox_0123456789abcdef01234567', confidence: 2 }))
      .toMatchObject({ route: 'dump', decided_by: 'owner_words', record_id: 'inbox_0123456789abcdef01234567' })
    expect(log.get(a.id).confidence).toBeUndefined()
  })

  it('a new thread links to the orb row with the same words; otherwise it is a typed row', () => {
    const c = clock(), log = new SentLog('', { now: c.now })
    const orb = log.open({ text: 'Walk me through the budget' }).row
    log.finish(orb.id, { route: 'agent', decided_by: 'owner_words' })
    c.at += 1000
    expect(log.linkTurn({ thread: 'wizard_t1', text: 'Walk me through the budget', run_key: 'k1' })).toMatchObject({ id: orb.id, thread_id: 'wizard_t1', run_key: 'k1' })
    expect(log.linkTurn({ thread: 'wizard_t2', text: 'Walk me through the budget' })).toBeNull()
    // Only exactly the same words link: a longer first message is a capture of its own.
    const orb2 = log.open({ text: 'Plan the trip' }).row
    log.finish(orb2.id, { route: 'agent' })
    expect(log.linkTurn({ thread: 'wizard_t4', text: 'Plan the trip to Porto next year' })).toBeNull()
    const late = log.open({ text: 'Plan dinner' }).row
    log.finish(late.id, { route: 'agent' })
    c.at += SENT_LINK_MS
    expect(log.linkTurn({ thread: 'wizard_t3', text: 'Plan dinner' })).toBeNull()
    const typed = log.typed({ thread: 'wizard_t3', text: 'Plan dinner', run_key: 'k3' })
    expect(typed).toMatchObject({ source: 'typed', route: 'agent', decided_by: 'owner_words', rules_matched: ['typed'], thread_id: 'wizard_t3' })
    expect(log.typed({ thread: 'wizard_t3', text: 'Plan dinner' })?.id).toBe(typed?.id)
  })

  it('issue 707: a spoken new chat (its recording rides as a file block) links to the orb row with the same words', () => {
    const c = clock(), log = new SentLog('', { now: c.now })
    const orb = log.open({ text: 'Most of the UX changes I have ready' }).row
    log.finish(orb.id, { route: 'agent', decided_by: 'model' })
    c.at += 3000
    const block = '[WIZARD_FILES_V1]\n[{"id":"wf_1","filename":"wizard-voice.wav","trusted_path":"/files/Inbox/wizard-voice.wav"}]\n[/WIZARD_FILES_V1]'
    expect(log.linkTurn({ thread: 'wizard_v1', text: `Most of the UX changes I have ready\n\n${block}`, run_key: 'kv' }))
      .toMatchObject({ id: orb.id, source: 'orb', thread_id: 'wizard_v1', run_key: 'kv' })
    expect(log.all()).toHaveLength(1)
  })

  it('issue 707: an old orb row plus its spoken new_chat twin becomes one row linked to the chat, on load', () => {
    const dir = home(), path = join(dir, 'sent-log.json'), at = Date.parse('2026-11-27T11:56:00Z')
    const block = ' [WIZARD_FILES_V1] [{"id":"wf_2","trusted_path":"/files/Inbox/wizard-voice.wav"}] [/WIZARD_FILES_V1]'
    const base = { idempotency_key: null, rules_matched: [], model: '', tags: [], urgent: false, correction_id: null, record_id: null, routed_at: at }
    const rows = [
      // newest first, as the log keeps them
      { ...base, id: 'sent_ccccccccccccccccccccccc3', at: at + 60_000, source: 'typed', agent: 'hermes', text: 'Something typed', route: 'agent', thread_id: 'wizard_typed', run_key: 'kt' },
      { ...base, id: 'sent_bbbbbbbbbbbbbbbbbbbbbbb2', at: at + 3000, source: 'new_chat', agent: 'hermes', text: `Because our clips pipeline isn't running${block}`, route: 'agent', decided_by: 'owner_words', thread_id: 'wizard_1795780294769_da9122aea463', run_key: 'voice-1', notify_when_done: true,
        record_id: 'inbox_0123456789abcdef01234567', correction_id: 'ex_0123456789abcdef', corrected: { should_reply: false, at: at + 9000 } },
      { ...base, id: 'sent_aaaaaaaaaaaaaaaaaaaaaaa1', at, source: 'orb', agent: 'hermes', text: "Because our clips pipeline isn't running", route: 'agent', decided_by: 'model', thread_id: null, run_key: null },
      // a new_chat row with no orb twin keeps its row, without the file block
      { ...base, id: 'sent_ddddddddddddddddddddddd4', at: at - 3_600_000, source: 'new_chat', agent: 'hermes', text: `Untouched voice note${block}`, route: 'agent', thread_id: 'wizard_alone', run_key: 'k4' },
    ]
    writeFileSync(path, JSON.stringify({ schema: 1, rows, check: null }))
    const log = new SentLog(path)
    expect(log.all().map(r => [r.id, r.source, r.thread_id, r.text])).toEqual([
      ['sent_ccccccccccccccccccccccc3', 'typed', 'wizard_typed', 'Something typed'],
      ['sent_aaaaaaaaaaaaaaaaaaaaaaa1', 'orb', 'wizard_1795780294769_da9122aea463', "Because our clips pipeline isn't running"],
      ['sent_ddddddddddddddddddddddd4', 'new_chat', 'wizard_alone', 'Untouched voice note'],
    ])
    // A correction made on the chat's row before the upgrade moves with it (its inbox record and the example it taught).
    expect(log.get('sent_aaaaaaaaaaaaaaaaaaaaaaa1')).toMatchObject({ run_key: 'voice-1', notify_when_done: true,
      record_id: 'inbox_0123456789abcdef01234567', correction_id: 'ex_0123456789abcdef', corrected: { should_reply: false } })
    // Written back once, and a second load changes nothing.
    expect(JSON.parse(readFileSync(path, 'utf8')).rows).toHaveLength(3)
    expect(new SentLog(path).all()).toEqual(log.all())
  })

  it('the nightly check flags rows with no final state after 6 h, once a day; the log survives a restart', () => {
    const d = home(), path = join(d, 'sent-log.json'), c = clock(), logged: string[] = []
    const log = new SentLog(path, { now: c.now, log: m => logged.push(m) })
    const stuck = log.open({ text: 'Stuck one' }).row, fine = log.open({ text: 'Fine one' }).row
    c.at += SENT_FINAL_MS - 1
    expect(log.nightly(c.at, () => 'running')).toEqual({ at: c.at, unfinished: 0, rows: [] })
    expect(log.nightly(c.at + 1000, () => 'running')).toBeNull()
    c.at += 2 * 86400_000
    expect(log.nightly(c.at, r => r.id === fine.id ? 'done' : 'unknown')).toEqual({ at: c.at, unfinished: 1, rows: [stuck.id] })
    expect(logged).toHaveLength(1)
    const again = new SentLog(path, { now: c.now })
    expect(again.get(stuck.id)).toMatchObject({ flag: 'no_final_state' })
    expect(again.get(fine.id)).toMatchObject({ final_state: 'done' })
    expect(again.lastCheck()?.unfinished).toBe(1)
  })
})

describe('Sent log over HTTP', () => {
  async function start(d: string, extra: any = {}, routerMode: { mode: string } = { mode: 'agent' }) {
    const upstream = createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json')
        if (req.url?.startsWith('/router')) {
          if (routerMode.mode === 'throw') { res.statusCode = 500; res.end('{}'); return }
          res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ route: routerMode.mode, summary: 'x', title: 'Task' }) } }] })); return
        }
        res.statusCode = 404; res.end('{"error":"not_found"}')
      })
    })
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()))
    servers.push(upstream)
    const port = (upstream.address() as any).port
    writeFileSync(join(d, 'settings.json'), JSON.stringify({ fast_router: { endpoint: `http://127.0.0.1:${port}/router`, model: 'fast' } }))
    const s = createWizardServer({ wizardOsHome: d, settingsPath: join(d, 'settings.json'), requireAccess: false, hermesKey: 'test', agentBridge: false, followThrough: false,
      upstreamOrigin: `http://127.0.0.1:${port}`, runQueueStatePath: join(d, 'q.db'), runQueuePollIntervalMs: 0, agentInboxStatePath: join(d, 'agent-inbox.json'), ...extra })
    servers.push(s); const a: any = await listen(s)
    return { base: `http://127.0.0.1:${a.port}` }
  }
  const say = (base: string, text: string, extra = {}) => fetch(`${base}/wizard/v1/route`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, accept_dump: true, ...extra }) })

  it('WIZARD_AGENT_INBOX=0: routing is exactly as before, no row, every Sent route is 404', async () => {
    const d = home(), { base } = await start(d, { agentInbox: false })
    const r = await say(base, 'Note to self call mom')
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(Object.keys(body).sort()).toEqual(['cmd', 'model', 'ms'])
    expect(body.cmd.route).toBe('agent')
    for (const path of ['/wizard/v1/sent', '/wizard/v1/sent/sent_0123456789abcdef01234567']) expect((await fetch(`${base}${path}`)).status).toBe(404)
    expect((await fetch(`${base}/wizard/v1/sent/sent_0123456789abcdef01234567/correct`, { method: 'POST', body: '{"should_reply":true}' })).status).toBe(404)
    expect(existsSync(join(d, 'sent-log.json'))).toBe(false)
  })

  it('switch on: a router that throws leaves a fallback row; the answer keeps its status and names the row', async () => {
    const d = home(), mode = { mode: 'throw' }, { base } = await start(d, { agentInbox: true }, mode)
    const r = await say(base, 'Sam and the garden thing', { source: 'side', idempotency_key: 'take-7' })
    expect(r.status).toBe(502)
    const { sent_id } = await r.json()
    const row = (await (await fetch(`${base}/wizard/v1/sent/${sent_id}`)).json()).row
    expect(row).toMatchObject({ source: 'side', idempotency_key: 'take-7', text: 'Sam and the garden thing', route: 'agent', decided_by: 'fallback', rules_matched: ['router_error'], state: 'unknown' })
    // The row is on disk before anything else (a crash after this still leaves it).
    expect(JSON.parse(readFileSync(join(d, 'sent-log.json'), 'utf8')).rows[0].id).toBe(sent_id)
    expect((await fetch(`${base}/wizard/v1/sent`, { method: 'POST' })).status).toBe(405)
    expect((await fetch(`${base}/wizard/v1/sent/${sent_id}/correct`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(400)
    expect((await fetch(`${base}/wizard/v1/sent/sent_ffffffffffffffffffffffff/correct`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"should_reply":true}' })).status).toBe(404)
    const listed = await (await fetch(`${base}/wizard/v1/sent`)).json()
    expect(listed).toMatchObject({ rows: [{ id: sent_id }], next: null, check: null })
  })
})
