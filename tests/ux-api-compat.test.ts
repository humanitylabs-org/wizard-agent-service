import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer } from '../server/service.mjs'

// Split packaging (wizard-agent-service + wizard-ux): the shell proxies <prefix>api/transcribe and <prefix>api/route
// to a headless Service (no uxDir). WIZARD_UX_API_COMPAT=1 (owner Dockerfile) keeps those two paths on their existing
// handlers instead of 404, under the same owner gate as every other control route.
const servers: ReturnType<typeof createWizardServer>[] = []
afterEach(async () => { await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); servers.length = 0 })

async function start(options: Record<string, unknown>) {
  const upstream = vi.fn(async () => new Response(JSON.stringify({ text: ' hello there ' }), { status: 200 }))
  const dir = mkdtempSync(join(tmpdir(), 'was-compat-'))
  const server = createWizardServer({ fetchImpl: upstream, archivedSessionReader: () => [], settingsPath: join(dir, 'settings.json'), ...options })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  return { base: `http://127.0.0.1:${address.port}`, upstream }
}

function speech() {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(7426).fill(1)], { type: 'audio/aac' }), 'voice.aac')
  return form
}
const route = (base: string, headers: Record<string, string> = {}) => fetch(`${base}/wizard-os-home/api/route`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ text: 'hi' }) })
const transcriptions = (upstream: ReturnType<typeof vi.fn>) => upstream.mock.calls.map((call) => String((call as unknown[])[0])).filter((u) => u.endsWith('/v1/audio/transcriptions'))

describe('headless Service keeps the shell sidecar paths (WIZARD_UX_API_COMPAT)', () => {
  it('api/transcribe reaches the existing multipart handler: one transcription call', async () => {
    const { base, upstream } = await start({ requireAccess: false, uxApiCompat: true })
    const response = await fetch(`${base}/wizard-os-home/api/transcribe`, { method: 'POST', body: speech() })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ text: 'hello there' })
    expect(transcriptions(upstream)).toHaveLength(1)
  })

  it('api/route reaches the router handler: an unconfigured router is its capability answer, not a missing path', async () => {
    const { base } = await start({ requireAccess: false, uxApiCompat: true })
    const response = await route(base)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'router_not_configured' })
  })

  it('keeps the owner gate: another login on the box, or no Access proof, is refused before the transcriber', async () => {
    const box = await start({ requireAccess: false, uxApiCompat: true, appOwnerLogins: ['owner@example'] })
    const other = { 'Tailscale-User-Login': 'someone@example' }
    expect((await fetch(`${box.base}/wizard-os-home/api/transcribe`, { method: 'POST', headers: other, body: speech() })).status).toBe(403)
    expect((await route(box.base, other)).status).toBe(403)
    expect(box.upstream).not.toHaveBeenCalled()
    const owner = await fetch(`${box.base}/wizard-os-home/api/transcribe`, { method: 'POST', headers: { 'Tailscale-User-Login': 'owner@example' }, body: speech() })
    expect(owner.status).toBe(200)

    const access = await start({ requireAccess: true, uxApiCompat: true, accessVerifier: async () => false })
    expect((await fetch(`${access.base}/wizard-os-home/api/transcribe`, { method: 'POST', body: speech() })).status).toBe(403)
    expect((await route(access.base)).status).toBe(403)
    expect(transcriptions(access.upstream)).toHaveLength(0)
  })

  it('a cross-site page cannot post audio through the compat path', async () => {
    const { base, upstream } = await start({ requireAccess: false, uxApiCompat: true })
    const response = await fetch(`${base}/wizard-os-home/api/transcribe`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: speech() })
    expect(response.status).toBe(403)
    expect(transcriptions(upstream)).toHaveLength(0)
  })

  it('without the flag a headless Service does not claim the shell paths', async () => {
    const { base, upstream } = await start({ requireAccess: false })
    const response = await fetch(`${base}/wizard-os-home/api/transcribe`, { method: 'POST', body: speech() })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_found' })
    expect((await route(base)).status).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
  })
})
