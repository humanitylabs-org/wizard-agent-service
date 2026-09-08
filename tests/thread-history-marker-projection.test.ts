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
})
