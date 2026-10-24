import { afterEach, expect, it, vi } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'

const servers: ReturnType<typeof createWizardServer>[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})
async function fixture({ prefix = 'wizard-os-home', silence = false } = {}) {
  const sent: Array<{ name: string, type: string, size: number, model: string }> = []
  const upstream = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === 'http://127.0.0.1:8864/v1/models') {
      return Response.json({ data: [{ id: 'fixture-transcriber' }] })
    }
    if (url !== 'http://127.0.0.1:8864/v1/audio/transcriptions') throw new Error(`Unexpected upstream: ${url}`)
    const form = init?.body instanceof FormData ? init.body : await new Response(init?.body, { headers: init?.headers }).formData()
    const file = form.get('file') as File
    sent.push({ name: file.name, type: file.type, size: file.size, model: String(form.get('model')) })
    return silence ? Response.json({ detail: 'No speech detected' }, { status: 422 })
      : Response.json({ text: '  Headless voice fixture.  ', model: 'fixture-transcriber' })
  })
  // No static UX directory: production shell and Service are separate containers.
  const server = createWizardServer({ requireAccess: false, uxApiCompat: true, uxPrefix: prefix,
    uxDir: '', followThrough: false, fetchImpl: upstream, hermesStatePath: '' })
  servers.push(server)
  const address = await listen(server)
  return { url: `http://127.0.0.1:${address.port}/${prefix}/api/transcribe`, upstream, sent }
}
const recording = (model?: string) => {
  const body = new FormData()
  body.append('file', new Blob([new Uint8Array(2048).fill(1)], { type: 'audio/aac' }), 'native-orb.aac')
  if (model) body.append('model', model)
  return body
}

it.each(['wizard-os-home', 'custom-shell'])('headless multipart native voice works at /%s/api/transcribe without serving a UX build', async prefix => {
  const f = await fixture({ prefix })
  const response = await fetch(f.url, { method: 'POST', body: recording() })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ text: 'Headless voice fixture.', model: 'fixture-transcriber', ms: expect.any(Number) })
  expect(f.sent).toEqual([{ name: 'native-orb.aac', type: 'audio/aac', size: 2048, model: 'fixture-transcriber' }])
})
it('headless multipart preserves an explicit transcription model instead of substituting the discovery default', async () => {
  const f = await fixture()
  const response = await fetch(f.url, { method: 'POST', body: recording('fixture-explicit-transcriber') })
  expect(response.status).toBe(200)
  await response.json()
  expect(f.sent).toHaveLength(1)
  expect(f.sent[0].model).toBe('fixture-explicit-transcriber')
})
it('headless native silence returns no_speech rather than a retryable outage', async () => {
  const f = await fixture({ silence: true })
  const response = await fetch(f.url, { method: 'POST', body: recording() })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ text: '', no_speech: true, model: '' })
  expect(f.sent).toHaveLength(1)
})
it('headless voice retains cross-origin rejection without contacting the transcriber', async () => {
  const f = await fixture()
  const response = await fetch(f.url, { method: 'POST', headers: { Origin: 'https://not-the-shell.invalid' }, body: recording() })
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ error: 'same_origin_required' })
  expect(f.upstream).not.toHaveBeenCalled()
})
it('headless multipart endpoint rejects raw non-multipart requests without upstream calls', async () => {
  const f = await fixture()
  const response = await fetch(f.url, { method: 'POST', headers: { 'Content-Type': 'audio/aac' }, body: new Uint8Array(2048) })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'multipart_required' })
  expect(f.upstream).not.toHaveBeenCalled()
})
