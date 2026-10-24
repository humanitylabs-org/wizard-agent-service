import { existsSync } from 'node:fs'
import { isSilentResult, SCHEDULE_INPUT } from './scheduler.mjs'
import { DatabaseSync } from 'node:sqlite'
import { readUndeliveredHelperReceipts, completionDelegationId, receiptConsumed, ownerGate } from './delegation-receipts.mjs'
import { parseStatus, replyAppId } from './thread-status.mjs'
import { hasAppToolCalls } from './thread-app-provenance.mjs'

const USER_EVENT_KINDS = new Set(['async_delegation_complete', 'internal_notification', 'system'])
const INTERNAL_ASSISTANT_KINDS = new Set([...USER_EVENT_KINDS, 'commentary', 'hidden'])
// Recovery requests for an interrupted Helm card arrive as a user turn that starts with this marker; the
// thread hides it. History written before markers were neutral carries the legacy wording (recognized only,
// never emitted).
export const RECOVERY_REQUEST_MARKER = '[Owner requested recovery of this interrupted Helm card.]'
export const LEGACY_RECOVERY_REQUEST_MARKER = '[James requested recovery of this interrupted Helm card.]'
const INTERNAL_USER_PREFIXES = [
  SCHEDULE_INPUT,
  '[System: Your previous response contained only internal reasoning and never produced a ',
  '[System: Continue now. Execute the required tool calls ',
  '[System: The previous response was cut off by a network error mid-stream.',
  '[System: Your previous response was truncated by the output length limit.',
  'Your previous turn indicated a tool call but none was included.',
  'You just executed tool calls but returned an empty response.',
  '[IMPORTANT: Background process ',
  '[ASYNC DELEGATION BATCH COMPLETE',
  '[Wizard follow-through]',
  '[CONTEXT COMPACTION — REFERENCE ONLY]',
  '[CONTEXT SUMMARY]:',
  '[PRIOR CONTEXT — for reference only; not a new message]',
  '[Your active task list was preserved across context compression]',
  '[Your previous agent loop was paused',
  RECOVERY_REQUEST_MARKER,
  LEGACY_RECOVERY_REQUEST_MARKER,
  '[STILL IN PROGRESS',
  'Workline browser QA found a concrete regression in ',
]
const EMPTY_TOOL_RESPONSE_NUDGE = 'You just executed tool calls but returned an empty response. Please process the tool results above and continue with the task.'

function boundedIds(values, limit = 200) {
  return [...new Set(values.filter((value) => typeof value === 'string' && /^[A-Za-z0-9._:-]+$/.test(value)).slice(0, limit))]
}

function openReadOnly(path) {
  if (!path || !existsSync(path)) return null
  try { return new DatabaseSync(path, { readOnly: true }) }
  catch { return null }
}

