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
import { dispatchHandles, countDispatchHandles, ownedOpenItems, guardOwnedOpenWork, claimsExistingHandle, nonHoldingFollowUpIds } from './owned-open-work.mjs'
import { isHumanRequest, retainedMessagesWhere } from './delegation-receipts.mjs'

export const OWNED_WORK_KIND = 'owned-open-work'
export const ownedWorkStatePathOf = options => options.followThrough === false || options.ownedOpenWork === false ? ''
  : options.ownedOpenWorkStatePath || (options.runQueueStatePath ? `${options.runQueueStatePath}.owned-open-work.db`
    : options.hermesStatePath ? `${options.hermesStatePath}.wizard-owned-open-work.db` : '')
export const OWNED_WORK_PREFIX = '[Wizard follow-through] Your last reply lists follow-up work you own under Still open without starting it:'
const digest = text => createHash('sha256').update(text).digest('hex')
const hidden = new Set(['commentary', 'hidden', 'system', 'internal_notification', 'async_delegation_complete'])
const MAX_ROWS = 10_000
const MAX_AGE = 2 * 3600
const CLAIM_GRACE = 120

export function readOwnedOpenWork(path, sessionId) {
  if (!path || !sessionId) return null
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
    db.exec('BEGIN')
    const cols = new Set(db.prepare('PRAGMA table_info(messages)').all().map(row => row.name))
    if (!['id', 'session_id', 'role', 'content', 'tool_calls', 'tool_call_id', 'timestamp'].every(key => cols.has(key))) return null
    const retained = `AND ${retainedMessagesWhere(cols)}`
    const active = cols.has('active') ? 'AND COALESCE(active,1)=1' : ''
    const latest = db.prepare(`SELECT * FROM messages WHERE session_id=? AND role IN ('user','assistant') ${active} ORDER BY id DESC LIMIT 100`).all(sessionId)
      .find(row => !hidden.has(row.display_kind) && String(row.content ?? '').trim())
    if (!latest || latest.role !== 'assistant' || latest.tool_calls && latest.tool_calls !== '[]' && latest.tool_calls !== 'null') return null
    // Machine wakeups, reporter rewrites and compaction must not renew nudge authority.
    // Keep retained rows: compaction changes context, not the owner request chain.
    const users = db.prepare(`SELECT * FROM messages WHERE session_id=? AND role='user' AND id<? ${retained} ORDER BY id DESC LIMIT 513`).all(sessionId, latest.id)
    const user = users.find(row => !/^\s*\[(?:reporter|CONTEXT COMPACTION|CONTEXT SUMMARY|PRIOR CONTEXT)/u.test(String(row.content ?? '')))
    const owner = users.find(row => isHumanRequest(row) && !String(row.content ?? '').startsWith('[reporter]'))
    if (!user || !owner) return null // machine-only chains have no owner authority
    const continuation = users.some(row => row.id >= owner.id && String(row.content ?? '').startsWith(OWNED_WORK_PREFIX))
    const items = ownedOpenItems(latest.content)
    const rows = items.length ? db.prepare(`SELECT * FROM messages WHERE session_id=? AND id>? AND id<=? ${retained} ORDER BY id LIMIT ?`).all(sessionId, user.id, latest.id, MAX_ROWS + 1) : []
    if (rows.length > MAX_ROWS) return null // incomplete tool evidence is not zero handles
    const claimed = items.filter(claimsExistingHandle).length
    // Earlier turns of this thread (bounded): real handles that a restated item may point to.
    const prior = claimed ? countDispatchHandles(db.prepare(`SELECT * FROM messages WHERE session_id=? AND id<=? ${retained} ORDER BY id DESC LIMIT 2000`).all(sessionId, user.id)) : 0
    const handles = dispatchHandles(rows)
    const handleCount = handles.length + Math.min(Math.max(0, claimed - handles.length), prior)
    return { agentId: 'hermes', sessionId, runId: String(user.message_uid || user.id), chainId: String(owner.message_uid || owner.id), messageId: String(latest.message_uid || latest.id),
      userId: Number(user.id), replyId: Number(latest.id), fingerprint: digest(latest.content), at: Number(latest.timestamp),
      status: parseStatus(latest.content), items, ownedCount: items.length, handleCount,
      followUpIds: nonHoldingFollowUpIds(latest.content, parseStatus(latest.content), handles),
      continuation }

  } catch { return null } finally { db?.close() }
}

export const readNonHoldingFollowUps = (path, sessionId) => new Set(readOwnedOpenWork(path, sessionId)?.followUpIds ?? [])

