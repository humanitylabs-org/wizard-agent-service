// One-time, re-runnable import of the old Wizard Uploads service (wizard-inbox) into the built-in file
// store (issue 423). A box that moves to the built-in store keeps every old chat attachment opening:
// each old upload is placed in `Inbox/<date>/<name>` by hard link (no extra disk; a copy only where the
// filesystem cannot link), under its original `drop_…` id, name, type, size, sha256, date and
// duplicate_of. The old database is opened read-only and the old blob folder is left as it is, so the
// agent's old `trusted_path`s keep working. A dry run reports the same counts and writes nothing.
//
// The store only serves the imported ids with WIZARD_MEDIA_LEGACY_IDS=1 (option mediaLegacyIds).
import { copyFileSync, existsSync, linkSync, mkdirSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { cleanName, createMediaFiles, LEGACY_ID } from './media-files.mjs'

const NO_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK', 'EXDEV'])
const FILE_ID = /^(?:wf|drop)_[0-9a-f]{32}$/

function within(root, path) {
  const child = relative(root, path)
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

// The old service stores seconds as REAL; accept milliseconds and ISO text too.
export function importedDate(value, fallback = new Date()) {
  let at = null
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) at = new Date(value > 1e12 ? value : value * 1000)
  else if (typeof value === 'string' && value.trim()) {
    const number = Number(value)
    at = Number.isFinite(number) && number > 0 ? new Date(number > 1e12 ? number : number * 1000) : new Date(value)
  }
  return at && Number.isFinite(at.getTime()) ? at : fallback
}

function readDrops(inboxDbPath) {
  // A missing database is an error, never an invitation for SQLite to create one.
  if (!statSync(inboxDbPath).isFile()) throw Object.assign(new Error('old uploads database is not a file'), { code: 'ENOTFILE' })
  const db = new DatabaseSync(inboxDbPath, { readOnly: true })
  try {
    return db.prepare(`SELECT id, filename, mime, bytes, sha256, duplicate_of, blob_path, created_at
      FROM drops ORDER BY created_at, id`).all()
  } finally { db.close() }
}

export function importInboxUploads({ inboxDbPath, blobRoot = '', mediaRoot, indexPath, dryRun = false, batch = 500, now = () => new Date(), link = linkSync }) {
  if (!inboxDbPath || !mediaRoot || !indexPath) throw new Error('inboxDbPath, mediaRoot and indexPath are required')
  const dbPath = resolve(String(inboxDbPath))
  const blobs = resolve(String(blobRoot || dirname(dbPath)))
  const store = createMediaFiles({ mediaRoot, agentRoot: mediaRoot, indexPath, now })
  const root = store.root
  const realBlobs = existsSync(blobs) ? realpathSync(blobs) : blobs
  const counts = { total: 0, imported: 0, already_present: 0, missing: 0, size_mismatch: 0, invalid: 0, linked: 0, copied: 0, copied_bytes: 0 }
  const problems = []
  const note = (kind, id, detail) => { counts[kind] += 1; if (problems.length < 50) problems.push({ kind, id, ...(detail ? { detail } : {}) }) }
  const pending = []
  const flush = () => { if (!dryRun && pending.length) store.importRecords(pending.splice(0)) }
  const planned = new Set()
  const usedRels = store.rels()

  for (const row of readDrops(dbPath)) {
    counts.total += 1
    const id = String(row.id ?? '')
    if (!LEGACY_ID.test(id)) { note('invalid', id, 'not a drop_ id'); continue }
    if (store.record(id) || planned.has(id)) { counts.already_present += 1; continue }
    const bytes = Number(row.bytes)
    if (typeof row.blob_path !== 'string' || !row.blob_path || !Number.isSafeInteger(bytes) || bytes < 0) { note('invalid', id, 'no blob path or size'); continue }
    const source = resolve(dirname(dbPath), row.blob_path)
    if (!within(blobs, source)) { note('invalid', id, 'blob outside the blob folder'); continue }
    let info
    try {
      if (!within(realBlobs, realpathSync(source))) { note('invalid', id, 'blob outside the blob folder'); continue }
      info = statSync(source)
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error?.code)) { note('missing', id); continue }
      throw error
    }
    if (!info.isFile()) { note('missing', id); continue }
    if (info.size !== bytes) { note('size_mismatch', id, `${info.size} on disk, ${bytes} listed`); continue }

    const created = importedDate(row.created_at, now())
    const name = cleanName(row.filename)
    const dir = join('Inbox', created.toISOString().slice(0, 10))
    const stem = name.slice(0, name.length - extname(name).length) || 'file'
    let rel = ''
    if (dryRun) rel = join(dir, name)
    else {
      mkdirSync(join(root, dir), { recursive: true })
      for (let n = 1; !rel; n += 1) {
        const candidate = n === 1 ? name : `${stem} (${n})${extname(name)}`
        const target = join(root, dir, candidate)
        try {
          link(source, target)
          rel = join(dir, candidate)
          counts.linked += 1
        } catch (error) {
          if (error?.code === 'EEXIST') {
            // A run that stopped before writing the list already linked this very file: adopt it.
            try {
              const there = statSync(target)
              if (there.ino === info.ino && there.dev === info.dev && !usedRels.has(join(dir, candidate))) { rel = join(dir, candidate); counts.linked += 1 }
            } catch { /* gone again: try the next name */ }
            continue
          }
          if (!NO_LINK.has(error?.code)) throw error
          // No hard link possible (another disk, exFAT): copy beside the target, then claim the name.
          const part = join(root, dir, `.import-${id}.part`)
          copyFileSync(source, part)
          try {
            for (let m = n; !rel; m += 1) {
              const name2 = m === 1 ? name : `${stem} (${m})${extname(name)}`
              try { linkSync(part, join(root, dir, name2)); rel = join(dir, name2) } catch (inner) { if (inner?.code !== 'EEXIST') throw inner }
            }
          } finally { try { unlinkSync(part) } catch { /* already gone */ } }
          counts.copied += 1
          counts.copied_bytes += bytes
        }
      }
    }
    const duplicate = typeof row.duplicate_of === 'string' && FILE_ID.test(row.duplicate_of) ? row.duplicate_of : null
    pending.push({
      id, rel, filename: name, mime: String(row.mime || 'application/octet-stream').slice(0, 160), bytes,
      sha256: String(row.sha256 || ''), created_at: created.toISOString(), duplicate_of: duplicate, imported_from: 'wizard-inbox',
    })
    planned.add(id)
    usedRels.add(rel)
    counts.imported += 1
    if (pending.length >= batch) flush()
  }
  flush()
  return { dry_run: Boolean(dryRun), inbox_db: dbPath, blob_root: blobs, media_root: root, index: resolve(String(indexPath)), counts, problems }
}

