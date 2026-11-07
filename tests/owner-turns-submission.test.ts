import { describe, expect, it } from 'vitest'
import { restoreOwnerTurns } from '../server/service.mjs'

// Shapes copied from the real Wizard OS · Chats #2 thread after Hermes 0.22.7: the API drops
// platform_message_id/display_metadata, the user row lands 10-25 minutes after the queue admitted
// the run, one row carries Python repr of the multipart list, and compaction re-emits copies.
const SID = 'wizard_1794036340706_7a4a6d366ae1'
const chips = '\n\n[WIZARD_FILE_CHIPS_V1]\n[{"id":"drop_1","filename":"a.png"}]\n[/WIZARD_FILE_CHIPS_V1]'
const listBody = (text: string) => JSON.stringify({ session_id: SID, input: [{ role: 'user', content: [{ type: 'text', text }] }] })
const rec = (publicRunId: string, upstreamRunId: string, createdAt: number, body: string, status = 'completed', admission = '') => ({
  publicRunId, upstreamRunId, status, createdAt, body, payload: { created_at: createdAt + 0.45, ...(admission ? { admission_id: admission } : {}) },
})
const records = [
  rec('wizardq_a', 'run_554f', 1794036341.929, listBody('This is broken, please fix' + chips), 'interrupted'),
  { ...rec('wizardq_b', 'run_f5f2', 1794037203.545, listBody('This is broken, please fix' + chips), 'completed', 'adm-b'), retrySourceId: 'wizardq_a' },
  rec('wizardq_c', 'run_2e98', 1794038717.469, '{"input":"[Wizard follow-through] Recovered helper receipt deleg_3d7accbb"}'),
  rec('wizardq_d', 'run_13f5', 1794056159.504, listBody('Why am I not seeing any of my messages in my chats? Please fix.' + chips), 'completed', 'adm-d'),
  rec('wizardq_e', 'run_0000', 1794030000.1, listBody('Please check the old thing' + chips), 'completed'),
]
const queue = { admittedForSession: (runtime: string, sid: string) => (runtime === 'direct' && sid === SID ? records : []) }
const meta = new Map<number, { submission_id?: string }>([
  [4256117, { submission_id: 'run_554f' }], [4257217, { submission_id: 'run_554f' }],
  [4256184, { submission_id: 'run_f5f2' }], [4257283, { submission_id: 'run_2e98' }],
  [4261216, { submission_id: 'run_13f5' }],
])
const rowMeta = (_sid: string, ids: number[]) => new Map(ids.filter((id) => meta.has(id)).map((id) => [id, meta.get(id)!]))
const reprOf = (text: string) => `[{'text': ${JSON.stringify(text).replace(/'/g, "\\'")}, 'type': 'text'}, {'type': 'text', 'text': '[System: skills changed]'}]`
const page = () => ({ object: 'list', session_id: SID, pagination: { limit: 500, offset: 0, order: 'latest', returned: 9 }, data: [
  { id: 4256117, session_id: SID, role: 'user', display_kind: 'internal_notification', timestamp: 1794037756.97, content: 'This is broken, please fix' + chips },
  { id: 4256184, session_id: SID, role: 'user', display_kind: 'internal_notification', timestamp: 1794037845.87, content: 'This is broken, please fix' + chips },
  { id: 4256200, session_id: SID, role: 'assistant', timestamp: 1794037900, content: 'On it.' },
  { id: 4257217, session_id: SID, role: 'user', display_kind: 'internal_notification', timestamp: 1794037756.97, content: 'This is broken, please fix' + chips },
  { id: 4257283, session_id: SID, role: 'user', display_kind: 'internal_notification', timestamp: 1794039218.35, content: '[Wizard follow-through] Recovered helper receipt deleg_3d7accbb' },
  { id: 4257300, session_id: SID, role: 'assistant', timestamp: 1794039300, content: 'Fixed.' },
  { id: 4261186, session_id: SID, role: 'user', display_kind: 'hidden', timestamp: 1794057227.5, content: '' },
  { id: 4261216, session_id: SID, role: 'user', display_kind: 'internal_notification', timestamp: 1794056734.4, content: [{ text: 'Why am I not seeing any of my messages in my chats? Please fix.' + chips, type: 'text' }, { type: 'text', text: '[System: skills changed]' }] },
  { id: 4261319, session_id: SID, role: 'user', display_kind: 'steer', timestamp: 1794057252.9, content: '[OUT-OF-BAND USER MESSAGE]' },
] })
const run = (payload: object = page(), q: unknown = queue, lookup: unknown = rowMeta) =>
  JSON.parse(restoreOwnerTurns(Buffer.from(JSON.stringify(payload)), q, SID, lookup).toString()).data as Array<Record<string, any>>