export function visibleUserRequest(content, displayKind) {
  const text = typeof content === 'string' ? content.trim() : ''
  const kind = String(displayKind || '')
  if (!text || text === EMPTY_TOOL_RESPONSE_NUDGE || USER_EVENT_KINDS.has(kind) || kind.startsWith('process_wakeup')) return false
  return !/^\[IMPORTANT: \d+ background processes completed for this session\./.test(text) && !INTERNAL_USER_PREFIXES.some((prefix) => text.startsWith(prefix))
}

export function visibleAssistantReply(content, displayKind, finishReason) {
  const text = typeof content === 'string' ? content.trim() : ''
  const kind = String(displayKind || '')
  const completion = String(finishReason || '')
  const completed = kind === 'final' || Boolean(completion && !['tool_calls', 'function_call', 'cancelled', 'interrupted', 'error'].includes(completion))
  if (isSilentResult(text)) return false
  if (!text || text === '(empty)' || !completed || INTERNAL_ASSISTANT_KINDS.has(kind) || kind.startsWith('process_wakeup')) return false
  return !/^\[IMPORTANT: \d+ background processes completed for this session\./.test(text) && !INTERNAL_USER_PREFIXES.some((prefix) => text.startsWith(prefix))
}

// Script publishers append canonical assistant reports with metadata, but without
// model finish_reason/display_kind. Only explicit publisher metadata qualifies;
// keep existing activity/attention semantics unchanged and reject internal/tool rows.
function visibleProvenanceReply(row) {
  if (row.role !== 'assistant' || hasAppToolCalls(row)) return false
  if (visibleAssistantReply(row.content, row.display_kind, row.finish_reason)) return true
  const kind = String(row.display_kind || ''), finish = String(row.finish_reason || '')
  const text = typeof row.content === 'string' ? row.content.trim() : ''
  if (isSilentResult(text)) return false
  if (!text || text === '(empty)' || INTERNAL_ASSISTANT_KINDS.has(kind) || kind.startsWith('process_wakeup')
    || ['tool_calls', 'function_call', 'cancelled', 'interrupted', 'error'].includes(finish)
    || INTERNAL_USER_PREFIXES.some(prefix => text.startsWith(prefix))) return false
  let meta = row.display_metadata
  if (typeof meta === 'string') { try { meta = JSON.parse(meta) } catch { return false } }
  return !!meta && typeof meta === 'object' && !Array.isArray(meta)
    && (Object.hasOwn(meta, 'app_id') || (typeof meta.report_id === 'string' && meta.report_id.trim().length > 0))
}

const ROUTE_PART = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}(?:\[[0-9a-z]{1,8}\])?(?![\s\S])/

function lockedRoute(modelConfig) {
  if (typeof modelConfig !== 'string' || !modelConfig) return null
  try {
    const lock = JSON.parse(modelConfig)?.browser_model_lock
    const model = typeof lock?.model === 'string' ? lock.model : ''
    const provider = typeof lock?.provider === 'string' ? lock.provider : ''
    return ROUTE_PART.test(model) && ROUTE_PART.test(provider) ? { model, provider, updatedAt: Number(lock.updated_at) || 0 } : null
  } catch { return null }
}

// The trigram index is complete only when it exists and no FTS rebuild is mid-way
// (Hermes records rebuild progress in state_meta while backfilling).
function trigramIndexReady(db) {
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'messages_fts_trigram'").get()) return false
    const meta = db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'state_meta'").get()
    return !meta || !db.prepare("SELECT 1 FROM state_meta WHERE key IN ('fts_rebuild_high_water','fts_rebuild_progress')").get()
  } catch { return false }
}

// Search only caller-approved session IDs in this runtime, with the same visibility rules
// as the list truth reader. Never discover agents or open their stores here.
export function searchHermesSessionText(path, sessionIds, query) {
  const ids = boundedIds(sessionIds), hits = new Map();
  const words = String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!ids.length || !words.length) return hits;
  const db = openReadOnly(path); if (!db) return hits;
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(x=>x.name));
    const optional = name => columns.has(name) ? name : `NULL AS ${name}`;
    const accept = row => {
      if (hits.has(row.session_id)) return;
      const visible = row.role === 'user' ? visibleUserRequest(row.content,row.display_kind) : visibleAssistantReply(row.content,row.display_kind,row.finish_reason);
      if (visible && words.every(w=>row.content.toLowerCase().includes(w))) hits.set(row.session_id,row.content);
    };
    // Fast path: Hermes keeps a trigram FTS index over every non-tool message. Scanning
    // content with instr() reads the whole (multi-GB) store and blew the search deadline,
    // so Chats search spun forever. The index narrows to candidate rows; each session then
    // reads only its newest candidates. The JS check above stays the authority.
    const indexed = trigramIndexReady(db) ? words.filter(w => w.length >= 3 && /^[\x00-\x7f]+$/.test(w)) : [];
    if (indexed.length) try {
      db.exec('CREATE TEMP TABLE IF NOT EXISTS wizard_search_hits (id INTEGER PRIMARY KEY); DELETE FROM temp.wizard_search_hits');
      db.prepare('INSERT INTO temp.wizard_search_hits SELECT rowid FROM messages_fts_trigram WHERE messages_fts_trigram MATCH ?')
        .run(indexed.map(w => `"${w.replace(/"/g, '""')}"`).join(' AND '));
      const perSession = db.prepare(`SELECT session_id, role, content, ${optional('display_kind')}, ${optional('finish_reason')} FROM messages WHERE session_id = ? AND id IN (SELECT id FROM temp.wizard_search_hits) AND role IN ('user','assistant') AND content IS NOT NULL ORDER BY timestamp DESC`);
      for (const id of ids) for (const row of perSession.iterate(id)) { accept(row); if (hits.has(id)) break; }
      return hits;
    } catch { hits.clear() /* fall back to the content scan below */ }
    // Let SQLite drop non-matching messages before they become JS strings (the costly part):
    // instr(lower()) folds ASCII only, so it prefilters only ASCII words; the JS check below
    // stays the authority.
    const ascii = words.filter(w => /^[\x00-\x7f]+$/.test(w));
    const prefilter = ascii.map(() => ' AND instr(lower(content), ?) > 0').join('');
    const sql = `SELECT session_id, role, content, ${optional('display_kind')}, ${optional('finish_reason')} FROM messages WHERE session_id IN (${ids.map(()=>'?').join(',')}) AND role IN ('user','assistant') AND content IS NOT NULL${prefilter} ORDER BY timestamp DESC`;
    for (const row of db.prepare(sql).iterate(...ids, ...ascii)) accept(row);
  } catch { /* old stores retain title/request search */ } finally { db.close(); }
  return hits;
}

