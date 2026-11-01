// Safe post-deploy smoke check: uses the installed modules with a disposable
// synthetic transcript, never the owner's DB and never a real run/model/tool.
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectOwnedOpenWork, ownedOpenItems, countDispatchHandles, dispatchHandles, nonHoldingFollowUpIds } from '../server/owned-open-work.mjs'
import { guardHeavyStatus } from '../server/thread-status.mjs'
import { createOwnedWorkFollowThrough, readOwnedOpenWork, OWNED_WORK_PREFIX } from '../server/owned-open-work-follow-through.mjs'

const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'wizard-owned-work-proof-'))
const path = join(root, 'synthetic-state.db')
const db = new DatabaseSync(path)
let worker
try {
  db.exec(`CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
    timestamp REAL, tool_calls TEXT, tool_call_id TEXT, active INTEGER DEFAULT 1, display_kind TEXT);
    CREATE TABLE session_turn_leases(conversation_id TEXT, expires_at REAL);`)
  const add = (role, content) => db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)')
    .run('wizard_owned_smoke', role, content, Date.now()/1000)
  const attention = { state: 'done', ask: 'Synthetic fix verified.' }
  const reply = `**Synthetic fix works.**\n\n**Still open:**\n- Archimedes: run the follow-up checks\n[WIZARD_STATUS_V1]${JSON.stringify(attention)}[/WIZARD_STATUS_V1]`
  add('user', 'Synthetic request, not an owner message'); add('assistant', reply)
  let admissions = 0, input = '', busy = true
  worker = createOwnedWorkFollowThrough({ sessionDbPath: path, statePath: join(root, 'claims.db'),
    busy: async () => busy, admit: async (_session, text) => { admissions++; input = text } })
  // First scan flags the thread (the owner's turn still holds it, so nothing is admitted yet).
  await worker.tick()
  assert.equal(admissions, 0)
  const before = projectOwnedOpenWork({ id: 'wizard_owned_smoke', status: 'completed', wizard_attention: attention },
    worker.evidenceFor('wizard_owned_smoke'))
  assert.equal(before.status, 'running')
  assert.equal(before.wizard_waiting_on, 'owned_work')
  assert.equal(before.wizard_attention.state, 'fyi')
  busy = false
  await worker.tick(); await worker.tick()
  assert.equal(admissions, 1)
  assert.ok(input.startsWith(OWNED_WORK_PREFIX))
  add('user', input); add('assistant', reply)
  await worker.tick()
  assert.equal(admissions, 1)
  const after = projectOwnedOpenWork({ status: 'completed', wizard_attention: attention }, readOwnedOpenWork(path, 'wizard_owned_smoke'))
  assert.equal(after.wizard_attention.state, 'fyi')
  assert.equal(after.wizard_attention.ask, attention.ask)
  add('user', '[reporter] Synthetic rewrite'); add('assistant', reply)
  add('user', '[Wizard schedule] Synthetic wakeup'); add('assistant', reply)
  assert.equal(readOwnedOpenWork(path, 'wizard_owned_smoke').continuation, true)
  await worker.tick(); assert.equal(admissions, 1)
  assert.deepEqual(ownedOpenItems('**Still open:**\n- Archimedes: Want me to start the soak? Reply yes'), [])
  assert.deepEqual(ownedOpenItems('**Still open:**\n- You: the check covers Archimedes only for now.'), [])
  const tools = [{ role: 'assistant', tool_calls: JSON.stringify([{ id: 'wrapped', function: { name: 'mcp__tool_call', arguments: JSON.stringify({ calls: [{ name: 'wizard_heavy_submit', arguments: {} }] }) } }]) },
    { role: 'tool', tool_call_id: 'wrapped', content: JSON.stringify({ job_id: 'heavy_synthetic', state: 'queued' }) }]
  assert.equal(countDispatchHandles(tools), 1)
  const finished = '**Fix verified.**\n**Still open:**\n- Archimedes: started optional follow-up heavy_synthetic running now'
  const ids = new Set(nonHoldingFollowUpIds(finished, attention, dispatchHandles(tools)))
  assert.deepEqual([...ids], ['heavy_synthetic'])
  assert.equal(guardHeavyStatus(attention, { sessionId: 'synthetic', jobs: [{ job_id: 'heavy_synthetic', sessionId: 'synthetic', state: 'queued' }], nonHoldingIds: ids }), attention)
  console.log(JSON.stringify({ before, synthetic_continuations: admissions, after, owner_corrections: true, real_dispatches: 0, passed: true }, null, 2))
} finally { worker?.close(); db.close(); rmSync(root, { recursive: true, force: true }) }
