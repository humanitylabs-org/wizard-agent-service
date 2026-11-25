// Capture inboxes (wizard-os issue 696, spec/CAPTURE_INBOXES.md; owner switch `wizard/capture-inbox`, off by default;
// env WIZARD_CAPTURE_INBOX '1'/'0' forces it).
//
// The owner drops things in `Inbox/` of his Files (uploads, the phone's share menu, a synced laptop folder). This
// module watches that folder from the box side, waits for a quiet period (nothing new or growing for a few minutes) so
// a batch is handled as one, and hands each batch to the main agent as one agent-inbox record plus one hidden worker
// turn. The agent files every item with the `wizard_capture` tool only: each move, kept item and note is one log line,
// and "undo that" puts the whole batch back exactly. Nothing here reads file contents; the agent does that itself.
//
// Rules:
// - Only items that arrive while the switch is on are touched: turning it on takes a baseline of what is already there
//   (by change time), so a year of old drops is never swept up.
// - Chat attachments (the media-files index) belong to their chat and are never batched.
// - Hidden names, symlinks and anything outside the files root are ignored; the agent can move only items of its own
//   batches, only into folders of the files root (never into Inbox, never a hidden or `..` segment), never over
//   another file. Undo moves back only when the original place is free and the file is still where it was filed.
// - The owner's rules are one plain file in Files (`Capture rules.md`), written with the default set on first use.
// - App inboxes (Photos first): the app sends `items_arrived` with its own app token and its own batch id; the batch
//   here holds no item list (the agent reads the items through the app's tools). Its items stay in the app: the agent
//   only adds copies to Files (action copy) and notes, logged and undoable here; the app keeps its own log (tags,
//   albums, processed marks) and reverts it when it reads that the batch was undone.

import { appendFileSync, closeSync, constants as fsConstants, copyFileSync, existsSync, rmdirSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { atomicStoreWrite } from './thread-reference.mjs'

export const CAPTURE_SWITCH = 'wizard/capture-inbox'
export const CAPTURE_TOOL = 'wizard_capture'
export const CAPTURE_SOURCE = 'capture:files'
export const INBOX_FOLDER = 'Inbox'
export const RULES_FILE = 'Capture rules.md'
export const QUIET_MS = 2 * 60_000
export const SCAN_MS = 30_000
export const BATCH_MAX = 50
const MAX_WALK = 20_000
const MAX_DEPTH = 6
const MAX_BATCHES = 200
const MAX_NOTE_CHARS = 20_000
const BATCH_ID = /^cap_[a-f0-9]{16}$/u
const APP_ITEM = /^[A-Za-z0-9._:-]{1,128}$/u
export const APP_BATCH = /^[A-Za-z0-9._:-]{1,64}$/u
export const APP_BATCH_MAX = 500

export const DEFAULT_RULES = `# Capture rules

Your agent files whatever you drop in Inbox by these rules, one batch at a time, and logs every move so "undo that" puts a batch back. Change them in plain words; the agent reads this file for every batch.

- A voice note in a batch says what the batch is ("these are the Tokyo receipts"): follow it first. Then file the voice note in Voice notes.
- Receipts and invoices: file in Documents/Receipts/<year>. If Money is installed, also add the expense there. Keep the original.
- Articles and other things to read (PDF, saved pages): file in Reading/Articles.
- Photos of book pages: write the highlighted passages into Reading/<book title>.md (one note per book, newest at the end), and file the photos in Reading/<book title>.
- Screenshots: file in Pictures/Screenshots/<year>.
- Personal photos and videos: file in Pictures/<year>/<month>.
- Photos from my phone's camera roll (the Photos app): personal photos stay in Photos; tag them (people, places, events) and add them to an album for the event or trip. Photos of documents (book pages, receipts, whiteboards) follow the rules above with a copy in Files; the original stays in Photos, marked processed.
- Other documents (letters, forms, contracts, manuals): file in Documents/<what it is>.
- Not sure what something is: leave it in Inbox and ask me one question.
- Never delete anything.
`

const KINDS = [
  ['image', /\.(jpe?g|png|heic|heif|webp|gif|bmp|tiff?|avif)$/iu],
  ['video', /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/iu],
  ['audio', /\.(m4a|mp3|wav|ogg|oga|opus|flac|aac|amr|caf|wma)$/iu],
  ['pdf', /\.pdf$/iu],
  ['document', /\.(docx?|odt|rtf|txt|md|pages|xlsx?|ods|csv|pptx?|key|html?|epub)$/iu],
]
export const kindOf = name => KINDS.find(([, re]) => re.test(name))?.[0] || 'other'
const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}
const within = (root, path) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
const refuse = (message, code = 'refused') => { throw Object.assign(new Error(message), { code, capture: true }) }

