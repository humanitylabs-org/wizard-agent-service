// Uploads with a destination land in the owner's user-files root (server/user-files.mjs), and the Files
// app can list and read that root (wizard-os spec/AGENT_SERVICE_API.md, "Upload destination").
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'
import { createUserFiles, localDay, normalizeFolder } from '../server/user-files.mjs'

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const roots: string[] = []
const servers: ReturnType<typeof createServer>[] = []
const tmp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); roots.push(dir); return dir }
afterAll(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }) })
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))) })

// 2026-10-14T20:00Z is already 15 October in Bangkok (UTC+7).
const NOW = Date.parse('2026-10-14T20:00:00Z')

async function box(extra: Record<string, unknown> = {}) {
  const dir = tmp('wizard-user-files-')
  const files = join(dir, 'media')
  mkdirSync(join(files, 'Projects', 'Clips'), { recursive: true })
  mkdirSync(join(dir, 'outside'), { recursive: true })
  writeFileSync(join(dir, 'outside', 'secret.txt'), 'secret')
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ clock: { timezone: 'Asia/Bangkok' } }))
  const server = createWizardServer({
    requireJoinedDelegationCapability: false,
    upstreamOrigin: 'http://127.0.0.1:9',
    hermesKey: 'fixture-key',
    requireAccess: false,
    followThrough: false,
    settingsPath: join(dir, 'settings.json'),
    mediaRoot: join(dir, 'attachments'),
    mediaIndexPath: join(dir, 'state', 'media-files.json'),
    uploadStatePath: join(dir, 'state', 'uploads.sqlite3'),
    uploadReserveBytes: 0,
    uploadNow: () => NOW,
    userFilesRoot: files,
    runQueueStatePath: join(dir, 'state', 'queue.sqlite3'),
    runQueuePollIntervalMs: 0,
    activeSessionReader: async () => [],
    dispatchHealthReader: () => true,
    ...extra,
  })
  servers.push(server)
  const address = await listen(server)
  return { base: `http://127.0.0.1:${address.port}`, dir, files }
}

