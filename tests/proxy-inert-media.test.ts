import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'

// Privilege separation: the agent owns its gateway. Whatever it answers, the
// owner/shell origin must never receive active content (HTML/SVG/script) from it,
// on ANY status, and JSON it is allowed to send stays sandboxed.
const servers: ReturnType<typeof createServer>[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function proxyWith(status: number, type: string | null, body: string) {
  const upstream = createServer((_req, res) => {
    const headers: Record<string, string> = {}
    if (type) headers['Content-Type'] = type
    res.writeHead(status, headers)
    res.end(body)
  })
  servers.push(upstream)
  const up = await listen(upstream)
  const directory = await mkdtemp(join(tmpdir(), 'wizard-proxy-mime-'))
  directories.push(directory)
  const wizard = createWizardServer({
    requireJoinedDelegationCapability: false,
    upstreamOrigin: `http://127.0.0.1:${up.port}`,
    hermesKey: 'fixture-key',
    requireAccess: false,
    wizardOsHome: directory,
    runQueueStatePath: join(directory, 'queue.sqlite3'),
    activeSessionReader: async () => [],
    dispatchHealthReader: () => true,
  })
  servers.push(wizard)
  const address = await listen(wizard)
  return fetch(`http://127.0.0.1:${address.port}/wizard/hermes/api/model/options`)
}

describe('agent gateway responses are inert on the owner origin', () => {
  for (const [status, type] of [[404, 'text/html'], [200, 'text/html; charset=utf-8'], [500, 'image/svg+xml'], [403, 'application/javascript'], [404, null]] as const) {
    it(`refuses ${type ?? 'missing type'} on ${status}`, async () => {
      const response = await proxyWith(status, type, '<script>window.parent.postMessage("ran","*")</script>')
      const text = await response.text()
      expect(response.status).toBe(502)
      expect(response.headers.get('content-type')).toBe('application/json')
      expect(response.headers.get('content-security-policy')).toContain('sandbox')
      expect(text).not.toContain('<script')
    })
  }

  it('keeps JSON, including JSON errors, and sandboxes it', async () => {
    const ok = await proxyWith(200, 'application/json', '{"provider":"x","providers":[]}')
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-security-policy')).toContain('sandbox')
    const missing = await proxyWith(404, 'application/json', '{"error":"not found"}')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'not found' })
  })
})