// Rowid-range scan only: state.db holds millions of rows, so a time/content predicate
// over the whole table is a full scan. Callers pass the previous high-water id; the
// first scan starts a bounded window behind the newest row (ids are monotonic).
export const OWNED_SCAN_WINDOW = 20_000
/** @param {string} path @param {{now?: number, afterId?: number|null}} [options] */
export function scanOwnedOpenWork(path, { now = Date.now(), afterId = null } = {}) {
  if (!path) return { evidence: [], lastId: afterId }
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const top = Number(db.prepare('SELECT MAX(id) AS id FROM messages').get()?.id ?? 0)
    const from = afterId == null ? Math.max(0, top - OWNED_SCAN_WINDOW) : Math.min(afterId, top)
    // Page matching rows in primary-key order, with one unprocessed sentinel.
    // DISTINCT hides the boundary id; jumping to top loses every later session.
    const rows = db.prepare(`SELECT id, session_id FROM messages WHERE id>? AND id<=? AND role='assistant'
      AND timestamp>=? AND instr(lower(content),'still open:')>0 ORDER BY id LIMIT 201`).all(from, top, now/1000 - MAX_AGE)
    const page = rows.slice(0, 200)
    const lastId = rows.length > 200 ? Number(page.at(-1).id) : top
    db.close(); db = null
    const sessions = new Set(page.map(row => row.session_id).filter(id => /^(?:wizard_|wizard-assistant-)/u.test(id)))
    const evidence = [...sessions].map(id => readOwnedOpenWork(path, id)).filter(Boolean)
    return { evidence, lastId }
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
  if (!db.prepare('PRAGMA table_info(owned_work_claims)').all().some(row => row.name === 'chain_id')) db.exec('ALTER TABLE owned_work_claims ADD COLUMN chain_id TEXT')
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS owned_work_chain ON owned_work_claims(session_id,chain_id)')
  const claimFor = evidence => db.prepare('SELECT * FROM owned_work_claims WHERE session_id=? AND (run_id=? OR reply_id=? OR chain_id=?)')
    .get(evidence.sessionId, evidence.runId, evidence.messageId, evidence.chainId ?? evidence.runId)
  const canClaim = evidence => {
    const claim = claimFor(evidence)
    // Only reconcile an interrupted admission of this exact witness, never a
    // rewritten reply or another machine turn in an already-claimed owner chain.
    return !claim || claim.state === 'claimed' && claim.created_at < now()/1000 - CLAIM_GRACE
      && claim.run_id === evidence.runId && claim.reply_id === evidence.messageId && claim.fingerprint === evidence.fingerprint
  }
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
      // A fresh claim may be admitting; an admitted continuation may be running.
      // Stale claimed rows need recovery, not a fabricated running continuation.
      const pending = db.prepare(`SELECT 1 FROM owned_work_claims WHERE session_id=? AND
        ((state='claimed' AND created_at>=?) OR (state='admitted' AND created_at>=?)) LIMIT 1`)
        .get(sessionId, now()/1000 - CLAIM_GRACE, now()/1000 - 15 * 60)
      return pending ? { agentId: 'hermes', sessionId, ownedCount: 1, handleCount: 0, continuation: false } : null
    }
    if (!evidence.status) return null
    // A known admission failure or expired authority stops the spinner without
    // pretending that a follow-up is running, and never grants a fresh retry.
    const claim = claimFor(evidence)
    return { ...evidence, continuation: evidence.continuation || Boolean(claim && (claim.state === 'failed' || claim.reply_id !== evidence.messageId))
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
      // each tick until admitted/failed or aged out, including stale interrupted claims.
      const seen = new Set(found.map(evidence => evidence?.sessionId))
      for (const [sessionId, at] of candidates) {
        if (seen.has(sessionId) || now()/1000 - at > MAX_AGE) continue
        const evidence = read(sessionId)
        if (evidence && canClaim(evidence)) found.push(evidence)
      }
      for (const evidence of found) {
        if (stopped) break
        if (evidence.agentId !== 'hermes' || evidence.continuation || !evidence.items?.length
          || guardOwnedOpenWork(evidence.status, evidence) === evidence.status || !canClaim(evidence)
          || await busy(evidence.sessionId)) continue
        const token = { kind: OWNED_WORK_KIND, agent_id: 'hermes', session_id: evidence.sessionId,
          sessionId: evidence.sessionId, runId: evidence.runId, chainId: evidence.chainId ?? evidence.runId, messageId: evidence.messageId,
          userId: evidence.userId, fingerprint: evidence.fingerprint }
        try { await validate(token) } catch { continue }
        // Persist before sending. Reclaim the same interrupted witness atomically,
        // refreshing its grace period so concurrent controllers cannot both retry.
        // The unchanged stable queue key reconciles a crash after queue admission.
        const at = now()/1000
        const claimed = claimFor(evidence)
          ? db.prepare(`UPDATE owned_work_claims SET created_at=? WHERE session_id=? AND run_id=? AND reply_id=?
              AND fingerprint=? AND state='claimed' AND created_at<?`)
            .run(at, evidence.sessionId, evidence.runId, evidence.messageId, evidence.fingerprint, at - CLAIM_GRACE)
          : db.prepare('INSERT OR IGNORE INTO owned_work_claims(session_id,run_id,reply_id,fingerprint,state,created_at,chain_id) VALUES(?,?,?,?,?,?,?)')
            .run(evidence.sessionId, evidence.runId, evidence.messageId, evidence.fingerprint, 'claimed', at, evidence.chainId ?? evidence.runId)
        if (!claimed.changes) continue
        const key = `wizard-owned-work-${digest(`${evidence.sessionId}\0${evidence.runId}`).slice(0, 40)}`
        const input = `${OWNED_WORK_PREFIX}\n${evidence.items.map(item => `- ${item}`).join('\n')}\nResolve each item plainly: either start it within existing authority (wizard_schedule, wizard_heavy_submit, delegate_task or kanban_create) and name its handle and when it lands, or ask the owner one clear question about starting it. Do not widen authority: ask for owner decisions, money or external sends. A verified requested outcome remains done even with started optional follow-ups. This is the only automatic correction in this owner request chain; do not leave ambiguous offers.`
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
