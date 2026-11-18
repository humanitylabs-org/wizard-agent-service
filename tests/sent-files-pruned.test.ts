// Issue 556: Hermes prunes cache/audio and cache/images after 24 h, so a file an agent sent in a chat turned into
// "[file: X unavailable]" a day later. The Service already keeps a durable copy of every file it shows; a sent path
// that no longer exists must keep showing that copy.
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectAgentMedia } from '../server/service.mjs'

const root = mkdtempSync(join(tmpdir(), 'wizard-sent-pruned-'))
const home = join(root, 'home')
const audio = join(home, 'cache/audio')
const images = join(home, 'cache/images')
const roots = [audio, images]
afterAll(() => rmSync(root, { recursive: true, force: true }))
mkdirSync(audio, { recursive: true }); mkdirSync(images, { recursive: true })

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const mp3 = (n: number) => Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2048, n)])
const show = (artifacts: string, path: string) => JSON.parse(projectAgentMedia(Buffer.from(JSON.stringify({ messages: [
  { role: 'assistant', content: `Here is the voice sample.\n\nMEDIA:${path}\n` },
] })), artifacts, roots).toString()).messages[0].content as string
const items = (text: string) => [...text.matchAll(/<helm_attachments>([\s\S]*?)<\/helm_attachments>/g)].flatMap(m => JSON.parse(m[1]).items)

describe('a sent file after Hermes pruned its cache', () => {
  it('keeps showing the copy saved when the message was first shown', () => {
    const artifacts = join(root, 'a1')
    const path = join(audio, 'sky-voice-uk-1.mp3')
    writeFileSync(path, mp3(1))
    const [first] = items(show(artifacts, path))
    expect(first).toMatchObject({ name: 'sky-voice-uk-1.mp3', kind: 'audio', mime: 'audio/mpeg' })
    rmSync(path)
    const later = show(artifacts, path)
    expect(later).not.toContain('unavailable')
    expect(items(later)).toEqual([first])
    expect(readFileSync(join(artifacts, `${first.id}.bin`))).toEqual(mp3(1))
  })

  it('keeps images too, and a rewritten source still shows the new bytes while it exists', () => {
    const artifacts = join(root, 'a2')
    const path = join(images, 'poster.png')
    writeFileSync(path, png)
    const [first] = items(show(artifacts, path))
    expect(first.kind).toBe('image')
    const changed = Buffer.concat([png, Buffer.from([0])])
    writeFileSync(path, changed)
    const [second] = items(show(artifacts, path))
    expect(second.id).not.toBe(first.id)
    rmSync(path)
    expect(items(show(artifacts, path))).toEqual([second])
  })

  it('finds a copy saved before this fix by its unique file name', () => {
    const artifacts = join(root, 'a3')
    const path = join(audio, 'sky-voice-uk-2.mp3')
    writeFileSync(path, mp3(2))
    const [first] = items(show(artifacts, path))
    rmSync(join(artifacts, 'sources'), { recursive: true }) // an artifact store written before issue 556
    rmSync(path)
    expect(items(show(artifacts, path))).toEqual([first])
  })

  it('shows nothing rather than a guess when two old copies share a name', () => {
    const artifacts = join(root, 'a4')
    const a = join(audio, 'take.mp3'), b = join(images, 'take.mp3')
    writeFileSync(a, mp3(3)); writeFileSync(b, mp3(4))
    show(artifacts, a); show(artifacts, b)
    rmSync(join(artifacts, 'sources'), { recursive: true })
    rmSync(a)
    expect(show(artifacts, a)).toContain('[file: take.mp3 unavailable]')
  })

  it('never falls back for a path outside the agent folders or one that was never shown', () => {
    const artifacts = join(root, 'a5')
    const path = join(audio, 'outside-test.mp3')
    writeFileSync(path, mp3(5))
    show(artifacts, path)
    rmSync(join(artifacts, 'sources'), { recursive: true })
    expect(show(artifacts, join(root, 'elsewhere', 'outside-test.mp3'))).toContain('unavailable')
    expect(show(artifacts, join(audio, 'never-sent.mp3'))).toContain('[file: never-sent.mp3 unavailable]')
  })
})
