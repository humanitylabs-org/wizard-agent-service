import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { aiConnectionApps, aiConnectionUrl, createAiUsageReader } from '../server/ai-usage.mjs'
import { createWizardServer } from '../server/service.mjs'

const NOW = Date.parse('2026-10-15T12:00:00Z')
const APP = { id: 'claude', name: 'Claude', status: 'running', provides: ['ai-connection', 'claude-subscription'], view: { local: 'http://127.0.0.1:8811/' }, mcp: { internal: 'http://claude:8811/mcp' } }
const PAYLOAD = { contract: 'wizard.ai-connection/1', provider: 'claude', status: 'connected', usage: { fetchedAt: new Date(NOW).toISOString(), limits: [{ id: 'weekly', label: 'Week', usedPercent: 12 }] }, error: null }
const json = (payload: unknown) => new Response(JSON.stringify(payload))
function fixture(apps: unknown[] = [APP]) {
  const root = mkdtempSync(join(tmpdir(), 'connection-boundaries-'))
  const appsJsonPath = join(root, 'apps.json')
  const empty = join(root, 'empty.json')
  writeFileSync(appsJsonPath, JSON.stringify({ apps }))
  writeFileSync(empty, '{}')
  return { appsJsonPath, claudeCredentialsPath: empty, codexAuthPath: empty, hermesAuthPath: empty, hermesGlobalAuthPath: '' }
}
const claude = (snapshot: any) => snapshot.providers.find((p: any) => p.id === 'claude')
const servers: ReturnType<typeof createWizardServer>[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
})

