// Workspace sync: one box-wide copy of the owner's desks (which desks exist, their order, the apps on each), shared by
// every Wizard client. Layout, focus, full screen and the current desk stay on each device and are never sent here.
//
//   GET  /wizard/v1/workspaces?since=<rev>&wait=<s>   long-poll (wait ≤ 25 s): { rev, state, closed, device, at }
//   PUT  /wizard/v1/workspaces { baseRev, device, state }   200 snapshot | 409 snapshot (stale baseRev; merge and retry)
//   POST /wizard/v1/workspaces/closed/forget { desk }   drop one Recently closed desk
//
// Desks that disappear together with their windows are kept (newest first, at most 12) as `closed`, so any device can
// reopen them; a window moved to another desk is not a close.
import { existsSync, readFileSync, mkdirSync, rmdirSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export const WORKSPACES_MAX_BYTES = 1024 * 1024 // stored file (state + Recently closed); a single PUT body is capped at 512 KiB
const MAX_DESKS = 40, MAX_WINS = 12, MAX_CLOSED = 12
const APPS = new Set(['chats', 'frame', 'review', 'maps', 'feature'])
const ID = /^[A-Za-z0-9_~-]{1,40}$/
const CTRL = /[\u0000-\u001f\u007f]/u
const STR = { appId: 120, url: 2048, thread: 200, agent: 120, chatsProvider: 120, title: 200, dest: 300, mode: 40, query: 300, featureId: 120 }
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')

function cleanWin(w) {
  if (!isObj(w) || typeof w.id !== 'string' || !ID.test(w.id) || !APPS.has(w.app)) return null
  const out = { id: w.id, app: w.app }
  for (const [k, n] of Object.entries(STR)) if (typeof w[k] === 'string' && w[k].length > 0 && w[k].length <= n && !CTRL.test(w[k])) out[k] = w[k]
  for (const k of ['z', 'featureOptions']) if (isObj(w[k]) && JSON.stringify(w[k]).length <= 2000) out[k] = w[k]
  return out
}

// Lenient per desk/window: anything invalid is dropped, the rest kept. null when the shape itself is wrong.
export function cleanWorkspaces(s) {
  if (!isObj(s) || !Array.isArray(s.desks)) return null
  const desks = [], seenD = new Set(), seenW = new Set()
  for (const d of s.desks.slice(0, MAX_DESKS)) {
    if (!isObj(d) || typeof d.id !== 'string' || !ID.test(d.id) || seenD.has(d.id)) continue
    const wins = []
    for (const w of (Array.isArray(d.wins) ? d.wins : []).slice(0, MAX_WINS)) {
      const c = cleanWin(w)
      if (c && !seenW.has(c.id)) { seenW.add(c.id); wins.push(c) }
    }
    if (wins.length) { seenD.add(d.id); desks.push({ id: d.id, wins }) }
  }
  return { desks }
}

function closedDesks(old, next, device) {
  const alive = new Set(next.desks.flatMap(d => d.wins.map(w => w.id))), ids = new Set(next.desks.map(d => d.id)), at = now()
  const out = []
  for (const d of old.desks) {
    if (ids.has(d.id)) continue
    const gone = d.wins.filter(w => !alive.has(w.id))
    if (gone.length) out.push({ desk: { id: d.id, wins: gone }, closedAt: at, device })
  }
  return out
}

const empty = () => ({ rev: 0, state: { desks: [] }, closed: [], device: '', at: '' })
function parseDb(text) {
  const j = JSON.parse(text)
  if (!isObj(j) || !Number.isInteger(j.rev)) return null
  return { ...empty(), rev: j.rev, state: cleanWorkspaces(j.state) || { desks: [] },
    closed: Array.isArray(j.closed) ? j.closed.filter(c => isObj(c) && cleanWorkspaces({ desks: [c.desk] })?.desks.length).slice(0, MAX_CLOSED) : [],
    device: typeof j.device === 'string' ? j.device : '', at: typeof j.at === 'string' ? j.at : '' }
}
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// The file on disk is the single authority, so two service processes sharing one Wizard OS home agree on `rev`:
// every mutation takes a short exclusive lock, re-reads the file, compares, writes, then publishes. Nothing is
// visible to readers until the write has succeeded.
export function createWorkspaceStore(path) {
  const lockPath = `${path}.lock`
  let db = empty(), seen = ''
  function refresh() {
    try {
      if (!existsSync(path)) return
      const st = statSync(path), mark = `${st.mtimeMs}:${st.size}`
      if (mark === seen) return
      seen = mark
      if (st.size > WORKSPACES_MAX_BYTES) return
      const next = parseDb(readFileSync(path, 'utf8'))
      if (next && next.rev >= db.rev) { const changed = next.rev !== db.rev; db = next; if (changed) wake() }
    } catch { /* unreadable: keep serving what we have; the next good save replaces the file */ }
  }
  function withLock(fn) {
    mkdirSync(dirname(path), { recursive: true })
    for (let i = 0; ; i++) {
      try { mkdirSync(lockPath); break } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        try { if (Date.now() - statSync(lockPath).mtimeMs > 10000) { rmdirSync(lockPath); continue } } catch {}
        if (i > 200) throw Object.assign(new Error('workspaces_busy'), { status: 503 })
        sleepSync(10)
      }
    }
    try { refresh(); return fn() } finally { try { rmdirSync(lockPath) } catch {} }
  }
  function write(next) {
    const text = JSON.stringify(next) + '\n'
    if (Buffer.byteLength(text) > WORKSPACES_MAX_BYTES) throw Object.assign(new Error('too_large'), { status: 413 })
    const temp = `${path}.${randomUUID()}.tmp`
    try { writeFileSync(temp, text, { mode: 0o600, flag: 'wx' }); renameSync(temp, path) }
    finally { if (existsSync(temp)) unlinkSync(temp) }
    db = next
    try { const st = statSync(path); seen = `${st.mtimeMs}:${st.size}` } catch {}
    wake()
  }
  const waiters = new Set()
  function wake() { for (const w of [...waiters]) w() }
  const snapshot = () => ({ rev: db.rev, state: db.state, closed: db.closed, device: db.device, at: db.at })
  refresh()
  return {
    snapshot: () => { refresh(); return snapshot() },
    // Resolves as soon as rev > since (this process or another one sharing the file), or after `wait` seconds.
    wait(since, wait, signal) {
      refresh()
      if (db.rev > since || wait <= 0) return Promise.resolve(snapshot())
      return new Promise(resolve => {
        const done = () => { clearTimeout(t); clearInterval(poll); waiters.delete(done); signal?.removeEventListener?.('abort', done); resolve(snapshot()) }
        const t = setTimeout(done, Math.min(25, wait) * 1000)
        const poll = setInterval(() => { refresh(); if (db.rev > since) done() }, 1000)
        waiters.add(done); signal?.addEventListener?.('abort', done)
      })
    },
    put({ baseRev, device, state }) {
      const clean = cleanWorkspaces(state)
      if (!clean || !Number.isInteger(baseRev)) throw Object.assign(new Error('invalid_workspaces'), { status: 400 })
      return withLock(() => {
        if (baseRev !== db.rev) return { status: 409, body: snapshot() }
        if (JSON.stringify(clean) === JSON.stringify(db.state)) return { status: 200, body: snapshot() }
        const who = typeof device === 'string' ? device.replace(new RegExp(CTRL, 'gu'), '').slice(0, 60) : ''
        const back = new Set([...clean.desks.map(d => d.id), ...clean.desks.flatMap(d => d.wins.map(w => w.id))])
        const kept = db.closed.filter(c => !back.has(c.desk.id) && !c.desk.wins.some(w => back.has(w.id)))
        let closed = [...closedDesks(db.state, clean, who).reverse(), ...kept].slice(0, MAX_CLOSED)
        const next = { rev: db.rev + 1, state: clean, closed, device: who, at: now() }
        // Recently closed is a convenience: drop the oldest entries before ever refusing the owner's live desks.
        while (closed.length && Buffer.byteLength(JSON.stringify(next) + '\n') > WORKSPACES_MAX_BYTES) { closed = closed.slice(0, -1); next.closed = closed }
        write(next)
        return { status: 200, body: snapshot() }
      })
    },
    forget(desk) {
      return withLock(() => {
        const closed = db.closed.filter(c => c.desk.id !== desk)
        if (closed.length !== db.closed.length) write({ ...db, rev: db.rev + 1, closed })
        return snapshot()
      })
    },
  }
}
