import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer } from '../server/service.mjs'

// Live failure (12 Oct 2026): a ~1 s accidental orb take (7 KB AAC) got 422 "No speech detected" from
// wizard-stt; /wizard/voice/transcribe turned it into 502 upstream_unavailable, the outbox read that as
// "Wizard was unavailable (502)" and every Retry failed again. No speech is a result, not an outage.
const servers: ReturnType<typeof createWizardServer>[] = []
afterEach(async () => { await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); servers.length = 0 })

async function fixture(reply: () => Response, headless = false) {
  const upstream = vi.fn(async () => reply())
  const uxDir = mkdtempSync(join(tmpdir(), 'was-ux-'))
  writeFileSync(join(uxDir, 'index.html'), '<!doctype html>')
  // headless: the two-container split; the shell serves the UX, the service only the API (no uxDir).
  const server = createWizardServer({ requireAccess: false, fetchImpl: upstream, archivedSessionReader: () => [], ...(headless ? { uxApiCompat: true } : { uxDir }) })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  return { base: `http://127.0.0.1:${address.port}`, upstream }
}
const post = (url: string) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'audio/aac', 'X-Wizard-Filename': 'voice.webm' }, body: new Uint8Array(7426).fill(1) })
const noSpeech = () => new Response(JSON.stringify({ detail: 'No speech detected' }), { status: 422 })

describe('a take with no speech is an empty transcript, never a retryable failure', () => {
  it('voice/transcribe answers 200 with empty text when STT finds no speech', async () => {
    const { base } = await fixture(noSpeech)
    const response = await post(`${base}/wizard/voice/transcribe`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ text: '', no_speech: true })
  })

  it('voice/transcribe answers 200 with empty text when STT returns a blank reading', async () => {
    const { base } = await fixture(() => new Response(JSON.stringify({ text: '  ' }), { status: 200 }))
    const response = await post(`${base}/wizard/voice/transcribe`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ text: '', no_speech: true })
  })

  it('the shell sidecar route treats no speech the same way', async () => {
    const { base } = await fixture(noSpeech)
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(7426).fill(1)], { type: 'audio/aac' }), 'voice.aac')
    form.append('language', 'en')
    const response = await fetch(`${base}/wizard-os-home/api/transcribe`, { method: 'POST', body: form })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ text: '', no_speech: true })
  })

  it('a headless service (separate shell container) still answers the native multipart path', async () => {
    const { base, upstream } = await fixture(() => new Response(JSON.stringify({ text: ' hello there ' }), { status: 200 }), true)
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(7426).fill(1)], { type: 'audio/aac' }), 'voice.aac')
    const response = await fetch(`${base}/wizard-os-home/api/transcribe`, { method: 'POST', body: form })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ text: 'hello there' })
    // (an earlier call may ask the transcriber for its model list)
    const urls = upstream.mock.calls.map((call) => String((call as unknown[])[0]))
    expect(urls.filter((u) => u.endsWith('/v1/audio/transcriptions'))).toHaveLength(1)
  })

  it('without the compat flag a headless service does not claim the shell paths', async () => {
    const upstream = vi.fn(async () => new Response('{}'))
    const server = createWizardServer({ requireAccess: false, fetchImpl: upstream, archivedSessionReader: () => [] })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(10)], { type: 'audio/aac' }), 'voice.aac')
    const response = await fetch(`http://127.0.0.1:${address.port}/wizard-os-home/api/transcribe`, { method: 'POST', body: form })
    expect(response.status).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
  })

  it.each([
    ['a malformed-request 422', () => new Response(JSON.stringify({ detail: [{ msg: 'field required' }] }), { status: 422 })],
    ['a provider 502', () => new Response(JSON.stringify({ detail: 'tinfoil returned HTTP 500' }), { status: 502 })],
  ])('%s still reports a failure', async (_label, reply) => {
    const { base } = await fixture(reply)
    expect((await post(`${base}/wizard/voice/transcribe`)).status).toBe(502)
  })
})
