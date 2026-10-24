// Workspace sync: one box-wide copy of the owner's desks (which desks exist, their order, the apps on each), shared by
// every Wizard client. Layout, focus, full screen and the current desk stay on each device and are never sent here.
//
//   GET  /wizard/v1/workspaces?since=<rev>&wait=<s>   long-poll (wait ≤ 25 s): { rev, state, closed, device, at }
//   PUT  /wizard/v1/workspaces { baseRev, device, state }   200 snapshot | 409 snapshot (stale baseRev; merge and retry)
//   POST /wizard/v1/workspaces/closed/forget { desk }   drop one Recently closed desk
//
// Desks that disappear together with their windows are kept (newest first, at most 12) as `closed`, so any device can
// reopen them; a window moved to another desk is not a close.
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export const WORKSPACES_MAX_BYTES = 512 * 1024
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

export function createWorkspaceStore(path) {
  const empty = () => ({ rev: 0, state: { desks: [] }, closed: [], device: '', at: '' })
  let db = empty()
  try {
    if (existsSync(path) && statSync(path).size <= WORKSPACES_MAX_BYTES) {
      const j = JSON.parse(readFileSync(path, 'utf8'))
      if (isObj(j) && Number.isInteger(j.rev)) db = { ...empty(), rev: j.rev, state: cleanWorkspaces(j.state) || { desks: [] },
        closed: Array.isArray(j.closed) ? j.closed.filter(c => isObj(c) && cleanWorkspaces({ desks: [c.desk] })?.desks.length).slice(0, MAX_CLOSED) : [],
        device: typeof j.device === 'string' ? j.device : '', at: typeof j.at === 'string' ? j.at : '' }
    }
  } catch { /* unreadable: start empty, leave the file until the next save replaces it */ }
  const waiters = new Set()
  const snapshot = () => ({ rev: db.rev, state: db.state, closed: db.closed, device: db.device, at: db.at })
  function save() {
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${randomUUID()}.tmp`
    try { writeFileSync(temp, JSON.stringify(db) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temp, path) }
    finally { if (existsSync(temp)) unlinkSync(temp) }
  }
  function bump() { db.rev += 1; save(); for (const w of [...waiters]) w() }
  return {
    snapshot,
    // Resolves with the snapshot as soon as rev > since, or after `wait` seconds.
    wait(since, wait, signal) {
      if (db.rev > since || wait <= 0) return Promise.resolve(snapshot())
      return new Promise(resolve => {
        const done = () => { clearTimeout(t); waiters.delete(done); signal?.removeEventListener?.('abort', done); resolve(snapshot()) }
        const t = setTimeout(done, Math.min(25, wait) * 1000)
        waiters.add(done); signal?.addEventListener?.('abort', done)
      })
    },
    put({ baseRev, device, state }) {
      const next = cleanWorkspaces(state)
      if (!next || !Number.isInteger(baseRev)) throw Object.assign(new Error('invalid_workspaces'), { status: 400 })
      if (baseRev !== db.rev) return { status: 409, body: snapshot() }
      if (JSON.stringify(next) !== JSON.stringify(db.state)) {
        const who = typeof device === 'string' ? device.replace(CTRL, '').slice(0, 60) : ''
        const back = new Set([...next.desks.map(d => d.id), ...next.desks.flatMap(d => d.wins.map(w => w.id))])
        const kept = db.closed.filter(c => !back.has(c.desk.id) && !c.desk.wins.some(w => back.has(w.id)))
        db.closed = [...closedDesks(db.state, next, who).reverse(), ...kept].slice(0, MAX_CLOSED)
        db.state = next; db.device = who; db.at = now()
        bump()
      }
      return { status: 200, body: snapshot() }
    },
    forget(desk) {
      const before = db.closed.length
      db.closed = db.closed.filter(c => c.desk.id !== desk)
      if (db.closed.length !== before) bump()
      return snapshot()
    },
  }
}
