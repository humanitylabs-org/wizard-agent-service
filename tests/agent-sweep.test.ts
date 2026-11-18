// Issue 550: the signal sweep card (caps in code, no summary text, answers, Yes to all, ageing) and its history row.
import { describe, expect, it } from 'vitest'
import { AgentInboxStore } from '../server/agent-inbox.mjs'
import { cardMarkdown, isScheduledSweep, isSweepPhrase, withCardRow, DONE_CAP, WAITING_CAP } from '../server/agent-sweep.mjs'

const line = (value: any) => `Reply text\n[WIZARD_STATUS_V1]${JSON.stringify(value)}[/WIZARD_STATUS_V1]`
// Each read of the clock moves it on 1 ms, so records keep their creation order.
const clock = (start = Date.parse('2026-11-18T10:00:00Z')) => { const c = { at: start, now: () => c.at++ }; return c }
const store = (c = clock()) => new AgentInboxStore('', { now: c.now, log: () => undefined })
let seq = 0
const waiting = (s: any, extra: any = {}) => {
  const thread = `wizard_worker_${++seq}`
  const r = s.capture({ thread_id: thread, title: `Synthetic ask ${seq}`, ask: `Synthetic question ${seq}` }).record
  s.noteRun('hermes', thread, { id: `run_${seq}`, status: 'completed', output: line({ state: 'needs_you', ask: `Synthetic question ${seq}. Reply yes or no`,
    recommendation: `Say yes to synthetic ask ${seq}.`, options: { yes: `Yes: go ahead with synthetic ask ${seq} as recommended.`, no: `No: leave synthetic ask ${seq} alone.` }, default_option: 'yes', ...extra }) })
  return s.get(r.id)
}
const done = (s: any) => {
  const thread = `wizard_worker_${++seq}`
  const r = s.capture({ thread_id: thread, title: `Synthetic job ${seq}`, ask: `Synthetic job ${seq}` }).record
  s.noteRun('hermes', thread, { id: `run_${seq}`, status: 'completed', output: line({ state: 'done', ask: `Synthetic job ${seq} finished` }) })
  return s.get(r.id)
}
const fyi = (s: any) => {
  const thread = `wizard_worker_${++seq}`
  const r = s.capture({ thread_id: thread, title: `Synthetic note ${seq}`, ask: `Synthetic note ${seq}` }).record
  s.noteRun('hermes', thread, { id: `run_${seq}`, status: 'completed', output: line({ state: 'fyi', ask: `Synthetic note ${seq}` }) })
  return s.get(r.id)
}
const running = (s: any) => s.capture({ thread_id: `wizard_worker_${++seq}`, title: `Synthetic running ${seq}`, ask: `Synthetic running ${seq}` }).record
const keysDeep = (value: any, out = new Set<string>()): Set<string> => {
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keysDeep(v, out) }
  return out
}

