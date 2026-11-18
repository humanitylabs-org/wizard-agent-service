// Files an agent sends in a chat stay openable after their source is gone (issue 556).
//
// An agent sends a file with a MEDIA:/path line, usually in its cache/audio or cache/images folder. Hermes prunes
// those caches after 24 hours, and history re-projects every MEDIA line on each read, so a day later the line read
// "[file: X unavailable]" even though the Service had already copied the bytes into its own durable,
// content-addressed artifact folder (<id>.bin + <id>.json) the first time the message was shown.
//
// This module remembers which artifact each sent path became (one small file per path under <artifactDir>/sources),
// so a later read of a path that no longer exists shows that copy. Artifacts saved before this existed have no
// record; they are found by their file name, only when exactly one such artifact carries that name.

import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const SOURCES = 'sources'
const LEGACY_TTL_MS = 60_000
const remembered = new Map()
const legacyScans = new Map()

const sourceKey = sourcePath => createHash('sha256').update(resolve(String(sourcePath).trim())).digest('hex').slice(0, 40)

// The name the artifact metadata stores for a source path (same rule as the Service's registration).
export const sentFileName = sourcePath => basename(String(sourcePath).trim()).replace(/[\\/\p{Cc}]/gu, '_').trim().slice(-120)

/** Remember that `sourcePath` was shown as artifact `id`. Never throws: remembering must not break a read. */
export function rememberSentFile(artifactDir, sourcePath, id) {
  if (!artifactDir || !id) return
  const key = sourceKey(sourcePath)
  const memo = `${artifactDir}\0${key}`
  if (remembered.get(memo) === id) return
  try {
    const dir = join(artifactDir, SOURCES)
    const file = join(dir, `${key}.json`)
    let current = null
    try { current = JSON.parse(readFileSync(file, 'utf8')).id } catch { /* first time */ }
    if (current !== id) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const temporary = join(dir, `.${key}.${randomUUID()}.tmp`)
      writeFileSync(temporary, JSON.stringify({ id }), { mode: 0o600 })
      renameSync(temporary, file)
      legacyScans.delete(artifactDir)
    }
    if (remembered.size > 4096) remembered.clear()
    remembered.set(memo, id)
  } catch { /* the next read tries again */ }
}

/** True only when the path (or a folder on it) does not exist; other errors keep today's behaviour. */
export function sourceGone(localPath) {
  try { lstatSync(localPath); return false } catch (error) { return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' }
}

// name -> artifact ids, for artifacts no source record points at (saved before records existed).
function legacyNames(artifactDir, now) {
  const cached = legacyScans.get(artifactDir)
  if (cached && now - cached.at < LEGACY_TTL_MS) return cached.names
  const recorded = new Set()
  try {
    for (const entry of readdirSync(join(artifactDir, SOURCES))) {
      if (!entry.endsWith('.json') || entry.startsWith('.')) continue
      try { recorded.add(JSON.parse(readFileSync(join(artifactDir, SOURCES, entry), 'utf8')).id) } catch {}
    }
  } catch { /* no records yet */ }
  const names = new Map()
  try {
    for (const entry of readdirSync(artifactDir)) {
      if (!/^[0-9a-f]{32}\.json$/.test(entry)) continue
      const id = entry.slice(0, 32)
      if (recorded.has(id)) continue
      let name
      try { name = JSON.parse(readFileSync(join(artifactDir, entry), 'utf8')).name } catch { continue }
      if (typeof name !== 'string' || !name) continue
      const ids = names.get(name) ?? []
      ids.push(id)
      names.set(name, ids)
    }
  } catch { /* no artifacts */ }
  if (legacyScans.size > 64) legacyScans.clear()
  legacyScans.set(artifactDir, { at: now, names })
  return names
}

/**
 * The artifact a now-missing sent path was shown as, or null. `read(id)` returns a verified artifact or null.
 * `legacy` allows the by-name match for artifacts saved before records existed.
 */
export function recallSentFile(artifactDir, sourcePath, read, { legacy = true, now = Date.now() } = {}) {
  if (!artifactDir) return null
  try {
    const id = JSON.parse(readFileSync(join(artifactDir, SOURCES, `${sourceKey(sourcePath)}.json`), 'utf8')).id
    const artifact = typeof id === 'string' ? read(id) : null
    if (artifact) return artifact
  } catch { /* no record */ }
  if (!legacy) return null
  const name = sentFileName(sourcePath)
  const ids = name ? legacyNames(artifactDir, now).get(name) : null
  // Two old artifacts with one name (screenshot.png) could be either: show neither rather than the wrong one.
  if (ids?.length !== 1) return null
  const artifact = read(ids[0])
  if (artifact) rememberSentFile(artifactDir, sourcePath, artifact.id)
  return artifact
}
