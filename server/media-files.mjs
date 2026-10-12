// Wizard Files on a Wizard OS box: attachments are ordinary user files.
//
// On a box running the Wizard App Manager, the user-files root is Runtipi's shared `media/` folder
// (wizard-os docs/SYSTEM_APPS.md, "one files root"). The Files app shows it and every app that works
// on user files mounts it. This store keeps Wizard attachments there, under `Inbox/<date>/<name>`, so
// a video sent in a chat is visible in the Files app and usable by DeFleur by name.
//
// It replaces the separate Wizard Inbox service when WIZARD_MEDIA_ROOT is set and no inbox token is
// configured. Records live in one small JSON index next to the Agent Service's state.
//
//   mediaRoot      where this service sees the folder (e.g. /media)
//   agentRoot      where the agent sees the same folder (e.g. /files); trusted_path uses it
//   indexPath      JSON index of uploaded files
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'

const ID = /^wf_[0-9a-f]{32}$/
const MAX_INDEX = 5000

function cleanName(value) {
  const name = basename(String(value || 'file')).replace(/[\u0000-\u001f\u007f/\\]/gu, '_').replace(/^\.+/u, '_').trim()
  return (name || 'file').slice(0, 200)
}

export function createMediaFiles({ mediaRoot, agentRoot, indexPath, now = () => new Date() }) {
  const root = resolve(String(mediaRoot))
  const agent = resolve(String(agentRoot || mediaRoot))
  if (root === sep || agent === sep) throw new Error('media root must be narrower than /')
  const index = resolve(String(indexPath))

  const load = () => {
    try {
      const value = JSON.parse(readFileSync(index, 'utf8'))
      return Array.isArray(value?.files) ? value.files : []
    } catch { return [] }
  }
  const save = (files) => {
    mkdirSync(dirname(index), { recursive: true })
    const tmp = `${index}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ schema: 1, files: files.slice(-MAX_INDEX) }))
    renameSync(tmp, index)
  }
  const relOf = (record) => String(record.rel || '')
  const hostPath = (record) => {
    const path = resolve(root, relOf(record))
    if (!path.startsWith(`${root}${sep}`)) throw Object.assign(new Error('file escaped the media root'), { status: 502 })
    return path
  }
  const publicRecord = (record, trusted = false) => {
    const out = {
      id: record.id, filename: record.filename, mime: record.mime, bytes: record.bytes, sha256: record.sha256,
      note: '', duplicate_of: record.duplicate_of ?? null, created_at: record.created_at, source: 'Wizard app', status: 'ready',
      path: relOf(record),
    }
    if (trusted) out.trusted_path = resolve(agent, relOf(record))
    return out
  }

  return {
    root,
    agentRoot: agent,
    list(limit = 100) {
      return load().slice(-limit).reverse().map((record) => publicRecord(record))
    },
    get(id, trusted = false) {
      if (!ID.test(String(id))) return null
      const record = load().find((item) => item.id === id)
      if (!record) return null
      try { if (!statSync(hostPath(record)).isFile()) return null } catch { return null }
      return publicRecord(record, trusted)
    },
    open(id, range = null) {
      const record = load().find((item) => item.id === id)
      if (!record) return null
      const path = hostPath(record)
      const size = statSync(path).size
      if (!range) return { status: 200, size, stream: createReadStream(path), record }
      const match = /^bytes=(\d*)-(\d*)$/u.exec(range)
      if (!match) return { status: 416, size, record }
      let start = match[1] === '' ? size - Number(match[2]) : Number(match[1])
      let end = match[1] === '' || match[2] === '' ? size - 1 : Number(match[2])
      if (!Number.isSafeInteger(start) || start < 0 || start >= size || end < start) return { status: 416, size, record }
      end = Math.min(end, size - 1)
      return { status: 206, size, start, end, stream: createReadStream(path, { start, end }), record }
    },
    save(data, { filename, mime }) {
      const sha256 = createHash('sha256').update(data).digest('hex')
      const files = load()
      const same = files.find((item) => item.sha256 === sha256 && existsSync(resolve(root, relOf(item))))
      const day = now().toISOString().slice(0, 10)
      const name = cleanName(filename)
      const dir = join('Inbox', day)
      mkdirSync(join(root, dir), { recursive: true })
      let candidate = name
      const stem = name.slice(0, name.length - extname(name).length) || 'file'
      for (let n = 2; existsSync(join(root, dir, candidate)); n += 1) candidate = `${stem} (${n})${extname(name)}`
      const rel = join(dir, candidate)
      const tmp = join(root, dir, `.${randomUUID()}.part`)
      writeFileSync(tmp, data)
      renameSync(tmp, join(root, rel))
      const record = {
        id: `wf_${randomUUID().replaceAll('-', '')}`, rel, filename: name, mime: String(mime || 'application/octet-stream').slice(0, 160),
        bytes: data.length, sha256, created_at: now().toISOString(), duplicate_of: same ? same.id : null,
      }
      files.push(record)
      save(files)
      return publicRecord(record)
    },
  }
}
