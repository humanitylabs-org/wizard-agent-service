// Manual recovery of finished work. Canonical Hermes results are the durable source; the Service's existing
// run queue is the durable admission ledger. Discovery never starts a model and never writes Hermes state.
import { createHash } from 'node:crypto'
import { readUndeliveredHelperReceipts, RECEIPT_PREFIX, receiptKey, completionDelegationId } from './delegation-receipts.mjs'
import { parseStatus } from './thread-status.mjs'

const ID = /^[A-Za-z0-9._:-]{1,180}$/
const WIZARD = /^(wizard_|wizard-assistant-)[A-Za-z0-9._:-]+$/
const ACTIVE = new Set(['queued', 'running', 'waiting_for_approval', 'stopping'])
const PREFIX = '[ASYNC DELEGATION BATCH COMPLETE'
const INTERNAL = /^\s*\[(?:ASYNC DELEGATION BATCH COMPLETE|Wizard follow-through|CONTEXT COMPACTION|CONTEXT SUMMARY|PRIOR CONTEXT|IMPORTANT:|System:|Your active task list|Your previous agent loop)/
const rowsOf = p => Array.isArray(p?.data) ? p.data : Array.isArray(p?.sessions) ? p.sessions : []
const textOf = row => typeof row?.content === 'string' ? row.content : Array.isArray(row?.content)
  ? row.content.filter(part => typeof part?.text === 'string').map(part => part.text).join('\n') : ''
const human = row => row?.role === 'user' && textOf(row).trim() && !INTERNAL.test(textOf(row)) && !['async_delegation_complete', 'internal_notification', 'system', 'hidden'].includes(row.display_kind)
const identity = (root, source) => `bg_${createHash('sha256').update(`${root}\0${source}`).digest('hex').slice(0, 32)}`
const error = (message, status = 409) => Object.assign(new Error(message), { status })
// Service-written queue identity of an owner-approved manual Continue. The run queue stores it in its
// continuation column, which no client path can set; the body marker alone carries no authority.
export const BACKGROUND_RECOVERY_KIND = 'background-recovery'
export const MARKER = '_wizard_background_recovery'

function snapshot(rows, at) {
  const ordered = rows.map((row, n) => ({ ...row, n })).sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0) || Number(b.id || b.n) - Number(a.id || a.n))
  const user = ordered.find(human)
  const assistant = ordered.find(row => row.role === 'assistant' && textOf(row).trim() && !['commentary', 'hidden'].includes(row.display_kind) && !row.tool_calls?.length)
  const gate = assistant && Number(assistant.timestamp) >= Number(user?.timestamp || 0) ? parseStatus(textOf(assistant))?.state : null
  return { boundary: String(user?.id || ''), moved: Number(user?.timestamp || 0) > at, gated: ['needs_you', 'check'].includes(gate) }
}

