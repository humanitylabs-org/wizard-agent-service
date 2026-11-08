import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWizardServer } from '../server/service.mjs'

const servers: ReturnType<typeof createWizardServer>[] = []
afterEach(async () => { await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); servers.length = 0 })
const request = { sessionId: 'wizard_fixture', intentId: 'voice-fixture', sourceFileId: `drop_${'a'.repeat(32)}`, audioSha256: 'b'.repeat(64), inputSha256: 'c'.repeat(64) }
async function fixture(requireAccess = false) {
  const upstream = vi.fn(() => { throw new Error('Receipt lookup must never contact an upstream or admit a run') })
  const server = createWizardServer({ requireAccess, accessVerifier: async () => false, fetchImpl: upstream, archivedSessionReader: () => [] })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  return { url: `http://127.0.0.1:${address.port}/wizard/voice/recovery-receipt`, upstream }
}
describe('read-only voice recovery HTTP boundary', () => {
  it('returns no receipt with no configured attestation, and makes no upstream request', async () => {
    const { url, upstream } = await fixture()
    const response = await fetch(url, { method: 'POST', body: JSON.stringify(request) })
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ receipt: null }); expect(upstream).not.toHaveBeenCalled()
  })
  it('requires the existing Access boundary', async () => {
    const { url, upstream } = await fixture(true)
    const response = await fetch(url, { method: 'POST', body: JSON.stringify(request) })
    expect(response.status).toBe(403); expect(upstream).not.toHaveBeenCalled()
  })
  it.each(['{broken', JSON.stringify({ ...request, secret: 'must not echo' })])('rejects malformed requests with a generic response', async (body) => {
    const { url, upstream } = await fixture()
    const response = await fetch(url, { method: 'POST', body })
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'voice_recovery_unverified' }); expect(upstream).not.toHaveBeenCalled()
  })
  it('bounds the small identity-only request', async () => {
    const { url, upstream } = await fixture()
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ ...request, padding: 'a'.repeat(2048) }) })
    expect(response.status).toBe(413); expect(upstream).not.toHaveBeenCalled()
  })
})
