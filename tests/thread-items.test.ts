// Thread tracker (owner tweak, off by default): item ledger, counts, seen marks, and quote-reply expansion.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scene, post, owner } from '../qa/agent-parity/fixture.mjs'
import { parseStatus, projectStatusMarkers } from '../server/thread-status.mjs'
import { ThreadItemStore, countItems, normalizeItems, trackerEnabled, parseReplyTo, expandReplyTo, expandReplyToInput, ITEMS_INSTRUCTIONS, TRACKER_TWEAK } from '../server/thread-items.mjs'

const dirs: string[] = []
const api = (s: any, path: string, init: any = {}) => fetch(`${s.origin()}${path}`, { ...init, headers: { ...owner, ...init.headers } })
afterEach(() => { dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'thread-items-')); dirs.push(d); return d }
const tag = (o: object) => `[WIZARD_STATUS_V1]${JSON.stringify(o)}[/WIZARD_STATUS_V1]`
const item = (id: string, state: string, title = id) => ({ id, title, state })

const runs = async (tracker: boolean | undefined) => {
  const d = tmp()
  const s: any = await scene('main', { threadItemsStatePath: join(d, 'items.json'), ...(tracker === undefined ? {} : { threadTracker: tracker }) })
  s.sessions.set('t1', { id: 't1', source: 'wizard-mobile', title: 'T', created_at: Date.now() / 1000 - 60, messages: [] })
  return { s, d }
}

describe('items in the status line', () => {
  it('are parsed, normalised and capped; malformed ones are dropped without losing the status', () => {
    const status = parseStatus(`Done.\n${tag({ state: 'done', ask: 'x', items: [item('Voice Notes', 'Done', 'Voice notes stuck at bottom'), { id: '', title: 'x', state: 'done' }, 5, null, item('ok', 'nonsense'), item('t', 'needs you'), { id: 'long', title: 'y'.repeat(90), state: 'running' }] })}`)
    expect(status.state).toBe('done')
    expect(status.items).toEqual([
      { id: 'voice-notes', title: 'Voice notes stuck at bottom', state: 'done' },
      { id: 't', title: 't', state: 'needs_you' },
      { id: 'long', title: `${'y'.repeat(39)}…`, state: 'running' },
    ])
    expect(parseStatus(tag({ state: 'done', ask: 'x', items: 'nope' })).items).toBeUndefined()
    expect(parseStatus(tag({ state: 'done', ask: 'x' }))).toEqual({ state: 'done', ask: 'x' }) // no items key at all
    expect(normalizeItems(Array.from({ length: 30 }, (_, i) => item(`a${i}`, 'done'))).length).toBe(12)
  })
  it('never show in message history', () => {
    const out = projectStatusMarkers(Buffer.from(JSON.stringify({ data: [{ role: 'assistant', content: `Hi\n${tag({ state: 'done', ask: 'x', items: [item('a', 'done')] })}` }] }))).toString()
    expect(out).not.toContain('items')
  })
})

