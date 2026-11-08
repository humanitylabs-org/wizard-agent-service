// Attachments in alongside mode: the service keeps the user-files folder at /media, the host Hermes sees the
// same folder at a host path. The agent must be handed the host path; the service must keep reading its own.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const text = Buffer.from('wizard sentinel 7f3a\n')
const root = mkdtempSync(join(tmpdir(), 'wizard-media-agent-root-'))
const serviceMedia = join(root, 'service-media')          // what the service container calls /media
const agentMedia = '/srv/host-runtipi/media'              // what the host Hermes calls the same folder (absent here)
const runs: Array<Record<string, any>> = []
let agentReply = ''
let upstream: ReturnType<typeof createServer>
let wizard: ReturnType<typeof createWizardServer>
let base = ''

const upload = async (bytes: Buffer, filename: string, mime: string) => {
  const response = await fetch(`${base}/wizard/files/upload`, {
    method: 'POST', body: bytes,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Wizard-Filename': filename, 'X-Wizard-Mime': mime },
  })
  expect(response.status).toBe(201)
  return (await response.json()).file
}

beforeAll(async () => {
  mkdirSync(serviceMedia)
  upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/v1/capabilities') { response.end(JSON.stringify({ features: { run_submission: true, run_status: true } })); return }
    if (request.method === 'POST' && request.url === '/v1/runs') {
      runs.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      response.end(JSON.stringify({ run_id: `run_${runs.length}`, status: 'started' }))
      return
    }
    if (request.url?.includes('/messages')) {
      response.end(JSON.stringify({ data: [{ id: 'a1', role: 'assistant', content: agentReply, timestamp: 1 }] }))
      return
    }
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
    mediaRoot: serviceMedia,
    mediaAgentRoot: agentMedia,
    mediaIndexPath: join(root, 'state', 'media-files.json'),
    agentArtifactDir: join(root, 'artifacts'),
    agentArtifactRoots: [serviceMedia],
  })
  base = `http://127.0.0.1:${(await listen(wizard)).port}`
})

afterAll(async () => {
  await Promise.all([upstream, wizard].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  rmSync(root, { recursive: true, force: true })
})

// The browser never sees a path; the stored relative path comes from the service's own index.
const relOf = (id: string) => JSON.parse(readFileSync(join(root, 'state', 'media-files.json'), 'utf8')).files.find((f: { id: string }) => f.id === id).rel as string

const markerFiles = (input: unknown) => {
  const raw = typeof input === 'string' ? input : JSON.stringify(input)
  const match = raw.match(/\[WIZARD_FILES_V1\]\\?n?([\s\S]*?)\\?n?\[\/WIZARD_FILES_V1\]/)
  expect(match).toBeTruthy()
  const body = typeof input === 'string' ? match![1] : JSON.parse(`"${match![1]}"`)
  return JSON.parse(body)
}

describe('attachments readable by the host Hermes', () => {
  it('hands the agent its own path, keeps the service path private, and stores bytes once', async () => {
    const file = await upload(text, 'notes.txt', 'text/plain')
    expect(file).not.toHaveProperty('trusted_path')
    expect(JSON.stringify(file)).not.toContain(serviceMedia)
    expect(JSON.stringify(file)).not.toContain(agentMedia)
    const response = await fetch(`${base}/wizard/hermes/v1/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'media-one' },
      body: JSON.stringify({ session_id: 'wizard_media', input: 'Read the attachment.', wizard_file_ids: [file.id] }),
    })
    expect(response.status).toBe(200)
    const [sent] = markerFiles(runs.at(-1)!.input)
    expect(sent.trusted_path).toBe(join(agentMedia, relOf(file.id)))
    expect(sent).not.toHaveProperty('localPath')
    expect(JSON.stringify(runs.at(-1))).not.toContain(serviceMedia)
    // The bytes are in the service's folder under the same relative path the agent is given.
    expect(relOf(file.id)).toMatch(/^Inbox\/\d{4}-\d{2}-\d{2}\/notes\.txt$/)
    expect(readFileSync(join(serviceMedia, relOf(file.id)))).toEqual(text)
    expect(sent.sha256).toBe(createHash('sha256').update(text).digest('hex'))
  })

  it('reads attached images from its own folder even though the agent path does not exist here', async () => {
    const file = await upload(png, 'shot.png', 'image/png')
    const response = await fetch(`${base}/wizard/hermes/v1/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'media-two' },
      body: JSON.stringify({ session_id: 'wizard_media', input: 'What is this?', wizard_file_ids: [file.id] }),
    })
    expect(response.status).toBe(200)
    const input = runs.at(-1)!.input
    expect(Array.isArray(input)).toBe(true)
    const parts = input[0].content
    expect(parts.filter((part: { type: string }) => part.type === 'image_url')).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
    ])
    const [sent] = markerFiles(parts[0].text)
    expect(sent.trusted_path).toBe(join(agentMedia, relOf(file.id)))
  })

  it('turns a file the agent names under its own path back into an openable attachment', async () => {
    const file = await upload(png, 'made.png', 'image/png')
    agentReply = `Here you go.\n\nMEDIA:${join(agentMedia, relOf(file.id))}`
    const body = await (await fetch(`${base}/wizard/hermes/api/sessions/wizard_media/messages?order=latest`)).text()
    expect(body).toContain('<helm_attachments>')
    expect(body).not.toContain(agentMedia)
    expect(body).not.toContain(serviceMedia)
    const id = body.match(/\\"id\\":\\"([0-9a-f]{32})/)?.[1]
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    const image = await fetch(`${base}/wizard/attachments/${id}`)
    expect(image.status).toBe(200)
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png)
  })

  it('leaves agent paths outside the shared folder alone', async () => {
    agentReply = 'Nope.\n\nMEDIA:/srv/host-runtipi/elsewhere/secret.png'
    const body = await (await fetch(`${base}/wizard/hermes/api/sessions/wizard_media/messages?order=latest`)).text()
    expect(body).not.toContain('<helm_attachments>')
  })
})
