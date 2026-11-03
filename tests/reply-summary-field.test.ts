import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen, projectWizardMessageHistory } from '../server/service.mjs'
import { projectStatusMarkers } from '../server/thread-status.mjs'

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

  it('adds nothing for replies without a status, malformed ones, or owner text quoting a marker', () => {
    const rows = viewOf([
      { ...reply, id: 1, content: 'No status here.' },
      { ...reply, id: 2, content: 'Bad.\n[WIZARD_STATUS_V1]{not json}[/WIZARD_STATUS_V1]' },
      { ...reply, id: 3, role: 'user', content: `Quoting: ${marker}` },
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
})
