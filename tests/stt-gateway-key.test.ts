// wizard-os issue 386 (card 5): the speech-to-text path sends the gateway's per-installation key to the Transcriber,
// so the Transcriber front can serve its engine API only to known box callers (its grants `enforce` flag).
// The key goes only to the installed app whose registry MCP address is the STT origin.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createWizardServer, listen } from '../server/service.mjs'

const seen: Array<{ path: string; grant: string }> = []
const root = mkdtempSync(join(tmpdir(), 'wizard-stt-key-'))
const key = randomBytes(32).toString('hex')   // generated at runtime (never a literal key in the repo)
let stt: ReturnType<typeof createServer>
let upstream: ReturnType<typeof createServer>
const services: Array<ReturnType<typeof createWizardServer>> = []

const home = (name: string, apps: unknown[], grants: Record<string, string> | null) => {
  const dir = join(root, name)
  mkdirSync(join(dir, 'grants'), { recursive: true })
  writeFileSync(join(dir, 'apps.json'), JSON.stringify({ apps }))
  if (grants) {
    writeFileSync(join(dir, 'grants', 'agent-service.json'), JSON.stringify({ outgoing: grants }))
    chmodSync(join(dir, 'grants', 'agent-service.json'), 0o600)
  }
  return dir
}
const sttOrigin = () => `http://127.0.0.1:${(stt.address() as any).port}`
const transcriber = (origin: string) => ({ id: 'transcriber', name: 'Transcriber', status: 'running', provides: ['transcription'], mcp: { url: `${origin}/mcp` } })

const start = async (dir: string) => {
  const svc = createWizardServer({
    joinedDelegation: 'prefer', requireAccess: false, followThrough: false, hermesKey: 'fixture',
    upstreamOrigin: `http://127.0.0.1:${(upstream.address() as any).port}`, sttOrigin: sttOrigin(),
    appsJsonPath: join(dir, 'apps.json'), wizardOsHome: dir,
  })
  services.push(svc)
  return `http://127.0.0.1:${(await listen(svc)).port}`
}

const dictate = async (base: string) => {
  seen.length = 0
  const status = await fetch(`${base}/wizard/voice/status`).then((r) => r.json())
  const r = await fetch(`${base}/wizard/voice/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: Buffer.from('synthetic audio') })
  return { status, transcribe: r.status, body: await r.json(), seen: [...seen] }
}

beforeAll(async () => {
  stt = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    if (request.url !== '/mcp') seen.push({ path: request.url ?? '', grant: String(request.headers['x-wizard-grant'] ?? '') })
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/health') { response.statusCode = 404; response.end('{}'); return }
    if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'Systran/faster-whisper-small', task: 'automatic-speech-recognition' }] })); return }
    if (request.url === '/v1/audio/transcriptions') { response.end(JSON.stringify({ text: 'hello there', segments: [{ text: 'hello there', no_speech_prob: 0.01 }] })); return }
    response.statusCode = 404; response.end('{}')
  })
  await listen(stt)
  upstream = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/v1/capabilities') { response.end(JSON.stringify({ features: { run_submission: true, run_status: true } })); return }
    response.statusCode = 404; response.end('{}')
  })
  await listen(upstream)
})

afterAll(async () => {
  await Promise.all([stt, upstream, ...services].map((s) => new Promise<void>((r) => s.close(() => r()))))
  rmSync(root, { recursive: true, force: true })
})

describe('speech-to-text carries the gateway key for the app at the STT origin', () => {
  it('sends X-Wizard-Grant on the readiness probe, the model listing and the transcription', async () => {
    const out = await dictate(await start(home('granted', [transcriber(sttOrigin())], { transcriber: key })))
    expect(out.status.ready).toBe(true)
    expect(out.transcribe).toBe(200)
    expect(out.body.text).toBe('hello there')
    const paths = out.seen.map((s) => s.path)
    expect(paths).toEqual(expect.arrayContaining(['/health', '/v1/models', '/v1/audio/transcriptions']))
    expect(out.seen.every((s) => s.grant === key)).toBe(true)
  })

  it('never sends a key to a listener that is not that app', async () => {
    const out = await dictate(await start(home('elsewhere', [transcriber('http://127.0.0.1:9')], { transcriber: key })))
    expect(out.transcribe).toBe(200)
    expect(out.seen.length).toBeGreaterThan(0)
    expect(out.seen.every((s) => s.grant === '')).toBe(true)
  })

  it('without a key the request is unchanged (the front decides by its enforce flag)', async () => {
    const out = await dictate(await start(home('nokey', [transcriber(sttOrigin())], null)))
    expect(out.transcribe).toBe(200)
    expect(out.seen.every((s) => s.grant === '')).toBe(true)
  })
})
