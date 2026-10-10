import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { STATUS_INSTRUCTIONS, StatusBackfill, normalizeStatus, parseStatus, projectStatusMarkers, stripStatus } from '../server/thread-status.mjs'
import { WIZARD_RUN_INSTRUCTIONS, latestVisibleSessionMessages, runInstructions } from '../server/service.mjs'

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

  it('is part of every Wizard run instruction set', () => {
    expect(WIZARD_RUN_INSTRUCTIONS).toContain(STATUS_INSTRUCTIONS)
    expect(runInstructions({ join: false })).toContain('[WIZARD_STATUS_V1]')
  })
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
