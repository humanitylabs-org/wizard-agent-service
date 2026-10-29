// James asked how a thread should send him a file (a 16 MB PDF) so it opens in one tap on his phone.
// The one supported route: a MEDIA:/path line for a file in a configured artifact root becomes a file card
// served by /wizard/attachments/<id>. These tests pin that route, with the shipped roots, and the instruction.
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectAgentMedia } from '../server/service.mjs'
import { WIZARD_CHAT_MEDIA_INSTRUCTIONS } from '../server/chat-presentation.mjs'

const root = mkdtempSync(join(tmpdir(), 'wizard-owner-file-'))
const home = join(root, 'home')
const artifacts = join(root, 'artifacts')
afterAll(() => rmSync(root, { recursive: true, force: true }))

// The shipped Runtipi recipe: WIZARD_AGENT_ARTIFACT_ROOTS is the agent's cache/images plus the Files root.
const compose = readFileSync(join(__dirname, '../runtipi/docker-compose.yml'), 'utf8')
const shippedRoots = (compose.match(/WIZARD_AGENT_ARTIFACT_ROOTS:\s*(\S+)/)?.[1] ?? '').split(':')
const roots = shippedRoots.map(r => r.replace(/^\/hermes/, home).replace(/^\/media$/, join(root, 'files')))
const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(6 * 1024 * 1024, 32)])
const send = (path: string) => JSON.parse(projectAgentMedia(Buffer.from(JSON.stringify({ output: `Here is the flight packet.\n\nMEDIA:${path}\n` })), artifacts, roots).toString()).output as string

describe('sending the owner a file from a thread', () => {
  it('uses the shipped artifact roots', () => {
    expect(shippedRoots).toEqual(['/hermes/cache/images', '/media'])
  })

  it('turns a PDF over 5 MB in cache/images into one file card', () => {
    mkdirSync(join(home, 'cache/images'), { recursive: true })
    const pdfPath = join(home, 'cache/images/Flight Packet.pdf')
    writeFileSync(pdfPath, pdf)
    const content = send(pdfPath)
    expect(content).not.toContain(home)
    expect(content).not.toContain('unavailable')
    const items = JSON.parse(content.match(/<helm_attachments>([\s\S]*?)<\/helm_attachments>/)?.[1] ?? '{"items":[]}').items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ name: 'Flight Packet.pdf', mime: 'application/pdf', kind: 'file', bytes: pdf.length })
  })

  it('does not show a file elsewhere in the home, so the instruction says to copy it into cache/images', () => {
    mkdirSync(join(home, 'workspace'), { recursive: true })
    writeFileSync(join(home, 'workspace/Elsewhere.pdf'), pdf)
    expect(send(join(home, 'workspace/Elsewhere.pdf'))).toContain('unavailable')
    expect(WIZARD_CHAT_MEDIA_INSTRUCTIONS).toContain('copy it into your own cache/images first')
    expect(WIZARD_CHAT_MEDIA_INSTRUCTIONS).not.toMatch(/anywhere in your own home/)
  })

  it('tells every thread that MEDIA sends non-image files up to 256 MB and to skip Files URLs', () => {
    expect(WIZARD_CHAT_MEDIA_INSTRUCTIONS).toContain('MEDIA:/absolute/path')
    expect(WIZARD_CHAT_MEDIA_INSTRUCTIONS).toMatch(/PDF/)
    expect(WIZARD_CHAT_MEDIA_INSTRUCTIONS).toMatch(/256 MB/)
    expect(WIZARD_CHAT_MEDIA_INSTRUCTIONS).toMatch(/5 MB limit is for images only/)
    expect(WIZARD_CHAT_MEDIA_INSTRUCTIONS).toMatch(/Files API URL/)
    expect(WIZARD_CHAT_MEDIA_INSTRUCTIONS).toMatch(/non-image files are not intercepted/)
    expect(WIZARD_CHAT_MEDIA_INSTRUCTIONS).toMatch(/right after the sentence that talks about it/)
  })
})
