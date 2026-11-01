import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { ModelSelections, readOptionalSessionSelectionRow } from '../server/model-selection.mjs'

for (const schema of [
  'CREATE TABLE messages(session_id TEXT, content TEXT)',
  'CREATE TABLE sessions(id TEXT)',
  'CREATE TABLE sessions(id TEXT, model TEXT)',
  'CREATE TABLE sessions(model TEXT, model_config TEXT)',
]) test(`optional selection schema absence omits projection without writes: ${schema}`, () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(schema)
    const before = db.prepare('SELECT total_changes() AS n').get().n
    const s = new ModelSelections({ sessionRoute: id => readOptionalSessionSelectionRow(db, id) })
    const payload = { data: [{ id: 'wizard_fixture', model: 'upstream-model' }] }
    assert.equal(s.current('wizard_fixture'), null)
    assert.deepEqual(s.project(payload), { data: [{ id: 'wizard_fixture', model: 'upstream-model' }] })
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before)
    assert.equal(s.rows.size, 0)
  } finally { db.close() }
})
test('optional selection query returns the exact row when schema exists', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE sessions(id TEXT, model TEXT, model_config TEXT)')
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('wizard_fixture', 'fixture-model', '{"browser_model_lock":{"confirmed":true}}')
    assert.deepEqual({ ...readOptionalSessionSelectionRow(db, 'wizard_fixture') }, { model: 'fixture-model', model_config: '{"browser_model_lock":{"confirmed":true}}' })
  } finally { db.close() }
})
for (const [code, message] of [
  ['ERR_SQLITE_ERROR', 'disk I/O error'], ['ERR_SQLITE_ERROR', 'database disk image is malformed'],
  ['ERR_SQLITE_ERROR', 'no such table: another_table'], ['ERR_SQLITE_ERROR', 'no such column: another_column'],
  ['EIO', 'no such table: sessions'], ['ERR_SQLITE_BUSY', 'database is locked'],
]) test(`unexpected optional selection error is not schema absence: ${code}: ${message}`, () => {
  const error = Object.assign(new Error(message), { code })
  const db = { prepare() { throw error } }
  const s = new ModelSelections({ sessionRoute: id => readOptionalSessionSelectionRow(db, id) })
  assert.throws(() => s.project({ id: 'wizard_fixture' }), actual => actual === error)
})
test('persisted selection corruption is not hidden by optional fallback handling', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE sessions(id TEXT, model TEXT, model_config TEXT)')
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('wizard_fixture', 'fixture-model', '{corrupt')
    const s = new ModelSelections({ sessionRoute: id => {
      const row = readOptionalSessionSelectionRow(db, id)
      return JSON.parse(row.model_config)
    } })
    assert.throws(() => s.project({ id: 'wizard_fixture' }), SyntaxError)
  } finally { db.close() }
})
