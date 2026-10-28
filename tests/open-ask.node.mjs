import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveThreadSection, projectOpenAskSession, threadBackground } from '../server/open-ask.mjs'
import { readHermesSessionTruth } from '../server/session-truth.mjs'
import { latestVisibleSessionMessages, createWizardServer, listen } from '../server/service.mjs'
import { listRow } from '../server/session-list-view.mjs'
import { STATUS_INSTRUCTIONS } from '../server/thread-status.mjs'
import { scene, kinds } from '../qa/agent-parity/fixture.mjs'

for (const kind of kinds) test(`open QR ask survives progress while background runs through ${kind} HTTP`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-ask-runtime-')), heavyStatePath = join(root, 'heavy.db')
  const s = await scene(kind, { heavyStatePath, heavyToken: 'synthetic-open-ask-000000000000000000', heavyPollIntervalMs: 3_600_000,
    heavyTransport: async () => { throw Error('fixture never contacts a worker') } })
  const db = new DatabaseSync(heavyStatePath), sid = 'wizard_qr_runtime', now = Date.now() / 1000
  const message = (state, ask, at) => ({ role: 'assistant', timestamp: at, content: `QR reply\n[WIZARD_STATUS_V1]${JSON.stringify({ state, ask, subject: 'Parity QA' })}[/WIZARD_STATUS_V1]` })
  const row = { id: sid, source: 'wizard-mobile', title: 'Phone', created_at: now - 300, messages: [
    { role: 'user', content: 'Connect my phone', timestamp: now - 290 },
    message('needs_you', qr.ask, now - 200), message('fyi', 'Still building the button', now - 100) ] }
  s.sessions.set(sid, row)
  db.prepare('INSERT INTO heavy_jobs(id,session,origin,key,hash,data,agent_id) VALUES(?,?,?,?,?,?,?)')
    .run('qr_background', sid, 'synthetic', 'key', 'hash', JSON.stringify({ job_id: 'qr_background', sessionId: sid, agent_id: s.id, state: 'running', created_at: Date.now() }), s.id)
  try {
    const response = await s.request('/api/sessions?limit=100')
    assert.equal(response.status, 200)
    const projected = (await response.json()).data.find(r => r.id === sid)
    assert.equal(projected.status, 'completed')
    assert.equal(projected.wizard_attention.state, 'needs_you')
    assert.equal(projected.wizard_attention.ask, qr.ask)
    assert.equal(projected.wizard_background, 'heavy')
  } finally { db.close(); await s.close(); rmSync(root, { recursive: true, force: true }) }
})

