// Issue 423: old Wizard Uploads files move into the built-in file store under their own ids.
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { importArgs, importInboxUploads, importedDate } from '../server/inbox-import.mjs'
import { createMediaFiles } from '../server/media-files.mjs'

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const id = (n: number) => `drop_${n.toString(16).padStart(32, '0')}`

function oldInbox() {
  const dir = mkdtempSync(join(tmpdir(), 'w-inbox-import-'))
  const data = join(dir, 'wizard-inbox')
  mkdirSync(data, { recursive: true })
  const dbPath = join(data, 'inbox.sqlite3')
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE drops (id TEXT PRIMARY KEY, upload_id TEXT, device_id TEXT, filename TEXT,
    mime TEXT, bytes INTEGER, sha256 TEXT, note TEXT, duplicate_of TEXT, blob_path TEXT, created_at REAL)`)
  const add = (n: number, filename: string, mime: string, bytes: Buffer | null, opts: { listed?: number, at?: number, duplicateOf?: string, blob?: string } = {}) => {
    const hash = bytes ? sha(bytes) : 'f'.repeat(64)
    const blob = opts.blob ?? join(data, 'blobs', hash.slice(0, 2), hash)
    if (bytes) { mkdirSync(dirname(blob), { recursive: true }); if (!existsSync(blob)) writeFileSync(blob, bytes) }
    db.prepare('INSERT INTO drops (id, filename, mime, bytes, sha256, duplicate_of, blob_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id(n), filename, mime, opts.listed ?? bytes?.length ?? 3, hash, opts.duplicateOf ?? null, relative(data, blob), opts.at ?? 1_762_000_000 + n)
    return { id: id(n), blob, hash }
  }
  const media = join(dir, 'media')
  const indexPath = join(dir, 'state', 'media-files.json')
  return { dir, data, dbPath, db, add, media, indexPath, run: (dryRun = false, extra = {}) => importInboxUploads({ inboxDbPath: dbPath, mediaRoot: media, indexPath, dryRun, ...extra }) }
}

const bytesOf = async (stream: AsyncIterable<Buffer>) => {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

const tree = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : []

describe('import old Wizard Uploads into the built-in store (issue 423)', () => {
  it('a dry run reports the counts and writes nothing', () => {
    const f = oldInbox()
    f.add(1, 'photo.jpg', 'image/jpeg', Buffer.from('jpeg bytes'))
    f.add(2, 'voice.m4a', 'audio/mp4', Buffer.from('voice note bytes'))
    const gone = f.add(3, 'gone.pdf', 'application/pdf', null)
    f.add(4, 'short.txt', 'text/plain', Buffer.from('abc'), { listed: 99 })
    f.db.close()
    const dbBefore = readFileSync(f.dbPath)
    const result = f.run(true)
    expect(result.dry_run).toBe(true)
    expect(result.counts).toMatchObject({ total: 4, imported: 2, already_present: 0, missing: 1, size_mismatch: 1, linked: 0, copied: 0 })
    expect(result.problems.map((p: { id: string }) => p.id)).toContain(gone.id)
    expect(existsSync(f.media)).toBe(false)
    expect(existsSync(f.indexPath)).toBe(false)
    expect(readFileSync(f.dbPath).equals(dbBefore)).toBe(true)
  })

  it('links each upload under its old id, keeps the old blobs, and grows disk by the list only', async () => {
    const f = oldInbox()
    const image = Buffer.from('jpeg bytes '.repeat(200))
    const photo = f.add(1, 'photo.jpg', 'image/jpeg', image, { at: Date.parse('2026-03-04T10:00:00Z') / 1000 })
    const voice = f.add(2, 'voice.m4a', 'audio/mp4', Buffer.from('0123456789voice'))
    const again = f.add(3, 'photo.jpg', 'image/jpeg', image, { duplicateOf: photo.id })
    // The same bytes under the same name on the same day get their own name, never another record's.
    const twin = f.add(4, 'photo.jpg', 'image/jpeg', image, { duplicateOf: photo.id })
    f.db.close()
    const result = f.run()
    expect(result.counts).toMatchObject({ total: 4, imported: 4, linked: 4, copied: 0, copied_bytes: 0 })
    expect(existsSync(photo.blob) && existsSync(voice.blob)).toBe(true)

    const index = JSON.parse(readFileSync(f.indexPath, 'utf8')).files
    const first = index.find((r: { id: string }) => r.id === photo.id)
    expect(first).toMatchObject({ rel: 'Inbox/2026-03-04/photo.jpg', filename: 'photo.jpg', mime: 'image/jpeg', bytes: image.length, sha256: photo.hash, created_at: '2026-03-04T10:00:00.000Z', duplicate_of: null })
    expect(index.find((r: { id: string }) => r.id === again.id)).toMatchObject({ duplicate_of: photo.id, rel: 'Inbox/2025-11-01/photo.jpg' })
    expect(index.find((r: { id: string }) => r.id === twin.id).rel).toBe('Inbox/2025-11-01/photo (2).jpg')
    // Same inode as the old blob: no file bytes were written.
    expect(statSync(join(f.media, first.rel)).ino).toBe(statSync(photo.blob).ino)

    // Off by default: the store still refuses drop_ ids.
    const off = createMediaFiles({ mediaRoot: f.media, agentRoot: '/files', indexPath: f.indexPath })
    expect(off.get(photo.id)).toBeNull()
    expect(off.open(photo.id)).toBeNull()

    const on = createMediaFiles({ mediaRoot: f.media, agentRoot: '/files', indexPath: f.indexPath, legacyIds: true })
    expect(on.get(photo.id, true)).toMatchObject({ id: photo.id, mime: 'image/jpeg', trusted_path: '/files/Inbox/2026-03-04/photo.jpg' })
    const opened = on.open(photo.id)
    expect((await bytesOf(opened.stream)).equals(image)).toBe(true)
    const part = on.open(voice.id, 'bytes=10-')
    expect(part).toMatchObject({ status: 206, start: 10, end: 14, size: 15 })
    expect((await bytesOf(part.stream)).toString()).toBe('voice')
    expect(on.get('drop_nothex')).toBeNull()
  })

  it('a second run adds nothing, and a run that stopped before writing the list reuses its links', () => {
    const f = oldInbox()
    const photo = f.add(1, 'photo.jpg', 'image/jpeg', Buffer.from('jpeg'))
    f.add(2, 'note.txt', 'text/plain', Buffer.from('note'))
    f.db.close()
    // Earlier run linked the photo, then stopped before the list was saved.
    const created = new Date((1_762_000_001) * 1000).toISOString().slice(0, 10)
    mkdirSync(join(f.media, 'Inbox', created), { recursive: true })
    linkSync(photo.blob, join(f.media, 'Inbox', created, 'photo.jpg'))

    expect(f.run().counts).toMatchObject({ imported: 2, already_present: 0 })
    const files = tree(f.media)
    expect(files.filter((name) => name.includes('photo'))).toEqual([`Inbox/${created}/photo.jpg`])
    const indexBefore = readFileSync(f.indexPath)
    const again = f.run()
    expect(again.counts).toMatchObject({ total: 2, imported: 0, already_present: 2, linked: 0 })
    expect(tree(f.media)).toEqual(files)
    expect(readFileSync(f.indexPath).equals(indexBefore)).toBe(true)
  })

  it('copies only where the disk cannot hard link', () => {
    const f = oldInbox()
    const data = Buffer.from('across disks')
    f.add(1, 'far.bin', 'application/octet-stream', data)
    f.db.close()
    // EPERM: a destination that cannot hard link at all (exFAT), so the copy is never linked either.
    mkdirSync(join(f.media, 'Inbox', '2025-11-01'), { recursive: true })
    writeFileSync(join(f.media, 'Inbox', '2025-11-01', 'far.bin'), 'someone else')
    const link = () => { throw Object.assign(new Error('no links here'), { code: 'EPERM' }) }
    const result = f.run(false, { link })
    expect(result.counts).toMatchObject({ imported: 1, linked: 0, copied: 1, copied_bytes: data.length })
    const rel = JSON.parse(readFileSync(f.indexPath, 'utf8')).files[0].rel
    expect(rel).toBe('Inbox/2025-11-01/far (2).bin')
    expect(readFileSync(join(f.media, rel)).equals(data)).toBe(true)
    expect(readFileSync(join(f.media, 'Inbox', '2025-11-01', 'far.bin'), 'utf8')).toBe('someone else')
    expect(tree(f.media).some((name) => name.endsWith('.part'))).toBe(false)
  })

  it('keeps new uploads in the list and refuses blobs outside the old folder', () => {
    const f = oldInbox()
    const outside = join(f.dir, 'elsewhere.txt')
    writeFileSync(outside, 'secret')
    f.add(1, 'escape.txt', 'text/plain', null, { blob: outside, listed: 6 })
    writeFileSync(outside, 'secret')
    f.add(2, 'ok.txt', 'text/plain', Buffer.from('ok'))
    f.db.close()
    const store = createMediaFiles({ mediaRoot: f.media, agentRoot: '/files', indexPath: f.indexPath, now: () => new Date('2026-11-20T10:00:00Z') })
    const fresh = store.save(Buffer.from('new upload'), { filename: 'new.txt', mime: 'text/plain' })
    const result = f.run()
    expect(result.counts).toMatchObject({ imported: 1, invalid: 1 })
    const ids = JSON.parse(readFileSync(f.indexPath, 'utf8')).files.map((r: { id: string }) => r.id)
    // Imported history goes before the newer upload, so the files list still shows the new one first.
    expect(ids).toEqual([id(2), fresh.id])
    expect(store.list(1).map((r: { id: string }) => r.id)).toEqual([fresh.id])
  })

  it('reads dates and command-line paths the way the Service does', () => {
    expect(importedDate(1_762_000_000).toISOString()).toBe('2025-11-01T12:26:40.000Z')
    expect(importedDate(1_762_000_000_000).toISOString()).toBe('2025-11-01T12:26:40.000Z')
    expect(importedDate('2026-01-02T03:04:05Z').toISOString()).toBe('2026-01-02T03:04:05.000Z')
    const args = importArgs(['--inbox-dir', '/old/wizard-inbox', '--dry-run'], { HERMES_HOME: '/h', WIZARD_MEDIA_ROOT: '/media' })
    expect(args).toEqual({ dryRun: true, inboxDbPath: '/old/wizard-inbox/inbox.sqlite3', mediaRoot: '/media', indexPath: '/h/state/wizard-mobile/media-files.json' })
    expect(() => importArgs(['--wat'], {})).toThrow(/unknown option/)
  })
})
