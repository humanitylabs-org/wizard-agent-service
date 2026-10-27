// Service-owned follow-through for undispatched Hermes work. The canonical
// transcript survives service/stream-keeper restarts and covers both native locked
// and /v1/runs turns. Tool evidence is scoped by insertion IDs after the run's last
// triggering user row, never a previous turn's handles. Read-only Hermes DB; claims
// live in a separate service DB and queue continuation metadata, not model prose.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { parseStatus } from './thread-status.mjs'
import { countDispatchHandles, ownedOpenItems, guardOwnedOpenWork, claimsExistingHandle } from './owned-open-work.mjs'

export const OWNED_WORK_KIND = 'owned-open-work'
export const ownedWorkStatePathOf = options => options.followThrough === false || options.ownedOpenWork === false ? ''
  : options.ownedOpenWorkStatePath || (options.runQueueStatePath ? `${options.runQueueStatePath}.owned-open-work.db`
    : options.hermesStatePath ? `${options.hermesStatePath}.wizard-owned-open-work.db` : '')
export const OWNED_WORK_PREFIX = '[Wizard follow-through] Your last reply lists follow-up work you own under Still open without starting it:'
const digest = text => createHash('sha256').update(text).digest('hex')
const hidden = new Set(['commentary', 'hidden', 'system', 'internal_notification', 'async_delegation_complete'])
const MAX_ROWS = 10_000
const MAX_AGE = 2 * 3600

export function readOwnedOpenWork(path, sessionId) {
  if (!path || !sessionId) return null
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
    db.exec('BEGIN')
    const cols = new Set(db.prepare('PRAGMA table_info(messages)').all().map(row => row.name))
    if (!['id', 'session_id', 'role', 'content', 'tool_calls', 'tool_call_id', 'timestamp'].every(key => cols.has(key))) return null
    const active = cols.has('active') ? 'AND COALESCE(active,1)=1' : ''
    const latest = db.prepare(`SELECT * FROM messages WHERE session_id=? AND role IN ('user','assistant') ${active} ORDER BY id DESC LIMIT 100`).all(sessionId)
      .find(row => !hidden.has(row.display_kind) && String(row.content ?? '').trim())
    if (!latest || latest.role !== 'assistant' || latest.tool_calls && latest.tool_calls !== '[]' && latest.tool_calls !== 'null') return null
    const user = db.prepare(`SELECT * FROM messages WHERE session_id=? AND role='user' AND id<? ${active} ORDER BY id DESC LIMIT 1`).get(sessionId, latest.id)
    if (!user) return null
    const items = ownedOpenItems(latest.content)
    const rows = items.length ? db.prepare(`SELECT * FROM messages WHERE session_id=? AND id>? AND id<=? ${active} ORDER BY id LIMIT ?`).all(sessionId, user.id, latest.id, MAX_ROWS + 1) : []
    if (rows.length > MAX_ROWS) return null // incomplete tool evidence is not zero handles
    const claimed = items.filter(claimsExistingHandle).length
    // Earlier turns of this thread (bounded): real handles that a restated item may point to.
    const prior = claimed ? countDispatchHandles(db.prepare(`SELECT * FROM messages WHERE session_id=? AND id<=? ${active} ORDER BY id DESC LIMIT 2000`).all(sessionId, user.id)) : 0
    const handleCount = countDispatchHandles(rows) + Math.min(claimed, prior)
    return { agentId: 'hermes', sessionId, runId: String(user.message_uid || user.id), messageId: String(latest.message_uid || latest.id),
      userId: Number(user.id), replyId: Number(latest.id), fingerprint: digest(latest.content), at: Number(latest.timestamp),
      status: parseStatus(latest.content), items, ownedCount: items.length, handleCount,
      continuation: String(user.content ?? '').startsWith(OWNED_WORK_PREFIX) }
  } catch { return null } finally { db?.close() }
}