describe('the ledger', () => {
  it('counts current reply anchors, keeps per-ask custody, and moves changed asks into their new reply', () => {
    let clock = 1_700_000_500_000
    const store: any = new ThreadItemStore('', { now: () => clock })
    store.ingest('hermes', 'group', { items: [item('a', 'done'), item('b', 'needs_you'), item('c', 'blocked')], at: 1_700_000_100, messageId: 'reply-1' })
    expect(store.list('hermes', 'group')).toHaveLength(3)
    expect(store.counts('hermes', 'group')).toEqual({ total: 1, blocked: 1, needs_you: 0, running: 0, done_unseen: 0, acknowledged: 0 })
    expect(store.allCounts()['hermes/group']).toEqual(store.counts('hermes', 'group'))
    store.markSeen('hermes', 'group', ['a', 'b'])
    expect(store.counts('hermes', 'group')).toMatchObject({ total: 1, blocked: 1, acknowledged: 0 })
    store.markSeen('hermes', 'group', ['a', 'b', 'c'])
    expect(store.counts('hermes', 'group')).toMatchObject({ total: 1, acknowledged: 1, blocked: 0 })
    clock += 1_000_000
    store.ingest('hermes', 'group', { items: [item('c', 'needs_you')], at: 1_700_001_000, messageId: 'reply-2' })
    expect(store.counts('hermes', 'group')).toMatchObject({ total: 2, needs_you: 1, acknowledged: 1 })
    expect(store.list('hermes', 'group').find((i: any) => i.id === 'c')).toMatchObject({ message_id: 'reply-2', seen: false })
  })
  it('uses blocked > needs-you > running > finished-unseen > acknowledged and never groups unknown anchors', () => {
    const base = { seen_at: 0, updated_at: 10, message_id: 'm' }
    for (const [states, kind] of [
      [['done', 'running', 'needs_you', 'blocked'], 'blocked'],
      [['done', 'running', 'needs_you'], 'needs_you'],
      [['done', 'running'], 'running'], [['done', 'done'], 'done_unseen'],
    ] as const) expect(countItems(states.map((state, n) => ({ ...base, id: `a${n}`, state })))).toMatchObject({ total: 1, [kind]: 1 })
    const bad = [null, undefined, '', ' ', {}, [], true]
    expect(countItems(bad.map((message_id, n) => ({ ...base, id: `b${n}`, state: 'done', message_id })))).toMatchObject({ total: bad.length, done_unseen: bad.length })
    expect(countItems([{ ...base, state: 'done', message_id: 42 }, { ...base, state: 'running', message_id: '42' }])).toMatchObject({ total: 1, running: 1 })
  })
  it('keeps the latest state per id, anchors on the latest reply, ignores older or repeated replies', () => {
    const store = new ThreadItemStore('', { now: () => 5_000_000 })
    expect(store.ingest('hermes', 't1', { items: [item('a', 'running', 'Fix voice'), item('b', 'needs_you', 'Pick colour')], at: 100, messageId: '11' })).toBe(true)
    expect(store.ingest('hermes', 't1', { items: [item('a', 'done', 'Fix voice')], at: 200, messageId: '12' })).toBe(true)
    expect(store.ingest('hermes', 't1', { items: [item('a', 'running')], at: 150, messageId: '99' })).toBe(false) // older
    const by = Object.fromEntries(store.list('hermes', 't1').map((i: any) => [i.id, i]))
    expect(by.a).toMatchObject({ state: 'done', message_id: '12', created_at: 100_000, updated_at: 200_000 })
    expect(by.b).toMatchObject({ state: 'needs_you', message_id: '11' })
    // a restatement with no change keeps its anchor and its Seen mark
    store.markSeen('hermes', 't1', ['a'])
    expect(store.ingest('hermes', 't1', { items: [item('a', 'done', 'Fix voice')], at: 300, messageId: '13' })).toBe(false)
    expect(store.list('hermes', 't1').find((i: any) => i.id === 'a')).toMatchObject({ message_id: '12', seen: true })
    // an unseen anchor id fills in when the same reply is read again with its message id
    store.ingest('hermes', 't2', { items: [item('x', 'done')], at: 10 })
    expect(store.list('hermes', 't2')[0].message_id).toBeNull()
    store.ingest('hermes', 't2', { items: [item('x', 'done')], at: 10, messageId: '7' })
    expect(store.list('hermes', 't2')[0].message_id).toBe('7')
  })
  it('"Looks good" on a try-it ask acknowledges it; a plain needs-you ask stays', () => {
    const store = new ThreadItemStore('', { now: () => 1_700_000_500_000 })
    store.ingest('hermes', 'try', { items: [item('a', 'needs_you'), item('b', 'needs_you')], at: 1_700_000_100, tryIt: true })
    store.ingest('hermes', 'try', { items: [item('c', 'needs_you')], at: 1_700_000_101 })
    expect(store.counts('hermes', 'try')).toMatchObject({ needs_you: 3, acknowledged: 0 })
    store.markSeen('hermes', 'try', ['a', 'c'])
    expect(store.counts('hermes', 'try')).toMatchObject({ needs_you: 2, acknowledged: 1 })
  })
  it('counts needs-you, running, finished-unseen and acknowledged, per thread and for every thread', () => {
    let clock = 1_700_000_150_000
    const store = new ThreadItemStore('', { now: () => clock })
    store.ingest('hermes', 't', { items: [item('a', 'running'), item('b', 'needs_you'), item('c', 'needs_you'), item('d', 'done'), item('e', 'done'), item('f', 'blocked')], at: 1_700_000_100 })
    expect(store.counts('hermes', 't')).toEqual({ needs_you: 2, running: 1, done_unseen: 2, blocked: 1, acknowledged: 0, total: 6 })
    expect(store.markSeen('hermes', 't', ['d', 'nope', 'a'])).toBe(true)
    expect(store.counts('hermes', 't')).toMatchObject({ done_unseen: 1, acknowledged: 1 })
    expect(store.markSeen('hermes', 't', ['d'])).toBe(false)
    // a later update to a seen ask is unseen again
    clock = 1_700_000_900_000
    store.ingest('hermes', 't', { items: [item('d', 'running')], at: 1_700_000_200 })
    store.ingest('hermes', 't', { items: [item('d', 'done')], at: 1_700_000_300 })
    expect(store.list('hermes', 't').find((i: any) => i.id === 'd').seen).toBe(false)
    expect(store.list('hermes', 't').find((i: any) => i.id === 'e').seen).toBe(false)
    expect(store.list('hermes', 't').find((i: any) => i.id === 'd').seen).toBe(false)
    expect(Object.keys(store.allCounts())).toEqual(['hermes/t'])
  })
  it('survives a restart, an unreadable file, and rejects hostile thread ids', () => {
    const path = join(tmp(), 'items.json')
    const a = new ThreadItemStore(path, { now: () => 1 })
    a.ingest('hermes', 't', { items: [item('a', 'done')], at: 5, messageId: 'm' })
    a.markSeen('hermes', 't', ['a'])
    expect(new ThreadItemStore(path).list('hermes', 't')[0]).toMatchObject({ id: 'a', seen: true, message_id: 'm' })
    expect(a.ingest('hermes', '../x', { items: [item('a', 'done')], at: 5 })).toBe(false)
    expect(a.ingest('Bad Agent', 't', { items: [item('a', 'done')], at: 5 })).toBe(false)
    expect(JSON.parse(readFileSync(path, 'utf8')).schema).toBe(1)
  })
})

