import { readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicStoreWrite } from './thread-reference.mjs'

const validRoute = r => typeof r?.model === 'string' && r.model.length > 0 && typeof r.provider === 'string' && r.provider.length > 0
export const sameRoute = (a, b) => validRoute(a) && validRoute(b) && a.model === b.model && a.provider === b.provider

// This fallback is optional metadata, not authority to invent a selection. Only
// absence of this exact query's schema is compatible; corruption/IO still throw.
export function readOptionalSessionSelectionRow(db, sessionId) {
  try { return db.prepare('SELECT model, model_config FROM sessions WHERE id=?').get(String(sessionId)) }
  catch (error) {
    if (error.code === 'ERR_SQLITE_ERROR' && /^(?:no such table: sessions|no such column: (?:model|model_config|id))$/.test(error.message)) return null
    throw error
  }
}
export class ModelSelectionConflict extends Error {
  constructor(selection, code = 'model_selection_changed') {
    super(code.includes('unproven') ? 'The selected agent model/provider cannot be verified · message kept; nothing sent.' : code.includes('steer') ? 'The running reply uses another or unconfirmed model · send a new turn on the selected model.' : 'Model choice changed or is not confirmed · message kept. Refresh the model choice before sending.')
    this.status = 409
    this.payload = { error: { code, message: this.message }, selection }
  }
}

