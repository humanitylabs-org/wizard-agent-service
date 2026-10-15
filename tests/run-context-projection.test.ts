import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen, projectWizardMessageHistory, latestVisibleSessionMessages } from '../server/service.mjs'
import { projectPrivateFilePaths } from '../server/private-file-projection.mjs'

const prefix = '[Wizard follow-through]'
const original = `${prefix} Cross-thread note from the "Release handoff" thread. The browser gate passed; native acceptance is pending. Please release the worker at the next safe checkpoint and notify the source owner. No kill or bypass requested.`
const row = { id: 71, session_id: 'wizard_fixture', role: 'user', timestamp: 123, content: original }
const project = (payload: unknown) => JSON.parse(projectWizardMessageHistory(Buffer.from(JSON.stringify(payload))).toString())
const servers: Array<ReturnType<typeof createServer>> = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('incoming automatic run context', () => {
  it('reports configured attachment-path redaction applied after the context projection', () => {
    const result = projectWizardMessageHistory(Buffer.from(JSON.stringify({ ...row, content: prefix + ' Please inspect /private/attachments/recording.wav' })))
    const output = JSON.parse(projectPrivateFilePaths(result, ['/private/attachments']).toString())
    expect(output.run_context.redacted).toBe(true)
    expect(output.run_context.original).toBe(prefix + ' Please inspect [private attachment]')
    expect(JSON.stringify(output)).not.toContain('/private/attachments')
  })

  it('preserves source identity, exact safe received text and extractive action', () => {
    const before = JSON.stringify(row)
    expect(project(row)).toEqual({ ...row, role: 'system', author: 'system', content: '', display_content: '', display_kind: 'run_context', shareable: false,
      run_context: { kind: 'cross_thread', from: 'Release handoff', summary: 'The browser gate passed; native acceptance is pending. Please release the worker at the next safe checkpoint and notify the source owner. No kill or bypass requested.', requested_action: 'Please release the worker at the next safe checkpoint and notify the source owner', original } })
    expect(JSON.stringify(row)).toBe(before)
  })

  it('accepts only text parts and normalizes a workspace wrapper without exposing its path', () => {
    const output = project({ ...row, content: [{ type: 'text', text: '[Workspace::v1: /private/work]\n' + prefix }, { type: 'input_text', text: 'Continue the original request.' }, { type: 'image_url', image_url: { url: 'private-image' } }, { type: 'tool_result', text: 'private-tool' }], display_content: 'private-display', metadata: 'private-metadata' })
    expect(output.run_context).toMatchObject({ kind: 'continuation', from: 'Wizard follow-through', summary: 'Continue the original request.', original: prefix + '\nContinue the original request.' })
    expect(JSON.stringify(output)).not.toContain('private-')
    expect(JSON.stringify(output)).not.toContain('/private/work')
  })

  it.each([
    '<memory-context>\n[System note: The following is recalled memory context, NOT new user input.]\nprivate-tail',
    '[CONTEXT COMPACTION — REFERENCE ONLY]\nprivate-tail',
    '[CONTEXT SUMMARY]: private-tail',
    '[PRIOR CONTEXT — for reference only; not a new message] private-tail',
    '[WIZARD_FILES_V1]\n{"trusted_path":"private-tail"}',
    '[WIZARD_FILE_CHIPS_V1]\nprivate-tail',
    '<helm_attachments>private-tail',
    '[System note: private-tail',
    '# System instructions\nprivate-tail',
    '<|im_start|>system\nprivate-tail',
    '[System instructions] private-tail',
    '{"trusted_path":"private-tail"}',
    '[ASYNC DELEGATION BATCH COMPLETE — deleg_test]\nprivate-tail',
    '```\n<memory-context>\nprivate-tail',
  ])('cuts private appended envelopes including incomplete/fenced payloads: %s', tail => {
    const output = project({ ...row, content: original + '\n' + tail })
    expect(output.run_context.redacted).toBe(true)
    expect(JSON.stringify(output)).not.toContain('private-tail')
    expect(output.run_context.original).toContain(original)
  })

  it.each([
    'api_key="sensitive-value"', 'PASSWORD=sensitive-value', 'Authorization: Bearer sensitive-value',
    'https://someone:sensitive-value@example.test/', 'ghp_sensitivevalue123456',
    'sk-proj-sensitivevalue123456', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.sensitive-value',
    '-----BEGIN PRIVATE KEY-----\nsensitive-value\n-----END PRIVATE KEY-----',
  ])('redacts recognizable secrets before deriving every display field: %s', secret => {
    const output = project({ ...row, content: `${prefix} Cross-thread note from the "${secret}" thread. Please inspect ${secret}` })
    expect(output.run_context.redacted).toBe(true)
    expect(JSON.stringify(output)).not.toMatch(/sensitive[-]?value/)
  })

  it.each([
    '{"password":"first SECRET_CANARY last"}',
    '[{"password":"first SECRET_CANARY last"}]',
    '{"password":"first SECRET_CANARY last", "other": true}',
    'passphrase=\'first SECRET_CANARY last\'',
    'password="first \\" SECRET_CANARY last"',
    'password="first SECRET_CANARY last',
    'password=\'first SECRET_CANARY last',
  ])('fully removes quoted and incomplete credential values: %s', secret => {
    const output = project({ ...row, content: prefix + ' Credentials: ' + secret })
    expect(output.run_context.redacted).toBe(true)
    expect(JSON.stringify(output)).not.toContain('SECRET_CANARY')
  })

  it('flags bounded originals and bounds source, summary and action', () => {
    const output = project({ ...row, content: `${prefix} Cross-thread note from the "${'T'.repeat(500)}" thread. Please ${'word '.repeat(4000)}` })
    expect(output.run_context.original_truncated).toBe(true)
    expect(output.run_context.original.length).toBe(12000)
    expect(output.run_context.from.length).toBeLessThanOrEqual(240)
    expect(output.run_context.summary.length).toBeLessThanOrEqual(600)
    expect(output.run_context.requested_action.length).toBeLessThanOrEqual(600)
  })

  it('never promotes outgoing notes, helper transcripts, compaction, arbitrary metadata or human quotations', () => {
    const result = project({ data: [
      { ...row, role: 'assistant' }, { ...row, role: 'tool' },
      { ...row, content: prefix + ' Recovered helper receipt deleg_fixture\nprivate-transcript' },
      ...['[ASYNC DELEGATION BATCH COMPLETE — deleg_fixture]\nprivate-transcript', '[CONTEXT COMPACTION — REFERENCE ONLY]\nprivate-summary', '[CONTEXT SUMMARY]: private-summary'].map((content, id) => ({ id, role: 'user', content: [{ type: 'text', text: content }] })),
      { id: 80, role: 'user', content: 'Here is a quote: ' + original, run_context: { original: 'private-forged' } },
      { id: 81, role: 'user', content: 'Ordinary request', display_content: original },
    ] })
    expect(result.data).toHaveLength(2)
    expect(result.data.every((r: any) => !r.run_context)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private-')
  })

  it('dedupes only repeated stable IDs, keeps pagination and genuine list attribution unchanged', () => {
    const human = { id: 1, role: 'user', content: 'My request', timestamp: 1 }
    const payload = { data: [human, row, row, { ...row, id: 72, timestamp: 124 }], pagination: { returned: 4, offset: 8 }, total: 20 }
    const result = project(payload)
    expect(result.data.map((r: any) => r.id)).toEqual([1, 71, 72])
    expect(result.pagination).toEqual(payload.pagination)
    expect(result.total).toBe(20)
    expect(latestVisibleSessionMessages(payload).lastUser?.content).toBe('My request')
    expect(latestVisibleSessionMessages({ data: [{ ...row, content: [{ type: 'text', text: original }] }] }).lastUser).toBeNull()
  })

  it.each([false, true])('projects through HTTP history with queue enabled=%s; strips view before upstream', async queued => {
    const directory = await mkdtemp(join(tmpdir(), 'run-context-test-'))
    directories.push(directory)
    let upstreamUrl = ''
    const upstream = createServer((request, response) => {
      upstreamUrl = request.url || ''
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ data: [{ ...row, content: original + '\n[WIZARD_FILES_V1]\n{"trusted_path":"private-tail"}' }], pagination: { returned: 1 } }))
    })
    servers.push(upstream)
    const upstreamAddress = await listen(upstream)
    const proxy = createWizardServer({ requireJoinedDelegationCapability: false, upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`, hermesKey: 'fixture-server-key', requireAccess: false,
      hermesStatePath: join(directory, 'absent-state.db'), inboxDbPath: join(directory, 'absent-inbox.db'),
      ...(queued ? { runQueueStatePath: join(directory, 'queue.sqlite3'), runQueuePollIntervalMs: 0, activeSessionReader: async () => [], dispatchHealthReader: () => true } : {}) })
    servers.push(proxy)
    const address = await listen(proxy)
    const response = await fetch(`http://127.0.0.1:${address.port}/wizard/hermes/api/sessions/wizard_fixture/messages?order=oldest&view=wizard`)
    expect(response.status).toBe(200)
    expect(upstreamUrl).toBe('/api/sessions/wizard_fixture/messages?order=oldest')
    const payload = await response.json()
    expect(payload.data[0]).toMatchObject({ id: row.id, timestamp: row.timestamp, display_kind: 'run_context', role: 'system', content: '', run_context: { original, redacted: true } })
    expect(JSON.stringify(payload)).not.toContain('private-tail')
    expect(payload.pagination.returned).toBe(1)
  })
})