export function readHermesSessionTruth(path, sessionIds, nowSeconds = Date.now() / 1000) {
  const ids = boundedIds(sessionIds)
  const truth = new Map()
  if (!ids.length) return truth
  const db = openReadOnly(path)
  if (!db) return truth
  try {
    const placeholders = ids.map(() => '?').join(',')
    const sessionRows = db.prepare(`SELECT id, started_at FROM sessions WHERE id IN (${placeholders})`).all(...ids)
    for (const row of sessionRows) truth.set(String(row.id), {
      startedAt: Number.isFinite(Number(row.started_at)) ? Number(row.started_at) : 0,
      lastUserAt: 0,
      lastAssistantAt: 0,
      activityAt: 0,
      requestPreview: '',
      active: false,
    })
    // Hermes' session API omits provider. A thread's exact model lock is the only
    // trustworthy route; billing_provider can name a different account.
    try {
      const routeRows = db.prepare(`SELECT id, model, model_config FROM sessions WHERE id IN (${placeholders})`).all(...ids)
      for (const row of routeRows) {
        const current = truth.get(String(row.id))
        const lock = lockedRoute(row.model_config)
        if (current && lock && lock.model === row.model) {
          current.route = { model: lock.model, provider: lock.provider }
          current.routeUpdatedAt = lock.updatedAt
        }
      }
    } catch { /* older state schemas carry no model lock */ }
    // Seek newest-first within each session's existing indexed range. Loading
    // every historical body for a whole Work page blocks the shared HTTP loop;
    // only the newest visible request and completed reply determine this view.
    const messageColumns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(row => row.name))
    const metadataColumn = messageColumns.has('display_metadata') ? 'display_metadata' : 'NULL AS display_metadata'
    const toolsColumn = messageColumns.has('tool_calls') ? 'tool_calls' : 'NULL AS tool_calls'
    // Real Hermes tables have rowid for equal-timestamp arrival order. A view may
    // not; do not force a sort/materialization of old bodies in that fallback.
    const messageTable = db.prepare("SELECT type, sql FROM sqlite_schema WHERE name = 'messages'").get()
    const tieOrder = messageTable?.type === 'table' && !/WITHOUT ROWID/iu.test(messageTable.sql || '') ? ', rowid DESC' : ''
    const recentMessages = db.prepare(`
      SELECT role, finish_reason, timestamp, content, display_kind, ${metadataColumn}, ${toolsColumn}
      FROM messages
      WHERE session_id = ?
        AND role IN ('user', 'assistant')
        AND active = 1
        AND trim(COALESCE(content, '')) <> ''
      ORDER BY timestamp DESC${tieOrder}
    `)
    const sessionColumns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map(row => row.name))
    const hasLineage = ['parent_session_id', 'end_reason', 'source', 'model_config'].every(column => sessionColumns.has(column))
    const lineageParent = hasLineage ? db.prepare('SELECT end_reason FROM sessions WHERE id = ?') : null
    const lineageChildren = hasLineage ? db.prepare('SELECT id, source, model_config FROM sessions WHERE parent_session_id = ?') : null
    const provenanceTip = (id) => {
      if (!hasLineage) return id
      const seen = new Set()
      for (let depth = 0; depth < 1000; depth++) {
        if (seen.has(id)) return null
        seen.add(id)
        if (lineageParent.get(id)?.end_reason !== 'compression') return id
        const children = lineageChildren.all(id).filter(child => {
          if (child.source === 'tool') return false
          let config = {}
          try { config = JSON.parse(child.model_config || '{}') } catch { return false }
          // Fork markers inherited from an older ancestor are not forks of this parent.
          return !['_branched_from', '_delegate_from', '_reset_from'].some(marker => config?.[marker] === id)
        })
        // Ambiguous/missing continuation fails closed, never reuse a stale ancestor icon.
        if (children.length !== 1) return null
        id = children[0].id
      }
      return null
    }
    for (const [id, current] of truth) {
      let latestVisibleRole = null, provenanceAt = 0
      for (const row of recentMessages.iterate(id)) {
        const timestamp = Number(row.timestamp) || 0
        const visibleUser = row.role === 'user' && visibleUserRequest(row.content, row.display_kind)
        const visibleAssistant = row.role === 'assistant' && visibleAssistantReply(row.content, row.display_kind, row.finish_reason)
        const provenanceAssistant = visibleProvenanceReply(row)
        if (!provenanceAt && (visibleUser || provenanceAssistant)) {
          provenanceAt = timestamp
          if (provenanceAssistant) current.appId = replyAppId(row.content, row.display_metadata)
        }
        if (!latestVisibleRole && (visibleUser || visibleAssistant)) latestVisibleRole = row.role
        if (!current.activityAt && (visibleUser || visibleAssistant)) current.activityAt = timestamp
        if (!current.lastUserAt && visibleUser) {
          current.lastUserAt = timestamp
          current.requestPreview = row.content.trim()
        }
        if (!current.lastAssistantAt && visibleAssistant) {
          current.lastAssistantAt = timestamp
          // The agent's own status line on its latest reply, while no newer request follows it.
          // Lets the list show it for threads past the history-read preview window.
          if (latestVisibleRole === 'assistant') {
            const status = parseStatus(row.content)
            if (status) current.status = status
          }
        }
        if (current.lastUserAt && current.lastAssistantAt) break
      }
      // Provenance alone follows compression. Leave existing status/activity semantics intact.
      const tip = provenanceTip(id)
      if (tip !== id) {
        const rootAppId = current.appId
        delete current.appId
        if (tip) for (const row of recentMessages.iterate(tip)) {
          const user = row.role === 'user' && visibleUserRequest(row.content, row.display_kind)
          const assistant = visibleProvenanceReply(row)
          if (!user && !assistant) continue
          // An explicit publisher can append a newer report to the root; prefer it
          // over older tip history, but never resurrect root work after a newer tip user.
          if (provenanceAt > Number(row.timestamp)) current.appId = rootAppId
          else if (assistant) current.appId = replyAppId(row.content, row.display_metadata)
          break
        }
      }
    }
    // Helpers the agent dispatched in the background (stock Hermes delegate_task). While one runs, or its
    // result is saved but the agent has not answered yet, the thread is still working for the owner: the
    // "I've delegated this" reply is progress, not something to act on. Capped at 6 h so a lost helper
    // cannot pin a thread in Working forever.
    try {
      const helperRows = db.prepare(`
        SELECT origin_session_id AS id, COUNT(*) AS n
        FROM async_delegations
        WHERE state IN ('running', 'stalling', 'finalizing') AND dispatched_at > ?
          AND origin_session_id IN (${placeholders})
        GROUP BY origin_session_id
      `).all(nowSeconds - 6 * 3600, ...ids)
      for (const row of helperRows) {
        const current = truth.get(String(row.id || ''))
        if (current && !ownerGate(db, String(row.id))) current.helpersRunning = Number(row.n) || 0
      }
    } catch { /* agents without background delegation */ }
    // Completion can precede the parent's handoff, and failed delivery leaves no message at all.
    // Read delivery receipts independently of the latest transcript row and execution state.
    for (const receipt of readUndeliveredHelperReceipts(path, { now: nowSeconds * 1000 })) {
      const current = truth.get(receipt.sessionId)
      if (current) current.helperResultUnanswered = true
    }
    try {
      const newestRow = db.prepare(`
        SELECT role, content, timestamp FROM messages
        WHERE session_id = ? AND active = 1
        ORDER BY timestamp DESC LIMIT 1
      `)
      for (const [id, current] of truth) {
        const row = newestRow.get(id)
        const delegationId = completionDelegationId(row?.content)
        if (row?.role === 'user' && typeof row.content === 'string' && row.content.startsWith('[ASYNC DELEGATION BATCH COMPLETE')
          && Number(row.timestamp) > nowSeconds - 6 * 3600 && !ownerGate(db, id)
          && !(delegationId && receiptConsumed(db, id, delegationId))) current.helperResultUnanswered = true
      }
    } catch { /* unreadable newest row: no helper wait */ }
    const leaseRows = db.prepare(`
      SELECT conversation_id
      FROM session_turn_leases
      WHERE expires_at > ? AND conversation_id IN (${placeholders})
    `).all(nowSeconds, ...ids)
    for (const row of leaseRows) {
      const current = truth.get(String(row.conversation_id || ''))
      if (current) current.active = true
    }
  } catch {
    return new Map()
  } finally {
    try { db.close() } catch { /* read-only cleanup */ }
  }
  return truth
}