const qr = { state: 'needs_you', ask: 'Your QR is ready. Scan it to connect your phone', subject: 'Phone' }
const reply = (status, timestamp = 20) => ({ timestamp, status })
const solve = (replies, background = 'helper', lastUserAt = 10) => resolveThreadSection({ replies, background, lastUserAt })
const cases = [
  ['QR delivered while helper builds button', [reply(qr)], 'helper', 10, 'Ready', qr],
  ['immediate QR action with future result stays Ready while helper runs', [reply({ state: 'needs_you', ask: 'Scan this QR; it will link the phone' })], 'helper', 10, 'Ready', { state: 'needs_you', ask: 'Scan this QR; it will link the phone' }],
  ['handoff-only reply with helper running', [reply({ state: 'fyi', ask: 'A helper is building the button' })], 'helper', 10, 'Working'],
  ['unmarked handoff reply with helper running', [reply(null)], 'helper', 10, 'Working'],
  ['needs_you then later fyi progress keeps the original ask', [reply(qr), reply({ state: 'fyi', ask: 'Still building' }, 30)], 'helper', 10, 'Ready', qr],
  ['helper finishes and agent replies check', [reply(qr), reply({ state: 'check', ask: 'New button is live. Say if it feels right' }, 30)], '', 10, 'Ready', { state: 'check', ask: 'New button is live. Say if it feels right' }],
  ['user message after needs_you while helper runs clears the ask', [reply(qr)], 'helper', 25, 'Working'],
  ['done with helper running is only progress', [reply({ state: 'done', ask: 'Finished' })], 'helper', 10, 'Working'],
  ['check with heavy job pending stays Working', [reply({ state: 'check', ask: 'Try the new button' })], 'heavy', 10, 'Working'],
  ['future QR promise once helper finishes is not an owner action', [reply({ state: 'needs_you', ask: 'I will send the QR once the helper finishes' })], 'helper', 10, 'Working'],
  ['no background and done stays Ready', [reply({ state: 'done', ask: 'Finished' })], '', 10, 'Ready'],
]
for (const [name, replies, background, lastUserAt, section, attention] of cases) test(name, () => {
  const decision = solve(replies, background, lastUserAt)
  assert.equal(decision.section, section)
  if (attention) assert.deepEqual(decision.attention, attention)
  const row = projectOpenAskSession({ id: 'qr', status: background ? 'running' : 'completed' }, { replies, background, lastUserAt })
  assert.equal(row.status === 'running' ? 'Working' : 'Ready', section)
  assert.equal(row.wizard_background, section === 'Ready' && background ? background : undefined)
  if (attention) assert.deepEqual(row.wizard_attention, attention)
})
test('archived user-only history without background keeps its existing section', () => {
  assert.equal(projectOpenAskSession({ id: 'old', status: 'completed', archived: true }, { replies: [], lastUserAt: 10 }).status, 'completed')
})
test('ISO and millisecond API timestamps share the canonical seconds boundary', () => {
  const iso = '2026-10-28T10:00:00.000Z', timestamp = Date.parse(iso)
  assert.equal(solve([reply(qr, iso)], 'helper', timestamp - 1000).section, 'Ready')
  assert.equal(solve([reply(qr, timestamp)], 'helper', timestamp + 1000).section, 'Working')
})
test('done and unmarked progress never erase a live ask; a new ask replaces it', () => {
  for (const status of [null, { state: 'done', ask: 'Finished' }]) assert.deepEqual(solve([reply(qr), reply(status, 30)]).attention, qr)
  const newer = { state: 'needs_you', ask: 'Choose a layout' }
  assert.deepEqual(solve([reply(qr), reply(newer, 30)]).attention, newer)
  for (const state of ['done', 'fyi']) assert.equal(solve([reply(qr), reply({ state, ask: 'Finished' }, 30)], '').attention.state, state)
})
test('future-tense guards cover will, once, when the helper, after the helper and soon', () => {
  for (const ask of ['It will arrive', 'Scan once ready', 'Try when the helper returns', 'Try after the helper returns', 'Try soon']) {
    assert.equal(solve([reply({ state: 'needs_you', ask })]).section, 'Working', ask)
  }
})
test('same-tick owner and reply use proven message order, never revive an older ask', () => {
  const content = `QR ready\n[WIZARD_STATUS_V1]${JSON.stringify(qr)}[/WIZARD_STATUS_V1]`
  const user = { role: 'user', content: 'Connect my phone', timestamp: 20 }
  const assistant = { role: 'assistant', content, timestamp: 20 }
  const after = latestVisibleSessionMessages({ data: [user, assistant] })
  const before = latestVisibleSessionMessages({ data: [assistant, user] })
  assert.equal(resolveThreadSection({ replies: after.replies, lastUserAt: 20, background: 'helper' }).section, 'Ready')
  assert.equal(resolveThreadSection({ replies: before.replies, lastUserAt: 20, background: 'helper' }).section, 'Working')
  assert.equal(resolveThreadSection({ replies: [{ ...reply(qr, 20), afterUser: true }], lastUserAt: 20, background: 'helper' }).section, 'Ready')
})