describe('signal sweep card', () => {
  it('with 30 waiting and 40 done records shows exactly 7 and 10, "and 23 more" / "more", and no summary text', () => {
    const s = store()
    for (let n = 0; n < 30; n++) waiting(s)
    for (let n = 0; n < 40; n++) done(s)
    for (let n = 0; n < 3; n++) running(s)
    fyi(s); fyi(s)
    const card = s.sweep({ thread_id: 'wizard_daily_1', day: '2026-11-18' })
    expect(card.waiting.items).toHaveLength(WAITING_CAP)
    expect(card.waiting.more).toBe(23)
    expect(card.done.items).toHaveLength(DONE_CAP)
    expect(card.done.more).toBe(30)
    expect([card.running.count, card.later.count, card.parked.count]).toEqual([3, 2, 0])
    for (const key of ['summary', 'text', 'body', 'description']) expect(keysDeep(card).has(key)).toBe(false)
    // Each Waiting item is record fields only: title, ask, recommendation and one button per token.
    expect(card.waiting.items[0]).toMatchObject({ title: 'Synthetic ask 1', recommendation: 'Say yes to synthetic ask 1.', options: [{ token: 'yes' }, { token: 'no' }], seen: 1 })
    const text = cardMarkdown(s.sweepView(card))
    expect(text).toContain('[and 23 more](/wizard-os-home/?inbox=waiting)')
    expect(text).toContain('[more](/wizard-os-home/?inbox=done)')
    expect(text.match(/^\d+\. /gmu)).toHaveLength(7)
    expect(text.match(/^- \[/gmu)).toHaveLength(10)
    // Shown Done and FYI records archive; Waiting ones are surfaced once; hidden ones are untouched.
    expect(s.list({ kind: 'result', state: 'archived' })).toHaveLength(10)
    expect(s.list({ kind: 'fyi', state: 'archived' })).toHaveLength(2)
    expect(s.list({ kind: 'needs_you', state: 'surfaced' })).toHaveLength(7)
    expect(s.list({ kind: 'needs_you', state: 'new' })).toHaveLength(23)
    // The next sweep shows the 7 again (second sweep) and the next 10 done.
    const next = s.sweep({ thread_id: 'wizard_daily_1' })
    expect(next.waiting.items.map((i: any) => i.seen)).toEqual(Array(7).fill(2))
    expect(next.done.more).toBe(20)
  })

  it('an item left unanswered for 3 sweeps parks and is counted', () => {
    const s = store()
    const item = waiting(s)
    for (let n = 1; n <= 3; n++) expect(s.sweep({ thread_id: 'wizard_daily_1' }).waiting.items.map((i: any) => [i.id, i.seen])).toEqual([[item.id, n]])
    const fourth = s.sweep({ thread_id: 'wizard_daily_1' })
    expect(fourth.waiting.items).toEqual([])
    expect(fourth.parked.count).toBe(1)
    expect(s.get(item.id).state).toBe('parked')
    expect(cardMarkdown(s.sweepView(fourth))).toContain('[1 parked](/wizard-os-home/?inbox=parked)')
    expect(s.sweep({ thread_id: 'wizard_daily_1' }).parked.count).toBe(1)
  })

  it('Yes to all answers only the shown Waiting items with a default, never confirm items or hidden ones', () => {
    const s = store()
    const plain = Array.from({ length: 5 }, () => waiting(s))
    const confirm = waiting(s, { confirm: true })
    const noDefault = waiting(s, { default_option: undefined })
    const hidden = waiting(s)
    const card = s.sweep({ thread_id: 'wizard_daily_1' })
    expect(card.waiting.items.map((i: any) => i.id)).toEqual([...plain, confirm, noDefault].map(r => r.id))
    const targets = s.yesToAll(card.id)
    expect(targets).toEqual(plain.map(r => ({ id: r.id, option: 'yes' })))
    expect(targets!.some((t: any) => [confirm.id, noDefault.id, hidden.id].includes(t.id))).toBe(false)
    const view = s.sweepView(card)
    expect(view.yes_to_all).toEqual({ count: 5, skipped: 1 })
    expect(cardMarkdown(view)).toContain('Open to confirm.')
    // An item answered since is skipped too.
    s.patch(plain[0].id, { action: 'answer', option: 'no' })
    expect(s.yesToAll(card.id)).toHaveLength(4)
    expect(s.sweepView(card).waiting.items[0]).toMatchObject({ state: 'answered', answer: 'no' })
    expect(s.yesToAll('sweep_000000000000000000000000')).toBeNull()
  })

  it('an answer archives the record at the worker\'s next status line; a new question starts again; Later snoozes', () => {
    const s = store()
    const a = waiting(s), b = waiting(s), c = waiting(s)
    s.sweep({ thread_id: 'wizard_daily_1' })
    s.patch(a.id, { action: 'answer', option: 'yes', run_id: 'answer-a' })
    expect(s.get(a.id)).toMatchObject({ state: 'answered', answer: 'yes', answer_run: 'answer-a' })
    // A turn that was already running when the owner answered finishes first: the record waits for the answer's turn.
    s.noteRun('hermes', a.thread_id, { id: 'earlier-a', status: 'completed', output: line({ state: 'done', ask: 'Older turn' }) })
    expect(s.get(a.id).state).toBe('answered')
    s.noteRun('hermes', a.thread_id, { id: 'answer-a', status: 'completed', output: line({ state: 'done', ask: 'Went ahead' }) })
    expect(s.get(a.id).state).toBe('archived')
    s.patch(b.id, { action: 'answer', option: 'no' })
    s.noteRun('hermes', b.thread_id, { id: 'after-b', status: 'completed', output: line({ state: 'needs_you', ask: 'One more synthetic question' }) })
    expect(s.get(b.id)).toMatchObject({ state: 'new', kind: 'needs_you', surfaced_count: 0, answer: null })
    // Later: back to the next sweep, no answer recorded.
    const later = s.patch(c.id, { action: 'answer', option: 'later' })
    expect([later?.state, later?.answer]).toEqual(['new', undefined])
    expect(s.sweep({ thread_id: 'wizard_daily_1' }).waiting.items.map((i: any) => i.id)).toEqual([b.id, c.id])
  })

  it('the stored card survives a restart and only the newest card is live', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'agent-sweep-'))
    try {
      const path = join(dir, 'agent-inbox.json')
      const c = clock()
      const s = new AgentInboxStore(path, { now: c.now, log: () => undefined })
      waiting(s)
      const first = s.sweep({ thread_id: 'wizard_daily_1' })
      const reopened = new AgentInboxStore(path, { now: c.now, log: () => undefined })
      expect(reopened.latestSweep({ thread: 'wizard_daily_1' })?.id).toBe(first.id)
      const second = reopened.sweep({ thread_id: 'wizard_daily_2' })
      expect(reopened.latestSweep({ thread: 'wizard_daily_1' })).toBeNull()
      expect(reopened.latestSweep({ thread: 'wizard_daily_2' })?.id).toBe(second.id)
      expect(reopened.sweepCard(first.id)?.id).toBe(first.id)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('the phrase: said or typed on its own, or a scheduled brief whose prompt is the phrase', () => {
    for (const t of ['signal sweep', 'Signal sweep.', '  SIGNAL SWEEP!  ', 'signal-sweep']) expect(isSweepPhrase(t)).toBe(true)
    for (const t of ['do a signal sweep later', 'signal', 'sweep', '', 'signal sweep please']) expect(isSweepPhrase(t)).toBe(false)
    expect(isScheduledSweep('[Wizard schedule] scheduled message\nYou scheduled this message to the owner, in this thread:\nsignal sweep\n')).toBe(true)
    expect(isScheduledSweep('[Wizard schedule]\nWrite a signal sweep of the news\n')).toBe(false)
    expect(isScheduledSweep('signal sweep')).toBe(false)
  })

  it('the card row is the last row of the newest history page only', () => {
    const s = store()
    waiting(s)
    const view = s.sweepView(s.sweep({ thread_id: 'wizard_daily_1' }))
    const rows = [{ id: 1, role: 'user', content: 'signal sweep' }, { id: 2, role: 'assistant', content: 'It is there.' }]
    const q = (text: string) => new URLSearchParams(text)
    const last = withCardRow({ data: rows }, view, q('order=oldest&limit=500&offset=0'))
    expect(last.data.map((r: any) => r.id)).toEqual([1, 2, view.id])
    expect(last.data.at(-1)).toMatchObject({ role: 'assistant', display_kind: 'agent_sweep', agent_sweep: { id: view.id } })
    expect(last.data.at(-1).content).toContain('**Waiting on you** (1)')
    expect(withCardRow(last, view, q('order=oldest&limit=500&offset=0')).data).toHaveLength(3)
    expect(withCardRow({ data: rows }, view, q('order=oldest&limit=2&offset=0')).data).toHaveLength(2)
    expect(withCardRow({ data: rows, has_more: true }, view, q('order=oldest&limit=500')).data).toHaveLength(2)
    expect(withCardRow({ data: [] }, view, q('order=oldest&limit=500&offset=500')).data).toHaveLength(0)
    // order=latest pages come back in chronological order: the card is still the last row.
    expect(withCardRow({ data: rows }, view, q('order=latest&limit=100&offset=0')).data.map((r: any) => r.id)).toEqual([1, 2, view.id])
    expect(withCardRow({ data: rows }, view, q('order=latest&limit=100&offset=100')).data).toHaveLength(2)
    expect(withCardRow({ messages: rows }, view, q('')).messages.at(-1).id).toBe(view.id)
  })
})
