import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { restoreOwnerTurns } from '../server/service.mjs'
import { fullRetryInput, ownerRetryRows } from '../server/session-detail.mjs'
import { DurableRunQueue } from '../server/run-queue.mjs'

// Issue 145, points 2, 3 and 5 (AI review kickback). Synthetic thread; no real conversation content.
const SID = 'wizard_synthetic_followups'
const listBody = (text: string, extra: any[] = []) => JSON.stringify({ session_id: SID, input: [{ role: 'user', content: [{ type: 'text', text }, ...extra] }] })
const rec = (publicRunId: string, createdAt: number, body: string, more: Record<string, any> = {}) => ({
  publicRunId, upstreamRunId: `run_${publicRunId}`, status: 'completed', createdAt, body, payload: { created_at: createdAt }, ...more,
})
const restore = (page: any, queue: any, opts?: any) => JSON.parse(restoreOwnerTurns(Buffer.from(JSON.stringify(page)), queue, SID, null, opts).toString())
const page = (rows: any[]) => ({ object: 'list', session_id: SID, pagination: { limit: 100, offset: 0, order: 'oldest', returned: rows.length }, data: rows })

describe('point 5: service-written sends never match as owner turns', () => {
  const heavyText = '[Wizard heavy-work completion]\nSynthetic receipt'
  const rows = () => [
    { id: 1, session_id: SID, role: 'user', display_kind: 'internal_notification', timestamp: 1010, content: 'Synthetic owner words.' },
    { id: 2, session_id: SID, role: 'assistant', timestamp: 1020, content: 'Synthetic reply.' },
    { id: 3, session_id: SID, role: 'user', display_kind: 'internal_notification', timestamp: 2010, content: 'Synthetic continuation words.' },
    { id: 4, session_id: SID, role: 'assistant', timestamp: 2020, content: 'Synthetic reply two.' },
    { id: 5, session_id: SID, role: 'user', display_kind: 'internal_notification', timestamp: 3010, content: heavyText },
    { id: 6, session_id: SID, role: 'assistant', timestamp: 3020, content: 'Synthetic reply three.' },
  ]
  const records = [
    rec('wizardq_owner', 1000, listBody('Synthetic owner words.')),
    // A list-shaped send the Service queued itself (continuation metadata), and one keyed as a heavy continuation.
    rec('wizardq_cont', 2000, listBody('Synthetic continuation words.'), { continuation: { kind: 'heavy', job_id: 'j1' } }),
    rec('wizardq_heavy', 3000, listBody(heavyText), { idempotencyKey: 'wizard-heavy-j2' }),
    rec('wizardq_gone', 3500, listBody('[Wizard heavy-work completion]\nGone receipt'), { idempotencyKey: 'wizard-heavy-j3' }),
  ]
  const queue = { admittedForSession: () => records }
  it('the owner\'s own send is restored; continuation sends keep their kind and are never re-added', () => {
    const out = restore(page(rows()), queue).data
    expect(out.find((r: any) => r.id === 1).display_kind).toBeUndefined()
    expect(out.find((r: any) => r.id === 3).display_kind).toBe('internal_notification')
    expect(out.find((r: any) => r.id === 5).display_kind).toBe('internal_notification')
    expect(out.filter((r: any) => String(r.id).startsWith('queue-'))).toEqual([])
  })
})

describe('point 2: Retry rebuilds the owner\'s turn', () => {
  const rows = () => [
    { id: 1, session_id: SID, role: 'user', timestamp: 900, content: 'Synthetic older visible message.' },
    { id: 2, session_id: SID, role: 'assistant', timestamp: 950, content: 'Synthetic older reply.' },
    { id: 3, session_id: SID, role: 'user', display_kind: 'internal_notification', timestamp: 1010,
      content: [{ type: 'text', text: 'Synthetic latest owner words.' }, { type: 'text', text: '[System: synthetic Hermes notice]' }] },
  ]
  const queue = { admittedForSession: () => [rec('wizardq_latest', 1000, listBody('Synthetic latest owner words.'))] }
  const latestFirst = (p: any) => ({ ...p, data: [...p.data].reverse(), has_more: false })
  it('without the restore, Retry skips the owner\'s internal row and picks an older message', async () => {
    expect(await fullRetryInput(async () => latestFirst(page(rows())))).toBe('Synthetic older visible message.')
  })
  it('with the restore, Retry gets the owner\'s latest words, without Hermes\' notice', async () => {
    const got = await fullRetryInput(async () => ownerRetryRows(latestFirst(restore(page(rows()), queue, { ownerText: true }))))
    expect(got).toBe('Synthetic latest owner words.')
  })
  it('ownerRetryRows leaves internal rows and string rows alone', () => {
    const p = ownerRetryRows(page(rows()))
    expect(p.data[0].content).toBe('Synthetic older visible message.')
    expect(Array.isArray(p.data[2].content)).toBe(true)
  })
})

