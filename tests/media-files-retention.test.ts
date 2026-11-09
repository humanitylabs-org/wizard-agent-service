// Issue 422: the built-in file store must never forget a file because of how many came after it.
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMediaFiles } from '../server/media-files.mjs'

const fixed = () => new Date('2026-10-10T12:00:00Z')
const COUNT = 5_005

const store = () => {
  const dir = mkdtempSync(join(tmpdir(), 'wmf-keep-'))
  const indexPath = join(dir, 'state', 'media-files.json')
  const files = createMediaFiles({ mediaRoot: join(dir, 'media'), agentRoot: '/files', indexPath, now: fixed })
  return { dir, indexPath, files }
}

const bytesOf = async (stream: AsyncIterable<Buffer>) => {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

describe('built-in file store keeps every file (issue 422)', () => {
  it('opens the first file by id after 5,001+ uploads, with the right bytes and type', async () => {
    const { files, indexPath } = store()
    const first = files.save(Buffer.from('first file bytes'), { filename: 'first.png', mime: 'image/png' })
    for (let n = 1; n < COUNT; n += 1) files.save(Buffer.from(`file ${n}`), { filename: `f${n}.txt`, mime: 'text/plain' })

    expect(JSON.parse(readFileSync(indexPath, 'utf8')).files.length).toBe(COUNT)
    const record = files.get(first.id, true)
    expect(record).not.toBeNull()
    expect(record.mime).toBe('image/png')
    expect(record.trusted_path).toBe('/files/Inbox/2026-10-10/first.png')
    const opened = files.open(first.id)
    expect(opened.status).toBe(200)
    expect(opened.record.mime).toBe('image/png')
    expect((await bytesOf(opened.stream)).toString()).toBe('first file bytes')

    // A fresh store over the same index (a service restart) still finds it.
    const again = createMediaFiles({ mediaRoot: files.root, agentRoot: '/files', indexPath, now: fixed })
    expect(again.get(first.id)?.id).toBe(first.id)
  }, 120_000)

  it('duplicate detection still finds the first file after 5,001+ uploads', () => {
    const { files } = store()
    const first = files.save(Buffer.from('the original'), { filename: 'orig.txt', mime: 'text/plain' })
    for (let n = 1; n < COUNT; n += 1) files.save(Buffer.from(`file ${n}`), { filename: `f${n}.txt`, mime: 'text/plain' })
    const dup = files.save(Buffer.from('the original'), { filename: 'copy.txt', mime: 'text/plain' })
    expect(dup.duplicate_of).toBe(first.id)
  }, 120_000)

  it('opening or looking up an attachment does not rewrite the list', async () => {
    const { files, indexPath } = store()
    const saved = files.save(Buffer.from('0123456789'), { filename: 'n.bin', mime: 'application/octet-stream' })
    const before = readFileSync(indexPath, 'utf8')
    const stamp = statSync(indexPath, { bigint: true })
    files.get(saved.id, true)
    await bytesOf(files.open(saved.id).stream)
    await bytesOf(files.open(saved.id, 'bytes=2-4').stream)
    files.list()
    const after = statSync(indexPath, { bigint: true })
    expect(readFileSync(indexPath, 'utf8')).toBe(before)
    expect([after.ino, after.mtimeNs]).toEqual([stamp.ino, stamp.mtimeNs])
  })

  it('sees records another writer added to the index file', () => {
    const { files, indexPath } = store()
    files.save(Buffer.from('a'), { filename: 'a.txt', mime: 'text/plain' })
    const other = createMediaFiles({ mediaRoot: files.root, agentRoot: '/files', indexPath, now: fixed })
    const b = other.save(Buffer.from('b'), { filename: 'b.txt', mime: 'text/plain' })
    expect(files.get(b.id)?.id).toBe(b.id)
    expect(files.list().length).toBe(2)
  })
})
