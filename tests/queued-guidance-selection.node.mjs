import test from 'node:test'
import assert from 'node:assert/strict'
import { ModelSelections, ModelSelectionConflict } from '../server/model-selection.mjs'

const sid = 'wizard_guidance'
const A = { model: 'fixture-model', provider: 'fixture-provider' }
const captured = { session_id: sid, input: 'original' }
const guidance = { input: 'more guidance' }
const conflict = error => error instanceof ModelSelectionConflict && error.status === 409 && error.payload.error.code === 'model_selection_steer_mismatch'

test('both-unselected legacy queued guidance is pure and does not pin a route', () => {
  const s = new ModelSelections()
  const before = JSON.stringify([captured, guidance])
  s.assertQueuedGuidance(sid, guidance, captured)
  assert.equal(JSON.stringify([captured, guidance]), before)
  assert.equal(s.rows.size, 0); assert.equal(s.pending.size, 0)
})
for (const field of ['model', 'provider', 'require_model_lock', 'selection_version', 'selection_request_id', 'selection', 'wizard_selection', 'model_lock', 'wizard_model', 'wizard_provider', 'modelLockAt', 'wizard_model_lock_updated_at', 'route', 'runtime', 'transport', 'wizard_retry_run_id']) {
  for (const side of ['guidance', 'captured']) test(`no legacy exception for ${side} intent: ${field}`, () => {
    const s = new ModelSelections(), ambiguous = { [field]: null }
    assert.throws(() => s.assertQueuedGuidance(sid, side === 'guidance' ? { ...guidance, ...ambiguous } : guidance,
      side === 'captured' ? { ...captured, ...ambiguous } : captured), conflict)
    assert.equal(s.rows.size, 0)
  })
}
for (const body of [null, [], '', 3]) test(`ambiguous queued envelope is not unselected: ${JSON.stringify(body)}`, () => {
  const s = new ModelSelections()
  assert.throws(() => s.assertQueuedGuidance(sid, body, captured), conflict)
  assert.throws(() => s.assertQueuedGuidance(sid, guidance, body), conflict)
})
for (const state of ['confirmed', 'pending']) test(`${state} selection prevents the legacy exception`, () => {
  const s = new ModelSelections(); s.rows.set(sid, { ...A, version: 2, state })
  assert.throws(() => s.assertQueuedGuidance(sid, guidance, captured), conflict)
})
test('in-flight pending lock prevents even exact selected queued guidance', () => {
  const s = new ModelSelections(); s.pending.set(sid, { id: 'saving' })
  assert.throws(() => s.assertQueuedGuidance(sid, guidance, captured), conflict)
  assert.throws(() => s.assertQueuedGuidance(sid, { ...guidance, ...A }, { ...captured, ...A }), conflict)
})
test('selected queued guidance matches admitted route and version, not a later picker route', () => {
  const s = new ModelSelections(); s.rows.set(sid, { model: 'next', provider: 'next', version: 8, state: 'confirmed' })
  const admitted = { ...captured, ...A, selection_version: 7, require_model_lock: true }
  s.assertQueuedGuidance(sid, { ...guidance, ...A, selection_version: 7 }, admitted)
  for (const route of [{ ...A, selection_version: 6 }, { ...A }, { ...A, provider: 'other', selection_version: 7 }, { model: 'other', provider: A.provider, selection_version: 7 }])
    assert.throws(() => s.assertQueuedGuidance(sid, { ...guidance, ...route }, admitted), conflict)
  assert.throws(() => s.assertQueuedGuidance(sid, { ...guidance, ...A }, captured), conflict)
  assert.throws(() => s.assertQueuedGuidance(sid, guidance, { ...captured, ...A }), conflict)
})
test('private selected queued guidance never substitutes a public same-model route', () => {
  const s = new ModelSelections(), admitted = { ...captured, model: A.model, provider: 'custom:private-fixture', selection_version: 2 }
  s.assertQueuedGuidance(sid, { ...guidance, model: A.model, provider: 'custom:private-fixture', selection_version: 2 }, admitted)
  assert.throws(() => s.assertQueuedGuidance(sid, { ...guidance, ...A, selection_version: 2 }, admitted), conflict)
})
for (const version of [null, '7', -1, 1.5]) test(`invalid selected version cannot authorize queued guidance: ${JSON.stringify(version)}`, () => {
  const s = new ModelSelections()
  assert.throws(() => s.assertQueuedGuidance(sid, { ...guidance, ...A, selection_version: version }, { ...captured, ...A, selection_version: version }), conflict)
})
