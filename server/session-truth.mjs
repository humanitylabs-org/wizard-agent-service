import { existsSync } from 'node:fs'
import { AGENT_TO_AGENT_PREFIX, isAgentToAgentRequest } from './owner-thread-write.mjs'
import { visibleMemoryText } from './memory-context-projection.mjs'
import { isSilentResult, SCHEDULE_INPUT } from './scheduler.mjs'
import { DatabaseSync } from 'node:sqlite'
import { preparedRead, createReadOnlySqlite } from './read-only-sqlite.mjs'
import { readUndeliveredHelperReceipts, completionDelegationId, receiptConsumed, ownerGate, isHumanRequest, retainedMessagesWhere } from './delegation-receipts.mjs'
import { parseStatus, replyAppId } from './thread-status.mjs'
import { hasAppToolCalls } from './thread-app-provenance.mjs'
import { readNonHoldingFollowUps } from './owned-open-work-follow-through.mjs'

const USER_EVENT_KINDS = new Set(['async_delegation_complete', 'internal_notification', 'system'])
const INTERNAL_ASSISTANT_KINDS = new Set([...USER_EVENT_KINDS, 'commentary', 'hidden'])
// Recovery requests for an interrupted Helm card arrive as a user turn that starts with this marker; the
// thread hides it. History written before markers were neutral carries the legacy wording (recognized only,
// never emitted).
export const RECOVERY_REQUEST_MARKER = '[Owner requested recovery of this interrupted Helm card.]'
export const LEGACY_RECOVERY_REQUEST_MARKER = '[James requested recovery of this interrupted Helm card.]'
const INTERNAL_USER_PREFIXES = [
  AGENT_TO_AGENT_PREFIX,
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
  if (!isHumanRequest({ role: 'user', content: text, display_kind: kind }) || text === EMPTY_TOOL_RESPONSE_NUDGE || USER_EVENT_KINDS.has(kind) || kind.startsWith('process_wakeup')) return false
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
function wordIndexReady(db) {
  try {
    if (!preparedRead(db, "SELECT 1 FROM sqlite_schema WHERE name = 'messages_fts'").get()) return false
    const meta = preparedRead(db, "SELECT 1 FROM sqlite_schema WHERE name = 'state_meta'").get()
    return !meta || !preparedRead(db, "SELECT 1 FROM state_meta WHERE key IN ('fts_rebuild_high_water','fts_rebuild_progress')").get()
  } catch { return false }
}
function trigramIndexReady(db) {
  try {
    if (!preparedRead(db, "SELECT 1 FROM sqlite_schema WHERE name = 'messages_fts_trigram'").get()) return false
    const meta = preparedRead(db, "SELECT 1 FROM sqlite_schema WHERE name = 'state_meta'").get()
    return !meta || !preparedRead(db, "SELECT 1 FROM state_meta WHERE key IN ('fts_rebuild_high_water','fts_rebuild_progress')").get()
  } catch { return false }
}

// Search only caller-approved session IDs in this runtime, with the same visibility rules
// as the list truth reader. Never discover agents or open their stores here.
export const indexedSearchWords = query => {
  const words = String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean)
  return words.length && words.every(w => /^[\x00-\x7f]+$/.test(w)) && words.some(w => w.length >= 3) ? words : []
}
export function createHermesTextSearcher(path) {
  const db = openReadOnly(path)
  let rootsKey = '', candidates, wordCandidates, columns, insert
  const reads = new Map(), heads = new Map(), bodies = new Map()
  let bodyBytes=0, dataVersion=-1
  const remember = row => {
    const bytes=typeof row.content==='string' ? row.content.length*2 : 0
    if(bytes>4*1024*1024) return
    bodies.set(row.id,{row,bytes}); bodyBytes+=bytes
    while(bodyBytes>32*1024*1024) { const [id,v]=bodies.entries().next().value; bodies.delete(id); bodyBytes-=v.bytes }
  }
  if (db) {
    db.exec('PRAGMA mmap_size=2147483648; PRAGMA cache_size=-200000; CREATE TEMP TABLE wizard_roots(session_id TEXT PRIMARY KEY) WITHOUT ROWID')
    columns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(x => x.name))
    insert = db.prepare('INSERT INTO temp.wizard_roots VALUES (?)')
  }
  return {
    close() { db?.close() },
    search(sessionIds, query) {
      const hits = new Map(), words = indexedSearchWords(query)
      Object.assign(hits, {mode:'titles', partial:false, timings:{fts_ms:0,read_ms:0,candidates:0,sessions:0}})
      if (!db || !words.length || !(wordIndexReady(db) || trigramIndexReady(db))) return hits
      const ids = boundedIds(sessionIds, Infinity)
      if (!ids.length) return hits
      const key = JSON.stringify(ids)
      if (key !== rootsKey) {
        db.exec('BEGIN; DELETE FROM temp.wizard_roots')
        try { for (const id of ids) insert.run(id); db.exec('COMMIT'); rootsKey=key }
        catch (error) { db.exec('ROLLBACK'); throw error }
      }
      const version=db.prepare('PRAGMA data_version').get().data_version
      if(version!==dataVersion) { bodies.clear(); bodyBytes=0; dataVersion=version }
      const start = performance.now()
      let rows, partial
      if (wordIndexReady(db)) {
        // Hermes' word index first: one small posting list per word (20-80 ms cold) instead of three trigram lists,
        // where common trigrams like "str" in "nostr" cost 1-3 s cold (James, 25 Oct 2026: still 5 s on the phone).
        // Words match from their start ("nos" finds "nostr"); the JS check below stays the authority.
        wordCandidates ||= db.prepare('SELECT rowid AS id FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rowid DESC LIMIT 8000')
        const tokens=words.flatMap(w=>w.split(/[^a-z0-9]+/)).filter(t=>t.length>=3)
        const ftsIds=tokens.length ? wordCandidates.all(`content : (${tokens.map(t=>`"${t}"*`).join(' AND ')})`).map(r=>r.id) : []
        const roots=new Set(ids), sessions=new Set(); rows=[]; partial=ftsIds.length>=8000
        // Newest first, 200 at a time, until 60 threads have a visible match: tool output dominates the word index
        // and each row is a random read, so the old reads of all 8,000 rows cost seconds.
        let at=0
        for(; at<ftsIds.length && sessions.size<60; at+=200) {
          const chunk=ftsIds.slice(at,at+200)
          if(!heads.has(chunk.length)) heads.set(chunk.length,db.prepare(`SELECT id,session_id,role FROM messages WHERE id IN (${chunk.map(()=>'?').join(',')})`))
          for(const r of heads.get(chunk.length).all(...chunk)) if(roots.has(r.session_id) && (r.role==='user'||r.role==='assistant')) { rows.push(r); sessions.add(r.session_id) }
        }
        if(at<ftsIds.length) partial=true
        rows.sort((a,b)=>a.session_id<b.session_id?-1:a.session_id>b.session_id?1:b.id-a.id)
      } else {
        // Newest 8,000 matching messages only: each is a random lookup in a 30 GB store, and a common 3-letter word
        // ("nos": 30k rows) blew the deadline. Older matches still come from titles; the response says partial.
        candidates ||= db.prepare(`WITH c AS MATERIALIZED (
          SELECT rowid AS id FROM messages_fts_trigram WHERE messages_fts_trigram MATCH ? ORDER BY rowid DESC LIMIT 8000
        ) SELECT m.session_id AS session_id, m.id AS id, (SELECT count(*) FROM c) AS candidate_count
          FROM c JOIN messages m ON m.id=c.id JOIN temp.wizard_roots r ON r.session_id=m.session_id
          WHERE m.role IN ('user','assistant')
          UNION ALL SELECT NULL,NULL,count(*) FROM c ORDER BY session_id,id DESC`)
        const result = candidates.all(words.filter(w=>w.length>=3).map(w=>`"${w.replace(/"/g,'""')}"`).join(' AND '))
        rows=result.filter(r=>r.session_id!==null); partial=result.some(r=>r.candidate_count>=8000)
      }
      const fts_ms = performance.now()-start, readStart=performance.now(), grouped=new Map()
      for (const row of rows) { if(!grouped.has(row.session_id)) grouped.set(row.session_id,[]); grouped.get(row.session_id).push(row.id) }
      // Snippets for the 60 threads with the newest matching message: reading text is the slow part (a common
      // word matched 467 threads and took 5 s). The rest still count as partial, and titles cover them.
      const ranked=[...grouped].sort((a,b)=>b[1][0]-a[1][0]), skipped=ranked.length>60
      grouped.clear(); for(const [id,values] of ranked.slice(0,60)) grouped.set(id,values)
      for (let round=0; round<2; round++) {
        const wanted=[]
        for (const [id, values] of grouped) if(!hits.has(id)) wanted.push(...values.slice(round*3,round*3+3))
        const found=new Map(), missing=[]
        for(const id of wanted) { const cached=bodies.get(id); if(cached) found.set(id,cached.row); else missing.push(id) }
        for(let at=0; at<missing.length; at+=500) {
          const chunk=missing.slice(at,at+500)
          if(!reads.has(chunk.length)) reads.set(chunk.length,db.prepare(`SELECT id,session_id,role,content,${columns.has('display_kind')?'display_kind':'NULL AS display_kind'},${columns.has('finish_reason')?'finish_reason':'NULL AS finish_reason'} FROM messages WHERE id IN (${chunk.map(()=>'?').join(',')})`))
          for(const row of reads.get(chunk.length).all(...chunk)) { found.set(row.id,row); remember(row) }
        }
        for(const [id, values] of grouped) {
          if(hits.has(id)) continue
          for(const mid of values.slice(round*3,round*3+3)) {
            const row=found.get(mid); if(!row || row.session_id!==id || typeof row.content!=='string') continue
            const text=visibleMemoryText(row.content)
            const visible=row.role==='user'?visibleUserRequest(text,row.display_kind):visibleAssistantReply(text,row.display_kind,row.finish_reason)
            const low=text.toLowerCase()
            if(!visible || !words.every(w=>low.includes(w))) continue
            const at=low.indexOf(words[0]), from=Math.max(0,at-60), to=Math.min(text.length,from+200)
            hits.set(id,(from?'…':'')+text.slice(from,to)+(to<text.length?'…':'')); break
          }
        }
      }
      Object.assign(hits,{mode:'body',partial:partial || skipped || [...grouped].some(([id,values])=>!hits.has(id)&&values.length>6),timings:{fts_ms,read_ms:performance.now()-readStart,candidates:rows.length,sessions:hits.size}})
      return hits
    }
  }
}
export function searchHermesSessionText(path, sessionIds, query) {
  const searcher=createHermesTextSearcher(path)
  try { return searcher.search(sessionIds,query) } finally { searcher.close() }
}
export function createHermesSessionTruthReader(path) {
  const connection = createReadOnlySqlite(path)
  return {
    close: connection.close,
    read: (ids, nowSeconds = Date.now() / 1000, options = {}) => readHermesSessionTruth(path, ids, nowSeconds, { ...options, db: connection.get() }),
    busy(id, nowSeconds = Date.now() / 1000) {
      const db = connection.get()
      if (!db || !/^(?:wizard_|wizard-assistant-)/.test(String(id))) return false
      try { return !!preparedRead(db, 'SELECT 1 FROM session_turn_leases WHERE conversation_id=? AND expires_at>? LIMIT 1').get(id, nowSeconds) }
      catch { return false }
    },
  }
}
export function readHermesSessionTruth(path, sessionIds, nowSeconds = Date.now() / 1000, options = {}) {
  const ids = boundedIds(sessionIds)
  const truth = new Map()
  if (!ids.length) return truth
  const db = Object.hasOwn(options, 'db') ? options.db : openReadOnly(path)
  if (!db) return truth
  try {
    const placeholders = ids.map(() => '?').join(',')
    const sessionRows = preparedRead(db, `SELECT id, started_at FROM sessions WHERE id IN (${placeholders})`).all(...ids)
    for (const row of sessionRows) truth.set(String(row.id), {
      startedAt: Number.isFinite(Number(row.started_at)) ? Number(row.started_at) : 0,
      lastUserAt: 0,
      lastAssistantAt: 0,
      activityAt: 0,
      requestPreview: '',
      replies: [],
      active: false,
    })
    // Hermes' session API omits provider. A thread's exact model lock is the only
    // trustworthy route; billing_provider can name a different account.
    try {
      const routeRows = preparedRead(db, `SELECT id, model, model_config FROM sessions WHERE id IN (${placeholders})`).all(...ids)
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
    const messageColumns = new Set(preparedRead(db, 'PRAGMA table_info(messages)').all().map(row => row.name))
    const metadataColumn = messageColumns.has('display_metadata') ? 'display_metadata' : 'NULL AS display_metadata'
    const toolsColumn = messageColumns.has('tool_calls') ? 'tool_calls' : 'NULL AS tool_calls'
    // Real Hermes tables have rowid for equal-timestamp arrival order. A view may
    // not; do not force a sort/materialization of old bodies in that fallback.
    const messageTable = preparedRead(db, "SELECT type, sql FROM sqlite_schema WHERE name = 'messages'").get()
    const tieOrder = messageTable?.type === 'table' && !/WITHOUT ROWID/iu.test(messageTable.sql || '') ? ', rowid DESC' : ''
    const recentMessages = preparedRead(db, `
      SELECT role, finish_reason, timestamp, content, display_kind, ${metadataColumn}, ${toolsColumn}
      FROM messages
      WHERE session_id = ?
        AND role IN ('user', 'assistant')
        AND active = 1
        AND trim(COALESCE(content, '')) <> ''
      ORDER BY timestamp DESC${tieOrder}
    `)
    // Separate active/inactive seeks preserve the (session,active,timestamp) index.
    // An OR here sorts/materializes obsolete bodies before the early-stop iterator.
    const inactiveRequests = preparedRead(db, `SELECT content,display_kind,timestamp FROM messages
      WHERE session_id=? AND active=0 AND ${messageColumns.has('compacted') ? 'compacted=1' : '0'} AND role='user' AND timestamp>?
      ORDER BY timestamp DESC${tieOrder}`)
    const sessionColumns = new Set(preparedRead(db, 'PRAGMA table_info(sessions)').all().map(row => row.name))
    // Select the newest timestamp before reading its body; inactive machine inputs
    // still determine whether this assistant reply was an automated continuation.
    const retained = retainedMessagesWhere(messageColumns)
    // Each retained range can seek backwards on (session_id,active,timestamp).
    // COALESCE/OR in one MAX scans a session's old history for every assistant.
    // Keep NULL-active authority and the exact predicate (including affinities),
    // then choose the original timestamp/rowid winner before reading its body.
    const retainedRanges = [
      'active=1 AND COALESCE(active,1)=1', 'active IS NULL',
      ...(messageColumns.has('compacted') ? ['active=0 AND compacted=1'] : []),
    ]
    const newestRetainedUser = retainedRanges.map(range => `SELECT MAX(timestamp) AS timestamp FROM messages
      WHERE session_id=:sessionId AND role='user' AND ${range} AND timestamp<=:through`).join(' UNION ALL ')
    const triggeringUser = preparedRead(db, `SELECT content FROM messages WHERE session_id=:sessionId AND role='user' AND ${retained}
      AND timestamp=(SELECT MAX(timestamp) FROM (${newestRetainedUser}))
      ORDER BY timestamp DESC${tieOrder} LIMIT 1`)
    const hasLineage = ['parent_session_id', 'end_reason', 'source', 'model_config'].every(column => sessionColumns.has(column))
    const lineageParent = hasLineage ? preparedRead(db, 'SELECT end_reason FROM sessions WHERE id = ?') : null
    const lineageChildren = hasLineage ? preparedRead(db, 'SELECT id, source, model_config FROM sessions WHERE parent_session_id = ?') : null
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
        if (row.role === 'assistant' && isAgentToAgentRequest(triggeringUser.get({ ':sessionId': id, ':through': timestamp })?.content)) continue
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
        // Row order proves this reply follows the latest user even when the
        // provider stores both in the same timestamp tick.
        if (visibleAssistant && !current.lastUserAt) current.replies.unshift({ timestamp, status: parseStatus(row.content), afterUser: true })
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
      // Retained genuine requests remain authoritative even outside model context.
      // Seek them separately so active history still stops before obsolete bodies.
      for (const row of inactiveRequests.iterate(id,current.lastUserAt)) {
        if (!visibleUserRequest(row.content,row.display_kind)) continue
        current.lastUserAt = Number(row.timestamp) || 0
        current.requestPreview = row.content.trim()
        current.activityAt = Math.max(current.activityAt,current.lastUserAt)
        if (current.lastUserAt >= current.lastAssistantAt) delete current.status
        if (current.lastUserAt > provenanceAt) delete current.appId
        break
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
    const followUps = new Map()
    const isFollowUp = (id, handle) => {
      if (!followUps.has(id)) followUps.set(id, (options.nonHoldingFor ?? (id => readNonHoldingFollowUps(path, id)))(id))
      return followUps.get(id).has(handle)
    }
    try {
      const helperRows = preparedRead(db, `
        SELECT origin_session_id AS id, delegation_id
        FROM async_delegations
        WHERE state IN ('running', 'stalling', 'finalizing') AND dispatched_at > ?
          AND origin_session_id IN (${placeholders})
      `).all(nowSeconds - 6 * 3600, ...ids)
      for (const row of helperRows) {
        const current = truth.get(String(row.id || ''))
        if (current && !isFollowUp(String(row.id), row.delegation_id)) current.helpersRunning = (current.helpersRunning || 0) + 1
      }
    } catch { /* agents without background delegation */ }
    // Completion can precede the parent's handoff, and failed delivery leaves no message at all.
    // Read delivery receipts independently of the latest transcript row and execution state.
    for (const receipt of readUndeliveredHelperReceipts(path, { now: nowSeconds * 1000, db, sessionIds: ids })) {
      const current = truth.get(receipt.sessionId)
      if (current && !isFollowUp(receipt.sessionId, receipt.delegationId)) current.helperResultUnanswered = true
    }
    try {
      const newestRow = preparedRead(db, `
        SELECT role, content, timestamp FROM messages
        WHERE session_id = ? AND active = 1
        ORDER BY timestamp DESC LIMIT 1
      `)
      for (const [id, current] of truth) {
        const row = newestRow.get(id)
        const delegationId = completionDelegationId(row?.content)
        if (row?.role === 'user' && typeof row.content === 'string' && row.content.startsWith('[ASYNC DELEGATION BATCH COMPLETE')
          && Number(row.timestamp) > nowSeconds - 6 * 3600 && !ownerGate(db, id)
          && !(delegationId && (receiptConsumed(db, id, delegationId) || isFollowUp(id, delegationId)))) current.helperResultUnanswered = true
      }
    } catch { /* unreadable newest row: no helper wait */ }
    const leaseRows = preparedRead(db, `
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
    if (!Object.hasOwn(options, 'db')) try { db.close() } catch { /* read-only cleanup */ }
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