test('prompt requires a status even for handoffs and uses the request view', () => {
  assert.ok(STATUS_INSTRUCTIONS.includes('including replies that hand work to a helper'))
  assert.ok(STATUS_INSTRUCTIONS.includes("the user's request cannot move forward"))
  assert.ok(STATUS_INSTRUCTIONS.includes('install, scan, or act'))
  assert.ok(!STATUS_INSTRUCTIONS.includes('Leave the line out'))
})
test('API history extraction retains earlier asks for routed and main list fallback', () => {
  const marker = status => `[WIZARD_STATUS_V1]${JSON.stringify(status)}[/WIZARD_STATUS_V1]`
  const messages = latestVisibleSessionMessages({ messages: [
    { role: 'user', timestamp: 10, content: 'Connect my phone' },
    { role: 'assistant', timestamp: 20, content: 'QR ready\n' + marker(qr) },
    { role: 'assistant', timestamp: 30, content: 'Building the button\n' + marker({ state: 'fyi', ask: 'Still building' }) },
  ] })
  assert.deepEqual(solve(messages.replies).attention, qr)
})
test('QR delivered while helper builds button survives real main HTTP and slim list projection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-ask-')), path = join(root, 'state.db'), db = new DatabaseSync(path)
  const now = Date.now() / 1000, sid = 'wizard_qr_fixture'
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,started_at REAL,model TEXT,model_config TEXT);
    CREATE TABLE session_turn_leases(conversation_id TEXT,expires_at REAL);
    CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL,active INT DEFAULT 1,display_kind TEXT,tool_calls TEXT,finish_reason TEXT DEFAULT 'stop');
    CREATE TABLE async_delegations(delegation_id TEXT PRIMARY KEY,origin_session_id TEXT,parent_session_id TEXT,origin_ui_session_id TEXT,state TEXT,dispatched_at REAL,completed_at REAL,task_json TEXT,delivery_state TEXT,result_json TEXT);`)
  db.prepare('INSERT INTO sessions(id,started_at) VALUES(?,?)').run(sid, now - 300)
  const add = (role, content, at) => db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)').run(sid, role, content, at)
  add('user', 'Connect my phone', now - 290)
  add('assistant', `QR ready\n[WIZARD_STATUS_V1]${JSON.stringify(qr)}[/WIZARD_STATUS_V1]`, now - 200)
  add('assistant', 'A helper is building the button\n[WIZARD_STATUS_V1]{"state":"fyi","ask":"Still building"}[/WIZARD_STATUS_V1]', now - 100)
  db.prepare('INSERT INTO async_delegations VALUES(?,?,?,?,?,?,?,?,?,?)').run('deleg_qr', sid, null, '', 'running', now - 250, null, '{"goals":["Build button"]}', 'pending', '{}')
  const server = createWizardServer({ requireAccess: false, hermesKey: 'synthetic-only', hermesStatePath: path, sessionDbPath: path, followThrough: false, archivedSessionReader: () => [], fetchImpl: async url => new Response(JSON.stringify(String(url).includes('/api/sessions?') ? { data: [{ id: sid, title: 'Phone', source: 'wizard-mobile', status: 'completed' }] } : { data: [] }), { headers: { 'content-type': 'application/json' } }) })
  try {
    const truth = readHermesSessionTruth(path, [sid]).get(sid)
    assert.equal(threadBackground(truth), 'helper')
    assert.deepEqual(solve(truth.replies, 'helper', truth.lastUserAt).attention, qr)
    await listen(server)
    const response = await fetch(`http://127.0.0.1:${server.address().port}/wizard/hermes/api/sessions?limit=10`)
    assert.equal(response.status, 200)
    const row = (await response.json()).data[0]
    assert.equal(row.status, 'completed')
    assert.deepEqual(row.wizard_attention, qr)
    assert.equal(row.wizard_background, 'helper')
    assert.equal(listRow(row).background, 'helper')
    assert.deepEqual(listRow(row).attention, qr)
  } finally { if (server.listening) await new Promise(r => server.close(r)); db.close(); rmSync(root, { recursive: true, force: true }) }
})