// Command line (also inside the image: `node server/inbox-import.mjs --dry-run`). Paths default to the
// same environment the Service reads; see docs/inbox-import.md.
export function importArgs(argv, env = process.env) {
  const args = { dryRun: false }
  const take = (i) => { if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`); return argv[i + 1] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--inbox-dir') { args.inboxDbPath = join(take(i), 'inbox.sqlite3'); i += 1 }
    else if (arg === '--inbox-db') { args.inboxDbPath = take(i); i += 1 }
    else if (arg === '--blob-root') { args.blobRoot = take(i); i += 1 }
    else if (arg === '--media-root') { args.mediaRoot = take(i); i += 1 }
    else if (arg === '--index') { args.indexPath = take(i); i += 1 }
    else throw new Error(`unknown option ${arg}`)
  }
  const home = env.HERMES_HOME || (env.HOME ? join(env.HOME, '.hermes') : '')
  args.inboxDbPath ||= env.WIZARD_INBOX_DB_PATH || (home ? join(home, 'data/apps/wizard-inbox/inbox.sqlite3') : '')
  args.mediaRoot ||= env.WIZARD_MEDIA_ROOT || ''
  args.indexPath ||= env.WIZARD_MEDIA_INDEX_PATH || (home ? join(home, 'state/wizard-mobile/media-files.json') : '')
  return args
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    const result = importInboxUploads(importArgs(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`import failed: ${error?.message || error}\n`)
    process.exitCode = 1
  }
}