/** A folder the agent names, as 'A/B' relative to the files root. Refuses absolute, hidden, '..' and Inbox targets. */
export function cleanFolder(value, { agentRoot = '' } = {}) {
  let text = String(value ?? '').trim().replace(/\\/gu, '/')
  if (agentRoot && (text === agentRoot || text.startsWith(`${agentRoot.replace(/\/+$/u, '')}/`))) text = text.slice(agentRoot.replace(/\/+$/u, '').length)
  const parts = text.split('/').filter(part => part !== '' && part !== '.')
  if (!parts.length) refuse('Name a folder inside the owner\'s Files, e.g. Documents/Receipts/2026.')
  if (parts.length > 12 || text.length > 400) refuse('That folder path is too long.')
  for (const part of parts) {
    if (part === '..' || part.startsWith('.') || /[\u0000-\u001f\u007f]/u.test(part) || part.length > 120 || part.trim() !== part) refuse('Folder names must be plain names: no "..", no hidden names.')
  }
  if (parts[0].toLowerCase() === INBOX_FOLDER.toLowerCase()) refuse('Filing means moving out of Inbox: pick a folder outside Inbox, or keep the item with action keep.')
  return parts.join('/')
}

/** A file name for a filed item: the original by default, a plain name the agent gives otherwise (extension kept). */
const cleanName = (wanted, original) => {
  const ext = extname(original)
  let name = clip(wanted, 160).replace(/[\u0000-\u001f\u007f/\\]/gu, '_').replace(/^\.+/u, '')
  if (!name) return original
  if (ext && extname(name).toLowerCase() !== ext.toLowerCase()) name += ext
  return name
}

/** The folders a mkdir -p of `dir` would make (deepest last), so undo can take away the empty ones it made. */
const missingDirs = (root, dir) => {
  const out = []
  for (let at = dir; at !== root && within(root, at) && !existsSync(at); at = dirname(at)) out.unshift(relative(root, at).split(sep).join('/'))
  return out
}