describe('AI connection trust and resource boundaries', () => {
  it('uses real app HTTP, refuses redirects, and bounds stalled response bodies', async () => {
    let mode = 'healthy'
    const requests: Array<{ url: string | undefined; authorization: string | undefined }> = []
    const app = createServer((request, response) => {
      requests.push({ url: request.url, authorization: request.headers.authorization })
      if (mode === 'healthy') { response.end(JSON.stringify(PAYLOAD)); return }
      if (mode === 'redirect') { response.writeHead(302, { Location: '/trap' }); response.end(); return }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.write('{') // Never completes; the reader must abort during body consumption.
    })
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve))
    const address = app.address() as { port: number }
    const options = fixture([{ ...APP, view: { local: `http://127.0.0.1:${address.port}/` } }])
    try {
      for (mode of ['healthy', 'redirect', 'stalled']) {
        const reader = createAiUsageReader({ ...options, now: () => NOW, timeoutMs: 200 })
        expect(claude(await reader.read()).status).toBe(mode === 'healthy' ? 'ok' : 'unavailable')
      }
      expect(requests).toEqual(Array(3).fill({ url: '/api/connection', authorization: undefined }))
    } finally {
      app.closeAllConnections()
      await new Promise<void>((resolve) => app.close(() => resolve()))
    }
  })

  it('only discovers running, opted-in apps at loopback or their exact internal hostname', () => {
    expect(aiConnectionApps({ apps: [APP, { ...APP, id: 'notes', provides: ['notes'] }, { ...APP, id: 'stopped', status: 'stopped' }, { ...APP, id: 'remote', view: { local: 'http://169.254.169.254/' } }] }))
      .toEqual([{ appId: 'claude', provider: 'claude', name: 'Claude', url: 'http://127.0.0.1:8811/api/connection' }])
    expect(aiConnectionUrl({ ...APP, view: null, health: 'http://127.0.0.1:8811/health' })).toBe('http://127.0.0.1:8811/api/connection')
    for (const internal of ['http://other-app:8811/mcp', 'http://claude.attacker.test/mcp', 'file:///etc/passwd']) {
      expect(aiConnectionUrl({ ...APP, mcp: { internal } }, 'internal')).toBe('')
    }
    expect(aiConnectionApps({ apps: [APP] }, 'internal')[0].url).toBe('http://claude:8811/api/connection')
  })

  it('bounds a chunked response while reading and cancels it on overflow', async () => {
    let pulls = 0
    const cancel = vi.fn()
    const stream = new ReadableStream({
      pull(controller) { if (++pulls <= 100) controller.enqueue(new Uint8Array(64 * 1024)); else controller.close() }, cancel,
    })
    const reader = createAiUsageReader({ ...fixture(), now: () => NOW, fetchImpl: async () => new Response(stream) })
    expect(claude(await reader.read())).toMatchObject({ status: 'unavailable', error: { code: 'provider_error' } })
    expect(pulls).toBeLessThanOrEqual(6)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('rejects a contract for a different provider instead of relabeling its usage', async () => {
    const reader = createAiUsageReader({ ...fixture(), fetchImpl: async () => json({ ...PAYLOAD, provider: 'chatgpt' }) })
    expect(claude(await reader.read())).toMatchObject({ status: 'unavailable', limits: [], error: { code: 'provider_error' } })
  })

  it('does not normalize malformed registry identifiers or accept credential-bearing URLs', () => {
    for (const id of [' claude', 'claude\n', 'claude\u0000']) expect(aiConnectionUrl({ ...APP, id })).toBe('')
    expect(aiConnectionUrl({ ...APP, view: { local: 'http://user:secret@127.0.0.1:8811/' } })).toBe('')
    expect(aiConnectionUrl({ ...APP, mcp: { internal: 'http://user:secret@claude:8811/mcp' } }, 'internal')).toBe('')
    expect(aiConnectionApps({ apps: [{ ...APP, provides: [' ai-connection', 'claude-subscription'] }] })).toEqual([])
  })

  it('never serves usage after an app reports expired or signed-out credentials', async () => {
    for (const code of ['expired', 'signed_out']) {
      let clock = NOW
      let payload: any = PAYLOAD
      const reader = createAiUsageReader({ ...fixture(), cacheMs: 1, now: () => clock, fetchImpl: async () => json(payload) })
      expect(claude(await reader.read()).status).toBe('ok')
      clock += 2
      payload = { ...PAYLOAD, error: { code, message: 'Reconnect' } }
      expect(claude(await reader.read())).toMatchObject({ status: 'unavailable', limits: [], paid: null, error: { code } })
    }
  })

  it('isolates timeouts from healthy providers without falling back to another account', async () => {
    const other = { ...APP, id: 'chatgpt', name: 'ChatGPT', provides: ['ai-connection', 'chatgpt-subscription'], view: { local: 'http://127.0.0.1:8812/' } }
    const fetcher = vi.fn(async (url: string, options: any) => {
      if (url.includes(':8812')) return json({ ...PAYLOAD, provider: 'chatgpt' })
      return await new Promise<Response>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), { once: true }))
    })
    const reader = createAiUsageReader({ ...fixture([APP, other]), now: () => NOW, timeoutMs: 15, fetchImpl: fetcher })
    const snapshot = await reader.read()
    expect(claude(snapshot)).toMatchObject({ status: 'unavailable', error: { code: 'unreachable' } })
    expect(snapshot.providers.find((p: any) => p.id === 'chatgpt')?.status).toBe('ok')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('restores host readers after uninstall and never reuses the removed app cache', async () => {
    const options = fixture()
    let clock = NOW
    const reader = createAiUsageReader({ ...options, now: () => clock, cacheMs: 1, fetchImpl: async () => json(PAYLOAD) })
    expect(claude(await reader.read()).status).toBe('ok')
    writeFileSync(options.appsJsonPath, JSON.stringify({ apps: [] }))
    clock += 2
    expect(claude(await reader.read())).toMatchObject({ status: 'unavailable', limits: [], error: { code: 'signed_out' } })
  })

  it('wires discovery behind owner authentication and never forwards browser credentials or target input', async () => {
    const fetcher = vi.fn(async () => json({ ...PAYLOAD, account: 'private-owner@example.test', access_token: 'private-token' }))
    const server = createWizardServer({ ...fixture(), requireAccess: true,
      accessVerifier: async (token: string) => { if (token !== 'owner-proof') throw new Error('invalid'); return { sub: 'owner' } }, fetchImpl: fetcher,
      agents: false, agentBridge: false, archivedSessionReader: () => [],
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const url = `http://127.0.0.1:${address.port}/wizard/ai-usage`
    expect((await fetch(url, { headers: { Authorization: 'Bearer agent-token' } })).status).toBe(403)
    expect(fetcher).not.toHaveBeenCalled()
    const response = await fetch(`${url}?url=http://attacker.invalid&appsJsonPath=/etc/passwd`, { headers: { 'cf-access-jwt-assertion': 'owner-proof', Authorization: 'Bearer owner-secret', Cookie: 'secret-cookie' } })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('"status":"ok"')
    for (const secret of ['private-owner', 'private-token']) expect(body).not.toContain(secret)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]).toEqual(['http://127.0.0.1:8811/api/connection', expect.objectContaining({ headers: { Accept: 'application/json' }, redirect: 'error' })])
  })
})