describe('the gate', () => {
  it('reads the synced Look file: only an explicit ON counts', () => {
    expect(TRACKER_TWEAK).toBe('wizard/thread-tracker')
    expect(trackerEnabled(JSON.stringify({ version: 1, tweaks: { [TRACKER_TWEAK]: { on: true, at: 3 } } }))).toBe(true)
    expect(trackerEnabled(JSON.stringify({ version: 1, tweaks: { [TRACKER_TWEAK]: { on: false, at: 3 } } }))).toBe(false)
    for (const bad of ['', 'not json', '{}', JSON.stringify({ version: 2, tweaks: { [TRACKER_TWEAK]: { on: true } } }), undefined, null]) expect(trackerEnabled(bad as any)).toBe(false)
  })
  it('adds the agent instruction and the current asks only when the tweak is on', async () => {
    for (const on of [false, undefined]) {
      const { s } = await runs(on)
      try {
        expect((await s.request('/v1/runs', post({ session_id: 't1', input: 'hello' }))).status).toBe(202)
        const sent = s.seen.filter((r: any) => r.method === 'POST' && r.path.endsWith('/v1/runs')).at(-1)
        expect(sent.body.instructions).not.toContain('Thread tracker')
        expect(sent.body.instructions).not.toContain('"items"')
      } finally { await s.close() }
    }
    const { s } = await runs(true)
    try {
      expect((await s.request('/v1/runs', post({ session_id: 't1', input: 'hello' }))).status).toBe(202)
      const sent = s.seen.filter((r: any) => r.method === 'POST' && r.path.endsWith('/v1/runs')).at(-1)
      expect(sent.body.instructions).toContain(ITEMS_INSTRUCTIONS)
    } finally { await s.close() }
  }, 30_000)
})