const freeName = (dir, name) => {
  const ext = extname(name), stem = name.slice(0, name.length - ext.length)
  for (let n = 1; n < 1000; n += 1) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`
    if (!existsSync(join(dir, candidate))) return candidate
  }
  refuse('Too many files with that name in the folder.')
}

/**
 * The capture inbox for one files root.
 *   root       where the Service sees the owner's Files (the media root)
 *   agentRoot  where the agent sees the same folder (paths in the batch text and tool answers)
 *   statePath  JSON state (baseline, pending items, batches and their logs)
 *   chatFiles  () => Set of rel paths that are chat attachments (never batched)
 */
export function createCaptureInbox({ root, agentRoot = '', statePath = '', now = () => Date.now(), quietMs = QUIET_MS, batchMax = BATCH_MAX, chatFiles = () => new Set(), log = () => {} }) {
  const base = resolve(String(root))
  if (base === sep) throw new Error('files root must be narrower than /')
  const agentBase = resolve(String(agentRoot || root))
  let data = { schema: 1, active: false, baseline_at: 0, pending: {}, handled: {}, batches: [] }
  if (statePath && existsSync(statePath)) {
    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
      if (parsed?.schema === 1) data = { ...data, ...parsed, pending: parsed.pending || {}, handled: parsed.handled || {}, batches: Array.isArray(parsed.batches) ? parsed.batches : [] }
    } catch { /* unreadable: start empty; the old bytes stay until the next write */ }
  }
  const save = () => {
    data.batches = data.batches.slice(-MAX_BATCHES)
    if (!statePath) return
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
    atomicStoreWrite(statePath, JSON.stringify(data))
  }
  const realBase = () => { try { return realpathSync(base) } catch { return '' } }
  const inboxDir = () => join(base, INBOX_FOLDER)
  const agentPath = rel => join(agentBase, rel)
  const idOf = info => `${info.dev}:${info.ino}`

  /** Every regular, visible file under Inbox/ (no symlinks), with its identity. */
  function walk() {
    const out = []
    const top = inboxDir()
    let info
    try { info = lstatSync(top) } catch { return out }
    if (!info.isDirectory()) return out
    const stack = [[top, 0]]
    while (stack.length && out.length < MAX_WALK) {
      const [dir, depth] = stack.pop()
      let names = []
      try { names = readdirSync(dir) } catch { continue }
      for (const name of names) {
        if (name.startsWith('.')) continue
        const path = join(dir, name)
        let st
        try { st = lstatSync(path, { bigint: true }) } catch { continue }
        if (st.isSymbolicLink()) continue
        if (st.isDirectory()) { if (depth < MAX_DEPTH) stack.push([path, depth + 1]); continue }
        if (!st.isFile()) continue
        out.push({ rel: relative(base, path).split(sep).join('/'), id: idOf(st), size: Number(st.size), mtimeMs: Number(st.mtimeMs), ctimeMs: Number(st.ctimeMs) })
        if (out.length >= MAX_WALK) break
      }
    }
    return out
  }

  /** The switch went off: the next time it is on, a new baseline is taken. */
  function pause() {
    if (!data.active) return false
    data.active = false
    data.pending = {}
    save()
    return true
  }

  /** One look at Inbox/. Returns a new batch when one is due (quiet period over), else null. */
  function scan() {
    const t = now()
    const files = walk()
    if (!data.active) {
      // Turned on now: what is already there is the owner's own business, never swept up.
      data.active = true
      // File change times are wall-clock times, so the baseline is too (a test clock never moves it).
      data.baseline_at = Math.max(Date.now(), ...files.map(f => f.ctimeMs))
      data.pending = {}
      save()
      log(`baseline: ${files.length} item(s) already in Inbox left alone`)
      return null
    }
    let chat = new Set()
    try { chat = chatFiles() || new Set() } catch { chat = new Set() }
    let changed = false
    const seen = new Set()
    // A handled mark only matters while its file is still in Inbox (kept, waiting or put back): once the file has left,
    // the mark goes, so a later drop that happens to reuse the inode is new again.
    const present = new Set(files.map(f => f.id))
    for (const key of Object.keys(data.handled)) if (!present.has(key)) { delete data.handled[key]; changed = true }
    for (const file of files) {
      if (file.ctimeMs <= data.baseline_at || data.handled[file.id] || chat.has(file.rel)) continue
      seen.add(file.rel)
      const was = data.pending[file.rel]
      if (!was || was.id !== file.id) { data.pending[file.rel] = { id: file.id, size: file.size, mtimeMs: file.mtimeMs, seen_at: t, changed_at: t }; changed = true; continue }
      if (was.size !== file.size || was.mtimeMs !== file.mtimeMs) { Object.assign(was, { size: file.size, mtimeMs: file.mtimeMs, changed_at: t }); changed = true }
    }
    for (const rel of Object.keys(data.pending)) if (!seen.has(rel)) { delete data.pending[rel]; changed = true }
    const entries = Object.entries(data.pending)
    const quiet = entries.length && entries.every(([, p]) => t - p.changed_at >= quietMs)
    if (!quiet) { if (changed) save(); return null }
    return makeBatch(entries.sort((a, b) => a[1].seen_at - b[1].seen_at || a[0].localeCompare(b[0])).slice(0, batchMax), t)
  }

  function makeBatch(entries, t = now()) {
    const id = `cap_${randomBytes(8).toString('hex')}`
    const items = entries.map(([rel, p], n) => ({ item: `i${n + 1}`, path: rel, name: basename(rel), size: p.size, kind: kindOf(rel), file_id: p.id }))
    for (const [rel, p] of entries) { data.handled[p.id] = { batch: id, at: t }; delete data.pending[rel] }
    const batch = { id, source: 'files', at: t, items, log: [], state: 'open', outcome: '', record_id: null, thread_id: null }
    data.batches.push(batch)
    save()
    log(`batch ${id}: ${items.length} item(s)`)
    return structuredClone(batch)
  }

  const batchById = id => data.batches.find(b => b.id === id) || null
  const newest = (filter = () => true) => [...data.batches].reverse().find(filter) || null
  function pick(batchId) {
    const batch = batchId ? (BATCH_ID.test(String(batchId)) ? batchById(String(batchId)) : null) : newest()
    if (!batch) refuse(batchId ? `No capture batch ${clip(batchId, 40)}.` : 'There is no capture batch yet.', 'not_found')
    return batch
  }
  function itemOf(batch, ref) {
    const text = String(ref ?? '').trim()
    const rel = text.startsWith(agentBase) ? relative(agentBase, text).split(sep).join('/') : text.replace(/^\/+/u, '')
    let item = batch.items.find(i => i.item === text || i.path === rel || i.name === text)
    // An app batch learns its items as the agent names them (the app's own ids, e.g. a Photos asset id).
    if (!item && batch.app && APP_ITEM.test(text) && batch.items.length < APP_BATCH_MAX) {
      item = { item: text, path: '', name: text, size: 0, kind: 'app', app_item: true }
      batch.items.push(item)
    }
    if (!item) refuse(`Batch ${batch.id} has no item ${clip(text, 80)}. Items: ${batch.items.map(i => `${i.item} ${i.name}`).join(', ')}.`, 'not_found')
    return item
  }
  /** Where an item is now: its filed place, or where it arrived. */
  const placeOf = (batch, item) => {
    const moved = [...batch.log].reverse().find(e => e.item === item.item && e.action === 'file' && !e.undone)
    return moved ? moved.to : item.path
  }
  const stateOf = (batch, item) => {
    const last = [...batch.log].reverse().find(e => e.item === item.item && !e.undone && ['file', 'keep', 'copy'].includes(e.action))
    return last ? { file: 'filed', keep: 'kept', copy: 'copied' }[last.action] : 'waiting'
  }
  /** A real, regular file at rel inside the root (no symlink escape), or null. */
  const fileAt = rel => {
    const path = join(base, rel)
    const real = realBase()
    try {
      const st = lstatSync(path)
      if (!st.isFile()) return null
      const dirReal = realpathSync(dirname(path))
      if (!real || !within(real, dirReal)) return null
      return { path, st }
    } catch { return null }
  }

  function view(batch) {
    return {
      batch: batch.id, source: batch.source, at: new Date(batch.at).toISOString(), state: batch.state, outcome: batch.outcome || '',
      record_id: batch.record_id, thread_id: batch.thread_id,
      ...(batch.app ? { app: batch.app, app_batch: batch.app_batch, count: batch.count } : {}),
      items: batch.items.map(i => ({ item: i.item, name: i.name, kind: i.kind, size: i.size, ...(i.app_item ? { in_app: batch.app } : { arrived: i.path, now: agentPath(placeOf(batch, i)) }), state: stateOf(batch, i) })),
      log: batch.log.map(e => ({ item: e.item, action: e.action, judged_as: e.judged_as || '', rule: e.rule || '', ...(e.to ? { to: e.to } : {}), ...(e.action === 'copy' ? { from: e.from } : {}), ...(e.note_path ? { note: e.note_path } : {}), ...(e.reason ? { reason: e.reason } : {}), ...(e.undone ? { undone: true } : {}) })),
    }
  }

  /**
   * An app inbox's batch (Photos first): the app's own batch id and count, no item list. The same app batch twice is
   * the same batch (an app that resends after a lost answer), so it never runs twice.
   */
  function appBatch({ app, source, batch: appBatchId, count }, t = now()) {
    const name = String(app ?? ''), key = String(appBatchId ?? '')
    if (!APP_ITEM.test(name) || !APP_BATCH.test(key)) refuse('An app batch needs the app and its own batch id.', 'invalid')
    // The count the app sent (the route accepts 1 to 500); the Files inbox's 50-item batch limit is not an app's.
    const n = Math.max(1, Math.min(APP_BATCH_MAX, Math.floor(Number(count) || 0)))
    const was = data.batches.find(b => b.app === name && b.app_batch === key)
    if (was) return { batch: structuredClone(was), created: false }
    const id = `cap_${randomBytes(8).toString('hex')}`
    const batch = { id, source: String(source || name), app: name, app_batch: key, count: n, at: t, items: [], log: [], state: 'open', outcome: '', record_id: null, thread_id: null }
    data.batches.push(batch)
    save()
    log(`batch ${id}: ${n} item(s) from ${name} (${key})`)
    return { batch: structuredClone(batch), created: true }
  }

  /** An app's own batches, newest first, with what the app needs to know (undone: revert your own part). */
  const appBatches = app => [...data.batches].reverse().filter(b => b.app === app).slice(0, 50)
    .map(b => ({ batch: b.id, app_batch: b.app_batch, state: b.state, ...(b.undone_at ? { undone_at: new Date(b.undone_at).toISOString() } : {}) }))

  /** A regular file anywhere in the owner's Files (agent path or path relative to the root), for a copy. */
  function sourceFile(value) {
    const text = String(value ?? '').trim()
    if (!text) refuse('Name the file to copy (from), e.g. the path the app gave for the item.')
    const rel = text.startsWith(`${agentBase}/`) ? relative(agentBase, text) : text.replace(/^\/+/u, '')
    const parts = rel.split(/[\\/]+/u).filter(Boolean)
    if (!parts.length || parts.some(part => part === '..' || part.startsWith('.'))) refuse('That file is not inside the owner\'s Files.')
    const clean = parts.join('/')
    const at = fileAt(clean)
    if (!at) refuse(`There is no file at ${agentPath(clean)}.`, 'missing')
    return { rel: clean, ...at }
  }
  const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 32)

  /**
   * Add a copy of a file to a folder of the owner's Files; the original stays where it is (Photos originals stay in
   * Photos). Never overwrites; one log line; undo takes the copy away again while it is unchanged.
   */
  function copy(batchId, ref, { from = '', folder, name = '', judged_as = '', rule = '' } = {}) {
    const batch = pick(batchId), item = itemOf(batch, ref)
    if (batch.state === 'undone') refuse('That batch was undone; nothing more is filed from it.')
    const src = sourceFile(from || (item.path ? placeOf(batch, item) : ''))
    const st = lstatSync(src.path)
    if (st.size > 512 * 1048576) refuse('That file is too big to copy here (512 MB at most).')
    const target = cleanFolder(folder, { agentRoot: agentBase })
    const dir = join(base, target)
    const real = realBase()
    const made = missingDirs(base, dir)
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    let dirReal
    try { dirReal = realpathSync(dir) } catch { refuse('That folder could not be made.') }
    if (!real || !within(real, dirReal)) refuse('That folder resolves outside the owner\'s Files.')
    const finalName = freeName(dirReal, cleanName(name, basename(src.rel)))
    const to = `${target}/${finalName}`
    copyFileSync(src.path, join(dirReal, finalName), fsConstants.COPYFILE_EXCL)
    batch.log.push({ item: item.item, action: 'copy', from: src.rel, to, made, size: st.size, sha: digest(join(dirReal, finalName)), judged_as: clip(judged_as, 80), rule: clip(rule, 200), at: now() })
    save()
    return { item: item.item, copied: agentPath(to), original: agentPath(src.rel), folder: target }
  }

  /** The owner's rules text; the default set is written into Files the first time it is needed. */
  function rules({ write = true } = {}) {
    const path = join(base, RULES_FILE)
    try { return { path: agentPath(RULES_FILE), text: readFileSync(path, 'utf8').slice(0, 20_000), written: false } } catch (error) {
      if (error?.code !== 'ENOENT') return { path: agentPath(RULES_FILE), text: DEFAULT_RULES, written: false }
    }
    if (write) { try { writeFileSync(path, DEFAULT_RULES, { flag: 'wx', mode: 0o644 }) } catch { /* someone wrote it meanwhile, or read-only: the defaults still apply */ } }
    return { path: agentPath(RULES_FILE), text: DEFAULT_RULES, written: write }
  }

  function setRules(text) {
    const value = String(text ?? '')
    if (!value.trim()) refuse('The rules text is empty; nothing changed.')
    if (value.length > 20_000) refuse('The rules text is too long (20,000 characters at most).')
    const before = rules({ write: false }).text
    writeFileSync(join(base, RULES_FILE), value.endsWith('\n') ? value : `${value}\n`, { mode: 0o644 })
    return { path: agentPath(RULES_FILE), before }
  }

  /** Move one item out of Inbox into a folder of the files root. Never overwrites; one log line. */
  function file(batchId, ref, { folder, name = '', judged_as = '', rule = '' } = {}) {
    const batch = pick(batchId), item = itemOf(batch, ref)
    if (batch.state === 'undone') refuse('That batch was undone; nothing more is filed from it.')
    if (item.app_item) refuse(`${item.name} stays in ${batch.app}: use action copy (from = the path ${batch.app} gave) to add a copy to Files, and ${batch.app}'s own tools to tag it or mark it processed.`)
    const target = cleanFolder(folder, { agentRoot: agentBase })
    const from = placeOf(batch, item)
    const src = fileAt(from)
    if (!src) refuse(`${item.name} is no longer at ${agentPath(from)}; nothing moved.`, 'missing')
    const dir = join(base, target)
    const real = realBase()
    const made = missingDirs(base, dir)
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    let dirReal
    try { dirReal = realpathSync(dir) } catch { refuse('That folder could not be made.') }
    if (!real || !within(real, dirReal)) refuse('That folder resolves outside the owner\'s Files.')
    const finalName = freeName(dirReal, cleanName(name, item.name))
    const to = `${target}/${finalName}`
    renameSync(src.path, join(dirReal, finalName))
    batch.log.push({ item: item.item, action: 'file', from, to, made, judged_as: clip(judged_as, 80), rule: clip(rule, 200), at: now() })
    save()
    return { item: item.item, name: item.name, filed: agentPath(to), folder: target }
  }

  /** Leave one item where it is (a question pending, or the rule says keep it), with the reason. */
  function keep(batchId, ref, { judged_as = '', rule = '', reason = '' } = {}) {
    const batch = pick(batchId), item = itemOf(batch, ref)
    batch.log.push({ item: item.item, action: 'keep', judged_as: clip(judged_as, 80), rule: clip(rule, 200), reason: clip(reason, 200), at: now() })
    save()
    return { item: item.item, name: item.name, kept: agentPath(placeOf(batch, item)) }
  }

  /** Append text (e.g. highlights from a book page) to a Markdown note in Files; undo takes exactly that text out. */
  function note(batchId, ref, { path, text, judged_as = '', rule = '' } = {}) {
    const batch = pick(batchId)
    const item = ref ? itemOf(batch, ref) : null
    const body = String(text ?? '')
    if (!body.trim()) refuse('The note text is empty.')
    if (body.length > MAX_NOTE_CHARS) refuse('That note text is too long (20,000 characters at most per call).')
    let rel = String(path ?? '').trim()
    if (!/\.md$/iu.test(rel)) rel += '.md'
    const folder = cleanFolder(dirname(rel) === '.' ? '' : dirname(rel) || '', { agentRoot: agentBase })
    const name = cleanName(basename(rel), basename(rel))
    const dir = join(base, folder)
    const made = missingDirs(base, dir)
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    const real = realBase()
    let dirReal
    try { dirReal = realpathSync(dir) } catch { refuse('That folder could not be made.') }
    if (!real || !within(real, dirReal)) refuse('That folder resolves outside the owner\'s Files.')
    const target = join(dirReal, name)
    let before = -1
    try { const st = lstatSync(target); if (!st.isFile()) refuse('A note path must be a file.'); before = st.size } catch (error) { if (error?.capture) throw error }
    const chunk = Buffer.from(`${before > 0 ? '\n' : ''}${body.endsWith('\n') ? body : `${body}\n`}`, 'utf8')
    if (before < 0) writeFileSync(target, chunk, { flag: 'wx', mode: 0o644 })
    else appendFileSync(target, chunk)
    const notePath = `${folder}/${name}`
    batch.log.push({ item: item?.item || '', action: 'note', note_path: notePath, made, created: before < 0, before: Math.max(0, before), added: chunk.length, sha: createHash('sha256').update(chunk).digest('hex').slice(0, 32), judged_as: clip(judged_as, 80), rule: clip(rule, 200), at: now() })
    save()
    return { note: agentPath(notePath), created: before < 0, added_chars: body.length }
  }

  /** The batch is handled: the one-line outcome the sweep shows. */
  function finish(batchId, outcome) {
    const batch = pick(batchId)
    const line = clip(outcome, 140)
    if (!line) refuse('Give the outcome in one line, e.g. "5 filed from Inbox: 2 receipts to Documents/Receipts, 1 article to Reading".')
    batch.outcome = line
    if (batch.state === 'open') batch.state = 'done'
    save()
    return { batch: batch.id, outcome: line, waiting: batch.items.filter(i => stateOf(batch, i) === 'waiting').map(i => i.name) }
  }

  // Folders a filing step made are taken away again on undo, only while they are empty (deepest first).
  const unmake = made => {
    for (const rel of [...(Array.isArray(made) ? made : [])].reverse()) {
      try { rmdirSync(join(base, rel)) } catch { /* not empty, or already gone: leave it */ }
    }
  }

  /** Put a whole batch back: every filed item to where it arrived, every note without the added text. Newest first. */
  function undo(batchId) {
    const batch = batchId ? pick(batchId) : newest(b => b.log.some(e => !e.undone) || (b.app && b.state !== 'undone' && !b.undone_at))
    if (!batch) refuse('There is no capture batch to undo.', 'not_found')
    const restored = [], problems = []
    for (const entry of [...batch.log].reverse()) {
      if (entry.undone) continue
      if (entry.action === 'keep') { entry.undone = true; continue }
      if (entry.action === 'copy') {
        const at = fileAt(entry.to)
        if (!at) { entry.undone = true; restored.push(entry.to); unmake(entry.made); continue }
        if (at.st.size !== entry.size || digest(at.path) !== entry.sha) { problems.push(`${entry.to}: changed since, left as it is`); continue }
        unlinkSync(at.path)
        entry.undone = true
        restored.push(entry.to)
        unmake(entry.made)
        continue
      }
      if (entry.action === 'file') {
        const at = fileAt(entry.to)
        const name = basename(entry.from)
        if (!at) { problems.push(`${name}: no longer at ${entry.to}`); continue }
        const back = join(base, entry.from)
        if (existsSync(back)) { problems.push(`${name}: another file is now at ${entry.from}`); continue }
        mkdirSync(dirname(back), { recursive: true, mode: 0o755 })
        renameSync(at.path, back)
        // Put back means left alone: the watcher never batches it again.
        try { data.handled[idOf(lstatSync(back, { bigint: true }))] = { batch: batch.id, at: now(), undone: true } } catch { /* gone again */ }
        entry.undone = true
        restored.push(entry.from)
        unmake(entry.made)
        continue
      }
      if (entry.action === 'note') {
        const at = fileAt(entry.note_path)
        if (!at) { problems.push(`${entry.note_path}: note not found`); continue }
        const size = at.st.size
        let tail = Buffer.alloc(0)
        try {
          const fd = openSync(at.path, 'r')
          try { tail = Buffer.alloc(entry.added); const n = size >= entry.added ? readSyncAt(fd, tail, size - entry.added) : 0; tail = tail.subarray(0, n) } finally { closeSync(fd) }
        } catch { tail = Buffer.alloc(0) }
        if (size !== entry.before + entry.added || createHash('sha256').update(tail).digest('hex').slice(0, 32) !== entry.sha) {
          problems.push(`${entry.note_path}: changed since, left as it is`)
          continue
        }
        if (entry.created) unlinkSync(at.path)
        else truncateSync(at.path, entry.before)
        entry.undone = true
        restored.push(entry.note_path)
        unmake(entry.made)
      }
    }
    if (!problems.length) batch.state = 'undone'
    batch.undone_at = now()
    if (batch.app) {
      // App items never left the app: the app reverts its own part (tags, albums, processed marks) when it reads this.
      const of = Math.max(batch.count || 0, batch.items.length)
      batch.undo_result = { restored: restored.length, problems: problems.length, back: problems.length ? 0 : of, of }
      save()
      const label = `${batch.app.charAt(0).toUpperCase()}${batch.app.slice(1)}`
      return { batch: batch.id, restored: restored.length, problems, app: batch.app, app_batch: batch.app_batch, items_left_in_app: of, of, app_reverts: `${label} takes away its own tags, albums and processed marks for this batch within a minute` }
    }
    const back = batch.items.filter(i => placeOf(batch, i) === i.path && existsSync(join(base, i.path))).length
    batch.undo_result = { restored: restored.length, problems: problems.length, back, of: batch.items.length }
    save()
    return { batch: batch.id, restored: restored.length, problems, items_back_in_inbox: back, of: batch.items.length }
  }

  function link(batchId, { record_id = null, thread_id = null } = {}) {
    const batch = batchById(batchId)
    if (!batch) return null
    Object.assign(batch, { record_id, thread_id })
    save()
    return structuredClone(batch)
  }

  return {
    root: base, agentRoot: agentBase, scan, pause, makeBatch, appBatch, appBatches, rules, setRules, file, copy, keep, note, finish, undo, link, view,
    active: () => data.active === true,
    batch: id => { const b = BATCH_ID.test(String(id)) ? batchById(String(id)) : null; return b ? structuredClone(b) : null },
    byThread: thread => { const b = newest(x => x.thread_id === thread); return b ? structuredClone(b) : null },
    list: (limit = 20) => [...data.batches].reverse().slice(0, Math.max(1, Math.min(200, Number(limit) || 20))).map(view),
    pending: () => Object.keys(data.pending).length,
  }
}