// Wizard owns deliberate choice; Hermes browser_model_lock is also rewritten by native
// per-message execution, so its timestamp is not a deliberate-choice revision. This is
// a single-writer adapter store, like the adjacent locked-run journal, NOT a router.
export class ModelSelections {
  constructor({ statePath = '', sessionRoute = () => null } = {}) {
    this.statePath = statePath
    this.sessionRoute = sessionRoute
    this.rows = new Map()
    this.pending = new Map()
    if (statePath) {
      try { this.rows = new Map(JSON.parse(readFileSync(statePath, 'utf8'))) }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('Model selection custody is unreadable') }
    }
  }
  save() {
    if (!this.statePath) return
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 })
    atomicStoreWrite(this.statePath, JSON.stringify([...this.rows]))
  }
  current(sessionId) {
    const row = this.rows.get(sessionId)
    if (row) return { ...row }
    const stored = this.sessionRoute(sessionId)
    return validRoute(stored) ? { model: stored.model, provider: stored.provider,
      version: Number(stored.version) || 1, state: 'confirmed', source: 'existing_lock' } : null
  }
  assertQueuedGuidance(sessionId, guidance, captured) {
    const envelope = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    const unselected = value => envelope(value) && !Object.keys(value).some(key => /model|provider|lock|selection|version|route|runtime|transport|retry/i.test(key))

    // Only two genuinely unselected legacy envelopes retain the old path. This
    // exception is local to queued guidance, never admission/retry or migration.
    if (unselected(guidance) && unselected(captured)) return
    // Admitted custody, not a later picker (including an in-flight change), owns guidance.
    if (!envelope(guidance) || !envelope(captured) || !sameRoute(guidance, captured)
      || guidance.selection_version !== captured.selection_version
      || (Object.hasOwn(guidance, 'selection_version') !== Object.hasOwn(captured, 'selection_version'))
      || (Object.hasOwn(captured, 'selection_version') && (!Number.isSafeInteger(captured.selection_version) || captured.selection_version < 0)))
      throw new ModelSelectionConflict(current, 'model_selection_steer_mismatch')
  }
  // Capture happens before durable queue admission, without an intervening await.
  // A server-owned queue replay/dispatch does NOT call this again: its route is immutable.
  capture(value, persist = true) {
    if (typeof value.session_id !== 'string' || !/^[A-Za-z0-9._:-]{1,180}$/.test(value.session_id)) throw new ModelSelectionConflict(null, 'model_selection_invalid')
    if ((value.model || value.provider) && !validRoute(value)) throw new ModelSelectionConflict(this.current(value.session_id), 'model_selection_invalid')
    const current = this.current(value.session_id)
    if (this.pending.has(value.session_id) || current?.state === 'pending') throw new ModelSelectionConflict(current, 'model_selection_pending')
    const explicit = validRoute(value) ? { model: value.model, provider: value.provider } : null
    if (current && (!sameRoute(explicit || current, current)
      || (Object.hasOwn(value, 'selection_version') && value.selection_version !== current.version
        && !(value.selection_version === 0 && current.version === 1 && ['existing_lock','existing_agent_lock'].includes(current.source))))) throw new ModelSelectionConflict(current)
    if (!current && Object.hasOwn(value, 'selection_version') && value.selection_version !== 0) throw new ModelSelectionConflict(null)
    const route = explicit || current
    if (!route) return null
    const selected = current ? { ...current, source: current.source?.startsWith('existing_') ? 'first_message' : current.source } : { ...route, version: 1, state: 'confirmed', source: 'first_message' }
    if (persist && (!this.rows.has(value.session_id) || selected.source !== current?.source)) { this.rows.set(value.session_id, selected); this.save() }
    return { model: route.model, provider: route.provider, selection_version: selected.version }
  }
  async change(sessionId, value, apply) {
    if (!validRoute(value)) throw new ModelSelectionConflict(this.current(sessionId), 'model_selection_invalid')
    const requestId = value.selection_request_id
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,180}$/.test(requestId)) throw new ModelSelectionConflict(this.current(sessionId), 'model_selection_request_required')
    const active = this.pending.get(sessionId)
    if (active) {
      if (active.id !== requestId || !sameRoute(active.route, value)) throw new ModelSelectionConflict(this.current(sessionId), 'model_selection_pending')
      return active.task
    }
    const old = this.current(sessionId)
    if (old?.request_id === requestId && sameRoute(old, value) && old.state === 'confirmed') return old
    const recovering = old?.state === 'pending' && old.request_id === requestId && sameRoute(old, value)
    if (old?.state === 'pending' && !recovering) throw new ModelSelectionConflict(old, 'model_selection_pending')
    // Legacy clients may reassert the exact route, but cannot change another device's
    // acknowledged choice without first reading its revision. New threads need no prior lock.
    if (old && !recovering && (Object.hasOwn(value, 'selection_version') ? value.selection_version !== old.version : !sameRoute(old, value))) throw new ModelSelectionConflict(old)
    if (!old && Object.hasOwn(value, 'selection_version') && value.selection_version !== 0) throw new ModelSelectionConflict(null)
    const previous = recovering ? old.previous : old
    const row = recovering ? old : { model: value.model, provider: value.provider, version: (old?.version || 0) + 1,
      state: 'pending', source: 'picker', request_id: requestId, previous }
    this.rows.set(sessionId, row); this.save() // Unknown apply outcomes stay fail-closed after restart.
    const task = (async () => {
      try {
        const ack = await Promise.resolve().then(apply)
        if (!sameRoute(ack, row)) throw new ModelSelectionConflict(row, 'model_selection_ack_mismatch')
        row.state = 'confirmed'; delete row.previous; this.rows.set(sessionId, row); this.save()
        return { ...row }
      } catch (error) {
        // Only a proven pre-execution rejection may restore the prior choice.
        if (error.selectionNotApplied === true) {
          if (previous) this.rows.set(sessionId, previous); else this.rows.delete(sessionId)
          this.save()
          throw new ModelSelectionConflict(this.current(sessionId), 'model_selection_not_applied')
        }
        throw error
      } finally { this.pending.delete(sessionId) }
    })()
    this.pending.set(sessionId, { id: requestId, route: row, task })
    return task
  }
  project(payload, allowed = () => true) {
    for (const row of [payload?.id ? payload : null, payload?.session, ...(Array.isArray(payload?.sessions) ? payload.sessions : []), ...(Array.isArray(payload?.data) ? payload.data : []), ...(Array.isArray(payload?.items) ? payload.items : [])]) {
      if (!row || typeof row.id !== 'string' || !allowed(row.id)) continue
      const choice = this.current(row.id)
      if (choice) {
        row.wizard_selection = choice
        row.wizard_model = choice.model; row.wizard_provider = choice.provider
        row.wizard_model_lock_updated_at = choice.version
        row.selection = choice; row.modelLockAt = choice.version
        row.model = choice.model; row.provider = choice.provider
      }
    }
    return payload
  }
}
