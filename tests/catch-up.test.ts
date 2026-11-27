// Issue 668: catch me up (switch wizard/catch-me-up, off by default).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentInboxStore } from '../server/agent-inbox.mjs'
import { BASELINE_PROMPT, CATCH_UP_SWITCH, CATCH_UP_TOOL, createCatchUp, isCatchUpPhrase, lastTurns, startsCatchUp } from '../server/catch-up.mjs'
import { routeUtterance } from '../server/voice-router.mjs'

let root: string
let clock: number
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'wizard-catch-up-case-')); clock = Date.parse('2026-11-26T10:00:00Z') })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const status = (state: string, ask: string) => `[WIZARD_STATUS_V1]${JSON.stringify({ state, ask })}[/WIZARD_STATUS_V1]`
function box({ chats = [] as any[], inboxOn = true } = {}) {
  const inbox = new AgentInboxStore(join(root, 'agent-inbox.json'), { now: () => clock })
  const archived: string[] = []
  const pages = new Map<string, any[]>()
  const rows = chats.map((c: any) => {
    pages.set(c.id, [
      { role: 'user', content: c.mine ?? `Synthetic ask ${c.id}`, timestamp: c.at - 10 },
      ...(c.reply === null ? [] : [{ role: 'assistant', content: `${c.reply ?? `Synthetic reply ${c.id}`}\n${status(c.state ?? 'needs_you', c.ask ?? `Synthetic decision ${c.id}`)}`, timestamp: c.at }]),
    ])
    return { id: c.id, title: c.title ?? `Chat ${c.id}`, last_active: c.at, archived: c.archived ?? false }
  })
  const catchUp = createCatchUp({
    statePath: join(root, 'catch-up.json'), now: () => clock, inbox: inboxOn ? inbox : null,
    readChats: async () => rows,
    readTurns: async (id: string) => ({ data: pages.get(id) ?? [] }),
    archiveChat: async (id: string) => { archived.push(id) },
    log: () => {},
  })
  const record = (kind: string, title: string, extra: any = {}) => {
    const { record } = inbox.capture({ thread_id: `wizard_bg_${title.replace(/\W+/gu, '_')}`, title, ask: `${title} ask`, kind, ...extra })
    inbox.patch(record.id, { action: 'snooze' })
    return record.id
  }
  return { inbox, catchUp, archived, pages, rows, record }
}

describe('the phrase', () => {
  it('starts only on "catch me up" said on its own, with "signal sweep" as its alias', () => {
    for (const text of ['catch me up', 'Catch me up.', 'CATCH ME UP!', 'Hey Wizard, catch me up please', 'please catch me up', 'can you catch me up?', ' catch  me up ']) expect(isCatchUpPhrase(text), text).toBe(true)
    for (const text of ['catch me up on the Sam thread', 'did you catch me up yesterday', 'catch up', 'catch me up and book a table', '']) expect(isCatchUpPhrase(text), text).toBe(false)
    expect(startsCatchUp('Signal sweep.')).toBe(true)
    expect(startsCatchUp('signal sweep the mail')).toBe(false)
    expect(CATCH_UP_SWITCH).toBe('wizard/catch-me-up')
  })

  it('a spoken "catch me up" is an agent turn before any router is asked, only while the switch is on', async () => {
    let asked = 0
    const fetchImpl = async () => { asked += 1; return new Response(JSON.stringify({ choices: [{ message: { content: '{"route":"command","action":"open_view","view":"inbox"}' } }] })) }
    const router = { url: 'http://127.0.0.1:9/v1', model: 'm' }
    const on = await routeUtterance({ input: { text: 'Catch me up.' }, settings: {}, router, fetchImpl, dump: true, catchUp: startsCatchUp })
    expect(on.cmd).toEqual({ route: 'agent', summary: 'Catch me up.' })
    expect(on.why.rules[0]).toBe('catch_up')
    expect(asked).toBe(0)
    // No router configured: still an agent turn, never the 404.
    expect((await routeUtterance({ input: { text: 'catch me up' }, settings: {}, router: null, catchUp: startsCatchUp })).cmd.route).toBe('agent')
    const off = await routeUtterance({ input: { text: 'Catch me up.' }, settings: {}, router, fetchImpl })
    expect(off.cmd.route).toBe('command')
    expect(asked).toBe(1)
  })
})

