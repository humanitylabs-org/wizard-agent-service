import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWizardServer } from '../server/service.mjs'

// Live failure (9 Oct 2026): the native Wizard OS orb records AAC ADTS and posts it as
// audio/aac; /wizard/voice/transcribe answered 415 audio_required on every retry.
const servers: ReturnType<typeof createWizardServer>[] = []
afterEach(async () => { await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); servers.length = 0 })

async function fixture() {
  const seen: { type: string, name: string }[] = []
  const upstream = vi.fn(async (_url: string, init: { body: FormData }) => {
    const file = init.body.get('file') as File
    seen.push({ type: file.type, name: file.name })
    return new Response(JSON.stringify({ text: 'Synthetic words.', provider: 'tinfoil-attested', model: 'voxtral-small-24b' }), { status: 200 })
  })
  const server = createWizardServer({ requireAccess: false, fetchImpl: upstream, archivedSessionReader: () => [] })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  return { url: `http://127.0.0.1:${address.port}/wizard/voice/transcribe`, upstream, seen }
}

describe('voice transcription accepts every recorder format Wizard ships', () => {
  it.each([
    ['audio/aac', 'voice.webm', 'voice.aac'],
    ['audio/aac', '', 'wizard-voice.aac'],
    ['audio/mp4', 'voice.m4a', 'voice.m4a'],
    ['audio/webm;codecs=opus', 'voice.webm', 'voice.webm'],
  ])('%s named %s reaches the transcriber as %s', async (type, name, expected) => {
    const { url, seen } = await fixture()
    const headers: Record<string, string> = { 'Content-Type': type }
    if (name) headers['X-Wizard-Filename'] = name
    const response = await fetch(url, { method: 'POST', headers, body: new Uint8Array(2048).fill(1) })
    expect(response.status).toBe(200)
    expect((await response.json()).text).toBe('Synthetic words.')
    expect(seen).toEqual([{ type: type.split(';')[0], name: expected }])
  })

  it('still refuses non-audio bodies without contacting the transcriber', async () => {
    const { url, upstream } = await fixture()
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hello' })
    expect(response.status).toBe(415)
    expect(upstream).not.toHaveBeenCalled()
  })
})
