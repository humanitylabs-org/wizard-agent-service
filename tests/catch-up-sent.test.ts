// Issue 710: catch me up clears Sent (switch wizard/catch-up-sent, off by default). Every finished thread in Sent, any
// age, is one count line in Clear all; "clear" archives them, "clear except N" keeps the named ones, running threads
// and threads waiting on the owner are never offered, and a revived thread comes back at the next catch-up.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCatchUp } from '../server/catch-up.mjs'

let root: string
let clock: number
const DAY = 86400_000
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'wizard-catch-up-sent-case-')); clock = Date.parse('2026-11-27T10:00:00Z') })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const status = (state: string, ask = 'Synthetic decision') => `[WIZARD_STATUS_V1]${JSON.stringify({ state, ask })}[/WIZARD_STATUS_V1]`
type Thread = { id: string, age: number, at?: number, said?: string | null, pinned?: boolean, title?: string, state?: string, reply?: string | null, working?: boolean, snoozed?: boolean, archived?: boolean, listed?: boolean }

function box(threads: Thread[], { on = true, smart = false } = {}) {
  const switchOn = { on }
  const archived: string[] = []
  const sessionReads: string[] = []
  // Ages are fixed when the box is made; `age` set later means "now minus age" at that moment (a new reply).
  const start = clock
  const all = new Map(threads.map(t => [t.id, { ...t }]))
  const at = (t: Thread) => ((t.at ?? start - t.age)) / 1000
  const page = (t: Thread) => [
    { role: 'user', content: `Synthetic ask ${t.id}`, timestamp: at(t) - 30 },
    ...(t.reply === null ? [] : [{ role: 'assistant', content: `${t.reply ?? `Synthetic answer ${t.id}`}\n${status(t.state ?? 'done')}`, timestamp: at(t) }]),
  ]
  // Hermes' chat listing stops at 30 days: older threads are read one by one.
  const listedNow = (t: Thread) => t.listed ?? clock - at(t) * 1000 < 30 * DAY
  const catchUp = createCatchUp({
    statePath: join(root, 'catch-up.json'), now: () => clock, inbox: null,
    readChats: async () => [...all.values()].filter(listedNow).map(t => ({ id: t.id, title: t.title ?? `Chat ${t.id}`, last_active: at(t), archived: Boolean(t.archived) })),
    readTurns: async (id: string) => ({ data: page(all.get(id)!) }),
    archiveChat: async (id: string) => { archived.push(id); all.get(id)!.archived = true },
    sentOn: () => switchOn.on,
    readSent: async () => [...all.values()].map(t => ({ id: t.id, title: listedNow(t) ? t.title ?? `Chat ${t.id}` : `Synthetic ask ${t.id}`, at: at(t) * 1000,
      listed: listedNow(t), archived: listedNow(t) && Boolean(t.archived), hidden: false, snoozed: Boolean(t.snoozed), working: Boolean(t.working),
      ...(smart ? { smart, delivery: Boolean(t.pinned), last: t.said === null ? null : { state: 'done', text: t.said ?? `Please do: ${t.title ?? t.id}`, route: 'agent', rules_matched: ['typed'], at: (at(t) - 30) * 1000 } } : {}) })),
    readSession: async (id: string) => { sessionReads.push(id); const t = all.get(id); return t ? { id, title: t.title ?? `Chat ${id}`, archived: Boolean(t.archived), last_active: at(t) } : null },
    log: () => {},
  })
  const clear = (args: any) => catchUp.tools.call('wizard_catch_up', { action: 'clear', ...args })
  return { catchUp, archived, all, sessionReads, switchOn, clear }
}

const sentLine = (note: string) => note.slice(note.indexOf('Finished chats in Sent'), note.indexOf('Acting on his answer'))

