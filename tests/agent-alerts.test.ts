// Issue 552: alert rules. Fixed rules first, the owner's examples, the fast private model for borderline events,
// everything else waits for the sweep; the volume guard collapses the 4th alert of a day and flags the rules.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentInboxStore } from '../server/agent-inbox.mjs'
import { AlertRulesFile, classifyEvent, createAlertGate, defaultRules, normalizeEvent, privateRouter, COLLAPSED_TITLE } from '../server/agent-alerts.mjs'
import { cardMarkdown } from '../server/agent-sweep.mjs'

const T0 = Date.parse('2026-11-18T09:00:00Z')
const clock = (start = T0) => { const c = { at: start, now: () => c.at++ }; return c }
const router = { url: 'http://127.0.0.1:9/v1/chat/completions', model: 'fixture-private', account: 'tinfoil' }
const modelSaying = (urgent: boolean, calls: any[] = []) => async (_url: string, init: any) => {
  calls.push(JSON.parse(init.body))
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ urgent, reason: urgent ? 'Named person waiting today' : 'Routine update' }) } }] }), { status: 200 })
}
const setup = ({ urgent = false, calls = [] as any[], notified = [] as any[], rulesPath = '', withRouter = true } = {}) => {
  const c = clock()
  const inbox = new AgentInboxStore('', { now: c.now, log: () => undefined })
  const rules = new AlertRulesFile(rulesPath)
  const gate = createAlertGate({ inbox, rules, now: c.now, timezone: () => 'UTC', log: () => undefined,
    router: () => withRouter ? router : null, fetchImpl: modelSaying(urgent, calls) as any,
    notify: { available: () => true, send: async (n: any) => { notified.push(n) } } })
  return { c, inbox, rules, gate, calls, notified }
}
let n = 0
const mail = (extra: any = {}) => ({ type: 'mail', source: { app: 'wizard-mail', item: `msg-${++n}` }, sender: { name: 'Synthetic Sender', email: `sender${n}@example.test` }, title: `Synthetic mail ${n}`, ask: `Synthetic body ${n}`, ...extra })

