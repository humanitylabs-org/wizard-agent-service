// Uploads placed in the owner's Files root (wizard-os spec/AGENT_SERVICE_API.md, "Upload destination").
//
// The Files app uploads through /wizard/v1/uploads like every other client, but asks for the finished
// file to land in a folder of the user-files root (Runtipi's shared media/ folder on a Wizard OS box)
// rather than in the chat-attachment store. An upload with a destination folder is placed in that folder
// under its own name; one without a folder goes to Inbox/<YYYY-MM-DD> in the owner's time zone.
//
//   root        the user-files root (WIZARD_USER_FILES_ROOT; on a Wizard OS box, the media root)
//   indexPath   small JSON index of placed uploads (makes a retried completion return the same file)
//
// Rules: folders are relative to the root and confined to it (no absolute paths, no '..', no hidden
// segments, no symlink that resolves outside the root). A placed file never overwrites another: it
// gets 'name (2).ext'. The staged bytes are hard-linked into place (same filesystem: staging lives in
// <root>/.wizard-uploads), with a checked rename only where links are unsupported. Nothing is read
// into memory and file names are never logged.
import { accessSync, chmodSync, constants, createReadStream, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { UploadError, cleanFilename } from './uploads.mjs'

export const USER_FILES_TARGET = 'userfiles:'
const MAX_FOLDER_CHARS = 1024
const MAX_FOLDER_DEPTH = 32
const MAX_INDEX = 5000
const MAX_LIST = 5000
const NO_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK', 'EXDEV'])

const fieldError = (field = 'destination.folder') => new UploadError(400, 'invalid_request', { field })

/** Normalises a destination folder to 'A/B' form ('' = none). Throws 400 for anything unsafe. */
export function normalizeFolder(value) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || value.length > MAX_FOLDER_CHARS) throw fieldError()
  if (/[\u0000-\u001f\u007f\\]/u.test(value) || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) throw fieldError()
  const parts = value.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.length > MAX_FOLDER_DEPTH) throw fieldError()
  for (const part of parts) {
    if (part === '..' || part.startsWith('.') || part.length > 255 || part.trim() !== part) throw fieldError()
  }
  return parts.join('/')
}

/** The request's `destination` → { folder } ('' folder = the dated Inbox), or null when absent. */
export function parseDestination(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw fieldError('destination')
  const keys = Object.keys(value)
  if (keys.some((key) => key !== 'folder')) throw fieldError('destination')
  return { folder: normalizeFolder(value.folder) }
}

