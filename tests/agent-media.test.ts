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
const apkSource = join(sourceRoot, 'wizard-os-0.6.3.apk')
// A zip local-file header plus padding: big enough to exceed the 5 MB image cap.
const apk = Buffer.concat([Buffer.from('PK\x03\x04', 'binary'), Buffer.alloc(6 * 1024 * 1024, 7)])
let upstream: ReturnType<typeof createServer>
let wizard: ReturnType<typeof createWizardServer>
let base = ''

beforeAll(async () => {
  mkdirSync(sourceRoot)
  writeFileSync(source, png)
  writeFileSync(secondSource, Buffer.concat([png, Buffer.from([0])]))
  writeFileSync(apkSource, apk)
  upstream = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url?.includes('/messages')) {
      response.end(JSON.stringify({ data: [
        { id: 'assistant', role: 'assistant', content: `Made it.\n\nMEDIA:${source}`, timestamp: 1 },
        { id: 'unsafe', role: 'assistant', content: 'MEDIA:/etc/passwd', timestamp: 2 },
        { id: 'positioned', role: 'assistant', content: `First layout.\nMEDIA:${source}\nSecond layout.\nMEDIA:${secondSource}\nChoose either.\nMEDIA:${source}\nMEDIA:${apkSource}`, timestamp: 10 },
        { id: 'literal', role: 'assistant', content: `Example only:\n\`\`\`text\nMEDIA:/example/screenshot.png\n\`\`\``, timestamp: 11 },
        { id: 'assistant-apk', role: 'assistant', content: `Latest build.\n\nMEDIA:${apkSource}\n\nInstall it over the old copy.`, timestamp: 8 },
        { id: 'assistant-missing', role: 'assistant', content: `Here it is.\n\nMEDIA:${join(sourceRoot, 'gone.pdf')}`, timestamp: 9 },
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
  it('agent screenshots appear inline where the reply mentions them', async () => {
    const payload = await (await fetch(`${base}/wizard/hermes/api/sessions/chat/messages?order=latest`)).json()
    const content = payload.data.find((message: { id: string }) => message.id === 'positioned').content as string
    const blocks = [...content.matchAll(/<helm_attachments>([\s\S]*?)<\/helm_attachments>/g)]
    expect(blocks).toHaveLength(3)
    expect(blocks.slice(0, 2).map(block => JSON.parse(block[1]))).toEqual([
      expect.objectContaining({ inline: true, items: [expect.objectContaining({ name: 'poster.png', kind: 'image' })] }),
      expect.objectContaining({ inline: true, items: [expect.objectContaining({ name: 'second.png', kind: 'image' })] }),
    ])
    expect(content.indexOf('First layout.')).toBeLessThan(blocks[0].index!)
    expect(blocks[0].index!).toBeLessThan(content.indexOf('Second layout.'))
    expect(content.indexOf('Second layout.')).toBeLessThan(blocks[1].index!)
    expect(blocks[1].index!).toBeLessThan(content.indexOf('Choose either.'))
    expect(JSON.parse(blocks[2][1])).toMatchObject({ items: [{ kind: 'file' }] })
    const legacyItems = blocks.flatMap(block => JSON.parse(block[1]).items)
    expect(new Set(legacyItems.map(item => item.id)).size).toBe(3)
    expect(content).not.toContain(sourceRoot)
    const literal = payload.data.find((message: { id: string }) => message.id === 'literal').content
    expect(literal).not.toContain('<helm_attachments>')
  })

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
    expect(image.headers.get('content-disposition')).toContain('inline; filename="poster.png"')
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png)
    const head = await fetch(`${base}/wizard/attachments/${id}`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })

  it('projects a MEDIA APK into one downloadable file attachment', async () => {
    const payload = await (await fetch(`${base}/wizard/hermes/api/sessions/chat/messages?order=latest`)).json() as { data: Array<{ id: string; content: string }> }
    const content = payload.data.find((message) => message.id === 'assistant-apk')?.content ?? ''
    expect(content).toContain('Latest build.')
    expect(content).toContain('Install it over the old copy.')
    expect(content).not.toContain(sourceRoot)
    const envelope = content.match(/<helm_attachments>([\s\S]*?)<\/helm_attachments>/)?.[1] ?? '{"items":[]}'
    const items = JSON.parse(envelope).items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ name: 'wizard-os-0.6.3.apk', mime: 'application/vnd.android.package-archive', kind: 'file', bytes: apk.length })
    const file = await fetch(`${base}/wizard/attachments/${items[0].id}`)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toBe('application/vnd.android.package-archive')
    expect(file.headers.get('content-disposition')).toContain('attachment; filename="wizard-os-0.6.3.apk"')
    expect(Buffer.from(await file.arrayBuffer()).equals(apk)).toBe(true)
    const part = await fetch(`${base}/wizard/attachments/${items[0].id}`, { headers: { Range: 'bytes=0-3' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 0-3/${apk.length}`)
    expect(Buffer.from(await part.arrayBuffer()).toString('binary')).toBe('PK\x03\x04')
  })

  it('leaves a visible line when a MEDIA file cannot be shown', async () => {
    const payload = await (await fetch(`${base}/wizard/hermes/api/sessions/chat/messages?order=latest`)).json() as { data: Array<{ id: string; content: string }> }
    const content = payload.data.find((message) => message.id === 'assistant-missing')?.content ?? ''
    expect(content).toContain('Here it is.')
    expect(content).toContain('[file: gone.pdf unavailable]')
    expect(content).not.toContain(sourceRoot)
    expect(payload.data.find((message) => message.id === 'unsafe')?.content).toBe('[file: passwd unavailable]')
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
