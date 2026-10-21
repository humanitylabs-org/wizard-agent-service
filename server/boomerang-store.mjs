import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ID = /^(?!\.{1,2}$)[A-Za-z0-9._:-]{1,180}$/
const OFFSET_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/u
const iso = (value, label = 'due_at') => {
  const raw = String(value ?? ''), match = OFFSET_ISO.exec(raw)
  if (!match) throw Object.assign(new Error(`${label} must be ISO 8601 with an explicit offset`), { status: 400 })
  const [, ys, mos, ds, hs, mins, ss = '0', millis = '0', offset] = match
  const [y, mo, d, h, min, sec, ms] = [ys, mos, ds, hs, mins, ss, millis.padEnd(3, '0')].map(Number)
  const calendar = new Date(Date.UTC(y, mo - 1, d, h, min, sec, ms))
  if (calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== mo - 1 || calendar.getUTCDate() !== d
    || calendar.getUTCHours() !== h || calendar.getUTCMinutes() !== min || calendar.getUTCSeconds() !== sec) {
    throw Object.assign(new Error(`${label} is not a real calendar date`), { status: 400 })
  }
  if (offset !== 'Z') {
    const [oh, om] = offset.slice(1).split(':').map(Number)
    if (oh > 14 || om > 59 || (oh === 14 && om !== 0)) throw Object.assign(new Error(`${label} has an invalid offset`), { status: 400 })
  }
  const time = Date.parse(raw)
  if (!Number.isFinite(time)) throw Object.assign(new Error(`${label} must be an ISO date`), { status: 400 })
  return new Date(time).toISOString()
}
const zone = value => {
  const result = clean(value, 80)
  try { new Intl.DateTimeFormat('en', { timeZone: result }).format(0) } catch { throw Object.assign(new Error('Invalid timezone'), { status: 400 }) }
  return result
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
        notification_status TEXT NOT NULL DEFAULT 'pending', notification_attempts INTEGER NOT NULL DEFAULT 0,
        notification_next_at TEXT, notification_error TEXT,
        UNIQUE(scope, client_request_id));
      CREATE INDEX IF NOT EXISTS boomerang_due ON boomerang_reminders(status,due_at);
      CREATE INDEX IF NOT EXISTS boomerang_scope ON boomerang_reminders(scope,updated_at);`)
    const columns = new Set(this.db.prepare('PRAGMA table_info(boomerang_reminders)').all().map(value => value.name))
    if (!columns.has('notification_status')) this.db.exec("ALTER TABLE boomerang_reminders ADD COLUMN notification_status TEXT NOT NULL DEFAULT 'pending'")
    if (!columns.has('notification_attempts')) this.db.exec("ALTER TABLE boomerang_reminders ADD COLUMN notification_attempts INTEGER NOT NULL DEFAULT 0")
    if (!columns.has('notification_next_at')) this.db.exec('ALTER TABLE boomerang_reminders ADD COLUMN notification_next_at TEXT')
    if (!columns.has('notification_error')) this.db.exec('ALTER TABLE boomerang_reminders ADD COLUMN notification_error TEXT')
  }

  close() { this.db.close() }

  create(input, { allowPast = false } = {}) {
    const scope = clean(input.scope, 200), clientRequestId = clean(input.clientRequestId, 180)
    if (!scope || !clientRequestId || !ID.test(clientRequestId)) throw Object.assign(new Error('Invalid boomerang reminder'), { status: 400 })
    const existing = this.db.prepare('SELECT * FROM boomerang_reminders WHERE scope=? AND client_request_id=?').get(scope, clientRequestId)
    if (existing) return row(existing)
    const sessionId = clean(input.sessionId, 180), runtime = input.runtime, agentId = clean(input.agentId || 'hermes', 64)
    const targetKind = input.targetKind, timezone = zone(input.timezone)
    const dueAt = iso(input.dueAt)
    if (!scope || !ID.test(sessionId) || !['direct', 'operator'].includes(runtime) || !ID.test(agentId) || !['thread', 'message'].includes(targetKind)
      || (targetKind === 'message' && (!Number.isSafeInteger(input.anchorAt) || input.anchorAt <= 0))
      || (targetKind === 'thread' && input.anchorAt != null)) throw Object.assign(new Error('Invalid boomerang reminder'), { status: 400 })
    if (!allowPast && Date.parse(dueAt) <= this.now()) throw Object.assign(new Error('due_at must be in the future'), { status: 400 })
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
    const due = iso(dueAt), displayedZone = zone(timezone)
    if (Date.parse(due) <= this.now()) throw Object.assign(new Error('due_at must be in the future'), { status: 400 })
    const at = new Date(this.now()).toISOString()
    this.db.prepare("UPDATE boomerang_reminders SET due_at=?,timezone=?,status='scheduled',delivered_at=NULL,notification_status='pending',notification_attempts=0,notification_next_at=NULL,notification_error=NULL,updated_at=? WHERE scope=? AND id=? AND status!='cancelled'").run(due, displayedZone, at, scope, id)
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

  pendingNotifications(at = this.now()) {
    const instant = new Date(at).toISOString()
    return this.db.prepare("SELECT * FROM boomerang_reminders WHERE status='due' AND notification_status='pending' AND (notification_next_at IS NULL OR notification_next_at<=?) ORDER BY due_at,id LIMIT 100").all(instant).map(row)
  }
  notificationSent(id, at = this.now()) {
    const instant = new Date(at).toISOString()
    this.db.prepare("UPDATE boomerang_reminders SET notification_status='sent',notification_error=NULL,updated_at=? WHERE id=? AND status='due' AND notification_status='pending'").run(instant, id)
  }
  notificationFailed(id, error, at = this.now()) {
    const instant = new Date(at), current = this.db.prepare('SELECT notification_attempts FROM boomerang_reminders WHERE id=?').get(id)
    const attempts = Number(current?.notification_attempts || 0) + 1
    const delay = Math.min(15 * 60_000, 5_000 * (2 ** Math.min(attempts - 1, 8)))
    this.db.prepare("UPDATE boomerang_reminders SET notification_attempts=?,notification_next_at=?,notification_error=?,updated_at=? WHERE id=? AND status='due' AND notification_status='pending'")
      .run(attempts, new Date(instant.getTime() + delay).toISOString(), clean(error, 300), instant.toISOString(), id)
  }
}