// Rowid-range scan only: state.db holds millions of rows, so a time/content predicate
// over the whole table is a full scan. Callers pass the previous high-water id; the
// first scan starts a bounded window behind the newest row (ids are monotonic).
export const OWNED_SCAN_WINDOW = 20_000
export function scanOwnedOpenWork(path, { now = Date.now(), afterId = null } = {}) {
  if (!path) return { evidence: [], lastId: afterId }
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const top = Number(db.prepare('SELECT MAX(id) AS id FROM messages').get()?.id ?? 0)
    const from = afterId == null ? Math.max(0, top - OWNED_SCAN_WINDOW) : Math.min(afterId, top)
    const sessions = db.prepare(`SELECT DISTINCT session_id FROM messages WHERE id>? AND id<=? AND role='assistant'
      AND timestamp>=? AND instr(lower(content),'still open:')>0 LIMIT 201`).all(from, top, now/1000 - MAX_AGE)
    db.close(); db = null
    const evidence = sessions.filter(row => /^(?:wizard_|wizard-assistant-)/u.test(row.session_id))
      .map(row => readOwnedOpenWork(path, row.session_id)).filter(Boolean)
    return { evidence, lastId: top }
  } catch { return { evidence: [], lastId: afterId } } finally { db?.close() }
}
export function findOwnedOpenWork(path, now = Date.now()) {
  return scanOwnedOpenWork(path, { now }).evidence
}

// Recheck at both admission and eventual queue dispatch. A later user message,
// rewritten reply, owner decision, or live session lease revokes automatic authority.
export function requireOwnedWorkContinuation(path, token, now = Date.now()) {
  const current = readOwnedOpenWork(path, token?.sessionId)
  if (token?.kind !== OWNED_WORK_KIND || token.agent_id !== 'hermes' || !current
    || current.continuation || current.runId !== token.runId || current.messageId !== token.messageId
    || current.fingerprint !== token.fingerprint || current.userId !== token.userId
    || !['done', 'fyi'].includes(current.status?.state) || current.ownedCount <= current.handleCount
    || !Number.isFinite(current.at) || current.at > now/1000 || now/1000-current.at > MAX_AGE) {
    throw Object.assign(new Error('Owned follow-up request is no longer current'), { status: 410 })
  }
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const hasLeases = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_turn_leases'").get()
    if (hasLeases && db.prepare('SELECT 1 FROM session_turn_leases WHERE conversation_id=? AND expires_at>? LIMIT 1').get(token.sessionId, now/1000)) {
      throw Object.assign(new Error('The owner still holds this turn'), { status: 503 })
    }
  } finally { db?.close() }
}

