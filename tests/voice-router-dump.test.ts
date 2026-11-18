// Issue 551: the orb's dump route. A new task request goes to the background (dump); "reply", "tell me", a
// conversation and a short direct question stay a visible thread; commands and view answers are unchanged; and with
// the dump route off (switch off or an older shell) the routing is exactly what it was.
import { describe, expect, it } from 'vitest'
import { routeUtterance, routerSystemPrompt, dumpIntent, deadlineFrom, dumpTitle } from '../server/voice-router.mjs'

const router = { url: 'http://router.invalid/v1/chat/completions', model: 'fixture-router' }
const answering = (reply: unknown) => async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), { status: 200 })
const route = (text: string, reply: unknown, dump = true, extra = {}): Promise<any> =>
  routeUtterance({ input: { text, timezone: 'UTC', ...extra }, settings: {}, router, fetchImpl: answering(reply) as typeof fetch, dump, now: Date.UTC(2026, 10, 18, 12) })

// At least 20 utterances. Each is routed twice: once with a model that never says dump and once with one that always
// does, so the words alone settle every case here, whatever the model does.
const TASKS = [
  'Research flights to Lisbon for the second week of December',
  'Please draft a reply to the landlord about the broken boiler',
  'Can you look into why the backup failed last night',
  'Plan a three day trip to Porto in January',
  'Write up the notes from this morning as a short summary for Jan',
  'Book a table for four on Friday at the Italian place',
  'Sort out the receipts in my downloads folder by month',
  'Compare the three electricity offers and pick the cheapest',
  'Could you prepare the agenda for Thursday\'s team call',
  'I need you to follow up with the plumber about the invoice',
  'Find me a good dentist near the office',
  'Summarise the last ten emails from the accountant by Friday',
]
const VISIBLE = [
  'Research flights to Lisbon and tell me what you find',
  'Reply to me with the three best options for a new laptop',
  'Tell me about the history of the Alhambra',
  'What time is it in Tokyo?',
  'How much is left on the grocery budget?',
  'Is the train to Utrecht running today?',
  'Who wrote The Remains of the Day',
  'Let\'s talk about my week',
  'Good morning',
  'Thanks, that was great',
]

describe('dump route (issue 551)', () => {
  it('has a fixture of at least 20 utterances', () => expect(TASKS.length + VISIBLE.length).toBeGreaterThanOrEqual(20))

  it.each(TASKS)('a new task request routes to dump: %s', async text => {
    for (const reply of [{ route: 'agent', summary: 'x' }, { route: 'dump', title: 'Model title' }]) {
      const { cmd } = await route(text, reply)
      expect(cmd.route).toBe('dump')
      expect(cmd.title.length).toBeGreaterThan(0)
      expect(cmd.title.length).toBeLessThanOrEqual(60)
    }
  })

  it.each(VISIBLE)('reply / tell me / a short direct question stays visible: %s', async text => {
    for (const reply of [{ route: 'agent', summary: 'x' }, { route: 'dump', title: 'Model title' }]) {
      expect((await route(text, reply)).cmd.route).toBe('agent')
    }
  })

  it('leaves unclear words to the model', async () => {
    const text = 'The thing with the car insurance renewal'
    expect(dumpIntent(text)).toBe('')
    expect((await route(text, { route: 'dump', title: 'Car insurance renewal' })).cmd).toMatchObject({ route: 'dump', title: 'Car insurance renewal' })
    expect((await route(text, { route: 'agent', summary: 'car insurance' })).cmd.route).toBe('agent')
  })

  it('keeps commands and view answers unchanged', async () => {
    const command = { route: 'command', action: 'open_app', app: 'Notes', then_agent: 'research recipes' }
    expect((await route('Open notes and research recipes', command)).cmd).toEqual(command)
    expect((await route('Research it', { route: 'view' }, true, { view: { name: 'Mail', kind: 'app' } })).cmd).toEqual({ route: 'view' })
  })

  it('with the dump route off, routes exactly as before', async () => {
    expect((await route(TASKS[0], { route: 'agent', summary: 'flights' }, false)).cmd).toEqual({ route: 'agent', summary: 'flights' })
    expect((await route(TASKS[0], { route: 'dump', title: 'Flights' }, false)).cmd).toEqual({ route: 'agent', summary: TASKS[0] })
    const before = routerSystemPrompt({ settings: {}, apps: [], timezone: 'UTC', view: null, force: false, now: new Date(Date.UTC(2026, 10, 18)) })
    expect(before).not.toContain('dump')
    expect(routerSystemPrompt({ settings: {}, apps: [], timezone: 'UTC', view: null, force: false, now: new Date(Date.UTC(2026, 10, 18)), dump: true })).toContain('"route":"dump"')
  })

  it('reads a deadline from the words, in the owner\'s time zone', () => {
    const now = Date.UTC(2026, 10, 18, 12) // Wednesday
    expect(deadlineFrom('do it today', 'UTC', now)).toBe('2026-11-18T23:59:00.000Z')
    expect(deadlineFrom('by tomorrow please', 'UTC', now)).toBe('2026-11-19T23:59:00.000Z')
    expect(deadlineFrom('book it by Friday', 'UTC', now)).toBe('2026-11-20T23:59:00.000Z')
    expect(deadlineFrom('by Friday', 'Europe/Amsterdam', now)).toBe('2026-11-20T22:59:00.000Z')
    expect(deadlineFrom('plan the trip', 'UTC', now)).toBeNull()
    expect(deadlineFrom('by next Wednesday', 'UTC', now)).toBe('2026-11-25T23:59:00.000Z')
    expect(deadlineFrom('by Wednesday', 'UTC', now)).toBe('2026-11-18T23:59:00.000Z')
  })

  it('titles a dump from the words when the model gives none', () => {
    expect(dumpTitle({}, 'Can you please look into the backup failure?')).toBe('Look into the backup failure')
    expect(dumpTitle({ title: 'Backup failure' }, 'whatever')).toBe('Backup failure')
  })
})