const shown = (rows: Array<Record<string, any>>) => rows.filter((r) => r.role === 'user' && !r.display_kind)

describe('restoreOwnerTurns: owner turns by Hermes submission id (0.22.7)', () => {
  it('restores the owner row whose submission id is a queued list-input run, long after admission', () => {
    const out = run()
    const row = out.find((r) => r.id === 4261216)!
    expect(row.display_kind).toBeUndefined()
    expect(row.content).toEqual([{ text: 'Why am I not seeing any of my messages in my chats? Please fix.' + chips, type: 'text' }])
  })
  it('replaces a Python-repr string row with the queued input text', () => {
    const p: any = page(); p.data.find((r: any) => r.id === 4261216).content = reprOf('Why am I not seeing any of my messages in my chats? Please fix.' + chips)
    expect(run(p).find((r) => r.id === 4261216)!.content).toBe('Why am I not seeing any of my messages in my chats? Please fix.' + chips)
  })
  it('shows a retried message once: the interrupted attempt stays hidden, the completed one shows', () => {
    const out = run()
    expect(out.find((r) => r.id === 4256117)!.display_kind).toBe('internal_notification')
    expect(out.find((r) => r.id === 4256184)!.display_kind).toBeUndefined()
    expect(out.find((r) => r.id === 4257217)!.display_kind).toBe('internal_notification')
  })
  it('keeps machine follow-through, hidden and steer rows machine', () => {
    const out = run()
    expect(out.find((r) => r.id === 4257283)!.display_kind).toBe('internal_notification')
    expect(out.find((r) => r.id === 4261186)!.display_kind).toBe('hidden')
    expect(out.find((r) => r.id === 4261319)!.display_kind).toBe('steer')
  })
  it('restores a turn whose Hermes row is missing entirely, in time order, once', () => {
    const out = run()
    const synthetic = out.filter((r) => String(r.id).startsWith('queue-'))
    expect(synthetic.map((r) => r.content)).toEqual(['Please check the old thing' + chips])
    expect(synthetic[0]).toMatchObject({ role: 'user', session_id: SID })
    expect(synthetic[0].display_kind).toBeUndefined()
    expect(out.indexOf(synthetic[0])).toBe(0)
    expect(shown(run()).map((r) => r.id)).toEqual(['queue-wizardq_e', 4256184, 4261216])
  })
  it('does not synthesize machine strings or turns older than the page when more pages exist', () => {
    const p: any = page(); p.pagination = { limit: 5, offset: 0, order: 'latest', returned: 5 }
    expect(run(p).some((r) => String(r.id).startsWith('queue-'))).toBe(false)
    expect(run().some((r) => String(r.content).includes('follow-through') && r.role === 'user' && !r.display_kind)).toBe(false)
  })
  it('does nothing for another session or without a row lookup (text fallback still works)', () => {
    expect(restoreOwnerTurns(Buffer.from(JSON.stringify(page())), { admittedForSession: () => [] }, SID, rowMeta).toString()).toBe(JSON.stringify(page()))
    const noLookup = run(page(), queue, null)
    // The opening-words fallback still restores the retried message once, and the long last message.
    expect(noLookup.filter((r) => String(r.content).startsWith('This is broken') && !r.display_kind)).toHaveLength(1)
    expect(noLookup.find((r) => r.id === 4261216)!.display_kind).toBeUndefined()
    expect(noLookup.find((r) => r.id === 4257283)!.display_kind).toBe('internal_notification')
  })
})