/** YYYY-MM-DD for `date` in `timeZone` (falls back to the host zone for an invalid one). */
export function localDay(date, timeZone) {
  const format = (zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
  try { return format(timeZone || undefined) } catch { return format(undefined) }
}

export function createUserFiles({ root, indexPath, now = () => new Date() }) {
  const base = resolve(String(root))
  if (base === sep) throw new Error('user-files root must be narrower than /')
  const index = resolve(String(indexPath))
  const stagingDir = join(base, '.wizard-uploads')
  const realRoot = () => realpathSync(base)
  const inside = (real, top) => real === top || real.startsWith(`${top}${sep}`)

  // The folder as an absolute path, confined after resolving every symlink on the way. With create,
  // missing folders are made (only below an ancestor that is itself inside the root).
  function folderPath(folder, { create = false } = {}) {
    const top = realRoot()
    const target = folder ? join(top, ...folder.split('/')) : top
    let existing = target
    for (;;) {
      try { lstatSync(existing); break } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        if (existing === top) throw new UploadError(503, 'files_root_unavailable')
        existing = dirname(existing)
      }
    }
    if (!inside(realpathSync(existing), top)) throw new UploadError(400, 'invalid_request', { field: 'destination.folder' })
    if (existing !== target) {
      if (!create) throw new UploadError(404, 'folder_not_found')
      // One level at a time, each made 0755 explicitly: the service's umask (often 077) would otherwise
      // hide new folders from the Files app and the other apps that share the root.
      const missing = target.slice(existing.length + 1).split(sep)
      let at = existing
      for (const part of missing) {
        at = join(at, part)
        try { mkdirSync(at, { mode: 0o755 }) } catch (error) { if (error?.code !== 'EEXIST') throw error; continue }
        try { chmodSync(at, 0o755) } catch { /* keep */ }
      }
    }
    const real = realpathSync(target)
    if (!inside(real, top)) throw new UploadError(400, 'invalid_request', { field: 'destination.folder' })
    if (!statSync(real).isDirectory()) throw new UploadError(409, 'not_a_folder')
    return real
  }

  const load = () => {
    try {
      const value = JSON.parse(readFileSync(index, 'utf8'))
      return value && typeof value.placements === 'object' && !Array.isArray(value.placements) ? value.placements : {}
    } catch { return {} }
  }
  const save = (placements) => {
    const keys = Object.keys(placements)
    if (keys.length > MAX_INDEX) for (const key of keys.slice(0, keys.length - MAX_INDEX)) delete placements[key]
    mkdirSync(dirname(index), { recursive: true, mode: 0o700 })
    const tmp = `${index}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ schema: 1, placements }), { mode: 0o600 })
    renameSync(tmp, index)
  }
  const exists = (record) => {
    try {
      const top = realRoot()
      const path = join(top, ...record.path.split('/'))
      const stat = lstatSync(path)
      return stat.isFile() && stat.size === record.bytes && inside(dirname(realpathSync(path)), top)
    } catch { return false }
  }

  return {
    root: base,
    stagingDir,
    /** The target key an upload records for this destination (the dated Inbox is fixed at create). */
    targetKey(destination) {
      const folder = destination.folder || `Inbox/${localDay(now(), destination.timeZone)}`
      return `${USER_FILES_TARGET}${folder}`
    },
    folderOf(key) { return normalizeFolder(String(key).slice(USER_FILES_TARGET.length)) },
    /** A chosen folder must exist and be writable when the upload is created. */
    checkFolder(folder) {
      const path = folderPath(folder)
      try { accessSync(path, constants.W_OK) } catch { throw new UploadError(403, 'folder_not_writable') }
      return path
    },
    placed(key) {
      const record = key ? load()[key] : null
      return record && exists(record) ? { ...record } : null
    },
    /** Moves a finished staged upload into its folder; returns the public file record. */
    place(sourcePath, folder, { filename, mime, bytes, sha256, key = '' }) {
      if (key) {
        const earlier = this.placed(key)
        if (earlier) { try { unlinkSync(sourcePath) } catch { /* already moved */ } return earlier }
      }
      let dir
      try { dir = folderPath(folder, { create: true }) } catch (error) {
        if (error?.code === 'EACCES' || error?.code === 'EPERM') throw new UploadError(403, 'folder_not_writable')
        throw error
      }
      const source = statSync(sourcePath)
      const name = cleanFilename(filename)
      const stem = name.slice(0, name.length - extname(name).length) || 'file'
      let placedName = ''
      let moved = false
      for (let n = 1; !placedName; n += 1) {
        if (n > 10_000) throw new UploadError(409, 'name_unavailable')
        const candidate = n === 1 ? name : `${stem} (${n})${extname(name)}`
        const target = join(dir, candidate)
        try {
          // A retried completion after a crash between link and record finds its own bytes here.
          const there = lstatSync(target)
          if (there.ino === source.ino && there.dev === source.dev) { placedName = candidate; break }
          continue
        } catch (error) { if (error?.code !== 'ENOENT') throw error }
        try { linkSync(sourcePath, target); placedName = candidate } catch (error) {
          if (error?.code === 'EEXIST') continue
          if (error?.code === 'EACCES') throw new UploadError(403, 'folder_not_writable')
          if (error?.code === 'ENOSPC') throw new UploadError(507, 'insufficient_storage')
          if (!NO_LINK.has(error?.code)) throw error
          try { lstatSync(target); continue } catch { /* free */ }
          renameSync(sourcePath, target)
          placedName = candidate
          moved = true
        }
      }
      const rel = folder ? `${folder}/${placedName}` : placedName
      const record = {
        filename: placedName, path: rel, folder, mime: String(mime || 'application/octet-stream').slice(0, 160),
        bytes, sha256, created_at: now().toISOString(), location: 'files_root',
      }
      // Staged bytes are private (0600); a placed file is an ordinary user file like its neighbours.
      try { chmodSync(join(dir, placedName), 0o644) } catch { /* keep staging mode */ }
      if (key) { const placements = load(); placements[key] = record; save(placements) }
      if (!moved) { try { unlinkSync(sourcePath) } catch { /* gone */ } }
      return { ...record }
    },
    /** One folder's entries (hidden names skipped; symlinks only when they stay inside the root). */
    list(folder) {
      const top = realRoot()
      const dir = folderPath(folder)
      const entries = []
      let truncated = false
      for (const name of readdirSync(dir)) {
        if (name.startsWith('.')) continue
        if (entries.length >= MAX_LIST) { truncated = true; break }
        let stat
        try {
          const path = join(dir, name)
          stat = lstatSync(path)
          if (stat.isSymbolicLink()) {
            if (!inside(realpathSync(path), top)) continue
            stat = statSync(path)
          }
        } catch { continue }
        if (!stat.isDirectory() && !stat.isFile()) continue
        entries.push({ name, is_dir: stat.isDirectory(), size: stat.isDirectory() ? 0 : stat.size, mtime: new Date(stat.mtimeMs).toISOString() })
      }
      entries.sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }) : a.is_dir ? -1 : 1))
      return { folder, entries, ...(truncated ? { truncated: true } : {}) }
    },
    /** A file to read (path relative to the root), confined like a folder; null when absent. */
    file(relPath) {
      const clean = normalizeFolder(relPath)
      if (!clean) return null
      const slash = clean.lastIndexOf('/')
      const parent = slash < 0 ? '' : clean.slice(0, slash)
      let dir
      try { dir = folderPath(parent) } catch (error) { if (error?.status === 404 || error?.status === 409) return null; throw error }
      const path = join(dir, clean.slice(slash + 1))
      try {
        const real = realpathSync(path)
        if (!inside(real, realRoot())) return null
        const stat = statSync(real)
        if (!stat.isFile()) return null
        return { path: real, name: clean.slice(slash + 1), size: stat.size, mtime: stat.mtimeMs }
      } catch { return null }
    },
    open(path, start, end) { return createReadStream(path, { start, end }) },
  }
}