describe('catch me up clears Sent (switch on)', () => {
  it('offers the finished Sent threads aged 1, 8 and 30 days in one count line; clear archives exactly those; the running one stays', async () => {
    const b = box([
      { id: 'wizard_sent_1d', age: 1 * DAY, title: 'Synthetic flights' },
      { id: 'wizard_sent_8d', age: 8 * DAY, title: 'Synthetic recipes' },
      { id: 'wizard_sent_30d', age: 30 * DAY, title: 'Synthetic gym plan' },
      { id: 'wizard_sent_run', age: 600_000, title: 'Synthetic research', working: true, reply: null },
    ])
    const { note, sent } = await b.catchUp.compose({ threadId: 'wizard_cu1' })
    expect(sent!.sort()).toEqual(['wizard_sent_1d', 'wizard_sent_30d', 'wizard_sent_8d'])
    const line = sentLine(note)
    expect(line).toContain('ONE count line, "3 finished chats in Sent"')
    for (const id of ['wizard_sent_1d', 'wizard_sent_8d', 'wizard_sent_30d']) expect(line).toContain(`id ${id} |`)
    expect(note).not.toContain('wizard_sent_run')
    // The finished chats are on the Sent line only, never listed one by one as well.
    expect(note.slice(0, note.indexOf('Finished chats in Sent'))).not.toContain('wizard_sent_1d')
    expect(note).toContain('"sent": true when the Sent line is cleared')
    // The 30-day thread is past the listing: read one by one, with its own title.
    expect(b.sessionReads).toEqual(['wizard_sent_30d'])
    expect(line).toContain('"Synthetic gym plan"')

    // Nothing is archived before his answer.
    expect((await b.clear({ sent: true })).isError).toBe(true)
    expect(b.archived).toEqual([])
    expect(b.catchUp.ownerTurn('wizard_cu1', 'clear')).toBe(true)
    const done = await b.clear({ sent: true })
    expect(done.isError).toBeUndefined()
    expect(b.archived.sort()).toEqual(['wizard_sent_1d', 'wizard_sent_30d', 'wizard_sent_8d'])
    expect(b.all.get('wizard_sent_run')!.archived).toBeUndefined()
    // The archived thread past the listing is remembered, so the Sent log can leave its sends out.
    expect(Object.keys(b.catchUp.cleared())).toEqual(['wizard_sent_30d'])
  })

  it('never offers a thread that runs, waits on him, is snoozed, archived, or still has his message newest', async () => {
    const b = box([
      { id: 'wizard_ok', age: 3 * DAY },
      { id: 'wizard_waiting', age: 2 * DAY, state: 'needs_you' },
      { id: 'wizard_check', age: 2 * DAY, state: 'check' },
      { id: 'wizard_snoozed', age: 5 * DAY, snoozed: true },
      { id: 'wizard_archived', age: 5 * DAY, archived: true },
      { id: 'wizard_old_archived', age: 90 * DAY, archived: true },
      { id: 'wizard_unanswered', age: 1 * DAY, reply: null },
      { id: 'wizard_running', age: 1 * DAY, working: true },
    ])
    const { note, sent } = await b.catchUp.compose({ threadId: 'wizard_cu1' })
    expect(sent).toEqual(['wizard_ok'])
    expect(sentLine(note)).toContain('"1 finished chat in Sent"')
    // A waiting chat stays a step-two item.
    expect(note).toContain('id wizard_waiting | "Chat wizard_waiting" | waiting on the owner')
    // An archived thread past the listing is read once, then remembered until it changes.
    expect(b.sessionReads).toEqual(['wizard_old_archived'])
    await b.catchUp.compose({ threadId: 'wizard_cu2' })
    expect(b.sessionReads).toEqual(['wizard_old_archived'])
  })

  it('"clear except N" keeps the named ones, which are not offered again until they change', async () => {
    const b = box([{ id: 'wizard_a', age: 2 * DAY }, { id: 'wizard_b', age: 9 * DAY }, { id: 'wizard_c', age: 40 * DAY }])
    await b.catchUp.compose({ threadId: 'wizard_cu1' })
    b.catchUp.ownerTurn('wizard_cu1', 'clear except 2')
    const done = await b.clear({ sent: true, keep: ['wizard_b'] })
    expect(done.content[0].text).toContain('Kept in Sent: wizard_b')
    expect(b.archived.sort()).toEqual(['wizard_a', 'wizard_c'])
    clock += 3600_000
    const next = await b.catchUp.compose({ threadId: 'wizard_cu2' })
    expect(next.sent).toEqual([])
    expect(next.nothing_new).toBe(true)
    // A new reply in the kept thread brings it back.
    b.all.get('wizard_b')!.at = clock
    expect((await b.catchUp.compose({ threadId: 'wizard_cu3' })).sent).toEqual(['wizard_b'])
  })

  it('a thread revived by a later background run goes back into Sent and is offered at the next catch-up', async () => {
    const b = box([{ id: 'wizard_watch', age: 45 * DAY, title: 'Synthetic price watch' }])
    await b.catchUp.compose({ threadId: 'wizard_cu1' })
    b.catchUp.ownerTurn('wizard_cu1', 'clear')
    await b.clear({ sent: true })
    expect(b.archived).toEqual(['wizard_watch'])
    expect(Object.keys(b.catchUp.cleared())).toEqual(['wizard_watch'])
    clock += DAY
    expect((await b.catchUp.compose({ threadId: 'wizard_cu2' })).sent).toEqual([])
    // The watch wakes it: a new reply that needs nothing, and the thread is listed again, not archived.
    Object.assign(b.all.get('wizard_watch')!, { at: clock - 60_000, archived: false })
    const back = await b.catchUp.compose({ threadId: 'wizard_cu3' })
    expect(back.sent).toEqual(['wizard_watch'])
    expect(back.nothing_new).toBe(false)
    expect(b.catchUp.cleared()).toEqual({})
    b.catchUp.ownerTurn('wizard_cu3', 'clear')
    await b.clear({ sent: true })
    expect(b.archived).toEqual(['wizard_watch', 'wizard_watch'])
  })

  it('a chat not on the Sent line is never archived by sent: true or by id', async () => {
    const b = box([{ id: 'wizard_a', age: 2 * DAY }, { id: 'wizard_late', age: 9 * DAY }])
    b.all.get('wizard_late')!.working = true
    await b.catchUp.compose({ threadId: 'wizard_cu1' })
    b.all.get('wizard_late')!.working = false
    b.catchUp.ownerTurn('wizard_cu1', 'clear')
    const done = await b.clear({ sent: true, chats: ['wizard_late'] })
    expect(b.archived).toEqual(['wizard_a'])
    expect(done.content[0].text).toContain('wizard_late (not in this catch-up)')
  })
})