describe('point 3: owner turns survive queue retention', () => {
  const PNG = 'data:image/png;base64,' + 'A'.repeat(4000)
  const make = (dir: string, keepOwnerTurns: boolean) => new DurableRunQueue({ statePath: join(dir, 'q.sqlite3'), launch: async () => ({}),
    lookup: async () => ({}), activeSessionIds: async () => [], canDispatch: async () => false, keepOwnerTurns }) as any
  const seed = (queue: any) => {
    const insert = queue.database.prepare(`INSERT INTO wizard_run_queue (public_run_id, runtime, session_id, idempotency_key, request_hash, body,
      trusted_paths_json, status, upstream_run_id, payload_json, created_at, updated_at, terminal_at, continuation_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    const old = Date.now() / 1000 - 30 * 86400
    insert.run('wizardq_owner', 'direct', SID, 'k-owner', 'h', listBody('Synthetic old owner words.', [{ type: 'image_url', image_url: { url: PNG } }]), '[]', 'completed', 'run_owner',
      JSON.stringify({ admission_id: 'adm_owner', created_at: old }), old, old, old, 'null')
    insert.run('wizardq_heavy', 'direct', SID, 'wizard-heavy-j1', 'h', listBody('[Wizard heavy-work completion] receipt'), '[]', 'completed', 'run_heavy', '{}', old + 1, old + 1, old + 1, 'null')
    insert.run('wizardq_cont', 'direct', SID, 'k-cont', 'h', listBody('Synthetic watcher'), '[]', 'completed', 'run_cont', '{}', old + 2, old + 2, old + 2, JSON.stringify({ kind: 'watch' }))
    for (let i = 0; i < 130; i++) insert.run(`wizardq_fill${i}`, 'direct', `other${i}`, `k${i}`, 'h', '{}', '[]', 'completed', `run_f${i}`, '{}', old + 10 + i, old + 10 + i, old + 10 + i, 'null')
    return old
  }
  it('switch on: a pruned owner send keeps its words (no image bytes) and is still matched by its admission id', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'owner-ledger-'))
    try {
      const queue = make(dir, true)
      const old = seed(queue)
      queue._pruneTerminal(true)
      expect(queue.database.prepare('SELECT 1 FROM wizard_run_queue WHERE public_run_id = ?').get('wizardq_owner')).toBeUndefined()
      const kept = queue.admittedForSession('direct', SID)
      expect(kept.map((r: any) => r.publicRunId)).toEqual(['wizardq_owner'])
      expect(kept[0].body).not.toContain('AAAA')
      expect(kept[0].payload.admission_id).toBe('adm_owner')
      const out = restore(page([
        { id: 1, session_id: SID, role: 'user', display_kind: 'internal_notification', platform_message_id: 'adm_owner', timestamp: old + 5, content: 'Synthetic old owner words.\n[screenshot]' },
        { id: 2, session_id: SID, role: 'assistant', timestamp: old + 6, content: 'Synthetic reply.' },
      ]), queue, { screenshots: true }).data
      expect(out.find((r: any) => r.id === 1).display_kind).toBeUndefined()
      queue.close()
      // The ledger is read again after a restart.
      const again = make(dir, true)
      expect(again.admittedForSession('direct', SID).map((r: any) => r.publicRunId)).toEqual(['wizardq_owner'])
      again.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('switch off: retention drops the owner send as before and nothing is kept', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'owner-ledger-off-'))
    try {
      const queue = make(dir, false)
      seed(queue)
      queue._pruneTerminal(true)
      expect(queue.admittedForSession('direct', SID)).toEqual([])
      expect(queue.database.prepare("SELECT name FROM sqlite_master WHERE name = 'wizard_owner_turn_ledger'").get()).toBeUndefined()
      queue.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
