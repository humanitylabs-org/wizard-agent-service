import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMediaFiles } from '../server/media-files.mjs'
import { readApps, wizardOsInstructions } from '../server/wizard-os-settings.mjs'

const fixed = () => new Date('2026-10-10T12:00:00Z')

describe('media files (Wizard OS user-files root)', () => {
  it('saves uploads under Inbox/<date>/<name>, lists them and resolves the agent path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wmf-'))
    const files = createMediaFiles({ mediaRoot: join(dir, 'media'), agentRoot: '/files', indexPath: join(dir, 'idx.json'), now: fixed })
    const saved = files.save(Buffer.from('hello'), { filename: 'clip.mp4', mime: 'video/mp4' })
    expect(saved.id).toMatch(/^wf_[0-9a-f]{32}$/)
    expect(saved.path).toBe('Inbox/2026-10-10/clip.mp4')
    expect(readFileSync(join(dir, 'media/Inbox/2026-10-10/clip.mp4'), 'utf8')).toBe('hello')
    expect(files.get(saved.id, true).trusted_path).toBe('/files/Inbox/2026-10-10/clip.mp4')
    expect(files.list().map((f) => f.id)).toEqual([saved.id])
  })

  it('never overwrites: a second file with the same name gets a numbered name and records the duplicate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wmf-'))
    const files = createMediaFiles({ mediaRoot: join(dir, 'media'), agentRoot: '/files', indexPath: join(dir, 'idx.json'), now: fixed })
    const a = files.save(Buffer.from('x'), { filename: 'a.txt', mime: 'text/plain' })
    const b = files.save(Buffer.from('x'), { filename: 'a.txt', mime: 'text/plain' })
    expect(b.path).toBe('Inbox/2026-10-10/a (2).txt')
    expect(b.duplicate_of).toBe(a.id)
  })

  it('keeps path tricks inside the folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wmf-'))
    const files = createMediaFiles({ mediaRoot: join(dir, 'media'), agentRoot: '/files', indexPath: join(dir, 'idx.json'), now: fixed })
    const saved = files.save(Buffer.from('x'), { filename: '../../etc/passwd', mime: 'text/plain' })
    expect(saved.path).toBe('Inbox/2026-10-10/passwd')
    expect(existsSync(join(dir, 'etc'))).toBe(false)
    expect(files.get('wf_nope')).toBeNull()
  })

  it('serves byte ranges', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wmf-'))
    const files = createMediaFiles({ mediaRoot: join(dir, 'media'), agentRoot: '/files', indexPath: join(dir, 'idx.json'), now: fixed })
    const saved = files.save(Buffer.from('0123456789'), { filename: 'n.bin', mime: 'application/octet-stream' })
    const part = files.open(saved.id, 'bytes=2-4')
    expect([part.status, part.start, part.end, part.size]).toEqual([206, 2, 4, 10])
    const chunks = []
    for await (const c of part.stream) chunks.push(c)
    expect(Buffer.concat(chunks).toString()).toBe('234')
    expect(files.open(saved.id, 'bytes=20-30').status).toBe(416)
  })
})

describe('Wizard OS instructions inside a container', () => {
  const box = () => {
    const dir = mkdtempSync(join(tmpdir(), 'wos-'))
    mkdirSync(join(dir, 'skills/defleur-video'), { recursive: true })
    writeFileSync(join(dir, 'skills/defleur-video/SKILL.md'), '---\nname: defleur-video\ndescription: edit\n---\nCall edit_video.')
    writeFileSync(join(dir, 'apps.json'), JSON.stringify({ apps: [{
      id: 'defleur-video', name: 'DeFleur Video', status: 'running', summary: 'Edit videos.', provides: ['video-editing'],
      mcp: { url: 'http://127.0.0.1:20002/mcp', internal: 'http://defleur-video:8787/mcp', transport: 'streamable-http' },
      skill: 'skills/defleur-video/SKILL.md',
    }] }))
    return join(dir, 'apps.json')
  }

  it('host mode: loopback MCP url and a skill path', () => {
    const text = wizardOsInstructions({ appsJsonPath: box() })
    expect(text).toContain('http://127.0.0.1:20002/mcp')
    expect(text).toContain('Read its skill first:')
  })

  it('container mode: service-name MCP url and the skill text inline', () => {
    const text = wizardOsInstructions({ appsJsonPath: box(), mcpAddress: 'internal', skillsInline: true })
    expect(text).toContain('http://defleur-video:8787/mcp')
    expect(text).not.toContain('127.0.0.1')
    expect(text).toContain('<skill app="defleur-video">')
    expect(text).toContain('Call edit_video.')
  })
})

describe('launcher on a Wizard OS box', () => {
  it('never shows the shell itself as a tile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wla-'))
    const appsJsonPath = join(dir, 'apps.json')
    writeFileSync(appsJsonPath, JSON.stringify({ apps: [
      { id: 'wizard-shell', name: 'Wizard', provides: ['shell'], view: { url: '/apps/wizard-shell/' } },
      { id: 'files', name: 'Files', provides: ['files'], view: { url: '/apps/files/' } },
    ] }))
    const ids = readApps({ appsJsonPath, launcherPath: join(dir, 'none.json') }).apps.map((a) => a.id)
    expect(ids).toEqual(['files'])
  })
})
