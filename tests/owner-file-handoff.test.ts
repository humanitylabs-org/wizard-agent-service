// James asked how a thread should send him a file (a 16 MB PDF) so it opens in one tap on his phone.
// The one supported route: a MEDIA:/path line for a file in the agent's own home becomes a file card
// served by /wizard/attachments/<id>. These tests pin that route and the instruction every thread reads.
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectAgentMedia } from '../server/service.mjs'
import { WIZARD_CHAT_MEDIA_INSTRUCTIONS } from '../server/chat-presentation.mjs'

const root = mkdtempSync(join(tmpdir(), 'wizard-owner-file-'))
const home = join(root, 'home')
const artifacts = join(root, 'artifacts')
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('sending the owner a file from a thread', () => {
  it('turns a PDF over 5 MB anywhere in the agent home into one file card', () => {
    mkdirSync(join(home, 'runtipi/media/Wizard Quest'), { recursive: true })
    const pdfPath = join(home, 'runtipi/media/Wizard Quest/Flight Packet.pdf')
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(6 * 1024 * 1024, 32)])
    writeFileSync(pdfPath, pdf)
    const reply = Buffer.from(JSON.stringify({ output: `Here is the flight packet.\n\nMEDIA:${pdfPath}\n` }))
    const content = JSON.parse(projectAgentMedia(reply, artifacts, [home]).toString()).output as string
    expect(content).not.toContain(home)
    expect(content).not.toContain('unavailable')
    const items = JSON.parse(content.match(/<helm_attachments>([\s\S]*?)<\/helm_attachments>/)?.[1] ?? '{"items":[]}').items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ name: 'Flight Packet.pdf', mime: 'application/pdf', kind: 'file', bytes: pdf.length })
  })

  it('tells every thread that MEDIA sends non-image files up to 256 MB and to skip Files URLs', () => {
    expect(WIZARD_CHAT_MEDIA_INSTRUCTIONS).toContain('MEDIA:/absolute/path')
    expect(WIZARD_CHAT_MEDIA_INSTRUCTIONS).toMatch(/PDF/)
    expect(WIZARD_CHAT_MEDIA_INSTRUCTIONS).toMatch(/256 MB/)
    expect(WIZARD_CHAT_MEDIA_INSTRUCTIONS).toMatch(/5 MB limit is for images only/)
    expect(WIZARD_CHAT_MEDIA_INSTRUCTIONS).toMatch(/Files API URL/)
    expect(WIZARD_CHAT_MEDIA_INSTRUCTIONS).toMatch(/non-image files are not intercepted/)
  })
})
