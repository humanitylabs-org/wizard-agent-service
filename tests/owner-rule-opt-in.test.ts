import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { createWizardServer } from '../server/service.mjs'

// fetch() drops a caller-set Host header; node:http sends it as given, like nginx does.
function fetch(url: string, init: { method?: string, headers?: Record<string, string>, body?: string } = {}): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: init.method || 'GET', headers: init.headers }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode || 0 })) })
    req.on('error', reject)
    req.end(init.body)
  })
}

// Existing alongside boxes reach the Service as Tailscale Serve -> wizard-ux nginx -> loopback. nginx always adds
// X-Forwarded-*; those boxes have no WIZARD_APP_OWNER_LOGINS and often no network.base_url yet. The Mac owner rule
// must not lock them out on upgrade; it applies once the box names its owner (or serves an apps origin).
const servers: ReturnType<typeof createWizardServer>[] = []
afterEach(async () => { await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))); servers.length = 0 })

async function start(options: Record<string, unknown> = {}) {
  const upstream = vi.fn(async () => new Response('{}', { status: 200 }))
  const dir = mkdtempSync(join(tmpdir(), 'was-owner-'))
  const server = createWizardServer({ fetchImpl: upstream, archivedSessionReader: () => [], settingsPath: join(dir, 'settings.json'), requireAccess: false, ...options })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  return `http://127.0.0.1:${address.port}`
}

const HOST = 'box.tail0.ts.net:8444'
const served = { Host: HOST, 'X-Forwarded-Host': HOST, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '100.64.0.9', 'Tailscale-User-Login': 'owner@example' }

describe('box-owner rule is opt-in', () => {
  it('an unconfigured box behind Serve + nginx keeps working (reads and same-site writes)', async () => {
    const base = await start()
    expect((await fetch(`${base}/wizard/v1/bootstrap`, { headers: served })).status).toBe(200)
    const put = await fetch(`${base}/wizard/v1/settings`, { method: 'PUT', headers: { ...served, Origin: `https://${HOST}`, 'Content-Type': 'application/json' }, body: '{}' })
    expect(put.status).toBe(200)
  })

  it('an unconfigured box still refuses cross-site browser writes', async () => {
    const base = await start()
    const put = await fetch(`${base}/wizard/v1/settings`, { method: 'PUT', headers: { ...served, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })
    expect(put.status).toBe(403)
  })

  it('once owner logins are configured, the rule applies: unknown Host and other logins are refused', async () => {
    const base = await start({ appOwnerLogins: ['owner@example'], allowedHosts: [HOST] })
    expect((await fetch(`${base}/wizard/v1/bootstrap`, { headers: served })).status).toBe(200)
    expect((await fetch(`${base}/wizard/v1/bootstrap`, { headers: { ...served, 'Tailscale-User-Login': 'other@example' } })).status).toBe(403)
    expect((await fetch(`${base}/wizard/v1/bootstrap`, { headers: { ...served, Host: 'evil.example', 'X-Forwarded-Host': 'evil.example' } })).status).toBe(403)
  })

  it('ownerRule: true forces it on without owner logins', async () => {
    const base = await start({ ownerRule: true })
    expect((await fetch(`${base}/wizard/v1/bootstrap`, { headers: served })).status).toBe(403)
  })
})
