import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FINISH_REPORT_INSTRUCTIONS, STATUS_INSTRUCTIONS, StatusBackfill, normalizeStatus, parseStatus, projectStatusMarkers, stripStatus } from '../server/thread-status.mjs'
import { WIZARD_RUN_INSTRUCTIONS, latestVisibleSessionMessages, runInstructions } from '../server/service.mjs'
import { AGENT_RUN_INSTRUCTIONS } from '../server/agents-http.mjs'

const tag = (o: object) => `[WIZARD_STATUS_V1]${JSON.stringify(o)}[/WIZARD_STATUS_V1]`
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))) })

describe('thread status tag', () => {
  it('parses the last valid tag and normalises aliases', () => {
    const text = `Shipped.\n\n${tag({ state: 'fyi', ask: 'old' })}\n${tag({ state: 'needs you', ask: 'Decide whether to ship desks', subject: 'Wizard OS' })}`
    expect(parseStatus(text)).toEqual({ state: 'needs_you', ask: 'Decide whether to ship desks', subject: 'Wizard OS' })
    expect(parseStatus(tag({ state: 'qa', ask: 'Try the orb' }))?.state).toBe('check')
    expect(parseStatus(tag({ state: 'bogus', ask: 'x' }))).toBeNull()
    expect(parseStatus(tag({ state: 'done' }))).toBeNull()
    expect(parseStatus('[WIZARD_STATUS_V1]{not json[/WIZARD_STATUS_V1]')).toBeNull()
    expect(parseStatus('plain reply')).toBeNull()
  })

  it('clips long asks and subjects', () => {
    const s = normalizeStatus({ state: 'done', ask: 'a'.repeat(400), subject: 'b'.repeat(100) })
    expect(s!.ask.length).toBeLessThanOrEqual(140)
    expect(s!.subject!.length).toBeLessThanOrEqual(40)
  })

  it('strips complete and unterminated markers from visible text', () => {
    expect(stripStatus(`Answer.\n\n${tag({ state: 'done', ask: 'Fixed' })}`)).toBe('Answer.')
    expect(stripStatus('Answer.\n[WIZARD_STATUS_V1]{"state":"do')).toBe('Answer.')
    expect(stripStatus('No tag')).toBe('No tag')
  })

  it('removes the tag from message history JSON', () => {
    const history = Buffer.from(JSON.stringify({ data: [{ role: 'assistant', content: `Hi\n${tag({ state: 'fyi', ask: 'Hi' })}` }, { role: 'assistant', content: [{ type: 'text', text: `Hey ${tag({ state: 'done', ask: 'x' })}` }] }] }))
    const out = projectStatusMarkers(history).toString('utf8')
    expect(out).not.toContain('WIZARD_STATUS_V1')
    expect(JSON.parse(out).data[0].content).toBe('Hi')
  })

  it('defines done as verified-finished and check as the user\'s judgment call', () => {
    // James, 10 Oct 2026: "If you've QA'd something and you're 'Yep, the bug you reported is fixed', that should just be
    // reported as done. The QA ones for me should be like, you need me to see if this is what I meant or if I like it."
    expect(STATUS_INSTRUCTIONS).toContain('done (the request is finished and you verified it yourself, including a bug the user reported that you fixed and tested; a suggestion to try it never makes it check)')
    expect(STATUS_INSTRUCTIONS).toContain('check (only when the user\'s own judgment is the missing piece')
    expect(STATUS_INSTRUCTIONS).toContain('whether they like it (look, feel, wording, taste)')
    expect(STATUS_INSTRUCTIONS).toContain('never "Test that X works"')
    expect(STATUS_INSTRUCTIONS).not.toMatch(/should try or QA/)
  })

  it('keeps Ready asks understandable cold, situation-first, and free of internal jargon', () => {
    expect(STATUS_INSTRUCTIONS).toContain('140 characters')
    expect(STATUS_INSTRUCTIONS).toContain('read cold')
    expect(STATUS_INSTRUCTIONS).toContain('no PR')
    expect(STATUS_INSTRUCTIONS).toContain('first say what is waiting in everyday words, then the exact thing to do')
    expect(STATUS_INSTRUCTIONS).toContain('if the action is a reply word, the sentence says what that word does')
    expect(STATUS_INSTRUCTIONS).toContain('For check, say what changed and what to judge')
    expect(STATUS_INSTRUCTIONS).toContain('The reply itself ends with the same ask in plain words.')
    expect(STATUS_INSTRUCTIONS).not.toContain('under 90 characters')
  })

  it('is part of every Wizard run instruction set', () => {
    expect(WIZARD_RUN_INSTRUCTIONS).toContain(STATUS_INSTRUCTIONS)
    expect(runInstructions({ join: false })).toContain('[WIZARD_STATUS_V1]')
  })
})