describe('catch me up clears Sent: edges', () => {
  it('threads that are not finished never use up the room: an old finished one past 200 waiting ones is still offered', async () => {
    const waiting = Array.from({ length: 210 }, (_, n) => ({ id: `wizard_wait_${n}`, age: 40 * DAY + n * 60_000, state: 'needs_you' }))
    const b = box([...waiting, { id: 'wizard_done_old', age: 90 * DAY }])
    const { note, sent } = await b.catchUp.compose({ threadId: 'wizard_cu1' })
    expect(sent).toEqual(['wizard_done_old'])
    expect(note).not.toContain('were not checked')
  })

  it('clear checks each Sent thread again: one that got a new reply, runs or waits on him since the catch-up stays', async () => {
    const b = box([{ id: 'wizard_a', age: 9 * DAY }, { id: 'wizard_b', age: 9 * DAY }, { id: 'wizard_c', age: 9 * DAY }, { id: 'wizard_d', age: 9 * DAY }])
    await b.catchUp.compose({ threadId: 'wizard_cu1' })
    Object.assign(b.all.get('wizard_b')!, { at: clock + 60_000 })
    Object.assign(b.all.get('wizard_c')!, { working: true })
    Object.assign(b.all.get('wizard_d')!, { state: 'needs_you' })
    b.catchUp.ownerTurn('wizard_cu1', 'clear')
    const done = await b.clear({ sent: true })
    expect(b.archived).toEqual(['wizard_a'])
    for (const id of ['wizard_b', 'wizard_c', 'wizard_d']) expect(done.content[0].text).toContain(`${id} (changed since the catch-up`)
  })
})