const post = (base: string, path: string, value: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
async function upload(base: string, data: Buffer, body: Record<string, unknown>, chunk = 1024 * 1024) {
  const created = await post(base, '/wizard/v1/uploads', { mime: 'video/mp4', bytes: data.length, ...body })
  expect(created.status).toBe(201)
  const record = await created.json()
  let offset = record.offset
  while (offset < data.length) {
    const r = await fetch(`${base}/wizard/v1/uploads/${record.upload_id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset) }, body: data.subarray(offset, Math.min(data.length, offset + chunk)) })
    expect(r.status).toBe(204)
    offset = Number(r.headers.get('upload-offset'))
  }
  const done = await post(base, `/wizard/v1/uploads/${record.upload_id}/complete`, {})
  return { id: record.upload_id, status: done.status, body: await done.json() }
}

describe('upload destination', () => {
  it('places an upload in the chosen folder, never overwriting, and a retried complete returns the same file', async () => {
    const { base, files } = await box()
    const data = randomBytes(2 * 1024 * 1024 + 5)
    const first = await upload(base, data, { client_upload_id: 'f-1', filename: 'clip.mp4', sha256: sha(data), destination: { folder: 'Projects/Clips' } })
    expect(first.status).toBe(200)
    expect(first.body.file).toMatchObject({ filename: 'clip.mp4', path: 'Projects/Clips/clip.mp4', folder: 'Projects/Clips', bytes: data.length, sha256: sha(data), location: 'files_root' })
    const placed = join(files, 'Projects', 'Clips', 'clip.mp4')
    expect(sha(readFileSync(placed))).toBe(sha(data))
    expect(statSync(placed).mode & 0o777).toBe(0o644)
    expect(readdirSync(join(files, '.wizard-uploads'))).toEqual([])
    // retried complete and GET give the same file
    expect((await (await post(base, `/wizard/v1/uploads/${first.id}/complete`, {})).json()).file.path).toBe('Projects/Clips/clip.mp4')
    expect(await (await fetch(`${base}/wizard/v1/uploads/${first.id}`)).json()).toMatchObject({ status: 'complete', file: { path: 'Projects/Clips/clip.mp4' } })
    // the same name again: kept beside it, the original untouched
    const other = randomBytes(1000)
    const second = await upload(base, other, { client_upload_id: 'f-2', filename: 'clip.mp4', destination: { folder: 'Projects/Clips/' } })
    expect(second.body.file.path).toBe('Projects/Clips/clip (2).mp4')
    expect(sha(readFileSync(placed))).toBe(sha(data))
    expect(sha(readFileSync(join(files, 'Projects', 'Clips', 'clip (2).mp4')))).toBe(sha(other))
  })

  it('without a folder lands in Inbox/<today in the owner time zone>, folders readable whatever the umask', async () => {
    const { base, files } = await box()
    const data = randomBytes(4096)
    const umask = process.umask(0o077)
    let done
    try { done = await upload(base, data, { client_upload_id: 'inbox-1', filename: 'note.txt', destination: {} }) } finally { process.umask(umask) }
    expect(done.body.file.path).toBe('Inbox/2026-10-15/note.txt')
    expect(sha(readFileSync(join(files, 'Inbox', '2026-10-15', 'note.txt')))).toBe(sha(data))
    expect(statSync(join(files, 'Inbox')).mode & 0o777).toBe(0o755)
    expect(statSync(join(files, 'Inbox', '2026-10-15')).mode & 0o777).toBe(0o755)
    const again = await upload(base, data, { client_upload_id: 'inbox-2', filename: 'note.txt', destination: { folder: '' } })
    expect(again.body.file.path).toBe('Inbox/2026-10-15/note (2).txt')
  })

  it('keeps chat attachments (no destination) in Wizard Files as before', async () => {
    const { base, files, dir } = await box()
    const data = randomBytes(1000)
    const done = await upload(base, data, { client_upload_id: 'chat-1', filename: 'a.bin' })
    expect(done.body.file.id).toMatch(/^wf_[0-9a-f]{32}$/)
    expect(existsSync(join(dir, 'attachments', 'Inbox'))).toBe(true)
    expect(existsSync(join(files, 'Inbox'))).toBe(false)
  })

  it('refuses unsafe, missing and escaping folders', async () => {
    const { base, dir, files } = await box()
    symlinkSync(join(dir, 'outside'), join(files, 'Escape'))
    const make = (folder: unknown, id: string) => post(base, '/wizard/v1/uploads', { client_upload_id: id, filename: 'x.bin', bytes: 10, destination: { folder } })
    for (const [i, folder] of ['../outside', 'Projects/../../outside', '/etc/../..', 'C:/x', '.hidden', 'a\\b', 42].entries()) {
      const r = await make(folder, `bad-${i}`)
      expect(r.status, String(folder)).toBe(400)
      expect(await r.json()).toMatchObject({ error: 'invalid_request', field: 'destination.folder' })
    }
    expect((await make('Escape', 'esc')).status).toBe(400)
    expect((await make('Escape/sub', 'esc-2')).status).toBe(400)
    expect((await make('Nope', 'missing')).status).toBe(404)
    expect((await post(base, '/wizard/v1/uploads', { client_upload_id: 'extra', filename: 'x', bytes: 1, destination: { folder: 'Projects', overwrite: true } })).status).toBe(400)
    expect(readdirSync(join(dir, 'outside'))).toEqual(['secret.txt'])
  })

  it('is unavailable (409) and not advertised without a user-files root', async () => {
    const { base } = await box({ userFilesRoot: '' })
    const boot = await (await fetch(`${base}/wizard/v1/bootstrap`)).json()
    expect(boot.capabilities.upload_destinations).toBe(false)
    expect(boot.endpoints.user_files).toBe('')
    const r = await post(base, '/wizard/v1/uploads', { client_upload_id: 'nd', filename: 'x', bytes: 1, destination: { folder: 'Projects' } })
    expect(r.status).toBe(409)
    expect(await r.json()).toEqual({ error: 'destination_unavailable' })
    expect((await fetch(`${base}/wizard/v1/user-files`)).status).toBe(503)
  })
})

describe('user-files read API', () => {
  it('advertises the endpoint, lists a folder (hidden and escaping entries skipped) and serves files with ranges', async () => {
    const { base, dir, files } = await box()
    const boot = await (await fetch(`${base}/wizard/v1/bootstrap`)).json()
    expect(boot.capabilities.upload_destinations).toBe(true)
    expect(boot.endpoints.user_files).toBe('/wizard/v1/user-files')
    writeFileSync(join(files, 'Projects', 'b.txt'), 'hello world')
    writeFileSync(join(files, 'Projects', '.dot'), 'x')
    symlinkSync(join(dir, 'outside', 'secret.txt'), join(files, 'Projects', 'leak.txt'))
    symlinkSync(join(files, 'Projects', 'b.txt'), join(files, 'Projects', 'alias.txt'))
    const list = await (await fetch(`${base}/wizard/v1/user-files?folder=Projects`)).json()
    expect(list.folder).toBe('Projects')
    expect(list.entries.map((e: any) => [e.name, e.is_dir, e.size])).toEqual([['Clips', true, 0], ['alias.txt', false, 11], ['b.txt', false, 11]])
    expect(typeof list.entries[0].mtime).toBe('string')
    const root = await (await fetch(`${base}/wizard/v1/user-files`)).json()
    expect(root.entries.map((e: any) => e.name)).toEqual(['Projects'])
    expect((await fetch(`${base}/wizard/v1/user-files?folder=..`)).status).toBe(400)
    expect((await fetch(`${base}/wizard/v1/user-files?folder=Nope`)).status).toBe(404)
    const whole = await fetch(`${base}/wizard/v1/user-files/content?path=Projects/b.txt`)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-type')).toContain('text/plain')
    expect(await whole.text()).toBe('hello world')
    const part = await fetch(`${base}/wizard/v1/user-files/content?path=Projects/b.txt`, { headers: { Range: 'bytes=6-' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 6-10/11')
    expect(await part.text()).toBe('world')
    const dl = await fetch(`${base}/wizard/v1/user-files/content?path=Projects/b.txt&download=1`)
    expect(dl.headers.get('content-disposition')).toContain('attachment')
    expect((await fetch(`${base}/wizard/v1/user-files/content?path=Projects/leak.txt`)).status).toBe(404)
    expect((await fetch(`${base}/wizard/v1/user-files/content?path=../outside/secret.txt`)).status).toBe(400)
    expect((await fetch(`${base}/wizard/v1/user-files/content?path=Projects`)).status).toBe(404)
    expect((await fetch(`${base}/wizard/v1/user-files`, { method: 'POST' })).status).toBe(405)
  })
})

describe('user-files store', () => {
  it('normalises folders and dates', () => {
    expect(normalizeFolder('A//B/./')).toBe('A/B')
    expect(normalizeFolder('')).toBe('')
    expect(() => normalizeFolder('A/../B')).toThrow()
    expect(() => normalizeFolder('/A')).toThrow()
    expect(localDay(new Date(NOW), 'Asia/Bangkok')).toBe('2026-10-15')
    expect(localDay(new Date(NOW), 'UTC')).toBe('2026-10-14')
    expect(localDay(new Date(NOW), 'Not/AZone')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('recognises its own bytes after a crash between linking and recording (idempotent placement)', () => {
    const dir = tmp('wizard-user-files-store-')
    const root = join(dir, 'media')
    mkdirSync(join(root, '.wizard-uploads'), { recursive: true })
    mkdirSync(join(root, 'A'))
    const files = createUserFiles({ root, indexPath: join(dir, 'idx.json') })
    const staged = join(root, '.wizard-uploads', 'up.part')
    writeFileSync(staged, 'payload')
    linkSync(staged, join(root, 'A', 'f.txt')) // the crash: linked, never recorded
    const placed = files.place(staged, 'A', { filename: 'f.txt', mime: 'text/plain', bytes: 7, sha256: 'x', key: 'up_1' })
    expect(placed.path).toBe('A/f.txt')
    expect(readdirSync(join(root, 'A'))).toEqual(['f.txt'])
    expect(existsSync(staged)).toBe(false)
    expect(files.placed('up_1')?.path).toBe('A/f.txt')
  })
})
