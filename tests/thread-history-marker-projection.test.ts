import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'

const servers: Array<ReturnType<typeof createServer>> = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Wizard thread history marker projection', () => {
  it('restores a uniquely matched flattened screenshot only in the Wizard history display', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wizard-history-screenshot-repair-'))
    directories.push(directory)
    const queuePath = join(directory, 'queue.sqlite3')
    const at = Date.now() / 1000
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLh6wAAAABJRU5ErkJggg=='
    const flattened = 'Compare these\n[screenshot]\n[audio attached]'
    const source = {
      data: [
        { id: 'recover', role: 'user', timestamp: at, content: flattened, display_content: flattened },
        { id: 'assistant', role: 'assistant', timestamp: at, content: flattened },
        { id: 'wrong-message-session', session_id: 'other-session', role: 'user', timestamp: at, content: flattened },
        { id: 'already-structured', role: 'user', timestamp: at, content: [{ type: 'text', text: 'Already structured' }, { type: 'audio', audio_url: { url: 'data:audio/mp4;base64,AA==' } }] },
        { id: 'ambiguous', role: 'user', timestamp: at, content: 'Ambiguous\n[screenshot]' },
        { id: 'late', role: 'user', timestamp: at + 121, content: 'Late\n[screenshot]' },
        { id: 'cross-session', role: 'user', timestamp: at, content: 'Other session\n[screenshot]' },
        { id: 'unrecognized', role: 'user', timestamp: at, content: 'Unknown part\n[screenshot]' },
        { id: 'mismatched', role: 'user', timestamp: at, content: 'Mismatch\n[screenshot]\n[screenshot]' },
        { id: 'invalid-image', role: 'user', timestamp: at, content: 'Invalid image\n[screenshot]' },
        { id: 'pending', role: 'user', timestamp: at, content: 'Pending\n[screenshot]' },
      ],
    }
    const sourceBefore = JSON.parse(JSON.stringify(source))
    const upstream = createServer(async (request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      if (request.method === 'POST' && request.url === '/v1/runs') {
        for await (const _chunk of request) { /* drain */ }
        response.end(JSON.stringify({ run_id: 'admitted-screenshot', session_id: 'chat-one', status: 'running', created_at: at }))
        return
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/sessions/chat-one/messages')) {
        response.end(JSON.stringify(source))
        return
      }
      response.end('{}')
    })
    servers.push(upstream)
    const upstreamAddress = await listen(upstream)
    const proxy = createWizardServer({
      requireJoinedDelegationCapability: false,
      upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      hermesKey: 'server-only-secret',
      requireAccess: false,
      runQueueStatePath: queuePath,
      runQueuePollIntervalMs: 0,
      activeSessionReader: async () => [],
      dispatchHealthReader: () => true,
    })
    servers.push(proxy)
    const proxyAddress = await listen(proxy)
    const admit = async (key: string, sessionId: string, content: Array<Record<string, unknown>>) => fetch(`http://127.0.0.1:${proxyAddress.port}/wizard/hermes/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ session_id: sessionId, input: [{ role: 'user', content }] }),
    })
    const admission = await admit('restore-screenshot', 'chat-one', [
      { type: 'text', text: 'Compare these' },
      { type: 'image_url', image_url: { url: image } },
      { type: 'text', text: '[audio attached]' },
    ])
    expect(admission.status).toBe(202)
    for (const key of ['ambiguous-one', 'ambiguous-two']) {
      expect((await admit(key, 'chat-one', [{ type: 'text', text: 'Ambiguous' }, { type: 'image_url', image_url: { url: image } }])).status).toBe(202)
    }
    expect((await admit('late-screenshot', 'chat-one', [{ type: 'text', text: 'Late' }, { type: 'image_url', image_url: { url: image } }])).status).toBe(202)
    expect((await admit('other-session-screenshot', 'other-session', [{ type: 'text', text: 'Other session' }, { type: 'image_url', image_url: { url: image } }])).status).toBe(202)
    expect((await admit('unknown-screenshot', 'chat-one', [{ type: 'text', text: 'Unknown part' }, { type: 'audio', audio_url: { url: 'data:audio/mp4;base64,AA==' } }, { type: 'image_url', image_url: { url: image } }])).status).toBe(202)
    expect((await admit('mismatched-screenshot', 'chat-one', [{ type: 'text', text: 'Mismatch' }, { type: 'text', text: '[screenshot]' }, { type: 'image_url', image_url: { url: image } }])).status).toBe(202)
    expect((await admit('invalid-image-screenshot', 'chat-one', [{ type: 'text', text: 'Invalid image' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }])).status).toBe(202)
    expect((await admit('pending-screenshot', 'chat-one', [{ type: 'text', text: 'Pending' }, { type: 'image_url', image_url: { url: image } }])).status).toBe(202)
    const database = new DatabaseSync(queuePath)
    database.prepare("UPDATE wizard_run_queue SET upstream_run_id = '' WHERE idempotency_key = 'pending-screenshot'").run()
    const rowsBefore = database.prepare('SELECT public_run_id, body FROM wizard_run_queue ORDER BY public_run_id').all()
    database.close()

    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/wizard/hermes/api/sessions/chat-one/messages?order=oldest&view=wizard`)
    expect(response.status).toBe(200)
    const payload = await response.json() as { data: Array<Record<string, unknown>> }
    const recovered = payload.data.find((message) => message.id === 'recover')!
    expect(recovered.content).toEqual([
      { type: 'text', text: 'Compare these\n' },
      { type: 'image_url', image_url: { url: image } },
      { type: 'text', text: '\n[audio attached]' },
    ])
    expect(recovered.display_content).toEqual(recovered.content)
    expect(payload.data.find((message) => message.id === 'assistant')?.content).toBe(flattened)
    expect(payload.data.find((message) => message.id === 'already-structured')?.content).toEqual(source.data.find((message) => message.id === 'already-structured')?.content)
    expect(payload.data.find((message) => message.id === 'wrong-message-session')?.content).toBe(flattened)
    for (const id of ['ambiguous', 'late', 'cross-session', 'unrecognized', 'mismatched', 'invalid-image', 'pending']) {
      expect(payload.data.find((message) => message.id === id)?.content).toBe(source.data.find((message) => message.id === id)?.content)
    }
    const nonWizard = await fetch(`http://127.0.0.1:${proxyAddress.port}/wizard/hermes/api/sessions/chat-one/messages?order=oldest`)
    expect((await nonWizard.json() as { data: Array<Record<string, unknown>> }).data.find((message) => message.id === 'recover')?.content).toBe(flattened)
    const after = new DatabaseSync(queuePath)
    expect(after.prepare('SELECT public_run_id, body FROM wizard_run_queue ORDER BY public_run_id').all()).toEqual(rowsBefore)
    after.close()
    expect(source).toEqual(sourceBefore)
  })

  it('hides Hermes empty-response recovery scaffolding without hiding genuine text', async () => {
    const recoveryNudge = 'You just executed tool calls but returned an empty response. Please process the tool results above and continue with the task.'
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ data: [
        { id: 'request', role: 'user', content: 'Finish the upload.' },
        { id: 'empty-sentinel', role: 'assistant', content: '(empty)', finish_reason: 'stop' },
        { id: 'recovery-nudge', role: 'user', content: recoveryNudge },
        { id: 'literal-user', role: 'user', content: '(empty)' },
        { id: 'literal-assistant', role: 'assistant', content: 'The source field literally contains (empty).', finish_reason: 'stop' },
      ] }))
    })
    servers.push(upstream)
    const upstreamAddress = await listen(upstream)
    const proxy = createWizardServer({
      requireJoinedDelegationCapability: false,
      upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      hermesKey: 'server-only-secret',
      requireAccess: false,
    })
    servers.push(proxy)
    const proxyAddress = await listen(proxy)

    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/wizard/hermes/api/sessions/chat-one/messages?order=latest&view=wizard`)
    expect(response.status).toBe(200)
    const payload = await response.json() as { data: Array<{ id: string; content: string }> }
    expect(payload.data.map((message) => message.id)).toEqual(['request', 'literal-user', 'literal-assistant'])
    expect(payload.data.find((message) => message.id === 'literal-user')?.content).toBe('(empty)')
    expect(JSON.stringify(payload)).not.toContain(recoveryNudge)
  })

  it('keeps source-code marker text in tool history from locking the thread', async () => {
    const sourceExcerpt = [
      "const TRUSTED_FILE_MARKER = /\\[WIZARD_FILES_V1\\]/g",
      "return `[WIZARD_FILE_CHIPS_V1]${safe}`",
      "const incompleteMarker = projected.indexOf('[WIZARD_FILES_V1]')",
    ].join('\n')
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        data: [
          { id: 'user-one', role: 'user', content: 'Please inspect the proxy.' },
          { id: 'tool-one', role: 'tool', content: sourceExcerpt, tool_call_id: 'call-one' },
          { id: 'assistant-one', role: 'assistant', content: 'I am still working.' },
        ],
      }))
    })
    servers.push(upstream)
    const upstreamAddress = await listen(upstream)
    const proxy = createWizardServer({
    requireJoinedDelegationCapability: false,
      upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      hermesKey: 'server-only-secret',
      requireAccess: false,
    })
    servers.push(proxy)
    const proxyAddress = await listen(proxy)

    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/wizard/hermes/api/sessions/chat-one/messages?order=latest`)
    expect(response.status).toBe(200)
    const payload = await response.json() as { data: Array<{ id: string; content: string }> }
    expect(payload.data.find((message) => message.id === 'tool-one')?.content).toBe(sourceExcerpt)
    expect(payload.data.find((message) => message.id === 'assistant-one')?.content).toBe('I am still working.')
  })

  it('projects genuine user file envelopes while preserving history availability', async () => {
    const trusted = {
      id: 'drop-one',
      filename: 'brief.pdf',
      mime: 'application/pdf',
      bytes: 42,
      trusted_path: '/srv/wizard-inbox/drop-one/brief.pdf',
    }
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ data: [{
        id: 'user-file',
        author: 'user',
        content: `Read this\n\n[WIZARD_FILES_V1]\n${JSON.stringify([trusted])}\n[/WIZARD_FILES_V1]`,
      }] }))
    })
    servers.push(upstream)
    const upstreamAddress = await listen(upstream)
    const proxy = createWizardServer({
    requireJoinedDelegationCapability: false,
      upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      hermesKey: 'server-only-secret',
      requireAccess: false,
    })
    servers.push(proxy)
    const proxyAddress = await listen(proxy)

    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/wizard/hermes/api/sessions/chat-one/messages?order=latest`)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('[WIZARD_FILE_CHIPS_V1]')
    expect(text).toContain('brief.pdf')
    expect(text).not.toContain('[WIZARD_FILES_V1]')
    expect(text).not.toContain('trusted_path')
    expect(text).not.toContain('/srv/wizard-inbox')
  })

  it('removes an incomplete user file envelope without exposing its remainder', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ data: [{
        id: 'user-broken-file',
        role: 'user',
        content: 'Keep this\n[WIZARD_FILES_V1]\n{"trusted_path":"/srv/private/file"}',
      }] }))
    })
    servers.push(upstream)
    const upstreamAddress = await listen(upstream)
    const proxy = createWizardServer({
    requireJoinedDelegationCapability: false,
      upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      hermesKey: 'server-only-secret',
      requireAccess: false,
    })
    servers.push(proxy)
    const proxyAddress = await listen(proxy)

    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/wizard/hermes/api/sessions/chat-one/messages?order=latest`)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('Keep this')
    expect(text).not.toContain('[WIZARD_FILES_V1]')
    expect(text).not.toContain('trusted_path')
    expect(text).not.toContain('/srv/private/file')
  })

  it('preserves marker source text in single-message and bare-array tool histories', async () => {
    const source = "const marker = '[WIZARD_FILES_V1]'"
    const upstream = createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      const message = { id: 'tool-shape', role: 'tool', content: source }
      response.end(request.url?.includes('/array/') ? JSON.stringify([message]) : JSON.stringify(message))
    })
    servers.push(upstream)
    const upstreamAddress = await listen(upstream)
    const proxy = createWizardServer({
    requireJoinedDelegationCapability: false,
      upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      hermesKey: 'server-only-secret',
      requireAccess: false,
    })
    servers.push(proxy)
    const proxyAddress = await listen(proxy)

    for (const sessionId of ['object', 'array']) {
      const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/wizard/hermes/api/sessions/${sessionId}/messages?order=latest`)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain(source)
    }
  })

  it('projects envelopes anywhere inside a user message object', async () => {
    const marker = `[WIZARD_FILES_V1]\n${JSON.stringify([{
      id: 'nested-drop', filename: 'nested.pdf', mime: 'application/pdf', bytes: 5,
      trusted_path: '/srv/wizard-inbox/nested-drop/nested.pdf',
    }])}\n[/WIZARD_FILES_V1]`
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'nested-user', role: 'user', content: 'Read it', parts: [{ text: marker }] }] }))
    })
    servers.push(upstream)
    const upstreamAddress = await listen(upstream)
    const proxy = createWizardServer({
    requireJoinedDelegationCapability: false,
      upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      hermesKey: 'server-only-secret',
      requireAccess: false,
    })
    servers.push(proxy)
    const proxyAddress = await listen(proxy)

    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/wizard/hermes/api/sessions/nested/messages?order=latest`)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('[WIZARD_FILE_CHIPS_V1]')
    expect(text).not.toContain('trusted_path')
    expect(text).not.toContain('/srv/wizard-inbox')
  })

  it('keeps the original global projection behavior on non-history JSON', async () => {
    const marker = `[WIZARD_FILES_V1]\n${JSON.stringify([{
      id: 'option-drop', filename: 'option.pdf', mime: 'application/pdf', bytes: 5,
      trusted_path: '/srv/wizard-inbox/option-drop/option.pdf',
    }])}\n[/WIZARD_FILES_V1]`
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ data: [{ value: 'fixture', description: marker }] }))
    })
    servers.push(upstream)
    const upstreamAddress = await listen(upstream)
    const proxy = createWizardServer({
    requireJoinedDelegationCapability: false,
      upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      hermesKey: 'server-only-secret',
      requireAccess: false,
    })
    servers.push(proxy)
    const proxyAddress = await listen(proxy)

    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/wizard/hermes/api/model/options`)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('[WIZARD_FILE_CHIPS_V1]')
    expect(text).not.toContain('trusted_path')
    expect(text).not.toContain('/srv/wizard-inbox')
  })

  it('returns lightweight contextual history pages and keeps projection-only parameters local', async () => {
    let upstreamUrl = ''
    const upstream = createServer((request, response) => {
      upstreamUrl = request.url ?? ''
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        data: [
          { id: 'user-one', role: 'user', content: 'Inspect the app.', timestamp: 1 },
          { id: 'legacy-background', role: 'user', content: '[IMPORTANT: Background process proc_fixture completed (exit_code=0).\nCommand: npm run build\nOutput: runtime output\n]', timestamp: 1.1 },
          { id: 'legacy-paused-loop', role: 'user', content: '[Your previous agent loop was paused while an out-of-band user message was delivered. The inner message was already included.]', timestamp: 1.2 },
          { id: 'legacy-workspace-recovery', role: 'user', content: '[Workspace::v1: /home/owner]\n[James requested recovery of this interrupted Helm card.]\nContinue working.', timestamp: 1.3 },
          { id: 'neutral-recovery', role: 'user', content: '[Owner requested recovery of this interrupted Helm card.]\nContinue working.', timestamp: 1.4 },
          { id: 'assistant-tool', role: 'assistant', content: '', timestamp: 2, tool_calls: [
            {
              id: 'call-one', function: { name: 'read_file', arguments: JSON.stringify({ path: '/private/project/src/App.tsx' }) },
            },
            {
              id: 'call-browser', function: { name: 'browser_exec', arguments: JSON.stringify({ code: 'click_at_xy(100, 100)' }) },
            },
          ] },
          { id: 'tool-one', role: 'tool', content: 'a very large private result', tool_call_id: 'call-one', timestamp: 3 },
          { id: 'tool-browser', role: 'tool', content: 'clicked', tool_call_id: 'call-browser', timestamp: 4 },
        ],
        pagination: { returned: 8 },
      }))
    })
    servers.push(upstream)
    const upstreamAddress = await listen(upstream)
    const proxy = createWizardServer({
    requireJoinedDelegationCapability: false,
      upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      hermesKey: 'server-only-secret',
      requireAccess: false,
    })
    servers.push(proxy)
    const proxyAddress = await listen(proxy)

    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/wizard/hermes/api/sessions/chat-one/messages?order=oldest&limit=500&offset=0&include_compacted=true&view=wizard`)
    expect(response.status).toBe(200)
    expect(upstreamUrl).toBe('/api/sessions/chat-one/messages?order=oldest&limit=500&offset=0&include_compacted=true')
    const payload = await response.json() as { data: Array<Record<string, unknown>>; pagination: { returned: number } }
    expect(payload.pagination.returned).toBe(8)
    expect(payload.data).toHaveLength(4)
    expect(payload.data[0]?.content).toBe('Inspect the app.')
    expect(payload.data[1]?.tool_calls).toEqual([
      expect.objectContaining({ display_label: 'Read App.tsx', function: { name: 'read_file' } }),
      expect.objectContaining({ display_label: 'Used the browser', function: { name: 'browser_exec' } }),
    ])
    expect(payload.data[2]?.content).toBe('')
    expect(payload.data[3]?.content).toBe('')
    expect(JSON.stringify(payload)).not.toContain('click_at_xy')
    expect(JSON.stringify(payload)).not.toContain('/private/project')
    expect(JSON.stringify(payload)).not.toContain('a very large private result')
    expect(JSON.stringify(payload)).not.toContain('IMPORTANT: Background process')
    expect(JSON.stringify(payload)).not.toContain('previous agent loop was paused')
  })

  it('projects background wakeups into safe Workline metadata without shipping raw process output', async () => {
    const completion = '[Workspace::v1: /home/telos]\n[IMPORTANT: Background process proc_build completed (exit_code=1).\nCommand: ./gradlew assembleDebug --secret private-value\nOutput:\nPRIVATE BUILD OUTPUT\n]'
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ data: [
        { id: 'request', role: 'user', content: 'Fix the app.', timestamp: 1 },
        { id: 'wake', role: 'user', content: completion, timestamp: 2 },
        {
          id: 'wake-display',
          role: 'user',
          content: '',
          display_kind: 'process_wakeup_watch_match',
          display_content: '[IMPORTANT: Background process proc_watch matched watch pattern "ready".\nCommand: npm test --token display-secret\nMatched output:\nPRIVATE DISPLAY OUTPUT',
          timestamp: 3,
        },
        {
          id: 'wake-metadata',
          role: 'user',
          content: '',
          display_kind: 'process_wakeup_completion',
          display_content: 'PRIVATE CANONICAL OUTPUT',
          display_metadata: {
            type: 'completion',
            process_id: 'proc_release',
            command: 'deploy --token metadata-secret',
            action_label: 'metadata-secret',
            status: 'failed',
          },
          timestamp: 4,
        },
        {
          id: 'wake-array',
          role: 'user',
          content: [{
            type: 'text',
            text: '[Workspace: /private/array]\n[IMPORTANT: Background process proc_array completed (exit code 0).\nCommand: npm test --token array-secret\nOutput:\nPRIVATE ARRAY OUTPUT\n]',
          }],
          timestamp: 5,
        },
        {
          id: 'wake-object',
          role: 'user',
          content: {
            text: '[IMPORTANT: Background process proc_object completed (exit_code=0).\nCommand: deploy --token object-secret\nOutput:\nPRIVATE OBJECT OUTPUT\n]',
          },
          timestamp: 6,
        },
      ] }))
    })
    servers.push(upstream)
    const upstreamAddress = await listen(upstream)
    const proxy = createWizardServer({
    requireJoinedDelegationCapability: false,
      upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      hermesKey: 'server-only-secret',
      requireAccess: false,
    })
    servers.push(proxy)
    const proxyAddress = await listen(proxy)

    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/wizard/hermes/api/sessions/chat-one/messages?order=oldest&limit=500&offset=0&include_compacted=true&view=wizard`)
    expect(response.status).toBe(200)
    const payload = await response.json() as { data: Array<Record<string, unknown>> }
    expect(payload.data[1]).toMatchObject({
      id: 'wake',
      role: 'system',
      content: '',
      display_kind: 'process_wakeup',
      _wakeup_meta: {
        type: 'completion',
        task_id: 'proc_build',
        action_label: 'Android build',
        failed: true,
      },
    })
    expect(payload.data[2]).toMatchObject({
      id: 'wake-display',
      role: 'system',
      content: '',
      display_content: '',
      display_kind: 'process_wakeup',
      _wakeup_meta: {
        type: 'watch_match',
        task_id: 'proc_watch',
        action_label: 'Automated tests',
        failed: false,
      },
    })
    expect(payload.data[3]).toMatchObject({
      id: 'wake-metadata',
      role: 'system',
      content: '',
      display_content: '',
      display_kind: 'process_wakeup',
      _wakeup_meta: {
        type: 'completion',
        task_id: 'proc_release',
        action_label: 'Release job',
        failed: true,
      },
    })
    expect(payload.data[4]).toMatchObject({
      id: 'wake-array',
      role: 'system',
      content: '',
      display_kind: 'process_wakeup',
      _wakeup_meta: { type: 'completion', task_id: 'proc_array', action_label: 'Automated tests', failed: false },
    })
    expect(payload.data[5]).toMatchObject({
      id: 'wake-object',
      role: 'system',
      content: '',
      display_kind: 'process_wakeup',
      _wakeup_meta: { type: 'completion', task_id: 'proc_object', action_label: 'Release job', failed: false },
    })
    const wire = JSON.stringify(payload)
    expect(wire).not.toContain('PRIVATE BUILD OUTPUT')
    expect(wire).not.toContain('PRIVATE DISPLAY OUTPUT')
    expect(wire).not.toContain('PRIVATE CANONICAL OUTPUT')
    expect(wire).not.toContain('private-value')
    expect(wire).not.toContain('display-secret')
    expect(wire).not.toContain('metadata-secret')
    expect(wire).not.toContain('array-secret')
    expect(wire).not.toContain('object-secret')
    expect(wire).not.toContain('PRIVATE ARRAY OUTPUT')
    expect(wire).not.toContain('PRIVATE OBJECT OUTPUT')
    expect(wire).not.toContain('/home/telos')
    expect(wire).not.toContain('/private/array')
  })

  it('removes process envelopes and metadata from session-list previews', async () => {
    const wakeup = '[Workspace: /private/workspace]\n[IMPORTANT: Background process proc_secret completed (exit_code=1).\nCommand: deploy --token SESSION_SECRET\nOutput:\nPRIVATE SESSION OUTPUT\n]'
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ data: [{
        id: 'chat',
        source: 'webui',
        title: 'Leak probe',
        message_count: 2,
        preview: wakeup,
        last_message: { role: 'user', content: [{ type: 'text', text: wakeup }] },
        display_metadata: { command: 'SESSION_SECRET' },
        _wakeup_meta: { command: 'SESSION_SECRET' },
      }] }))
    })
    servers.push(upstream)
    const upstreamAddress = await listen(upstream)
    const proxy = createWizardServer({
    requireJoinedDelegationCapability: false,
      upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      hermesKey: 'server-only-secret',
      requireAccess: false,
    })
    servers.push(proxy)
    const proxyAddress = await listen(proxy)

    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/wizard/hermes/api/sessions?limit=20&offset=0`)
    expect(response.status).toBe(200)
    const payload = await response.json() as { data: Array<Record<string, unknown>> }
    expect(payload.data[0]).toMatchObject({ id: 'chat', preview: '', last_message: null, display_content: '' })
    const wire = JSON.stringify(payload)
    expect(wire).not.toContain('SESSION_SECRET')
    expect(wire).not.toContain('PRIVATE SESSION OUTPUT')
    expect(wire).not.toContain('/private/workspace')
    expect(wire).not.toContain('IMPORTANT: Background process')
  })

  it('removes empty-response recovery previews when history enrichment is unavailable', async () => {
    const recoveryNudge = 'You just executed tool calls but returned an empty response. Please process the tool results above and continue with the task.'
    const upstream = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json')
      if (request.url?.includes('/messages')) {
        response.writeHead(503)
        response.end(JSON.stringify({ error: 'history unavailable' }))
        return
      }
      response.end(JSON.stringify({ data: [
        {
          id: 'recovery-preview', source: 'webui', message_count: 3,
          preview: recoveryNudge, last_message: { role: 'user', content: recoveryNudge },
        },
        {
          id: 'assistant-empty', source: 'webui', message_count: 2,
          preview: '(empty)', preview_role: 'assistant', last_message: { role: 'assistant', content: '(empty)' },
        },
        {
          id: 'genuine-user-empty', source: 'webui', message_count: 1,
          preview: '(empty)', preview_role: 'user', last_message: { role: 'user', content: '(empty)' },
        },
      ] }))
    })
    servers.push(upstream)
    const upstreamAddress = await listen(upstream)
    const proxy = createWizardServer({
      requireJoinedDelegationCapability: false,
      upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      hermesKey: 'server-only-secret',
      requireAccess: false,
      archivedSessionReader: () => [],
    })
    servers.push(proxy)
    const proxyAddress = await listen(proxy)

    const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/wizard/hermes/api/sessions?limit=100&offset=0`)
    expect(response.status).toBe(200)
    const payload = await response.json() as { data: Array<{ id: string; preview: string; last_message: unknown }> }
    expect(payload.data.find((session) => session.id === 'recovery-preview')).toMatchObject({ preview: '', last_message: null })
    expect(payload.data.find((session) => session.id === 'assistant-empty')).toMatchObject({ preview: '', last_message: null })
    expect(payload.data.find((session) => session.id === 'genuine-user-empty')).toMatchObject({ preview: '(empty)', last_message: { role: 'user', content: '(empty)' } })
  })
})