describe('catch me up clears Sent with Smart inbox on', () => {
  it('a thread Inbox shows (an answer to his words) is not on the Sent line and is still listed on its own', async () => {
    const b = box([
      { id: 'wizard_answer_1d', age: 1 * DAY, title: 'Synthetic answer he asked for' },
      { id: 'wizard_answer_8d', age: 8 * DAY },
      { id: 'wizard_thanks', age: 2 * DAY, said: 'ok thanks 👍' },
      { id: 'wizard_task', age: 3 * DAY },
      { id: 'wizard_watch', age: 4 * DAY, said: null },
      { id: 'wizard_pinned', age: 4 * DAY, said: null, pinned: true },
      { id: 'wizard_old', age: 45 * DAY },
    ], { smart: true })
    const { note, sent } = await b.catchUp.compose({ threadId: 'wizard_cu1' })
    expect(sent!.sort()).toEqual(['wizard_old', 'wizard_thanks', 'wizard_watch'])
    expect(note).toContain('id wizard_answer_1d | "Synthetic answer he asked for" | finished, not archived')
    expect(sentLine(note)).not.toContain('wizard_answer')
    expect(sentLine(note)).not.toContain('wizard_pinned')
    b.catchUp.ownerTurn('wizard_cu1', 'clear')
    await b.clear({ sent: true })
    expect(b.archived.sort()).toEqual(['wizard_old', 'wizard_thanks', 'wizard_watch'])
  })
})

describe('switch off', () => {
  it('the note, the tool and clear are exactly as before', async () => {
    const threads = [{ id: 'wizard_a', age: 2 * DAY }, { id: 'wizard_b', age: 9 * DAY }, { id: 'wizard_c', age: 40 * DAY }]
    const off = box(threads, { on: false })
    const { note, sent } = await off.catchUp.compose({ threadId: 'wizard_cu1' })
    expect(sent).toBeUndefined()
    expect(note).not.toContain('in Sent')
    expect(note).not.toContain('"sent": true')
    expect(note).toContain('id wizard_a | "Chat wizard_a" | finished, not archived')
    expect(note).not.toContain('wizard_b')
    expect(off.sessionReads).toEqual([])
    const [tool] = off.catchUp.tools.list()
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['action', 'chats', 'records', 'items'])
    expect(tool.description).not.toContain('sent: true')
    off.catchUp.ownerTurn('wizard_cu1', 'clear')
    expect((await off.clear({ sent: true })).isError).toBe(true)
    await off.clear({ sent: true, chats: ['wizard_a'] })
    expect(off.archived).toEqual(['wizard_a'])
    // Same note as a catch-up built with no Sent reader at all.
    rmSync(join(root, 'catch-up.json'), { force: true })
    const plain = createCatchUp({ statePath: join(root, 'plain.json'), now: () => clock, inbox: null, readChats: async () => [{ id: 'wizard_a', title: 'Chat wizard_a', last_active: (clock - 2 * DAY) / 1000 }],
      readTurns: async () => ({ data: [{ role: 'user', content: 'Synthetic ask wizard_a', timestamp: (clock - 2 * DAY) / 1000 - 30 }, { role: 'assistant', content: `Synthetic answer wizard_a\n${status('done')}`, timestamp: (clock - 2 * DAY) / 1000 }] }),
      archiveChat: async () => {}, log: () => {} })
    const offAgain = box([{ id: 'wizard_a', age: 2 * DAY }], { on: false })
    const strip = (text: string) => text.replace(/catchup_[a-f0-9]+/gu, 'catchup_x')
    expect(strip((await offAgain.catchUp.compose({ threadId: 'wizard_cu9' })).note)).toBe(strip((await plain.compose({ threadId: 'wizard_cu9' })).note))
  })

  it('switch on: the tool takes sent and keep', () => {
    const [tool] = box([]).catchUp.tools.list()
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['action', 'chats', 'records', 'items', 'sent', 'keep'])
  })
})
