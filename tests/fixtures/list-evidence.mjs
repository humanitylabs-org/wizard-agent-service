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