function readSyncAt(fd, buffer, position) {
  // Small helper so the undo check reads exactly the bytes a note call added.
  let read = 0
  while (read < buffer.length) {
    const n = readSync(fd, buffer, read, buffer.length - read, position + read)
    if (!n) break
    read += n
  }
  return read
}

/** The worker turn for one batch: what arrived, where the agent sees it, and the owner's rules. */
export function batchTurnText(batch, { agentRoot, rules, appName = '' }) {
  if (batch.app) return appBatchTurnText(batch, { agentRoot, rules, appName })
  const size = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
  const lines = batch.items.map(i => `- ${i.item}: ${i.name} (${i.kind}, ${size(i.size)}) at ${join(agentRoot, i.path)}`)
  return [
    `Capture batch ${batch.id}: ${batch.items.length} new item${batch.items.length === 1 ? '' : 's'} arrived in the owner's Files Inbox. File each one by the owner's capture rules below.`,
    '',
    'Items:',
    ...lines,
    '',
    `The owner's capture rules (the file ${rules.path}):`,
    '"""',
    rules.text.trim(),
    '"""',
    '',
    'How:',
    `1. Look at every item first (vision for images, read documents). A voice note in the batch is the owner's instructions for this batch: hear it with ${CAPTURE_TOOL} action listen before anything else.`,
    `2. For every item call ${CAPTURE_TOOL} once: action file (batch, item, folder, judged_as, rule) moves it into a folder of the owner's Files; action keep (with reason) leaves it in Inbox. Text you take out of an item (book-page highlights) goes in with action note (path of a .md file in Files, text).`,
    `3. Use only ${CAPTURE_TOOL} to move or write these files: it logs every step so the owner can undo the batch. Never delete anything. Other apps' tools (Money and so on) are fine for adding copies, never for moving the originals.`,
    `4. With no rule for an item: make your best guess only for a low-risk move; otherwise keep it in Inbox and ask the owner one question (needs_you status with a recommendation and short options).`,
    `5. Finish with ${CAPTURE_TOOL} action done (batch, outcome): one line like "5 filed from Inbox: 2 receipts to Documents/Receipts/2026, 1 article to Reading/Articles, 1 book page to Reading/<title>, 1 voice note".`,
  ].join('\n')
}

