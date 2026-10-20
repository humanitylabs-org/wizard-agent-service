import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DismissedFailureStore } from '../server/thread-seen.mjs'
import { ThreadTitleStore } from '../server/thread-titles.mjs'
import { LockedRunBridge } from '../server/locked-run-bridge.mjs'
import { DurableHeavyQueue } from '../server/heavy-queue.mjs'
import { createUploadStore } from '../server/uploads.mjs'
import { migrateJson, migrateJsonLines, qualifyContinuation } from '../server/thread-reference.mjs'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'agent-pair-stores-')); dirs.push(dir); return dir }
const suffix = '.pre-agent-pairs-v1.bak'

describe('agent-pair store migrations', () => {
  it('titles, dismissed failures and model-route journal keep original backups, explicit Hermes pairs, and idempotent bytes', () => {
    const dir = directory(), title = join(dir, 'titles.json'), dismissed = join(dir, 'dismissed.json'), locked = join(dir, 'locked.json')
    const original: Record<string, string> = {
      [title]: JSON.stringify({ schema: 1, threads: { wizard_same: { title: 'Old', locked: true, appliedFor: null, history: [] } } }),
      [dismissed]: JSON.stringify({ schema: 1, dismissals: { wizard_same: { failureKey: 'old-run', dismissedAt: 1 } } }),
      [locked]: JSON.stringify([['key', { sessionId: 'wizard_same', runId: 'run-old', state: 'done' }]]),
    }
    for (const [path, text] of Object.entries(original)) writeFileSync(path, text)
    const load = () => {
      const titles = new ThreadTitleStore(title), failures = new DismissedFailureStore(dismissed)
      new LockedRunBridge({ origin: 'http://127.0.0.1:1', statePath: locked })
      expect(titles.get('wizard_same')).toMatchObject({ agent_id: 'hermes', session_id: 'wizard_same' })
      expect(failures.isDismissed('wizard_same', 'old-run')).toBe(true)
      expect(failures.isDismissed('wizard_same', 'old-run', 'imported')).toBe(false)
    }
    load()
    const first = Object.fromEntries(Object.keys(original).map(path => [path, readFileSync(path, 'utf8')]))
    load()
    for (const [path, text] of Object.entries(original)) {
      expect(readFileSync(path, 'utf8')).toBe(first[path]); expect(readFileSync(path + suffix, 'utf8')).toBe(text)
      writeFileSync(path, readFileSync(path + suffix))
    }
    load()
    for (const path of Object.keys(original)) expect(readFileSync(path, 'utf8')).toBe(first[path])
  })

  it('legacy share receipts migrate to their stored recipient, not a new default; backup is restorable SQLite', async () => {
    const dir = directory(), path = join(dir, 'uploads.sqlite')
    const opts = { statePath: path, target: () => null, sweepIntervalMs: 0, defaultAgentId: () => 'new-default' }
    let store = createUploadStore(opts); store.close()
    const db = new DatabaseSync(path)
    db.exec('ALTER TABLE shares DROP COLUMN agent_id; ALTER TABLE shares DROP COLUMN session_id; ALTER TABLE shares DROP COLUMN request_default')
    db.prepare(`INSERT INTO shares(id,client_share_id,agent,thread_id,thread_new,target,status,created_at,updated_at) VALUES('sh_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','old','imported','wizard_same',1,'agent:imported','uploading',1,1)`).run()
    db.close()
    store = createUploadStore(opts)
    expect(store.publicShare(store.getShare('sh_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'))).toMatchObject({ agent_id: 'imported', session_id: 'wizard_same' }); store.close()
    const first = readFileSync(path + suffix)
    store = createUploadStore(opts); store.close()
    expect(readFileSync(path + suffix)).toEqual(first)
    const backup = new DatabaseSync(path + suffix, { readOnly: true })
    expect(backup.prepare('SELECT agent,thread_id FROM shares').get()).toEqual({ agent: 'imported', thread_id: 'wizard_same' })
    expect(backup.prepare('PRAGMA table_info(shares)').all().map(row => row.name)).not.toContain('agent_id'); backup.close()
    rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true }); writeFileSync(path, first)
    store = createUploadStore(opts)
    expect(store.getShare('sh_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').agent_id).toBe('imported'); store.close()
  })

  it('heavy resume receipts are pinned to Hermes and their SQLite migration is reversible and repeatable', async () => {
    const dir = directory(), path = join(dir, 'heavy.sqlite')
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE heavy_jobs(id TEXT PRIMARY KEY,session TEXT NOT NULL,origin TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(session,origin,key))')
    db.prepare('INSERT INTO heavy_jobs VALUES(?,?,?,?,?,?)').run('heavy_old', 'wizard_same', 'helper', 'key', 'hash', JSON.stringify({ job_id: 'heavy_old', sessionId: 'wizard_same', state: 'completed', resume: 'delivered' }))
    db.close()
    const options = { statePath: path, transport: async () => ({}), continuation: async () => ({}), current: async () => true, intervalMs: 0 }
    let queue = new DurableHeavyQueue(options)
    expect(queue.get('heavy_old')).toMatchObject({ agent_id: 'hermes', session_id: 'wizard_same' }); await queue.close()
    const original = readFileSync(path + suffix)
    queue = new DurableHeavyQueue(options); await queue.close()
    expect(readFileSync(path + suffix)).toEqual(original)
    const backup = new DatabaseSync(path + suffix, { readOnly: true })
    expect(backup.prepare('PRAGMA table_info(heavy_jobs)').all().map(row => row.name)).not.toContain('agent_id'); backup.close()
    rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true }); writeFileSync(path, original)
    queue = new DurableHeavyQueue(options); expect(queue.get('heavy_old').agent_id).toBe('hermes'); await queue.close()
  })

  it('diagnostic receipt journals retain exact backups and malformed input is never rewritten', () => {
    const path = join(directory(), 'interrupt-recovery.jsonl'), old = JSON.stringify({ session_id: 'wizard_same', recoveryRunId: 'old-run' }) + '\n'
    writeFileSync(path, old)
    expect(migrateJsonLines(path)).toBe(true); expect(migrateJsonLines(path)).toBe(false)
    expect(JSON.parse(readFileSync(path, 'utf8').trim())).toMatchObject({ agent_id: 'hermes', session_id: 'wizard_same' })
    expect(readFileSync(path + suffix, 'utf8')).toBe(old)
    writeFileSync(path, '{truncated')
    expect(() => migrateJsonLines(path)).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{truncated'); expect(readFileSync(path + suffix, 'utf8')).toBe(old)
    writeFileSync(path, old); expect(migrateJsonLines(path)).toBe(true)
  })

  it('continuations and nested delivery receipts carry explicit pairs; backups are never overwritten', () => {
    expect(qualifyContinuation({ sessionId: 'wizard_same', receipt: { sessionId: 'wizard_same', delegationId: 'old' } })).toMatchObject({
      agent_id: 'hermes', session_id: 'wizard_same', receipt: { agent_id: 'hermes', session_id: 'wizard_same' },
    })
    const path = join(directory(), 'manifest.json'), text = JSON.stringify({ version: 1, entries: [{ sessionId: 'wizard_same' }] })
    writeFileSync(path, text)
    const migrate = () => migrateJson(path, value => ({ ...value, entries: value.entries.map((entry: any) => qualifyContinuation(entry)) }))
    expect(migrate()).toBe(true); expect(migrate()).toBe(false)
    expect(readFileSync(path + suffix, 'utf8')).toBe(text)
    expect(existsSync(path + suffix)).toBe(true)
  })
})