describe('the counts, items and seen endpoints', () => {
  it('serve one ledger to every device, read it back from the thread history, and keep Seen', async () => {
    const { s, d } = await runs(true)
    try {
      s.sessions.get('t1').messages = [
        { id: 41, role: 'user', timestamp: 1_700_000_000, content: 'fix a and b' },
        { id: 42, role: 'assistant', timestamp: 1_700_000_100, content: `Both.\n${tag({ state: 'check', ask: 'Try it', items: [item('a', 'needs_you', 'Fix a'), item('b', 'running', 'Fix b')] })}` },
        { id: 43, role: 'assistant', timestamp: 1_700_000_200, content: `A is in.\n${tag({ state: 'done', ask: 'done', items: [item('a', 'done', 'Fix a')] })}` },
      ]
      expect((await s.request('/api/sessions/t1/messages?view=wizard&limit=50')).status).toBe(200)
      const raw = await api(s, '/wizard/v1/thread-items?thread=t1'); const list = await raw.json(); 
      expect(list.items.map((i: any) => [i.id, i.state, i.message_id])).toEqual([['a', 'done', '43'], ['b', 'running', '42']])
      expect(list.counts).toMatchObject({ running: 1, done_unseen: 1, total: 2 })
      expect((await (await api(s, '/wizard/v1/thread-items/counts')).json()).threads['hermes/t1']).toMatchObject({ running: 1, done_unseen: 1 })
      const seen = await (await api(s, '/wizard/v1/thread-items/seen', post({ thread: 't1', ids: ['a'] }))).json()
      expect(seen.counts).toMatchObject({ done_unseen: 0, acknowledged: 1 })
      // a second device sees the same, and so does a restart of the same file
      expect((await (await api(s, '/wizard/v1/thread-items?thread=t1')).json()).items.find((i: any) => i.id === 'a').seen).toBe(true)
      expect(JSON.parse(readFileSync(join(d, 'items.json'), 'utf8')).threads['hermes/t1'].items.a.seen_at).toBeGreaterThan(0)
      expect((await api(s, '/wizard/v1/thread-items?thread=..%2Fx')).status).toBe(400)
      expect((await api(s, '/wizard/v1/thread-items/seen', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).not.toBe(200)
    } finally { await s.close() }
  }, 30_000)
})

describe('quote reply', () => {
  const block = (o: object) => `[WIZARD_REPLY_TO_V1]${JSON.stringify(o)}[/WIZARD_REPLY_TO_V1]`
  it('parses the marker and ignores malformed ones', () => {
    expect(parseReplyTo(`${block({ message_id: 42, item: 'voice-notes', excerpt: ' It is  fixed ' })}\nthanks`)).toEqual({ message_id: '42', item: 'voice-notes', excerpt: 'It is fixed' })
    expect(parseReplyTo('[WIZARD_REPLY_TO_V1]{nope[/WIZARD_REPLY_TO_V1]')).toBeNull()
    expect(parseReplyTo(block({ item: 'Bad Id!' }))).toBeNull()
    expect(parseReplyTo('plain')).toBeNull()
  })
  it('gives the model a plain sentence with the ask title and excerpt, once', () => {
    const out = expandReplyTo(`${block({ message_id: '42', item: 'voice-notes', excerpt: 'It is "fixed" [now]' })}\nlooks wrong`, id => (id === 'voice-notes' ? 'Voice notes stuck' : ''))
    expect(out).toContain('Replying to an earlier message about “Voice notes stuck”: "It is ”fixed” (now)"')
    expect(out).toContain('\nlooks wrong')
    expect(expandReplyTo(out, () => 'other')).toBe(out)
    expect(expandReplyTo('no marker', () => '')).toBe('no marker')
    expect(expandReplyToInput([{ type: 'text', text: block({ excerpt: 'hi' }) }, { type: 'image' }], () => '')[0].text).toContain('Replying to an earlier message: "hi"')
  })
  it('reaches the model input for a new run and for a mid-turn steer', async () => {
    const { s } = await runs(true)
    try {
      // the ledger knows the ask title
      const store = new ThreadItemStore(join(tmp(), 'x.json'))
      expect(store).toBeTruthy()
      s.sessions.get('t1').messages = [{ id: 1, role: 'assistant', timestamp: 1_700_000_100, content: `ok\n${tag({ state: 'done', ask: 'x', items: [item('voice-notes', 'done', 'Voice notes stuck')] })}` }]
      await s.request('/api/sessions/t1/messages?view=wizard&limit=50')
      const marker = block({ message_id: '1', item: 'voice-notes', excerpt: 'Voice notes work now' })
      expect((await s.request('/v1/runs', post({ session_id: 't1', input: `${marker}\nstill broken` }))).status).toBe(202)
      const sent = s.seen.filter((r: any) => r.method === 'POST' && r.path.endsWith('/v1/runs')).at(-1)
      expect(sent.body.input).toContain('Replying to an earlier message about “Voice notes stuck”: "Voice notes work now"')
      expect(sent.body.input).toContain('still broken')
      // the same quote sent as a mid-turn steer reaches the running agent expanded too
      s.sessions.set('t2', { id: 't2', source: 'wizard-mobile', title: 'T2', created_at: Date.now() / 1000 - 60, messages: s.sessions.get('t1').messages })
      await s.request('/api/sessions/t2/messages?view=wizard&limit=50')
      const started = await (await s.request('/v1/runs', post({ session_id: 't2', input: 'go' }))).json()
      let steered: any
      for (let i = 0; i < 60 && !steered; i++) {
        const res = await s.request(`/v1/runs/${started.run_id}/steer`, post({ input: `${marker}\nand also this` }))
        const reached = s.seen.find((r: any) => /\/steer$/.test(r.path))
        if (res.status < 400 && reached) steered = reached
        else await new Promise(r => setTimeout(r, 50))
      }
      expect(steered?.body.input).toContain('Replying to an earlier message about “Voice notes stuck”: "Voice notes work now"')
      expect(steered.body.input).toContain('and also this')
    } finally { await s.close() }
  }, 30_000)
  it('asks the agent to list every ask, including answered questions (James, 6 Nov: a quick LINE question was never listed)', () => {
    expect(ITEMS_INSTRUCTIONS).not.toMatch(/Optionally add/u)
    expect(ITEMS_INSTRUCTIONS).not.toMatch(/quick answers/u)
    expect(ITEMS_INSTRUCTIONS).toMatch(/a question you answer is an ask in state done/u)
    expect(ITEMS_INSTRUCTIONS).toMatch(/mid-turn additions/u)
  })
})
