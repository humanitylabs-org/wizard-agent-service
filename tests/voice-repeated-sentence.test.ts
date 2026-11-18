import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer } from '../server/service.mjs'
import { collapseSpeechRepeats } from '../server/speech-repeats.mjs'

// wizard-messenger issue 298: James dictated two short things into a Messenger chat and every sentence arrived
// twice ("To do my call because everyone was gonna go home from the cafe. To do my call because ..."). The reading
// itself carried the repeat, so the transcription step every dictation, voice note and orb take uses drops it.
const ONE = 'To do my call because everyone was gonna go home from the cafe.'
const TWO = 'And it is a meditation call and it is quieter in our home.'

describe('a sentence the reading wrote twice comes out once', () => {
  it('drops a long sentence repeated back to back (the reported takes)', () => {
    expect(collapseSpeechRepeats(`${ONE} ${ONE}`)).toBe(ONE)
    expect(collapseSpeechRepeats(`${TWO} ${TWO}`)).toBe(TWO)
    expect(collapseSpeechRepeats(`${ONE} ${ONE} ${TWO} ${TWO}`)).toBe(`${ONE} ${TWO}`)
  })

  it('ignores case, spacing and punctuation differences between the copies', () => {
    expect(collapseSpeechRepeats(`${ONE}  to do my call, because everyone was gonna go home from the cafe!`)).toBe(ONE)
    expect(collapseSpeechRepeats(`${ONE} ${ONE.slice(0, -1)}`)).toBe(ONE)
  })

  it('keeps one copy of a whole passage said twice', () => {
    expect(collapseSpeechRepeats('Call me back. I will be home soon. Call me back. I will be home soon.'))
      .toBe('Call me back. I will be home soon.')
  })

  it('drops a decoder loop of a shorter sentence', () => {
    expect(collapseSpeechRepeats('See you at noon. See you at noon. See you at noon.')).toBe('See you at noon.')
  })

  it('leaves ordinary speech exactly as it was read', () => {
    for (const text of [ONE, `${ONE} ${TWO}`, 'No. No.', 'Go. Go. Go.', 'Thank you. Thank you.', 'I said yes. I said yes!',
      'Okay so the plan is this, the plan is this.', '  spaced   out  reading  ', '', 'Hello there']) {
      expect(collapseSpeechRepeats(text)).toBe(text)
    }
    expect(collapseSpeechRepeats(`${ONE} ${TWO} ${ONE}`)).toBe(`${ONE} ${TWO} ${ONE}`)
  })
})

const servers: ReturnType<typeof createWizardServer>[] = []
afterEach(async () => { await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); servers.length = 0 })

async function fixture(reading: unknown) {
  const upstream = vi.fn(async (url: unknown) => String(url).endsWith('/v1/models')
    ? new Response(JSON.stringify({ data: [] }))
    : new Response(JSON.stringify(reading), { status: 200 }))
  const uxDir = mkdtempSync(join(tmpdir(), 'was-ux-'))
  writeFileSync(join(uxDir, 'index.html'), '<!doctype html>')
  const server = createWizardServer({ requireAccess: false, fetchImpl: upstream, archivedSessionReader: () => [], uxDir })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  return `http://127.0.0.1:${address.port}`
}

describe('the transcription routes return the sentence once', () => {
  it('/wizard/voice/transcribe (shell dictation, app voice notes)', async () => {
    const base = await fixture({ text: ` ${ONE} ${ONE}` })
    const response = await fetch(`${base}/wizard/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/aac' }, body: new Uint8Array(7426).fill(1) })
    expect(response.status).toBe(200)
    expect((await response.json()).text).toBe(ONE)
  })

  it('/wizard/voice/transcribe with a segmented reading', async () => {
    const base = await fixture({ text: '', segments: [{ text: ` ${TWO}` }, { text: ` ${TWO}` }] })
    const response = await fetch(`${base}/wizard/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/aac' }, body: new Uint8Array(7426).fill(1) })
    expect((await response.json()).text).toBe(TWO)
  })

  it('the native multipart path (Android orb and assistant)', async () => {
    const base = await fixture({ text: `${ONE} ${ONE}` })
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(7426).fill(1)], { type: 'audio/aac' }), 'voice.aac')
    const response = await fetch(`${base}/wizard-os-home/api/transcribe`, { method: 'POST', body: form })
    expect(response.status).toBe(200)
    expect((await response.json()).text).toBe(ONE)
  })
})