export function createOwnedWorkFollowThrough({ statePath, sessionDbPath, read = id => readOwnedOpenWork(sessionDbPath, id),
  find = null, admit, busy = async () => false,
  validate = token => requireOwnedWorkContinuation(sessionDbPath, token), now = Date.now, log = () => {} }) {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(statePath)
  chmodSync(statePath, 0o600)
  db.exec(`CREATE TABLE IF NOT EXISTS owned_work_claims (
    session_id TEXT NOT NULL, run_id TEXT NOT NULL, reply_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, state TEXT NOT NULL, created_at REAL NOT NULL,
    PRIMARY KEY(session_id,run_id), UNIQUE(session_id,reply_id))`)
  const claimFor = evidence => db.prepare('SELECT * FROM owned_work_claims WHERE session_id=? AND (run_id=? OR reply_id=?)')
    .get(evidence.sessionId, evidence.runId, evidence.messageId)
  // Session-list projection reads only sessions the scanner flagged (or that hold a
  // claim), so listing hundreds of threads never seeks hundreds of transcripts.
  const candidates = new Map()
  for (const row of db.prepare('SELECT session_id, created_at FROM owned_work_claims WHERE created_at>=?').all(now()/1000 - MAX_AGE)) candidates.set(row.session_id, row.created_at)
  let lastId = null
  const scan = find ?? (async at => { const result = scanOwnedOpenWork(sessionDbPath, { now: at, afterId: lastId }); lastId = result.lastId; return result.evidence })
  const evidenceFor = sessionId => {
    if (!candidates.has(sessionId)) return null
    if (now()/1000 - candidates.get(sessionId) > MAX_AGE) { candidates.delete(sessionId); return null }
    const evidence = read(sessionId)
    if (!evidence) {
      // The admitted continuation is running: keep the previous green status hidden until
      // its own reply lands (then that reply is evaluated, as a continuation, on its own).
      const pending = db.prepare("SELECT 1 FROM owned_work_claims WHERE session_id=? AND state IN ('claimed','admitted') AND created_at>=? LIMIT 1")
        .get(sessionId, now()/1000 - 15 * 60)
      return pending ? { agentId: 'hermes', sessionId, ownedCount: 1, handleCount: 0, continuation: false } : null
    }
    if (!evidence.status) return null
    // A known admission failure or expired authority stops the spinner without
    // pretending that a follow-up is running, and never grants a fresh retry.
    const claim = claimFor(evidence)
    return { ...evidence, continuation: evidence.continuation || Boolean(claim && claim.state === 'failed')
      || now()/1000-evidence.at > MAX_AGE }
  }
  let ticking = false, stopped = false
  const tick = async () => {
    if (ticking || stopped) return
    ticking = true
    try {
      const found = await scan(now())
      for (const evidence of found) if (evidence?.sessionId && evidence.items?.length) candidates.set(evidence.sessionId, now()/1000)
      // Flagged threads that were busy (or otherwise skipped) on an earlier scan are re-read
      // each tick until claimed or aged out; the incremental scan alone would never revisit them.
      const seen = new Set(found.map(evidence => evidence?.sessionId))
      for (const [sessionId, at] of candidates) {
        if (seen.has(sessionId) || now()/1000 - at > MAX_AGE) continue
        const evidence = read(sessionId)
        if (evidence && !claimFor(evidence)) found.push(evidence)
      }
      for (const evidence of found) {
        if (stopped) break
        if (evidence.agentId !== 'hermes' || evidence.continuation || !evidence.items?.length
          || guardOwnedOpenWork(evidence.status, evidence) === evidence.status || claimFor(evidence)
          || await busy(evidence.sessionId)) continue
        const token = { kind: OWNED_WORK_KIND, agent_id: 'hermes', session_id: evidence.sessionId,
          sessionId: evidence.sessionId, runId: evidence.runId, messageId: evidence.messageId,
          userId: evidence.userId, fingerprint: evidence.fingerprint }
        try { await validate(token) } catch { continue }
        // Commit the per-run AND per-reply witness BEFORE sending. The queue's
        // stable key reconciles a transport retry; restart never creates a new turn.
        const claimed = db.prepare('INSERT OR IGNORE INTO owned_work_claims VALUES(?,?,?,?,?,?)')
          .run(evidence.sessionId, evidence.runId, evidence.messageId, evidence.fingerprint, 'claimed', now()/1000)
        if (!claimed.changes) continue
        const key = `wizard-owned-work-${digest(`${evidence.sessionId}\0${evidence.runId}`).slice(0, 40)}`
        const input = `${OWNED_WORK_PREFIX}\n${evidence.items.map(item => `- ${item}`).join('\n')}\nStart each one now within existing authority (wizard_schedule, wizard_heavy_submit, delegate_task or kanban_create), then end with an updated finish report naming each handle and when it lands. Do not widen authority: ask for owner decisions, money or external sends. If an item actually needs the owner, say so and mark it needs_you. This is the only automatic correction; do not offer the same work again.`
        try {
          await admit(evidence.sessionId, input, key, token)
          db.prepare("UPDATE owned_work_claims SET state='admitted' WHERE session_id=? AND run_id=?").run(evidence.sessionId, evidence.runId)
        } catch (error) {
          db.prepare("UPDATE owned_work_claims SET state='failed' WHERE session_id=? AND run_id=?").run(evidence.sessionId, evidence.runId)
          log(`admission failed: ${error?.status ?? 'unavailable'}`)
        }
      }
    } catch (error) { log(`scan failed: ${error?.message ?? error}`) } finally { ticking = false }
  }
  return { evidenceFor, tick,
    requireCurrent: token => {
      const record = claimFor(token)
      if (!record || record.fingerprint !== token.fingerprint || record.state === 'failed') throw Object.assign(new Error('Unknown owned follow-up'), { status: 410 })
      return validate(token)
    },
    stop: () => { stopped = true },
    close: () => { stopped = true; db.close() },
  }
}
