import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BoomerangStore } from '../server/boomerang-store.mjs'

const dirs: string[] = []
function store(now = Date.parse('2026-10-21T08:00:00.000Z')) {
  const dir = mkdtempSync(join(tmpdir(), 'wizard-boomerang-')); dirs.push(dir)
  return { path: join(dir, 'boomerang.sqlite3'), now, open: () => new BoomerangStore(join(dir, 'boomerang.sqlite3'), { now: () => now }) }
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const reminder = (dueAt = '2026-10-21T09:00:00.000Z') => ({
  scope: 'wizard-account-local', sessionId: 'wizard_synthetic_1', runtime: 'direct', agentId: 'hermes',
  targetKind: 'message', anchorAt: 1792571400000, context: 'Review the synthetic plan', note: 'Follow up',
  dueAt, timezone: 'Asia/Bangkok', clientRequestId: 'client-1',
})

describe('BoomerangStore', () => {
  it('persists UTC reminders and makes create idempotent across restart', () => {
    const s = store(); const first = s.open(); const created = first.create(reminder()); first.close()
    expect(created.due_at).toBe('2026-10-21T09:00:00.000Z')
    const reopened = s.open(); const same = reopened.create(reminder());
    expect(same.id).toBe(created.id); expect(reopened.list('wizard-account-local')).toHaveLength(1); reopened.close()
  })

  it('preserves the exact fractional message timestamp used by Wizard history', () => {
    const s=store(); const db=s.open(); const created=db.create({...reminder(),clientRequestId:'fractional-anchor',anchorAt:1792571400000.897})
    expect(created.anchor_at).toBe(1792571400000.897); db.close()
  })

  it('rejects invalid and past dates', () => {
    const s = store(); const db = s.open()
    expect(() => db.create(reminder('not-a-date'))).toThrow(/due_at/)
    expect(() => db.create(reminder('2026-10-21T07:59:59.000Z'))).toThrow(/future/)
    expect(() => db.create({...reminder(),clientRequestId:'offsetless',dueAt:'2026-10-21T09:00:00'})).toThrow(/explicit offset/)
    expect(() => db.create({...reminder(),clientRequestId:'bad-calendar',dueAt:'2026-02-30T09:00:00Z'})).toThrow(/real calendar/)
    expect(() => db.create({...reminder(),clientRequestId:'bad-zone',timezone:'Mars/Olympus'})).toThrow(/timezone/)
    expect(() => db.create({...reminder(),clientRequestId:'bad-anchor',anchorAt:null})).toThrow(/Invalid boomerang/)
    db.close()
  })

  it('returns an idempotent retry even after its original due time', () => {
    const s = store(); const db = s.open(); const created = db.create(reminder())
    db.now = () => Date.parse('2026-10-22T00:00:00Z')
    const retried = db.create(reminder())
    expect(retried.id).toBe(created.id); db.close()
  })

  it('claims each due reminder once even after restart', () => {
    const s = store(Date.parse('2026-10-21T10:00:00.000Z')); let db = s.open(); const created = db.create(reminder('2026-10-21T09:00:00.000Z'), { allowPast: true }); db.close()
    db = s.open(); expect(db.claimDue().map(x => x.id)).toEqual([created.id]); expect(db.claimDue()).toEqual([]); db.close()
    db = s.open(); expect(db.claimDue()).toEqual([]); expect(db.list('wizard-account-local')[0].status).toBe('due'); db.close()
  })

  it('cancels and reschedules without delivering stale work', () => {
    const s = store(Date.parse('2026-10-21T08:00:00.000Z')); const db = s.open(); const created = db.create(reminder())
    const moved = db.reschedule('wizard-account-local', created.id, '2026-10-21T11:00:00.000Z', 'Asia/Bangkok', 'Edited note')
    expect(moved.due_at).toBe('2026-10-21T11:00:00.000Z'); expect(moved.status).toBe('scheduled'); expect(moved.note).toBe('Edited note')
    expect(db.cancel('wizard-account-local', created.id).status).toBe('cancelled')
    expect(db.claimDue(Date.parse('2026-10-22T00:00:00.000Z'))).toEqual([]); db.close()
  })

  it('keeps failed notifications pending across restart and marks success once', () => {
    const s = store(Date.parse('2026-10-21T10:00:00Z')); let db = s.open()
    const created = db.create(reminder('2026-10-21T09:00:00Z'), {allowPast:true}); db.claimDue()
    expect(db.pendingNotifications()).toHaveLength(1); db.notificationFailed(created.id,'offline')
    expect(db.pendingNotifications()).toHaveLength(0); db.close()
    db=s.open(); expect(db.pendingNotifications(Date.parse('2026-10-21T10:00:06Z'))).toHaveLength(1)
    db.notificationSent(created.id); expect(db.pendingNotifications(Date.parse('2026-10-22T00:00:00Z'))).toHaveLength(0); db.close()
  })
})