/** The worker turn for an app inbox's batch (Photos first): the items stay in the app and are read with its tools. */
function appBatchTurnText(batch, { agentRoot, rules, appName = '' }) {
  const app = batch.app, name = appName || app, n = batch.count || 0
  const photos = app === 'photos'
  return [
    `Capture batch ${batch.id}: ${n} new item${n === 1 ? '' : 's'} arrived in the owner's ${name} app (${name}'s batch ${batch.app_batch}). Handle each one by the owner's capture rules below.`,
    '',
    photos
      ? `List them with the Photos tool photos_capture_batch (batch ${batch.app_batch}): every photo's asset id, when it was taken, and its original file (files_path, inside the owner's Files, which you see at ${agentRoot}). Look at each original with vision.`
      : `List them with ${name}'s own tools for its batch ${batch.app_batch}.`,
    '',
    `The owner's capture rules (the file ${rules.path}):`,
    '"""',
    rules.text.trim(),
    '"""',
    '',
    'How:',
    ...(photos ? [
      '1. Personal photos and videos stay in Photos: call photos_capture_file (batch, asset_id, judged_as, rule, tags for the people, places or event you see, album for the event or trip). That also marks the photo processed.',
      `2. Photos of documents (book pages, receipts, whiteboards): add a copy to the folder the rules name with ${CAPTURE_TOOL} action copy (batch ${batch.id}, item = the asset id, from = its files_path, folder, judged_as, rule); never move the original. Text you take out of a photo (the highlighted passages of a book page) goes in with ${CAPTURE_TOOL} action note (batch ${batch.id}, item = the asset id, path like Reading/<book title>.md, text). Then call photos_capture_file for it too (judged_as, rule, and the album the rules name, if any), so the original is marked processed.`,
    ] : [
      `1. Add copies to the owner's Files only with ${CAPTURE_TOOL} action copy, and notes with action note (batch ${batch.id}, item = the app's id for the item); use ${name}'s own tools for everything inside ${name}.`,
      '2. Never move or delete the originals in the app.',
    ]),
    '3. Use only these logged tools for these items, so the owner can undo the batch with one word. Never delete anything.',
    '4. With no rule for an item: make your best guess only for a low-risk step (a tag, an album); otherwise leave it as it is and ask the owner one question (needs_you status with a recommendation and short options).',
    `5. Finish with ${CAPTURE_TOOL} action done (batch ${batch.id}, outcome): one line like "3 photos from ${name}: 3 book pages of <title> to Reading/<title>.md".`,
  ].join('\n')
}

