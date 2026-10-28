// Chat pictures and files no longer download again on every visit (Oscar for Miguel, 28 Oct 2026), and an owner file
// edited in place through Wizard Files still shows its new bytes at once (the browser revalidates instead of trusting
// a day-old copy). Agent-made artifacts are content-hashed, so they are cached for good.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const root = mkdtempSync(join(tmpdir(), 'wizard-media-cache-'))
const media = join(root, 'media')
let upstream: ReturnType<typeof createServer>
let wizard: ReturnType<typeof createWizardServer>
let base = ''

beforeAll(async () => {
  mkdirSync(media)
  upstream = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/v1/capabilities') { response.end(JSON.stringify({ features: { run_submission: true, run_status: true } })); return }
    response.statusCode = 404
    response.end('{}')
  })
  const upstreamAddress = await listen(upstream)
  wizard = createWizardServer({
    requireJoinedDelegationCapability: false,
    upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
    hermesKey: 'fixture',
    requireAccess: false,
    followThrough: false,
    mediaRoot: media,
    mediaAgentRoot: '/owner-files',
    mediaIndexPath: join(root, 'state', 'media-files.json'),
    agentArtifactDir: join(root, 'artifacts'),
    agentArtifactRoots: [media],
  })
  base = `http://127.0.0.1:${(await listen(wizard)).port}`
})

afterAll(async () => {
  await Promise.all([upstream, wizard].map((server) => new Promise<void>((done) => server.close(() => done()))))
  rmSync(root, { recursive: true, force: true })
})

describe('chat media browser cache', () => {
  it('an owner file is kept by the browser but revalidated, so an in-place edit shows at once', async () => {
    const uploaded = await fetch(`${base}/wizard/files/upload`, {
      method: 'POST', body: Buffer.from('first version\n'),
      headers: { 'Content-Type': 'application/octet-stream', 'X-Wizard-Filename': 'note.txt', 'X-Wizard-Mime': 'text/plain' },
    })
    expect(uploaded.status).toBe(201)
    const { id } = (await uploaded.json()).file

    const first = await fetch(`${base}/wizard/files/${id}/content`)
    expect(first.status).toBe(200)
    expect(first.headers.get('cache-control')).toBe('private, no-cache')
    const etag = first.headers.get('etag')
    expect(etag).toMatch(/^W\/"/)
    expect(await first.text()).toBe('first version\n')

    const again = await fetch(`${base}/wizard/files/${id}/content`, { headers: { 'If-None-Match': etag! } })
    expect(again.status).toBe(304)
    expect(await again.text()).toBe('')

    const rel = JSON.parse(readFileSync(join(root, 'state', 'media-files.json'), 'utf8')).files.find((f: { id: string }) => f.id === id).rel
    const path = resolve(media, rel)
    writeFileSync(path, 'edited in Wizard Files\n')
    const later = new Date(Date.now() + 5000)
    utimesSync(path, later, later)
    const edited = await fetch(`${base}/wizard/files/${id}/content`, { headers: { 'If-None-Match': etag! } })
    expect(edited.status).toBe(200)
    expect(edited.headers.get('etag')).not.toBe(etag)
    expect(await edited.text()).toBe('edited in Wizard Files\n')

    const part = await fetch(`${base}/wizard/files/${id}/content`, { headers: { Range: 'bytes=0-5', 'If-None-Match': edited.headers.get('etag')! } })
    expect(part.status).toBe(206)
  })

  it('an agent-made attachment (content-hashed id) is cached for good, never by shared caches', async () => {
    const id = 'ab'.repeat(16)
    mkdirSync(join(root, 'artifacts'), { recursive: true })
    writeFileSync(join(root, 'artifacts', `${id}.bin`), png)
    writeFileSync(join(root, 'artifacts', `${id}.json`), JSON.stringify({ id, name: 'poster.png', mime: 'image/png', kind: 'image', bytes: png.length, sha256: id }))
    const image = await fetch(`${base}/wizard/attachments/${id}`)
    expect(image.status).toBe(200)
    expect(image.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png)
  })
})