describe('alert rules: stages', () => {
  it('rule hits (named sender, payment failed, meeting within 2 h) reach Alerts and are notified once', async () => {
    const { gate, rules, notified, calls } = setup()
    rules.edit({ senders: ['boss@example.test'] })
    const a = await gate.consider(mail({ sender: 'Synthetic Boss <Boss@example.test>' }))
    const b = await gate.consider({ type: 'payment_failed', source: { app: 'wizard-money', item: 'p1' }, title: 'Card payment failed', ask: 'Synthetic subscription payment failed' })
    const c = await gate.consider({ type: 'meeting', source: { app: 'wizard-calendar', item: 'e1' }, title: 'Synthetic meeting', starts_at: new Date(T0 + 90 * 60_000).toISOString() })
    for (const [r, rule] of [[a, 'sender'], [b, 'payment_failed'], [c, 'meeting_soon']] as const) {
      expect(r.record.kind).toBe('alert')
      expect(r.record.state).toBe('new')
      expect(r.decision.rule).toBe(rule)
      expect(r.record.notified).toBe(true)
    }
    expect(notified.map(x => x.title)).toEqual(['Synthetic mail 1', 'Card payment failed', 'Synthetic meeting'])
    expect(calls).toHaveLength(0)
    // The same event posted again is the same record and no second notification.
    const again = await gate.consider({ type: 'payment_failed', source: { app: 'wizard-money', item: 'p1' }, title: 'Card payment failed', ask: 'Synthetic subscription payment failed' })
    expect(again.created).toBe(false)
    expect(again.record.id).toBe(b.record.id)
    expect(notified).toHaveLength(3)
  })

  it('the same event posted twice at once is one record and one notification', async () => {
    const calls: any[] = []
    const { gate, inbox, notified } = setup({ urgent: true, calls })
    const event = mail({ ask: 'Synthetic invoice due today', severity: 'high' })
    const [a, b] = await Promise.all([gate.consider(event), gate.consider(event)])
    expect(a.record.id).toBe(b.record.id)
    expect([a.created, b.created].sort()).toEqual([false, true])
    expect(notified).toHaveLength(1)
    expect(inbox.list({ kind: 'alert' })).toHaveLength(1)
    expect(normalizeEvent({ title: 'x', sender: 'Synthetic <b>Name</b> <name@example.test>' }).sender).toEqual({ name: 'Synthetic', email: 'name@example.test' })
  })

  it('a meeting three hours away is not a rule hit', () => {
    const e = normalizeEvent({ type: 'meeting', title: 'Later meeting', starts_at: new Date(T0 + 180 * 60_000).toISOString() })
    expect(classifyEvent(e, defaultRules(), T0).decision).toBe('sweep')
  })

  it('a fixture of 12 non-urgent events all land in the sweep, none lost and none notified', async () => {
    const { gate, inbox, notified, calls } = setup()
    const ids = []
    for (let i = 0; i < 12; i++) ids.push((await gate.consider(mail({ title: `Synthetic newsletter ${i}`, ask: `Synthetic weekly digest ${i}` }))).record.id)
    const later = inbox.list({ kind: 'fyi', state: 'new' }).map(r => r.id)
    expect(new Set(later)).toEqual(new Set(ids))
    expect(inbox.list({ kind: 'alert' })).toHaveLength(0)
    expect(notified).toHaveLength(0)
    expect(calls).toHaveLength(0)
    const card = inbox.sweep({ thread_id: 'wizard_daily', day: '2026-11-18' })
    expect(card.later.count).toBe(12)
  })

  it('a borderline event is decided by the private model and the decision is logged', async () => {
    const calls: any[] = []
    const yes = setup({ urgent: true, calls })
    const r = await yes.gate.consider(mail({ title: 'Synthetic invoice due', ask: 'Synthetic invoice due today', severity: 'high' }))
    expect(r.decision).toMatchObject({ stage: 'model', decision: 'alert', rule: 'model', model: 'fixture-private' })
    expect(r.record.kind).toBe('alert')
    expect(calls).toHaveLength(1)
    expect(calls[0].messages[0].content).toContain('Urgent means ONLY one of: money at risk')
    expect(yes.inbox.alertLog()[0]).toMatchObject({ record_id: r.record.id, stage: 'model', decision: 'alert', reason: 'Named person waiting today', model: 'fixture-private' })
    const no = setup({ urgent: false })
    const s = await no.gate.consider(mail({ title: 'Synthetic invoice', ask: 'Synthetic invoice attached', severity: 'high' }))
    expect(s.record.kind).toBe('fyi')
    expect(no.inbox.alertLog()[0]).toMatchObject({ stage: 'model', decision: 'sweep', reason: 'Routine update' })
  })

  it('a private event never goes to a model that is not private; it waits for the sweep', async () => {
    const calls: any[] = []
    const c = clock()
    const inbox = new AgentInboxStore('', { now: c.now, log: () => undefined })
    const gate = createAlertGate({ inbox, rules: new AlertRulesFile(''), now: c.now, log: () => undefined,
      router: () => ({ url: 'https://api.example.test/v1/chat/completions', model: 'cloud', account: 'chatgpt' }), fetchImpl: modelSaying(true, calls) as any })
    const r = await gate.consider(mail({ ask: 'Synthetic invoice overdue', severity: 'urgent' }))
    expect(r.record.kind).toBe('fyi')
    expect(r.decision.rule).toBe('no_private_model')
    expect(calls).toHaveLength(0)
    expect(privateRouter(router)).toBe(true)
  })

  it('a model failure leaves the event in the sweep', async () => {
    const c = clock()
    const inbox = new AgentInboxStore('', { now: c.now, log: () => undefined })
    const gate = createAlertGate({ inbox, rules: new AlertRulesFile(''), now: c.now, log: () => undefined, router: () => router,
      fetchImpl: (async () => new Response('nope', { status: 500 })) as any })
    const r = await gate.consider(mail({ ask: 'Synthetic payment question', severity: 'high' }))
    expect(r.record.kind).toBe('fyi')
    expect(r.decision.rule).toBe('model_failed')
  })
})