describe('finish-report prompt', () => {
  it('preserves the approved wording including short-reply and background exceptions', () => {
    expect(FINISH_REPORT_INSTRUCTIONS).toBe('When a final reply finishes, fixes, ships or stages work (state done, check, or needs_you after work), format it as a finish report: first one plain verdict sentence in bold, with no label; then short paragraphs of one to three sentences, each starting with a bold label, in this order, leaving out any label with nothing to say: **What was wrong:** (fixes only), **What I did:**, **Does it work:** (the check that actually ran and what it returned, never "should work"), **What you need to do:** (one action; the same as the status ask when state is needs_you), **Still open:** (at most three bullets, each naming who owns it). No other headings, tables or recap; links sit inside the paragraph they belong to. Conversation, quick answers, ideation, interim progress and background-handoff messages stay free-form, and a reply that fits in three sentences never uses this format.')
  })

  for (const [kind, instructions] of [
    ['main', WIZARD_RUN_INSTRUCTIONS],
    ['host-profile', AGENT_RUN_INSTRUCTIONS],
    ['container', AGENT_RUN_INSTRUCTIONS],
    ['restricted', AGENT_RUN_INSTRUCTIONS],
  ]) {
    it(`puts the shared finish report immediately before the final status rule for ${kind}`, () => {
      expect(instructions).toContain(`${FINISH_REPORT_INSTRUCTIONS}\n\n${STATUS_INSTRUCTIONS}`)
      expect(instructions.endsWith(STATUS_INSTRUCTIONS)).toBe(true)
      expect(instructions.split(FINISH_REPORT_INSTRUCTIONS)).toHaveLength(2)
    })
  }
})

describe('session list status projection', () => {
  it('serves the latest assistant tag and a clean preview', () => {
    const rows = { data: [
      { role: 'user', content: 'Build it', timestamp: 100 },
      { role: 'assistant', content: `It is live.\n\n${tag({ state: 'check', ask: 'Try the new pill', subject: 'Wizard OS' })}`, timestamp: 200 },
    ] }
    const m = latestVisibleSessionMessages(rows)
    expect(m.status).toEqual({ state: 'check', ask: 'Try the new pill', subject: 'Wizard OS' })
    expect(m.latest.content).toBe('It is live.')
    expect(m.latest).not.toHaveProperty('status')
    expect(m.latestAssistantAt).toBe(200)
  })

  it('drops the status once the owner replies after it', () => {
    const rows = { data: [
      { role: 'assistant', content: `Done.\n${tag({ state: 'needs_you', ask: 'Approve it' })}`, timestamp: 200 },
      { role: 'user', content: 'Approved', timestamp: 300 },
    ] }
    expect(latestVisibleSessionMessages(rows).status).toBeNull()
  })

  it('a reply without a tag has no status', () => {
    expect(latestVisibleSessionMessages({ data: [{ role: 'assistant', content: 'Plain', timestamp: 5 }] }).status).toBeNull()
  })
})

describe('status backfill', () => {
  it('applies only to the exact reply it classified', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'status-backfill-')); dirs.push(dir)
    const path = join(dir, 'backfill.json')
    await writeFile(path, JSON.stringify({ threads: { t1: { state: 'needs_you', ask: 'Reply yes to build it', subject: 'Wizard OS', assistant_at: 1000.4 } } }))
    const store = new StatusBackfill(path)
    expect(store.lookup('t1', 1000)).toEqual({ state: 'needs_you', ask: 'Reply yes to build it', subject: 'Wizard OS' })
    expect(store.lookup('t1', 1500)).toBeNull()
    expect(store.lookup('t2', 1000)).toBeNull()
    expect(new StatusBackfill('').lookup('t1', 1000)).toBeNull()
  })
})

describe('needs_you means one clear action', () => {
  it('tells the agent needs_you is reserved for a specific user action, phrased as that action', () => {
    expect(STATUS_INSTRUCTIONS).toMatch(/needs_you \(only when the work cannot move until the user does one specific thing/)
    expect(STATUS_INSTRUCTIONS).toMatch(/optional next step[^.]*is not needs_you, use done or fyi/)
    expect(STATUS_INSTRUCTIONS).toMatch(/never a vague/)
  })
})
