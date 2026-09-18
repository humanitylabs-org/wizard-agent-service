import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const root = mkdtempSync(join(tmpdir(), 'wizard-agent-media-'))
const sourceRoot = join(root, 'source images')
const artifactDir = join(root, 'artifacts')
const source = join(sourceRoot, 'poster.png')
const secondSource = join(sourceRoot, 'second.png')
let upstream: ReturnType<typeof createServer>
let wizard: ReturnType<typeof createWizardServer>
let base = ''

beforeAll(async () => {
  mkdirSync(sourceRoot)
  writeFileSync(source, png)
  writeFileSync(secondSource, Buffer.concat([png, Buffer.from([0])]))
  upstream = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url?.includes('/messages')) {
      response.end(JSON.stringify({ data: [
        { id: 'assistant', role: 'assistant', content: `Made it.\n\nMEDIA:${source}`, timestamp: 1 },
        { id: 'unsafe', role: 'assistant', content: 'MEDIA:/etc/passwd', timestamp: 2 },
        ...['user', 'assistant'].map(role => ({ id: `${role}-inline-file`, role, content: [
          { type: 'text', text: `Review screenshot\n\n[WIZARD_FILES_V1]\n${JSON.stringify([
            { id: 'drop_screen', filename: 'screen.png', mime: 'image/png', bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') },
            { id: 'drop_voice', filename: 'voice.wav', mime: 'audio/wav', bytes: 44 },
          ])}\n[/WIZARD_FILES_V1]` },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.concat([png, Buffer.from([0])]).toString('base64')}` } },
        ], timestamp: 6 })),
        { id: 'user-inline-only', role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
        ], timestamp: 7 },
        { id: 'user-image', role: 'user', content: `Review this\n\n@image:\`${source}\`\n[screenshot]`, timestamp: 3 },
        { id: 'user-image-file', role: 'user', content: `Review durable file\n\n[WIZARD_FILES_V1]\n[{"id":"drop_screen","filename":"screen.png","mime":"image/png","bytes":${png.length},"sha256":"${createHash('sha256').update(png).digest('hex')}"}]\n[/WIZARD_FILES_V1]\n\n[WIZARD_IMAGE_INTENT_V1]\nInspect the trusted image path before answering.\n[/WIZARD_IMAGE_INTENT_V1]\n@image:\`${source}\`\n[screenshot]`, timestamp: 4 },
        { id: 'user-image-mixed', role: 'user', content: `Review both\n\n[WIZARD_FILES_V1]\n[{"id":"drop_screen","filename":"screen.png","mime":"image/png","bytes":${png.length},"sha256":"${createHash('sha256').update(png).digest('hex')}"}]\n[/WIZARD_FILES_V1]\n@image:\`${source}\`\n@image:\`${secondSource}\`\n[screenshot]`, timestamp: 5 },
      ] }))
      return
    }
    response.end(JSON.stringify({ id: 'run-one', status: 'completed', output: `Done\nMEDIA:${source}` }))
  })
  const upstreamAddress = await listen(upstream)
  wizard = createWizardServer({
    requireJoinedDelegationCapability: false,
    upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
    hermesKey: 'fixture',
    requireAccess: false,
    agentArtifactDir: artifactDir,
    agentArtifactRoots: [sourceRoot],
  })
  const wizardAddress = await listen(wizard)
  base = `http://127.0.0.1:${wizardAddress.port}`
})

afterAll(async () => {
  await Promise.all([upstream, wizard].filter(Boolean).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  rmSync(root, { recursive: true, force: true })
})

describe('agent image delivery', () => {
  it('renders the durable screenshot once while keeping distinct photos and audio', async () => {
    const payload = await (await fetch(`${base}/wizard/hermes/api/sessions/chat/messages?order=latest`)).json()
    const parts = payload.data.find((message: { id: string }) => message.id === 'user-inline-file').content
    expect(parts.filter((part: { type: string }) => part.type === 'image_url')).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.concat([png, Buffer.from([0])]).toString('base64')}` } },
    ])
    expect(parts[0].text).toContain('drop_screen')
    expect(parts[0].text).toContain('drop_voice')
    expect(payload.data.find((message: { id: string }) => message.id === 'user-inline-only').content).toHaveLength(1)
    expect(payload.data.find((message: { id: string }) => message.id === 'assistant-inline-file').content).toHaveLength(3)
  })

  it('projects trusted MEDIA paths into openable private image attachments', async () => {
    const response = await fetch(`${base}/wizard/hermes/api/sessions/chat/messages?order=latest`)
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('Made it.')
    expect(body).toContain('<helm_attachments>')
    expect(body).not.toContain(sourceRoot)
    expect(body).not.toContain('/etc/passwd')
    const content = JSON.parse(body).data[0].content as string
    const id = content.match(/"id":"([0-9a-f]{32})/)?.[1]
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    const image = await fetch(`${base}/wizard/attachments/${id}`)
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(image.headers.get('content-disposition')).toContain("inline; filename*=UTF-8''poster.png")
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png)
    const head = await fetch(`${base}/wizard/attachments/${id}`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })

  it('projects completed run output before the client renders it', async () => {
    const body = await (await fetch(`${base}/wizard/hermes/v1/runs/run-one`)).text()
    expect(body).toContain('<helm_attachments>')
    expect(body).not.toContain(sourceRoot)
  })

  it('restores persisted user image references as attachments instead of screenshot text', async () => {
    const payload = await (await fetch(`${base}/wizard/hermes/api/sessions/chat/messages?order=latest`)).json() as { data: Array<{ id: string; content: string }> }
    const content = payload.data.find((message) => message.id === 'user-image')?.content ?? ''
    expect(content).toContain('Review this')
    expect(content).toContain('<helm_attachments>')
    expect(content).not.toContain('[screenshot]')
    expect(content).not.toContain(sourceRoot)
  })

  it('deduplicates a persisted image reference beside its durable file chip', async () => {
    const payload = await (await fetch(`${base}/wizard/hermes/api/sessions/chat/messages?order=latest`)).json() as { data: Array<{ id: string; content: string }> }
    const content = payload.data.find((message) => message.id === 'user-image-file')?.content ?? ''
    expect(content).toContain('[WIZARD_FILE_CHIPS_V1]')
    expect(content).not.toContain('<helm_attachments>')
    expect(content).not.toContain('[screenshot]')
    expect(content).not.toContain('[WIZARD_IMAGE_INTENT_V1]')
    expect(content).not.toContain(sourceRoot)
  })

  it('keeps a distinct browser photo beside a durable image file', async () => {
    const payload = await (await fetch(`${base}/wizard/hermes/api/sessions/chat/messages?order=latest`)).json() as { data: Array<{ id: string; content: string }> }
    const content = payload.data.find((message) => message.id === 'user-image-mixed')?.content ?? ''
    expect(content).toContain('[WIZARD_FILE_CHIPS_V1]')
    expect(content).toContain('<helm_attachments>')
    expect(content).not.toContain('[screenshot]')
    expect(content).not.toContain(sourceRoot)
  })
})