describe('restoreOwnerTurns: no duplicates beside rows Hermes already shows', () => {
  it('does not restore a turn when a normal user row carries the same opening words (attachments re-rendered)', () => {
    const long = 'A long owner message about the broken chats screen and what I expect to see afterwards, with details.'
    const q = { admittedForSession: () => [rec('wizardq_x', 'run_x', 1794060000, listBody(long + chips))] }
    const payload = { pagination: { limit: 500, offset: 0, order: 'latest', returned: 2 }, data: [
      { id: 1, session_id: SID, role: 'user', timestamp: 1794060000.2, content: [{ type: 'text', text: long + '\n[Image attached at: /x.png]' }] },
      { id: 2, session_id: SID, role: 'assistant', timestamp: 1794060100, content: 'ok' },
    ] }
    expect(run(payload, q).map((r) => r.id)).toEqual([1, 2])
  })
})

describe('restoreOwnerTurns: review findings', () => {
  const long = 'A long owner message about the broken chats screen and what I expect to see afterwards, with details.'
  it('keeps one copy when a visible row and an internal copy of the same turn are both on the page', () => {
    const q = { admittedForSession: () => [rec('wizardq_x', 'run_x', 1794060000, listBody(long + chips))] }
    const payload = { pagination: { limit: 500, offset: 0, order: 'latest', returned: 3 }, data: [
      { id: 1, session_id: SID, role: 'user', timestamp: 1794060000.2, content: long },
      { id: 2, session_id: SID, role: 'user', display_kind: 'internal_notification', timestamp: 1794060000.3, content: long },
      { id: 3, session_id: SID, role: 'assistant', timestamp: 1794060100, content: 'ok' },
    ] }
    const out = run(payload, q)
    expect(out.filter((r) => r.role === 'user' && !r.display_kind)).toHaveLength(1)
  })
  it('only hides an earlier attempt that a later run names as its retry source', () => {
    const q = { admittedForSession: () => [
      rec('wizardq_1', 'run_1', 1794060000, listBody('please look at the other thing now ok, thanks a lot friend'), 'interrupted'),
      rec('wizardq_2', 'run_2', 1794060500, listBody('please look at the other thing now ok, thanks a lot friend'), 'completed'),
    ] }
    const payload = { pagination: { limit: 500, offset: 0, order: 'latest', returned: 3 }, data: [
      { id: 1, session_id: SID, role: 'user', display_kind: 'internal_notification', timestamp: 1794060000.5, content: 'please look at the other thing now ok, thanks a lot friend' },
      { id: 2, session_id: SID, role: 'user', display_kind: 'internal_notification', timestamp: 1794060500.5, content: 'please look at the other thing now ok, thanks a lot friend' },
      { id: 3, session_id: SID, role: 'assistant', timestamp: 1794060600, content: 'ok' },
    ] }
    expect(run(payload, q).filter((r) => r.role === 'user' && !r.display_kind).map((r) => r.id)).toEqual([1, 2])
  })
  it('restores a legacy plain-string owner message that starts with a bracket, but not machine-tagged ones', () => {
    const q = { admittedForSession: () => [
      rec('wizardq_1', 'run_1', 1794060000, JSON.stringify({ input: '[Question] can you check this?' })),
      rec('wizardq_2', 'run_2', 1794060100, JSON.stringify({ input: '[Wizard follow-through] Recovered helper receipt' })),
    ] }
    const payload = { pagination: { limit: 500, offset: 0, order: 'latest', returned: 3 }, data: [
      { id: 1, session_id: SID, role: 'user', display_kind: 'internal_notification', timestamp: 1794060000.5, content: '[Question] can you check this?' },
      { id: 2, session_id: SID, role: 'user', display_kind: 'internal_notification', timestamp: 1794060100.5, content: '[Wizard follow-through] Recovered helper receipt' },
      { id: 3, session_id: SID, role: 'assistant', timestamp: 1794060600, content: 'ok' },
    ] }
    const out = run(payload, q)
    expect(out.find((r) => r.id === 1)!.display_kind).toBeUndefined()
    expect(out.find((r) => r.id === 2)!.display_kind).toBe('internal_notification')
  })
})
