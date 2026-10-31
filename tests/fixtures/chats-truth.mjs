// Synthetic canonical history and copy-only instrumentation; never loaded by the service.
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function truthFixture(root, count = 12, sec = Math.floor(Date.now() / 1000)) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const path = join(root, 'state.db'), db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,parent_session_id TEXT,started_at REAL,last_activity_at REAL,message_count INTEGER,model TEXT,model_config TEXT,end_reason TEXT,source TEXT);
    CREATE INDEX session_parent ON sessions(parent_session_id);
    CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL,active INTEGER DEFAULT 1,compacted INTEGER DEFAULT 0,display_kind TEXT,finish_reason TEXT,display_metadata TEXT,tool_calls TEXT,tool_call_id TEXT);
    CREATE INDEX messages_session_time ON messages(session_id,active,timestamp);
    CREATE INDEX messages_session_id ON messages(session_id,id);
    CREATE TABLE async_delegations(delegation_id TEXT PRIMARY KEY,origin_session_id TEXT,parent_session_id TEXT,origin_ui_session_id TEXT,state TEXT,dispatched_at REAL,completed_at REAL,task_json TEXT,delivery_state TEXT,result_json TEXT);
    CREATE INDEX delegations_delivery ON async_delegations(delivery_state,completed_at);
    CREATE TABLE session_turn_leases(conversation_id TEXT PRIMARY KEY,expires_at REAL);`)
  const sessions = [], messages = new Map(), add = db.prepare('INSERT INTO messages(session_id,role,content,timestamp,display_kind,finish_reason,tool_calls,tool_call_id) VALUES(?,?,?,?,?,?,?,?)')
  const insert = db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)')
  const helper = db.prepare('INSERT INTO async_delegations VALUES(?,?,?,?,?,?,?,?,?,?)')
  const status = '[WIZARD_STATUS_V1]{"state":"done","ask":"Verified synthetic result","subject":"Tests"}[/WIZARD_STATUS_V1]'
  db.exec('BEGIN')
  for (let i = 0; i < count; i++) {
    const id = `wizard_truth_${i}`, at = sec - i - 20, rows = []
    const message = (role, content, timestamp, tools = null, toolId = null) => {
      const r = { role, content, timestamp, display_kind: role === 'assistant' ? 'final' : null, finish_reason: role === 'assistant' ? 'stop' : null, tool_calls: tools, tool_call_id: toolId }
      r.id = Number(add.run(id, role, content, timestamp, r.display_kind, r.finish_reason, tools, toolId).lastInsertRowid)
      rows.push(r)
    }
    message('user', 'Synthetic owner request', at - 20000)
    if (i < 25 && i % 2 === 1) {
      // Manual background result with no later answer. It is independent of the
      // optional-follow-up rows, whose later answer legitimately consumes receipts.
      message('assistant', `Earlier synthetic result.\n${status}`, sec - 9100)
      message('user', `[ASYNC DELEGATION BATCH COMPLETE — deleg_old_${i}]\nSynthetic saved findings`, sec - 9000)
    } else if (i < 25) {
      const optional = `deleg_optional_${i}`
      message('assistant', '', at - 15, JSON.stringify([{ id: optional, type: 'function', function: { name: 'delegate_task', arguments: '{}' } }]))
      message('tool', JSON.stringify({ job_id: optional }), at - 14, null, optional)
      helper.run(optional, id, null, '', 'running', at - 15, null, '{"goals":["Optional check"]}', 'pending', '{}')
      helper.run(`deleg_required_${i}`, id, null, '', 'completed', at - 20, at - 10, '{"goals":["Required check"]}', 'pending', '{"results":[{"task_index":0,"status":"completed","summary":"Saved synthetic finding"}]}')
      message('assistant', `Verified synthetic result.\n\n**Still open:**\n- Archimedes: started optional follow-up checks: ${optional} running now\n${status}`, at)
    } else message('assistant', `Verified synthetic result.\n${status}`, at)
    const session = { id, source: 'api_server', title: `Synthetic ${i}`, parent_session_id: null, message_count: rows.length, started_at: at - 20000, last_active: at }
    sessions.push(session); messages.set(id, rows)
    insert.run(id, null, session.started_at, at, rows.length, 'synthetic', '{}', null, 'api_server')
  }
  db.exec('COMMIT')
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok')
  db.close()
  return { path, sessions, messages, sec }
}

export async function instrumentProjection(source, archive, fixture, { legacy = false } = {}) {
  mkdirSync(archive, { recursive: true, mode: 0o700 })
  cpSync(join(source, 'server'), join(archive, 'server'), { recursive: true })
  cpSync(join(source, 'hermes-plugin'), join(archive, 'hermes-plugin'), { recursive: true })
  cpSync(join(source, 'skills'), join(archive, 'skills'), { recursive: true })
  if (existsSync(join(source, 'node_modules'))) symlinkSync(resolve(source, 'node_modules'), join(archive, 'node_modules'), 'dir')
  const probe = { truth_calls: 0, truth_sessions: 0, owned_reads: 0, prepares: 0, receipt_queries: 0 }
  const key = `__truthProbe_${Math.random().toString(36).slice(2)}`
  globalThis[key] = probe
  const truthPath = join(archive, 'server/session-truth.mjs')
  let truthSource = readFileSync(truthPath, 'utf8')
  truthSource = truthSource.replace(/(export function readHermesSessionTruth\([^\n]+\) \{)/, `$1\n globalThis['${key}'].truth_calls++; globalThis['${key}'].truth_sessions += sessionIds.length;`)
  writeFileSync(truthPath, truthSource)
  const receiptPath = join(archive, 'server/delegation-receipts.mjs')
  writeFileSync(receiptPath, readFileSync(receiptPath, 'utf8')
    .replace(/(export function receiptConsumed\([^)]*\) \{)/, `$1 globalThis['${key}'].receipt_queries++;`)
    .replace('export function receiptsConsumed(db, receipts) {', `export function receiptsConsumed(db, receipts) { if (receipts.length) globalThis['${key}'].receipt_queries++;`))
  const ownedPath = join(archive, 'server/owned-open-work-follow-through.mjs')
  writeFileSync(ownedPath, readFileSync(ownedPath, 'utf8').replace('export function readOwnedOpenWork(path, sessionId) {', `export function readOwnedOpenWork(path, sessionId) { globalThis['${key}'].owned_reads++;`))
  const servicePath = join(archive, 'server/service.mjs')
  let service = readFileSync(servicePath, 'utf8')
  if (legacy) {
    service = service.replace('const sessionTruth = listTruthReader.read(listedSessionIds, Date.now() / 1000, { nonHoldingFor })', 'const sessionTruth = readHermesSessionTruth(hermesStatePath, listedSessionIds)')
      .replace('{ nonHoldingFor, activeSessionIds:', '{ activeSessionIds:')
      .replace('backgroundResults.project(result, options.backgroundResultsBusyReader ? undefined : sessionTruth)', 'backgroundResults.project(result)')
  }
  assert(service.includes('    const gate = () => {'))
  service = service.replace('    const gate = () => {', '    backgroundResults = options.chatsBackground ?? backgroundResults\n    options.chatsTruthProbe?.({ projectBatch, fullCore, projectSessionListCore, check: () => checkCore() })\n    const gate = () => {')
  writeFileSync(servicePath, service)
  const { createWizardServer, listen } = await import(pathToFileURL(servicePath))
  const truth = await import(pathToFileURL(truthPath))
  const { createBackgroundResults } = await import(pathToFileURL(join(archive, 'server/background-results.mjs')))
  const request = async url => {
    const parsed = new URL(url, 'http://synthetic.invalid')
    if (parsed.pathname === '/api/sessions') {
      const offset = Number(parsed.searchParams.get('offset')) || 0, limit = Number(parsed.searchParams.get('limit')) || 50
      return { data: fixture.sessions.slice(offset, offset + limit) }
    }
    const match = parsed.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/)
    if (match) return { data: fixture.messages.get(decodeURIComponent(match[1])) ?? [] }
    if (parsed.pathname === '/v1/capabilities') return {}
    throw Error(`Unexpected synthetic request: ${parsed.pathname}`)
  }
  const background = createBackgroundResults({ request, busy: id => truth.readHermesSessionTruth(fixture.path, [id]).get(id)?.active === true,
    queue: () => null, now: () => fixture.sec * 1000, refreshMs: 1e12 })
  while (!(await background.list()).scan_complete) await new Promise(r => setImmediate(r))
  let core
  const server = createWizardServer({ hermesStatePath: fixture.path, hermesKey: 'synthetic-only', upstreamOrigin: 'http://127.0.0.1:1',
    requireAccess: false, agents: false, agentBridge: false, runQueue: false, followThrough: false, ownedOpenWork: false, joinedDelegation: 'off',
    canonicalSessionReader: () => fixture.sessions, pendingFirstSendReader: () => [], archivedSessionReader: () => [],
    wizardOsHome: join(archive, 'os'), listCacheMode: 'on', listCacheCheckMs: 3600000,
    chatsBackground: background, chatsTruthProbe: value => { core = value },
    fetchImpl: async (url, init = {}) => { assert.equal(init.method ?? 'GET', 'GET', 'no external writes'); return new Response(JSON.stringify(await request(url)), { headers: { 'content-type': 'application/json' } }) } })
  await listen(server)
  const prepare = DatabaseSync.prototype.prepare
  DatabaseSync.prototype.prepare = function(sql) { probe.prepares++; return prepare.call(this, sql) }
  return {
    core, probe, background,
    reset() { for (const name of Object.keys(probe)) probe[name] = 0 },
    async close() { DatabaseSync.prototype.prepare = prepare; server.closeAllConnections?.(); await new Promise(r => server.close(r)); await server.drained; delete globalThis[key] },
  }
}