export function readHelmActivitySessionIds(path, activityIds) {
  const ids = boundedIds(activityIds)
  const sessions = new Map()
  if (!ids.length) return sessions
  const db = openReadOnly(path)
  if (!db) return sessions
  try {
    const placeholders = ids.map(() => '?').join(',')
    const rows = db.prepare(`SELECT activity_id, session_id FROM activities WHERE activity_id IN (${placeholders})`).all(...ids)
    for (const row of rows) {
      const sessionId = String(row.session_id || '')
      if (sessionId) sessions.set(String(row.activity_id), sessionId)
    }
  } catch {
    return new Map()
  } finally {
    try { db.close() } catch { /* read-only cleanup */ }
  }
  return sessions
}

const PENDING_ASSISTANT_ADMISSION_SECONDS = 120

export function readWizardAssistantRunReferences(path, sessionIds, nowSeconds = Date.now() / 1000, boundWindowSeconds = Number.POSITIVE_INFINITY) {
  const ids = boundedIds(sessionIds)
  const latestBySession = new Map()
  const seenSessions = new Set()
  if (!ids.length) return []
  const db = openReadOnly(path)
  if (!db) return []
  try {
    const placeholders = ids.map(() => '?').join(',')
    const rows = db.prepare(`
      SELECT session_id, run_id, admission_status, created_at
      FROM assistant_requests
      WHERE session_id IN (${placeholders})
      ORDER BY updated_at DESC, created_at DESC, rowid DESC
    `).all(...ids)
    for (const row of rows) {
      const sessionId = String(row.session_id || '')
      if (!sessionId || seenSessions.has(sessionId)) continue
      seenSessions.add(sessionId)
      const runId = typeof row.run_id === 'string' ? row.run_id : ''
      const createdAt = Number(row.created_at) || 0
      const boundIsRecent = createdAt >= nowSeconds - boundWindowSeconds && createdAt <= nowSeconds + 5
      if (/^[A-Za-z0-9._:-]+$/.test(runId) && boundIsRecent) {
        latestBySession.set(sessionId, { sessionId, runId, createdAt })
        continue
      }
      if (row.run_id === null && row.admission_status === null
        && createdAt >= nowSeconds - PENDING_ASSISTANT_ADMISSION_SECONDS && createdAt <= nowSeconds + 5) {
        latestBySession.set(sessionId, { sessionId, runId: '', status: 'running', createdAt })
      }
    }
  } catch {
    return []
  } finally {
    try { db.close() } catch { /* read-only cleanup */ }
  }
  return [...latestBySession.values()]
}

