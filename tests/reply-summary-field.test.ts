import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen, projectWizardMessageHistory } from '../server/service.mjs'
import { projectStatusMarkers, askMaxFor, withAskMax, fullStatusAsk, parseStatus } from '../server/thread-status.mjs'
import { runInstructions } from '../server/service.mjs'
import { validateUiPreferences, updateUiPreferences } from '../server/ui-preferences.mjs'
import { writeFileSync } from 'node:fs'

// A long reply's own hidden status line already holds a plain-words ask written for someone reading cold.
// The Wizard history view keeps it on the row (wizard_ask / wizard_state) so a shell can show it first.
const marker = '[WIZARD_STATUS_V1]{"state":"check","ask":"New chat groups are live. Say if the 11 groups feel right","subject":"Wizard OS"}[/WIZARD_STATUS_V1]'
const reply = { id: 9, session_id: 'wizard_fixture', role: 'assistant', timestamp: 200, finish_reason: 'stop', content: `Long technical body.\n\n${marker}` }
const viewOf = (rows: unknown[]) => {
  const source = Buffer.from(JSON.stringify({ data: rows }))
  // Same order as the service: markers are stripped first, the Wizard view reads the untouched source.
  return JSON.parse(projectWizardMessageHistory(projectStatusMarkers(source), source).toString()).data
}
const servers: Array<ReturnType<typeof createServer>> = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('reply summary on Wizard history rows', () => {
  it('carries the status ask and state beside the stripped text', () => {
    const [row] = viewOf([reply])
    expect(row.content).toBe('Long technical body.')
    expect(row.wizard_ask).toBe('New chat groups are live. Say if the 11 groups feel right')
    expect(row.wizard_state).toBe('check')
    expect(JSON.stringify(row)).not.toContain('WIZARD_STATUS_V1')
  })

  it('keeps a long ask whole on the row (the 140-char clip is only for the chat list)', () => {
    const ask = "Short-answer-plus-Details is a Wizard OS feature, on only for you for now. Asked James's team on GitHub to merge it and consider it for everyone"
    expect(ask.length).toBeGreaterThan(140)
    const long = { ...reply, content: `Long technical body.\n\n[WIZARD_STATUS_V1]${JSON.stringify({ state: 'fyi', ask, subject: 'Wizard OS' })}[/WIZARD_STATUS_V1]` }
    const [row] = viewOf([long])
    expect(row.wizard_ask).toBe(ask)
    expect(row.wizard_ask).not.toContain('…')
  })

  it('adds nothing for replies without a status, malformed ones, or owner text quoting a marker', () => {
    const rows = viewOf([
      { ...reply, id: 1, content: 'No status here.' },
      { ...reply, id: 2, content: 'Bad.\n[WIZARD_STATUS_V1]{not json}[/WIZARD_STATUS_V1]' },
      { ...reply, id: 3, role: 'user', content: `Quoting: ${marker}` },
      // A valid marker quoted as an example, with the reply continuing after it, is not this reply's status.
      { ...reply, id: 4, content: `The line looks like ${marker} and then I kept explaining.` },
      // Non-final assistant rows ending in a valid marker are not the reply's answer.
      { ...reply, id: 5, display_kind: 'commentary' },
      { ...reply, id: 6, display_kind: 'hidden' },
      { ...reply, id: 7, tool_calls: [{ id: 'c1', function: { name: 'terminal', arguments: '{}' } }] },
      { ...reply, id: 8, finish_reason: 'length' },
    ])
    for (const row of rows) { expect(row).not.toHaveProperty('wizard_ask'); expect(row).not.toHaveProperty('wizard_state') }
  })

  it('reaches the shell through the HTTP history route (view=wizard)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'reply-summary-test-'))
    directories.push(directory)
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ data: [reply], pagination: { returned: 1 } }))
    })
    servers.push(upstream)
    const upstreamAddress = await listen(upstream)
    const proxy = createWizardServer({ requireJoinedDelegationCapability: false, upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`, hermesKey: 'fixture-server-key', requireAccess: false,
      hermesStatePath: join(directory, 'absent-state.db'), inboxDbPath: join(directory, 'absent-inbox.db') })
    servers.push(proxy)
    const address = await listen(proxy)
    const payload = await (await fetch(`http://127.0.0.1:${address.port}/wizard/hermes/api/sessions/wizard_fixture/messages?order=oldest&view=wizard`)).json()
    expect(payload.data[0]).toMatchObject({ role: 'assistant', content: 'Long technical body.', wizard_ask: 'New chat groups are live. Say if the 11 groups feel right', wizard_state: 'check' })
    // Without the Wizard view the row is unchanged apart from the stripped marker.
    const raw = await (await fetch(`http://127.0.0.1:${address.port}/wizard/hermes/api/sessions/wizard_fixture/messages?order=oldest`)).json()
    expect(raw.data[0]).not.toHaveProperty('wizard_ask')
    expect(JSON.stringify(raw)).not.toContain('WIZARD_STATUS_V1')
  })

  it('the short-answer length sets the ask budget only while the reply-summary view is on; the list clip stays 140', () => {
    expect(askMaxFor({})).toBe(140)
    expect(askMaxFor({ replySummary: { on: false, length: 'paragraph' } })).toBe(140)
    expect(askMaxFor({ replySummary: { on: true } })).toBe(140)
    expect(askMaxFor({ replySummary: { on: true, length: 'line' } })).toBe(80)
    expect(askMaxFor({ replySummary: { on: true, length: 'sentences' } })).toBe(140)
    expect(askMaxFor({ replySummary: { on: true, length: 'paragraph' } })).toBe(300)
    const base = runInstructions({ join: true })
    expect(base).toContain('at most 140 characters')
    expect(withAskMax(base, 140)).toBe(base)
    const long = withAskMax(base, 300)
    // Protocol only: the one number changes, nothing else in the run contract does.
    expect(long).toBe(base.replace('at most 140 characters', 'at most 300 characters'))
    const ask = 'x '.repeat(150).trim()
    const text = `Body.\n\n[WIZARD_STATUS_V1]${JSON.stringify({ state: 'fyi', ask })}[/WIZARD_STATUS_V1]`
    expect(fullStatusAsk(text)).toBe(ask)
    expect(parseStatus(text)?.ask.length).toBeLessThanOrEqual(140)
  })

  it('replySummary is a strict ui-preferences key', () => {
    expect(() => validateUiPreferences({ replySummary: { on: true, start: 'expanded', length: 'paragraph' } })).not.toThrow()
    for (const replySummary of [{}, { on: 'yes' }, { on: true, length: 'essay' }, { on: true, start: 'open' }, { on: true, style: 'bold' }, []])
      expect(() => validateUiPreferences({ replySummary })).toThrow('invalid_preferences')
  })

  it('a run sent while the owner chose Short paragraph carries the 300-character ask rule', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'reply-summary-run-'))
    directories.push(directory)
    const bodies: any[] = []
    const upstream = createServer((request, response) => {
      let raw = ''
      request.on('data', c => { raw += c }).on('end', () => {
        if (request.method === 'POST' && request.url?.startsWith('/v1/runs')) bodies.push(JSON.parse(raw))
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(request.url?.startsWith('/v1/runs') ? { run_id: 'run_fixture', status: 'started' } : { data: [] }))
      })
    })
    servers.push(upstream)
    const upstreamAddress = await listen(upstream)
    const proxy = createWizardServer({ requireJoinedDelegationCapability: false, upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`, hermesKey: 'fixture-server-key', requireAccess: false,
      wizardOsHome: directory, hermesStatePath: join(directory, 'absent-state.db'), inboxDbPath: join(directory, 'absent-inbox.db') })
    servers.push(proxy)
    const address = await listen(proxy)
    const send = () => fetch(`http://127.0.0.1:${address.port}/wizard/hermes/v1/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: 'wizard_fixture_' + bodies.length, input: 'hi' }) })
    await send()
    updateUiPreferences(join(directory, 'ui-preferences.json'), { replySummary: { on: true, start: 'collapsed', length: 'paragraph' } })
    await send()
    for (let i = 0; i < 50 && bodies.length < 2; i++) await new Promise(r => setTimeout(r, 20))
    expect(bodies[0].instructions).toContain('at most 140 characters')
    expect(bodies[1].instructions).toContain('at most 300 characters')
    expect(bodies[1].instructions).not.toContain('at most 140 characters')
  })
})