describe('lastTurns', () => {
  it('reads the owner\u2019s last message and the last reply without Wizard markers, newest last or first', () => {
    const rows = [
      { role: 'assistant', content: `Old reply\n${status('done', 'x')}`, timestamp: 1 },
      { role: 'user', content: 'Book the table', timestamp: 2 },
      { role: 'tool', content: 'noise', timestamp: 3 },
      { role: 'assistant', content: `Booked for 8.\n${status('needs_you', 'Confirm the deposit')}`, timestamp: 4 },
    ]
    for (const data of [rows, [...rows].reverse()]) {
      const turns = lastTurns({ data })
      expect(turns).toMatchObject({ answered: true, mine: 'Book the table', reply: 'Booked for 8.', at: 4 })
      expect(turns.status).toMatchObject({ state: 'needs_you', ask: 'Confirm the deposit' })
    }
    expect(lastTurns({ messages: [{ role: 'assistant', content: 'Hi', timestamp: 1 }, { role: 'user', content: 'Do it', timestamp: 2 }] }).answered).toBe(false)
  })
})

describe('a catch-up', () => {
  it('lists the waiting chats and the new agent inbox records with the prompt, and marks the records seen', async () => {
    const now = clock / 1000
    const b = box({ chats: [
      { id: 'wizard_a', at: now - 300, title: 'Weekend plan', ask: 'Pick Saturday or Sunday' },
      { id: 'wizard_b', at: now - 200, state: 'done' },
      { id: 'wizard_running', at: now - 100, reply: null },
      { id: 'wizard_old', at: now - 8 * 86400 },
      { id: 'wizard_gone', at: now - 50, archived: true },
    ] })
    const done = b.record('result', 'Report ready'), fyi = b.record('fyi', 'Prices updated'), confirm = b.record('needs_you', 'Send the invoice', { confirm: true })
    const out = await b.catchUp.compose({ threadId: 'wizard_cu' })
    expect(out.note).toContain(BASELINE_PROMPT)
    expect(out.chats.sort()).toEqual(['wizard_a', 'wizard_b'])
    expect(out.note).toContain('id wizard_a | "Weekend plan" | waiting on the owner: Pick Saturday or Sunday')
    expect(out.note).toContain('id wizard_b | "Chat wizard_b" | finished, not archived')
    for (const id of [done, fyi, confirm]) expect(out.note).toContain(`id ${id}`)
    expect(out.note.indexOf(`id ${confirm}`)).toBeGreaterThan(out.note.indexOf('Waiting on the owner'))
    expect(out.note.indexOf(`id ${done}`)).toBeLessThan(out.note.indexOf('Waiting on the owner'))
    expect(b.inbox.get(done)!.state).toBe('archived')
    expect(b.inbox.get(fyi)!.state).toBe('archived')
    expect(b.inbox.get(confirm)).toMatchObject({ state: 'surfaced', caught_up_at: clock })
    expect(b.archived).toEqual([])
    // Right after: nothing new, and the first catch-up's own thread is never reported.
    b.pages.set('wizard_cu', [{ role: 'user', content: 'catch me up', timestamp: now }, { role: 'assistant', content: 'Here you go', timestamp: now + 1 }])
    b.rows.push({ id: 'wizard_cu', title: 'Catch-up', last_active: now + 1, archived: false })
    clock += 60_000
    const again = await b.catchUp.compose({ threadId: 'wizard_cu2' })
    expect(again.nothing_new).toBe(true)
    expect(again.note).toContain('Nothing new since your last catch-up.')
    expect(again.note).not.toContain('id wizard_cu |')
    expect(again.records).toEqual([])
    // A record that changes after it was shown comes back; a chat with a new reply comes back.
    clock += 60_000
    b.inbox.update(confirm, { ask: 'Send the invoice today' })
    b.pages.get('wizard_a')!.push({ role: 'assistant', content: `New detail\n${status('needs_you', 'Pick now')}`, timestamp: now + 500 })
    b.rows[0].last_active = now + 500
    const third = await b.catchUp.compose({ threadId: 'wizard_cu3' })
    expect(third.nothing_new).toBe(false)
    expect(third.chats).toEqual(['wizard_a'])
    expect(third.records).toEqual([confirm])
    expect(third.note).toContain('1 chat was already in the last catch-up')
  })

  it('keeps the sweep card\u2019s hard caps: 7 waiting and 10 finished, the rest as "N more" for the next one', async () => {
    const b = box()
    const waiting = Array.from({ length: 9 }, (_, n) => { clock += 1; return b.record('needs_you', `Synthetic ask ${n}`) })
    const finished = Array.from({ length: 12 }, (_, n) => { clock += 1; return b.record(n % 2 ? 'fyi' : 'result', `Synthetic result ${n}`) })
    const out = await b.catchUp.compose({ threadId: 'wizard_cu' })
    expect(out.records.length).toBe(17)
    expect(out.note).toContain('- 2 more: show as "2 more".')
    expect(waiting.slice(0, 7).every(id => out.note.includes(`id ${id}`))).toBe(true)
    expect(out.note).not.toContain(`id ${waiting[8]}`)
    expect(finished.filter(id => b.inbox.get(id)!.state === 'archived').length).toBe(10)
    const next = await b.catchUp.compose({ threadId: 'wizard_cu2' })
    expect(next.records.length).toBe(4)
  })

  it('works with the agent inbox off and says so', async () => {
    const out = await box({ inboxOn: false }).catchUp.compose({ threadId: 'wizard_cu' })
    expect(out.note).toContain('The agent inbox is off on this Wizard.')
  })
})

