import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ID = /^(?!\.{1,2}$)[A-Za-z0-9._:-]{1,180}$/
const ZONE = /^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+.-]+)*$/
const iso = (value, label = 'due_at') => {
  const time = Date.parse(String(value ?? ''))
  if (!Number.isFinite(time)) throw Object.assign(new Error(`${label} must be an ISO date`), { status: 400 })
  return new Date(time).toISOString()
}
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max)
const row = value => value ? ({
  id: value.id, session_id: value.session_id, runtime: value.runtime, agent_id: value.agent_id,
  target_kind: value.target_kind, anchor_at: value.anchor_at || null, context: value.context, note: value.note,
  due_at: value.due_at, timezone: value.timezone, status: value.status, created_at: value.created_at,
  updated_at: value.updated_at, delivered_at: value.delivered_at || null,
}) : null

export class BoomerangStore {
  constructor(path = '', { now = Date.now } = {}) {
    if (!path) throw new Error('Boomerang state path is required')
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.now = now
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS boomerang_reminders(
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, client_request_id TEXT NOT NULL,
        session_id TEXT NOT NULL, runtime TEXT NOT NULL, agent_id TEXT NOT NULL,
        target_kind TEXT NOT NULL, anchor_at INTEGER, context TEXT NOT NULL, note TEXT NOT NULL,
        due_at TEXT NOT NULL, timezone TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, delivered_at TEXT,
        UNIQUE(scope, client_request_id));
      CREATE INDEX IF NOT EXISTS boomerang_due ON boomerang_reminders(status,due_at);
      CREATE INDEX IF NOT EXISTS boomerang_scope ON boomerang_reminders(scope,updated_at);`)
  }

  close() { this.db.close() }

  create(input, { allowPast = false } = {}) {
    const scope = clean(input.scope, 200), sessionId = clean(input.sessionId, 180), runtime = input.runtime, agentId = clean(input.agentId || 'hermes', 64)
    const targetKind = input.targetKind, timezone = clean(input.timezone, 80), clientRequestId = clean(input.clientRequestId, 180)
    const dueAt = iso(input.dueAt)
    if (!scope || !ID.test(sessionId) || !['direct', 'operator'].includes(runtime) || !ID.test(agentId) || !['thread', 'message'].includes(targetKind)
      || !ZONE.test(timezone) || !clientRequestId || !ID.test(clientRequestId)) throw Object.assign(new Error('Invalid boomerang reminder'), { status: 400 })
    if (!allowPast && Date.parse(dueAt) <= this.now()) throw Object.assign(new Error('due_at must be in the future'), { status: 400 })
    const existing = this.db.prepare('SELECT * FROM boomerang_reminders WHERE scope=? AND client_request_id=?').get(scope, clientRequestId)
    if (existing) return row(existing)
    const at = new Date(this.now()).toISOString(), id = `boom_${randomUUID().replaceAll('-', '')}`
    this.db.prepare(`INSERT INTO boomerang_reminders
      (id,scope,client_request_id,session_id,runtime,agent_id,target_kind,anchor_at,context,note,due_at,timezone,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, scope, clientRequestId, sessionId, runtime, agentId, targetKind,
        Number.isFinite(input.anchorAt) ? Math.trunc(input.anchorAt) : null, clean(input.context, 500), clean(input.note, 500), dueAt, timezone, 'scheduled', at, at)
    return this.get(scope, id)
  }

  get(scope, id) { return row(this.db.prepare('SELECT * FROM boomerang_reminders WHERE scope=? AND id=?').get(scope, id)) }
  list(scope, { sessionId = '' } = {}) {
    const values = sessionId
      ? this.db.prepare("SELECT * FROM boomerang_reminders WHERE scope=? AND session_id=? AND status!='cancelled' ORDER BY due_at,id").all(scope, sessionId)
      : this.db.prepare("SELECT * FROM boomerang_reminders WHERE scope=? AND status!='cancelled' ORDER BY CASE status WHEN 'due' THEN 0 ELSE 1 END,due_at,id").all(scope)
    return values.map(row)
  }
  cancel(scope, id) {
    const at = new Date(this.now()).toISOString()
    this.db.prepare("UPDATE boomerang_reminders SET status='cancelled',updated_at=? WHERE scope=? AND id=? AND status IN ('scheduled','due')").run(at, scope, id)
    return this.get(scope, id)
  }
  reschedule(scope, id, dueAt, timezone) {
    const due = iso(dueAt), zone = clean(timezone, 80)
    if (Date.parse(due) <= this.now()) throw Object.assign(new Error('due_at must be in the future'), { status: 400 })
    if (!ZONE.test(zone)) throw Object.assign(new Error('Invalid timezone'), { status: 400 })
    const at = new Date(this.now()).toISOString()
    this.db.prepare("UPDATE boomerang_reminders SET due_at=?,timezone=?,status='scheduled',delivered_at=NULL,updated_at=? WHERE scope=? AND id=? AND status!='cancelled'").run(due, zone, at, scope, id)
    return this.get(scope, id)
  }
  acknowledge(scope, id) {
    const at = new Date(this.now()).toISOString()
    this.db.prepare("UPDATE boomerang_reminders SET status='acknowledged',updated_at=? WHERE scope=? AND id=? AND status='due'").run(at, scope, id)
    return this.get(scope, id)
  }
  claimDue(at = this.now()) {
    const due = new Date(at).toISOString(), delivered = due
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const values = this.db.prepare("SELECT * FROM boomerang_reminders WHERE status='scheduled' AND due_at<=? ORDER BY due_at,id LIMIT 100").all(due)
      const mark = this.db.prepare("UPDATE boomerang_reminders SET status='due',delivered_at=?,updated_at=? WHERE id=? AND status='scheduled'")
      const claimed = []
      for (const value of values) if (mark.run(delivered, delivered, value.id).changes === 1) claimed.push(row({ ...value, status: 'due', delivered_at: delivered, updated_at: delivered }))
      this.db.exec('COMMIT'); return claimed
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}
