import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const root = mkdtempSync(join(tmpdir(), 'wizard-agent-media-'))
const sourceRoot = join(root, 'source')
const artifactDir = join(root, 'artifacts')
const source = join(sourceRoot, 'poster.png')
let upstream: ReturnType<typeof createServer>
let wizard: ReturnType<typeof createWizardServer>
let base = ''

beforeAll(async () => {
  mkdirSync(sourceRoot)
  writeFileSync(source, png)
  upstream = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url?.includes('/messages')) {
      response.end(JSON.stringify({ data: [
        { id: 'assistant', role: 'assistant', content: `Made it.\n\nMEDIA:${source}`, timestamp: 1 },
        { id: 'unsafe', role: 'assistant', content: 'MEDIA:/etc/passwd', timestamp: 2 },
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
})