describe('wizard_catch_up', () => {
  const text = (r: any) => r.content[0].text
  it('acts only after the owner answered, and only on what the catch-up showed', async () => {
    const now = clock / 1000
    const b = box({ chats: [{ id: 'wizard_a', at: now - 60 }, { id: 'wizard_b', at: now - 30 }] })
    const confirm = b.record('needs_you', 'Send the invoice', { confirm: true })
    const tool = b.catchUp.tools
    expect(tool.list().map((t: any) => t.name)).toEqual([CATCH_UP_TOOL])
    expect(await tool.call('wizard_other', {})).toBeUndefined()
    expect((await tool.call(CATCH_UP_TOOL, { action: 'clear', chats: ['wizard_a'] })).isError).toBe(true)
    await b.catchUp.compose({ threadId: 'wizard_cu' })
    const early = await tool.call(CATCH_UP_TOOL, { action: 'clear', chats: ['wizard_a'] })
    expect(early.isError).toBe(true)
    expect(text(early)).toContain('has not answered')
    // His own words elsewhere, or a new "catch me up", are not an answer.
    expect(b.catchUp.ownerTurn('wizard_other', 'clear')).toBe(false)
    expect(b.catchUp.ownerTurn('wizard_cu', 'catch me up')).toBe(false)
    expect((await tool.call(CATCH_UP_TOOL, { action: 'defer', chats: ['wizard_b'] })).isError).toBe(true)
    expect(b.archived).toEqual([])
    clock += 30_000
    expect(b.catchUp.ownerTurn('wizard_cu', 'clear except 2')).toBe(true)
    const cleared = await tool.call(CATCH_UP_TOOL, { action: 'clear', chats: ['wizard_a', 'wizard_never_shown'], records: [confirm] })
    expect(cleared.isError).toBeUndefined()
    expect(text(cleared)).toContain('Cleared 2')
    expect(text(cleared)).toContain('wizard_never_shown (not in this catch-up)')
    expect(b.archived).toEqual(['wizard_a'])
    expect(b.inbox.get(confirm)!.state).toBe('archived')
    const deferred = await tool.call(CATCH_UP_TOOL, { action: 'defer', chats: ['wizard_b'], items: ['Mail: Sam\u2019s invoice'] })
    expect(text(deferred)).toContain('Deferred 2')
    expect(b.catchUp.deferred().items.map((i: any) => i.label)).toEqual(['Mail: Sam\u2019s invoice'])
    // The next catch-up skips the deferred chat and names the deferred item.
    clock += 60_000
    const next = await b.catchUp.compose({ threadId: 'wizard_cu2' })
    expect(next.chats).toEqual([])
    expect(next.note).toContain('skip them: "Mail: Sam\u2019s invoice"')
    expect((await tool.call(CATCH_UP_TOOL, { action: 'pay' })).isError).toBe(true)
  })

  it('a catch-up answered more than a day later must be run again', async () => {
    const b = box({ chats: [{ id: 'wizard_a', at: clock / 1000 - 60 }] })
    await b.catchUp.compose({ threadId: 'wizard_cu' })
    clock += 25 * 3600_000
    expect(b.catchUp.ownerTurn('wizard_cu', 'clear')).toBe(false)
    expect((await b.catchUp.tools.call(CATCH_UP_TOOL, { action: 'clear', chats: ['wizard_a'] })).isError).toBe(true)
  })

  it('survives a restart', async () => {
    const b = box({ chats: [{ id: 'wizard_a', at: clock / 1000 - 60 }] })
    await b.catchUp.compose({ threadId: 'wizard_cu' })
    const again = createCatchUp({ statePath: join(root, 'catch-up.json'), now: () => clock, inbox: null, readChats: async () => b.rows, readTurns: async (id: string) => ({ data: b.pages.get(id) ?? [] }), archiveChat: async () => {}, log: () => {} })
    expect(again.latest()?.thread_id).toBe('wizard_cu')
    expect((await again.compose({ threadId: 'wizard_cu2' })).nothing_new).toBe(true)
  })
})
