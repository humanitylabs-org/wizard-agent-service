import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe('Wizard thread history marker projection', () => {
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
          { id: 'legacy-workspace-recovery', role: 'user', content: '[Workspace::v1: /home/telos]\n[James requested recovery of this interrupted Helm card.]\nContinue working.', timestamp: 1.3 },
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
        pagination: { returned: 7 },
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
    expect(payload.pagination.returned).toBe(7)
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
})