const ACTIONS = ['list', 'listen', 'file', 'copy', 'keep', 'note', 'done', 'undo', 'rules']
export const CAPTURE_TOOL_DEF = {
  name: CAPTURE_TOOL,
  description: '[WizardOS] Capture inbox: file what the owner drops in his Files Inbox, by his own capture rules, with a log he can undo. '
    + 'Actions: list (a batch, or the newest batches, with every item and where it is now), listen (transcribe an audio item of a batch: the owner\'s instructions for that batch), '
    + 'file (move one item into a folder of the owner\'s Files: folder like Documents/Receipts/2026, judged_as, rule), copy (add a copy of a file to a folder of the owner\'s Files and leave the original where it is: from = the file, e.g. the files_path Photos gave for a photo), keep (leave an item where it is, with reason), '
    + 'note (append text such as book-page highlights to a .md note in Files), done (the batch\'s one-line outcome), '
    + 'undo (put a whole batch back exactly: every item back where it arrived, notes without the added text; newest batch when none is named; use it when the owner says "undo that" about a filing), '
    + 'rules (read the owner\'s capture rules, or replace them with text when he asks to change a rule). Never move these files any other way.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTIONS },
      batch: { type: 'string', description: 'The batch id (cap_…) from the batch message. Optional for list and undo (newest).' },
      item: { type: 'string', description: 'The item (i1, i2 …), its name or its path; in an app batch (Photos) the app\'s id for it (the asset id).' },
      from: { type: 'string', description: 'copy: the file to copy, inside the owner\'s Files (e.g. the files_path Photos gave). Default: the item itself.' },
      folder: { type: 'string', description: 'file: target folder inside the owner\'s Files, e.g. Documents/Receipts/2026 (never Inbox).' },
      name: { type: 'string', description: 'file: optional new file name (the extension is kept).' },
      judged_as: { type: 'string', description: 'What you judged the item to be (receipt, article, book page, personal photo …).' },
      rule: { type: 'string', description: 'The rule you applied, in the owner\'s words, or "best guess".' },
      reason: { type: 'string', description: 'keep: why it stays in Inbox.' },
      path: { type: 'string', description: 'note: the .md file in Files, e.g. Reading/Thinking, Fast and Slow.md.' },
      text: { type: 'string', description: 'note: the text to add. rules: the full new rules text.' },
      outcome: { type: 'string', description: 'done: one line saying what happened to the batch.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
}

/** The `wizard_capture` gateway tool, main agent only, while the switch is on. */
export function captureTool({ inbox, on = () => false, mainAgent = 'hermes', listen = async () => null, finished = () => {}, undone = () => {} }) {
  const ok = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
  const bad = text => ({ content: [{ type: 'text', text }], isError: true })
  return {
    list: agentId => (on() && inbox() && agentId === mainAgent ? [CAPTURE_TOOL_DEF] : []),
    async call(name, args = {}, agentId) {
      if (name !== CAPTURE_TOOL) return null
      const box = inbox()
      if (!on() || !box) return bad('The capture inbox is switched off on this Wizard.')
      if (agentId !== mainAgent) return bad('Only the owner\'s main agent files captured items.')
      const action = String(args.action ?? '')
      try {
        if (action === 'list') return ok(args.batch ? box.view(box.batch(args.batch) || (() => { throw Object.assign(new Error(`No capture batch ${clip(args.batch, 40)}.`), { capture: true }) })()) : { batches: box.list(5), rules: box.rules({ write: false }).path })
        if (action === 'listen') {
          const batch = box.batch(args.batch)
          if (!batch) return bad(`No capture batch ${clip(args.batch, 40)}.`)
          const view = box.view(batch)
          const item = view.items.find(i => i.item === args.item || i.name === args.item || i.now === args.item)
          if (!item) return bad(`Batch ${batch.id} has no item ${clip(args.item, 80)}.`)
          if (item.kind !== 'audio' && item.kind !== 'video') return bad(`${item.name} is not an audio or video item.`)
          const heard = await listen(item.now, agentId)
          return heard || bad('Transcription is not available on this Wizard right now; treat the batch without the voice note and keep the voice note in Inbox.')
        }
        if (action === 'file') return ok(box.file(args.batch, args.item, { folder: args.folder, name: args.name, judged_as: args.judged_as, rule: args.rule }))
        if (action === 'copy') return ok(box.copy(args.batch, args.item, { from: args.from, folder: args.folder, name: args.name, judged_as: args.judged_as, rule: args.rule }))
        if (action === 'keep') return ok(box.keep(args.batch, args.item, { judged_as: args.judged_as, rule: args.rule, reason: args.reason }))
        if (action === 'note') return ok(box.note(args.batch, args.item, { path: args.path, text: args.text, judged_as: args.judged_as, rule: args.rule }))
        if (action === 'done') { const r = box.finish(args.batch, args.outcome); finished(r.batch); return ok(r) }
        if (action === 'undo') { const r = box.undo(args.batch); undone(r); return ok(r) }
        if (action === 'rules') return ok(args.text ? box.setRules(args.text) : box.rules())
        return bad(`action must be one of ${ACTIONS.join(', ')}`)
      } catch (error) {
        if (error?.capture) return bad(error.message)
        return bad(`That did not work: ${clip(error?.code || error?.message || error, 120)}. Nothing else was changed.`)
      }
    },
  }
}