export function createBackgroundResults({ request, sessionDbPath = '', queue, busy = () => false, now = Date.now, refreshMs = 15_000 }) {
  let cache = { at: 0, records: [], sessions: [], complete: true }
  let inflight = null
  const requestBounded = (path, signal) => request(path, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
  })
  const reads = new Map()
  const clicks = new Map()
  const recent = async (id, fresh = false, revision = '', signal) => {
    const previous = reads.get(id)
    if (!fresh && previous?.revision === revision) return previous.rows
    const rows = rowsOf(await requestBounded(`/api/sessions/${encodeURIComponent(id)}/messages?order=latest&limit=100`, signal)).map(row => ({
      id: row.id, role: row.role, timestamp: row.timestamp, finish_reason: row.finish_reason, display_kind: row.display_kind,
      // Native photos/voice are real human turns too. Keep their boundary without retaining base64 media or
      // unrelated reasoning in the discovery cache. Completion text is retained for the explicit replay.
      content: row.role === 'tool' ? (typeof row.content === 'string' ? row.content : JSON.stringify(row.content ?? ''))
        : textOf(row) || (row.role === 'user' && Array.isArray(row.content) && row.content.length ? '[Human attachment]' : ''),
      tool_calls: row.tool_calls,
    }))
    reads.set(id, { revision, rows })
    return rows
  }
  const threadRows = async (root, readId, fresh = false, revision = '', signal) => {
    const rows = await recent(readId, fresh, revision, signal)
    if (root === readId) return rows
    const rootRows = await recent(root, fresh, revision, signal)
    const unique = new Map()
    for (const row of [...rows, ...rootRows]) unique.set(String(row.id), row)
    return [...unique.values()]
  }
  const admitted = key => queue()?.byIdempotencyKey('direct', key)
  const isBusy = id => busy(id) || (queue()?.latestProjections([id]) || []).some(row => ACTIVE.has(row.status))
  const consumed = (rows, delegationId, at, messageId, sourceKind = 'transcript') => rows.some(row => {
    if (delegationId && row.role === 'user' && textOf(row).includes(`${RECEIPT_PREFIX}${delegationId}\n`)) return true
    if (delegationId && Number(row.timestamp) > at && (row.role === 'tool' || row.role === 'assistant' && row.tool_calls?.length)) {
      return JSON.stringify(row.role === 'tool' ? row.content : row.tool_calls).includes(delegationId)
    }
    // Legacy completion without a delegation identity: a later final assistant is its ordinary resolution.
    return sourceKind === 'transcript' && row.role === 'assistant' && !row.tool_calls?.length && !['commentary', 'hidden'].includes(row.display_kind)
      && (Number(row.timestamp) > at || Number(row.id) > Number(messageId)) && ['stop', 'end_turn'].includes(row.finish_reason)
  })
  const acceptable = (candidate, rows) => {
    const snap = snapshot(rows, candidate.at)
    if (snap.moved || snap.gated || isBusy(candidate.sessionId) || isBusy(candidate.readId) || consumed(rows, candidate.delegationId, candidate.at, candidate.messageId, candidate.sourceKind)) return null
    return { ...candidate, boundary: snap.boundary }
  }
  const scan = async () => {
    const signal = AbortSignal.timeout(40_000)
    const sessions = [], records = [], aliases = new Map(), roots = new Map(), failures = new Map()
    let complete = true
    // Walk the real HTTP pages, including session 101. This is independent of the UX's 30-day display policy.
    // Unchanged conversations reuse their message reads; one scan is shared/cached by all list consumers.
    for (let offset = 0; ; offset += 200) {
      const p = await requestBounded(`/api/sessions?limit=200&offset=${offset}&include_children=false`, signal)
      const page = rowsOf(p)
      for (const row of page) {
        const root = String(row._lineage_root_id || row.id || '')
        if (!WIZARD.test(root) || row.hidden || row.archived || row.deferred || row.is_internal_child || row.parent_session_id) continue
        const id = String(row.id || '')
        if (!ID.test(id)) continue
        aliases.set(id, root)
        aliases.set(root, root)
        roots.set(root, { ...row, id: root })
        sessions.push({ row, id, root })
      }
      if (page.length < 200 || p.has_more === false) break
      if (offset >= 9800) { complete = false; break }
    }
    for (let offset = 0; offset < sessions.length; offset += 8) {
      await Promise.all(sessions.slice(offset, offset + 8).map(async ({ row, id, root }) => {
        if (isBusy(root) || isBusy(id)) return
        let rows
        try { rows = await threadRows(root, id, false, `${row.last_active || row.started_at}:${row.message_count}`, signal) }
        catch (failure) {
          if (signal.aborted) throw failure
          complete = false; failures.set(root, Number(failure?.status) || 503)
          return
        }
        for (const message of rows) {
          const text = textOf(message), at = Number(message.timestamp)
          if (message.role !== 'user' || !text.startsWith(PREFIX) || !Number.isFinite(at) || now() / 1000 - at <= 7200 || text.length > 60_000) continue
          const delegationId = completionDelegationId(text)
          const source = delegationId || `message-${root}-${message.id}`
          const key = delegationId ? receiptKey(delegationId) : `wizard-follow-through-${root}-${message.id}`
          if (admitted(key)) continue
          const candidate = acceptable({ id: identity(root, source), sourceKind: 'transcript', source, sessionId: root, readId: id, at, messageId: message.id, delegationId, key,
            input: delegationId ? `${RECEIPT_PREFIX}${delegationId}\nThe owner pressed Continue for these saved helper findings. Finish the original request, including any other saved results above, under its latest instructions and release authority; verify helper claims yourself.\n\n${text}`
              : `[Wizard follow-through] The owner pressed Continue for the saved result below. Finish the original request, including any other saved results above, under its latest instructions and release authority; verify the findings yourself.\n\n${text}` }, rows)
          if (candidate && !records.some(row => row.id === candidate.id)) records.push(candidate)
        }
        const cacheEntry = reads.get(id)
        if (cacheEntry && !records.some(record => record.readId === id)) if (!rows.some(m => textOf(m).startsWith(PREFIX) && now() / 1000 - Number(m.timestamp) <= 7200)) cacheEntry.rows = []
      }))
    }
    // Optional read-only history opt-in: dropped/pending receipts that never produced a transcript row.
    // The existing receipt reader still enforces consumption, moved-on and owner-gate fences. Only its age
    // horizon is expanded here; automatic recovery keeps the original two-hour horizon unchanged.
    for (const receipt of readUndeliveredHelperReceipts(sessionDbPath, { now: now(), maxAgeSeconds: Number.MAX_SAFE_INTEGER })) {
      if (now() / 1000 - receipt.at <= 7200 || admitted(receipt.key)) continue
      if (!aliases.has(receipt.sessionId)) continue
      const root = aliases.get(receipt.sessionId)
      if (!WIZARD.test(root)) continue
      let rows
      try { rows = await threadRows(root, receipt.sessionId, true, '', signal) }
      catch (failure) {
        if (signal.aborted) throw failure
        complete = false; failures.set(root, Number(failure?.status) || 503)
        continue
      }
      const candidate = acceptable({ ...receipt, sourceKind: 'receipt', id: identity(root, receipt.delegationId), source: receipt.delegationId, sessionId: root, readId: receipt.sessionId,
        input: receipt.input.replace('These are saved helper findings,', 'The owner pressed Continue. These are saved helper findings,') }, rows)
      if (candidate && !records.some(row => row.id === candidate.id)) records.push(candidate)
    }
    for (const id of reads.keys()) if (!aliases.has(id)) reads.delete(id)
    cache = { at: now(), records, sessions: [...roots.values()], complete, failures, error: false }
    return cache
  }
  const refresh = async (fresh = false) => {
    if (!fresh && cache.at && now() - cache.at < refreshMs) return cache
    if (!inflight) inflight = scan().catch(error => { console.warn('[background-results] discovery temporarily unavailable:', String(error?.message || 'read failed').slice(0, 120)); cache = { ...cache, at: now(), error: true }; return cache }).finally(() => { inflight = null })
    return inflight
  }
  const publicRecord = row => ({ id: row.id, session_id: row.sessionId, completed_at: row.at, state: 'ready', label: 'Background result ready', action: 'Continue' })
  return {
    async list() {
      void refresh()
      const c = cache
      const pending = c.records.filter(row => !admitted(row.key) && !isBusy(row.sessionId) && !isBusy(row.readId))
      const bySession = new Map(pending.map(row => [row.sessionId, row]))
      // Include the minimal public thread metadata for an unresolved result that the normal 30-day display
      // window omitted. Full helper findings and host paths never cross into this listing.
      const sessions = c.sessions.filter(row => bySession.has(row.id)).map(row => ({
        id: row.id, title: String(row.title || 'Background work'), source: row.source || 'api_server',
        last_active: row.last_active || row.started_at, started_at: row.started_at, message_count: row.message_count,
        status: 'completed', wizard_background_result: publicRecord(bySession.get(row.id)),
        wizard_attention: { state: 'needs_you', ask: 'Continue from the saved background result' },
      }))
      return { results: pending.map(publicRecord), sessions, scan_complete: !inflight && !c.error && c.complete, scanning: Boolean(inflight), available: !c.error }
    },
    async project(result) {
      void refresh()
      const c = cache
      const bySession = new Map(c.records.filter(row => !admitted(row.key) && !isBusy(row.sessionId) && !isBusy(row.readId)).map(row => [row.sessionId, row]))
      let payload
      try { payload = JSON.parse(result.toString('utf8')) } catch { return result }
      const decorate = row => {
        const id = String(row._lineage_root_id || row.id || '')
        const pending = bySession.get(id)
        if (!pending) return row
        // Ready/manual is separate from Working: never pretend a stopped parent or finished helper is running.
        return { ...row, status: 'completed', wizard_waiting_on: '', wizard_background_result: publicRecord(pending), wizard_attention: { state: 'needs_you', ask: 'Continue from the saved background result', subject: '', title: '' } }
      }
      for (const key of ['data', 'sessions']) {
        if (Array.isArray(payload[key])) payload[key] = payload[key].map(decorate)
      }
      if (payload.session && typeof payload.session === 'object') payload.session = decorate(payload.session)
      return Buffer.from(JSON.stringify(payload))
    },
    async continue(id, sessionId) {
      const key = `${sessionId}/${id}`
      const pending = clicks.get(key)
      if (pending) { const result = await pending; return { ...result, replayed: true } }
      const work = this.continueOnce(id, sessionId).finally(() => { cache.at = 0; clicks.delete(key) })
      clicks.set(key, work)
      return work
    },
    async continueOnce(id, sessionId) {
      if (!/^bg_[0-9a-f]{32}$/.test(id) || !WIZARD.test(sessionId)) throw error('invalid recovery', 400)
      const q = queue()
      if (!q) throw error('durable admission unavailable', 503)
      // A result stays replayable by its exact queue identity even after the canonical transcript consumes it.
      const existing = q.byBackgroundRecovery(id, sessionId)
      if (existing) return { record: existing, replayed: true }
      const c = await refresh(true)
      const pending = c.records.find(row => row.id === id && row.sessionId === sessionId)
      if (!pending) {
        const failure = c.failures?.get(sessionId)
        if (failure === 404) throw error('the thread no longer exists', 400)
        if (failure || c.error || !c.complete) throw error('history is temporarily unavailable', 503)
        throw error('recovery no longer matches this thread')
      }
      let rows
      try { rows = await threadRows(pending.sessionId, pending.readId, true) }
      catch (failure) { throw error(Number(failure?.status) === 404 ? 'the thread no longer exists' : 'history is temporarily unavailable', Number(failure?.status) === 404 ? 400 : 503) }
      let current
      try { current = acceptable(pending, rows) }
      catch { throw error('lease information is temporarily unavailable', 503) }
      if (!current || current.boundary !== pending.boundary) throw error('the thread changed')
      const body = JSON.stringify({ session_id: pending.sessionId, input: pending.input,
        _wizard_background_recovery: { id, source_kind: pending.sourceKind, read_id: pending.readId, boundary: pending.boundary, at: pending.at, delegation_id: pending.delegationId || '', message_id: pending.messageId || '' } })
      const result = await q.admit({ runtime: 'direct', sessionId, idempotencyKey: pending.key, requestHash: createHash('sha256').update(`direct\0${body}`).digest('hex'), body, trustedPaths: [],
        continuation: { kind: BACKGROUND_RECOVERY_KIND, id, session_id: sessionId } })
      cache.at = 0
      return result
    },
    async validateDispatch(body) {
      if (!body || typeof body !== 'object' || !Object.hasOwn(body, MARKER)) return body
      const marker = body[MARKER]
      // Never forward the reserved key, whatever its value; only the service writes a plain-object marker.
      if (!marker || typeof marker !== 'object' || Array.isArray(marker)) throw error('invalid recovery marker', 400)
      // A turn holds the thread right now: wait (retryable, no history read while it is held) and re-check
      // everything once it ends, rather than failing the owner's Continue for good. Nothing dispatches meanwhile.
      let leased
      try { leased = busy(body.session_id) || busy(marker.read_id) }
      catch { throw error('lease information is temporarily unavailable', 503) }
      if (leased) throw error('the thread is busy', 503)
      let rows
      try { rows = await threadRows(body.session_id, marker.read_id, true) }
      catch (failure) { throw error(Number(failure?.status) === 404 ? 'the thread no longer exists' : 'history is temporarily unavailable', Number(failure?.status) === 404 ? 400 : 503) }
      const snap = snapshot(rows, marker.at)
      if (snap.moved || snap.gated || snap.boundary !== marker.boundary || consumed(rows, marker.delegation_id, marker.at, marker.message_id, marker.source_kind)) throw error('recovery became stale before dispatch', 400)
      const { [MARKER]: _internal, ...forward } = body
      return forward
    },
  }
}