describe('alert rules: feedback', () => {
  it('Not urgent and Should have alerted each add one example to the rules file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alerts-'))
    try {
      const path = join(dir, 'alert-rules.json')
      const { gate, rules } = setup({ rulesPath: path })
      rules.edit({ senders: ['loud@example.test'] })
      const alert = (await gate.consider(mail({ sender: 'loud@example.test' }))).record
      const quiet = (await gate.consider(mail({ sender: 'Synthetic Friend <friend@example.test>' }))).record
      expect(quiet.kind).toBe('fyi')
      const a = gate.feedback(alert.id, 'not_urgent')!
      expect(a.rules.examples.not_urgent).toHaveLength(1)
      expect(a.record).toMatchObject({ kind: 'fyi', state: 'new' })
      const b = gate.feedback(quiet.id, 'should_alert')!
      expect(b.rules.examples.should_alert).toHaveLength(1)
      const onDisk = JSON.parse(readFileSync(path, 'utf8'))
      expect(onDisk.examples.not_urgent).toHaveLength(1)
      expect(onDisk.examples.should_alert).toHaveLength(1)
      expect(onDisk.examples.should_alert[0]).toMatchObject({ app: 'wizard-mail', type: 'mail', sender: 'friend@example.test' })
      // The next mail from that friend alerts by the example; no model needed.
      const next = await gate.consider(mail({ sender: 'friend@example.test', title: 'Another synthetic mail' }))
      expect(next.decision).toMatchObject({ stage: 'example', rule: 'should_alert_example' })
      expect(next.record.kind).toBe('alert')
      // Wrong kind of tap is refused.
      expect(() => gate.feedback(quiet.id, 'not_urgent')).toThrow(/not an alert/)
      // A hand edit of the file applies at once.
      writeFileSync(path, JSON.stringify({ ...onDisk, keywords: ['synthetic fire'] }))
      expect(rules.read().keywords).toEqual(['synthetic fire'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('alert rules: volume guard (fake clock)', () => {
  it('the 4th alert of a day produces one collapsed alert and a rules flag in the next sweep', async () => {
    const { gate, inbox, rules, notified, c } = setup()
    rules.edit({ senders: ['loud@example.test'] })
    for (let i = 0; i < 3; i++) expect((await gate.consider(mail({ sender: 'loud@example.test' }))).record.kind).toBe('alert')
    const fourth = await gate.consider(mail({ sender: 'loud@example.test', title: 'Fourth synthetic' }))
    expect(fourth.record.kind).toBe('fyi')
    expect(fourth.record.alert_held).toBe(true)
    const fifth = await gate.consider(mail({ sender: 'loud@example.test', title: 'Fifth synthetic' }))
    expect(fifth.record.kind).toBe('fyi')
    const alerts = inbox.list({ kind: 'alert' })
    expect(alerts).toHaveLength(4)
    const collapsed = alerts.filter(r => r.alert_collapsed)
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0].title).toBe(COLLAPSED_TITLE)
    expect(collapsed[0].ask).toMatch(/^2 more alerts today/)
    expect(notified.map(x => x.title)).toEqual(['Synthetic mail ' + (n - 4), 'Synthetic mail ' + (n - 3), 'Synthetic mail ' + (n - 2), COLLAPSED_TITLE])
    const card = inbox.sweepView(inbox.sweep({ thread_id: 'wizard_daily', day: '2026-11-18' }))
    expect(card.rules_flag).toMatchObject({ day: '2026-11-18', alerts: 5, cap: 3 })
    expect(cardMarkdown(card)).toContain('Alert rules let 5 alerts through on 2026-11-18 (more than 3)')
    expect(card.later.count).toBe(2)
    // The flag rides on one card only.
    expect(inbox.sweep({ thread_id: 'wizard_daily', day: '2026-11-18' }).rules_flag).toBeUndefined()
    // Next day (after 05:00): alerts again.
    c.at = Date.parse('2026-11-19T06:00:00Z')
    expect((await gate.consider(mail({ sender: 'loud@example.test' }))).record.kind).toBe('alert')
  })
})

describe('alert rules: worker records', () => {
  it('a finished urgent worker record is checked once; a non-urgent one never makes a second record', async () => {
    const { gate, inbox, calls } = setup({ urgent: true })
    const quiet = inbox.capture({ thread_id: 'wizard_worker_a', title: 'Synthetic job', ask: 'Synthetic job' }, { ready: true }).record
    expect(await gate.considerRecord(quiet)).toBeNull()
    const loud = inbox.capture({ thread_id: 'wizard_worker_b', title: 'Synthetic urgent job', ask: 'Synthetic urgent ask', severity: 'urgent' }, { ready: true }).record
    const r = await gate.considerRecord(loud)
    expect(r!.record.kind).toBe('alert')
    expect(r!.record.link).toBe('/wizard-os-home/?session=wizard_worker_b')
    expect(await gate.considerRecord(inbox.get(loud.id))).toBeNull()
    expect(calls).toHaveLength(1)
    expect(inbox.list()).toHaveLength(3)
  })
})