export function readWizardAssistantRevision(path) {
  const db = openReadOnly(path)
  if (!db) return ''
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(run_id IS NULL), 0) AS pending,
             COALESCE(MAX(rowid), 0) AS latest_id,
             COALESCE(MAX(updated_at), 0) AS latest_update
      FROM assistant_requests
    `).get()
    return [row.total, row.pending, row.latest_id, row.latest_update].map((value) => Number(value) || 0).join(':')
  } catch {
    return ''
  } finally {
    try { db.close() } catch { /* read-only cleanup */ }
  }
}

export function readPendingWizardAssistantAdmissions(path, sessionIds, nowSeconds = Date.now() / 1000) {
  const ids = boundedIds(sessionIds)
  const seenSessions = new Set()
  const pending = []
  if (!ids.length) return []
  const db = openReadOnly(path)
  if (!db) return []
  try {
    const placeholders = ids.map(() => '?').join(',')
    const rows = db.prepare(`
      SELECT session_id, run_id, admission_status, created_at
      FROM assistant_requests
      WHERE session_id IN (${placeholders})
      ORDER BY updated_at DESC, created_at DESC, rowid DESC
    `).all(...ids)
    for (const row of rows) {
      const sessionId = String(row.session_id || '')
      if (!sessionId || seenSessions.has(sessionId)) continue
      seenSessions.add(sessionId)
      const createdAt = Number(row.created_at) || 0
      if (row.run_id === null && row.admission_status === null
        && createdAt >= nowSeconds - PENDING_ASSISTANT_ADMISSION_SECONDS && createdAt <= nowSeconds + 5) {
        pending.push({ sessionId, runId: '', status: 'running' })
      }
    }
    return pending
  } catch {
    return []
  } finally {
    try { db.close() } catch { /* read-only cleanup */ }
  }
}

// ---- Chats list cache signals (session-list-cache.mjs). Both readers fail open: null/undefined
// tells the caller to rebuild everything, never to trust a cached row.

/** Cheap revision of the Hermes state that can change a projected thread row. */
export function readHermesListRevision(path) {
  const db = openReadOnly(path)
  if (!db) return null
  try {
    const parts = []
    const sessions = db.prepare('SELECT COUNT(*) AS n, MAX(COALESCE(last_activity_at, started_at)) AS at, MAX(message_count) AS m FROM sessions').get()
    parts.push(sessions.n, sessions.at, sessions.m)
    parts.push(db.prepare('SELECT MAX(rowid) AS id FROM messages').get().id)
    for (const sql of [
      'SELECT COUNT(*) AS n, MAX(expires_at) AS at FROM session_turn_leases',
      'SELECT COUNT(*) AS n, MAX(rowid) AS id, SUM(state IN (\'running\', \'stalling\', \'finalizing\')) AS live FROM async_delegations',
    ]) {
      try { parts.push(...Object.values(db.prepare(sql).get())) } catch { parts.push('-') }
    }
    return parts.map((value) => String(value ?? '')).join(':')
  } catch {
    return null
  } finally {
    try { db.close() } catch { /* read-only cleanup */ }
  }
}

function lineageRoots(db, ids) {
  const parentOf = db.prepare('SELECT parent_session_id FROM sessions WHERE id = ?')
  const parents = new Map()
  const roots = new Set()
  for (const start of ids) {
    let id = String(start)
    const seen = new Set()
    for (let depth = 0; depth < 1000 && !seen.has(id); depth++) {
      seen.add(id)
      roots.add(id)
      let parent = parents.get(id)
      if (parent === undefined) {
        parent = parentOf.get(id)?.parent_session_id
        parent = parent ? String(parent) : ''
        parents.set(id, parent)
      }
      if (!parent) break
      id = parent
    }
  }
  return roots
}

/**
 * Thread ids (every lineage ancestor) with Hermes activity since `sinceSeconds`. A compression tip
 * or a helper child counts for the thread it descends from, so its root is re-projected.
 */
export function readRecentHermesRootIds(path, sinceSeconds) {
  const db = openReadOnly(path)
  if (!db) return null
  try {
    const recent = db.prepare('SELECT id FROM sessions WHERE COALESCE(last_activity_at, started_at) >= ?').all(Number(sinceSeconds))
    return lineageRoots(db, recent.map((row) => row.id))
  } catch {
    return null
  } finally {
    try { db.close() } catch { /* read-only cleanup */ }
  }
}

/**
 * Threads (with lineage ancestors) that received Hermes messages after message `afterId`.
 * `roots` is null when the delta is unknown or too large to trust: the caller rebuilds everything.
 */
export function readHermesMessageDelta(path, afterId, maxRows = 20_000) {
  const db = openReadOnly(path)
  if (!db) return null
  try {
    const maxId = Number(db.prepare('SELECT MAX(id) AS id FROM messages').get().id ?? 0)
    if (!Number.isFinite(afterId) || afterId > maxId || maxId - afterId > maxRows) return { maxId, roots: null }
    // Walk the primary key range; DISTINCT/GROUP BY here makes SQLite scan the session index.
    const sessions = new Set(db.prepare('SELECT session_id FROM messages WHERE id > ? AND id <= ? ORDER BY id').all(afterId, maxId).map((row) => String(row.session_id)))
    return { maxId, roots: lineageRoots(db, sessions) }
  } catch {
    return null
  } finally {
    try { db.close() } catch { /* read-only cleanup */ }
  }
}
