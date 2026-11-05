// Replays the owner timeline with synthetic history only: long quiet tool,
// notice with needs_you, queued user not yet in history, then a visible steer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { scene, kinds } from '../qa/agent-parity/fixture.mjs'
import { serverChecks } from '../qa/agent-parity/server-checks.mjs'
const source = process.env.WIZARD_SERVICE_ROOT || new URL('../', import.meta.url).pathname
const { projectOpenAskSession } = await import(pathToFileURL(join(source, 'server/open-ask.mjs')))
const { createWizardServer, listen } = await import(pathToFileURL(join(source, 'server/service.mjs')))
const ask = { state: 'needs_you', ask: 'An update is waiting. Restart it in Console' }
const replies = [{ timestamp: 20, status: ask }]
for (const kind of kinds) test(`${kind}: in-flight notice precedence through real synthetic HTTP routes`, async () => {
  const s = await scene(kind)
  try { await serverChecks['in-flight-notice'](s) } finally { await s.close() }
})
for (const status of ['submitting', 'accepted', 'queued', 'started', 'running', 'unknown']) test(`${status} controller beats an injected ask, but helper-only ask returns after terminal`, () => {
  const row = projectOpenAskSession({ id: 'synthetic', status, wizard_run_id: 'run_fixture' }, { replies, lastUserAt: 10, background: 'helper' })
  assert.equal(row.status, status)
  assert.equal(row.wizard_background, undefined)
  const done = projectOpenAskSession({ id: 'synthetic', status: 'completed' }, { replies, lastUserAt: 10, background: 'helper' })
  assert.equal(done.status, 'completed')
  assert.deepEqual(done.wizard_attention, ask)
  assert.equal(done.wizard_background, 'helper')
})
test('a live lease without an API run id also outranks injected asks', () => {
  assert.equal(projectOpenAskSession({ id: 'lease', status: 'running' }, { replies, lastUserAt: 10, background: 'helper', inFlight: true }).status, 'running')
})

test('HTTP full + slim lists: quiet active run survives notice and queued/steered user; Ready only after terminal', { timeout: 20000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'in-flight-notice-')), path = join(root, 'state.db'), db = new DatabaseSync(path)
  const sid = 'wizard_synthetic_notice', now = Date.now() / 1000
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,started_at REAL,model TEXT,model_config TEXT);
    CREATE TABLE session_turn_leases(conversation_id TEXT,expires_at REAL);
    CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL,active INT DEFAULT 1,display_kind TEXT,tool_calls TEXT,finish_reason TEXT DEFAULT 'stop',display_metadata TEXT);
    CREATE TABLE async_delegations(delegation_id TEXT PRIMARY KEY,origin_session_id TEXT,parent_session_id TEXT,origin_ui_session_id TEXT,state TEXT,dispatched_at REAL,completed_at REAL,task_json TEXT,delivery_state TEXT,result_json TEXT);`)
  db.prepare('INSERT INTO sessions(id,started_at) VALUES(?,?)').run(sid, now - 3600)
  const add = (role, content, at, kind = '') => db.prepare('INSERT INTO messages(session_id,role,content,timestamp,display_kind) VALUES(?,?,?,?,?)').run(sid, role, content, at, kind)
  add('user', 'Ship the desktop fix', now - 3500)
  db.prepare('INSERT INTO async_delegations VALUES(?,?,?,?,?,?,?,?,?,?)').run('deleg_fixture', sid, null, '', 'running', now - 3000, null, '{}', 'pending', '{}')
  let terminal = false, history = []
  const response = obj => new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json' } })
  const service = createWizardServer({ requireAccess: false, hermesKey: 'synthetic-key-never-in-a-response', hermesStatePath: path, sessionDbPath: path,
    wizardOsHome: root, agents: false, agentBridge: false, followThrough: false, joinedDelegation: 'off', runQueue: false,
    canonicalSessionReader: () => [{ id: sid, source: 'api_server', title: 'Synthetic · Working', message_count: 3, started_at: now - 3600 }],
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/v1/runs') && init?.method === 'POST') return response({ run_id: 'run_fixture', session_id: sid, status: 'running', created_at: now })
      if (String(url).endsWith('/v1/runs/run_fixture')) return response({ run_id: 'run_fixture', session_id: sid, status: terminal ? 'completed' : 'running', created_at: now })
      return response({ data: history })
    } })
  t.after(async () => { if (service.listening) await new Promise(r => service.close(r)); db.close(); rmSync(root, { recursive: true, force: true }) })
  await listen(service)
  const base = `http://127.0.0.1:${service.address().port}/wizard/hermes`
  const admitted = await fetch(base + '/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: sid, input: 'Ship the desktop fix' }) })
  assert.equal(admitted.status, 200, await admitted.text())
  // A direct writer's final-looking row is newer than admission, with no turn lease.
  add('assistant', `Update failed\n[WIZARD_STATUS_V1]${JSON.stringify(ask)}[/WIZARD_STATUS_V1]`, now + 10)
  const lists = async expected => {
    for (const query of ['?limit=100', '?view=list&window=archive-50&limit=100&overrides=%7B%7D']) {
      const r = await fetch(base + '/api/sessions' + query), body = await r.json()
      assert.equal(r.status, 200, JSON.stringify(body))
      const row = body.data.find(r => r.id === sid)
      assert.equal(row?.status, expected, query + ': ' + JSON.stringify(row))
      if (expected === 'running') assert.equal(row.runId ?? row.wizard_run_id, 'run_fixture')
    }
  }
  await lists('running') // owner sends another message, but it is still queued outside transcript
  // Once a steer is persisted it still cannot finish the same run.
  add('user', 'Why is this in Ready?', now + 20, 'steer')
  await lists('running')
  // A later notice during that same run still must not settle it.
  add('assistant', `Update notice\n[WIZARD_STATUS_V1]${JSON.stringify(ask)}[/WIZARD_STATUS_V1]`, now + 30)
  await lists('running')
  terminal = true
  assert.equal((await (await fetch(base + '/v1/runs/run_fixture')).json()).status, 'completed')
  await lists('completed')
})
