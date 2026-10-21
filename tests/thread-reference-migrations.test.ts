import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DismissedFailureStore, ThreadSeenStore } from '../server/thread-seen.mjs'
import { ThreadDispositionStore } from '../server/thread-dispositions.mjs'
import { createAgentRegistry } from '../server/agents.mjs'
import { ThreadTitleStore } from '../server/thread-titles.mjs'
import { StatusBackfill } from '../server/thread-status.mjs'
import { SubjectCatalog } from '../server/thread-subjects.mjs'
import { LockedRunBridge } from '../server/locked-run-bridge.mjs'
import { DurableHeavyQueue } from '../server/heavy-queue.mjs'
import { createUploadStore } from '../server/uploads.mjs'
import { migrateJson, migrateJsonLines, qualifyContinuation } from '../server/thread-reference.mjs'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'agent-pair-stores-')); dirs.push(dir); return dir }
const suffix = '.pre-agent-pairs-v1.bak'

describe('agent-pair store migrations', () => {
  it.each(['direct:literal', 'operator:literal'])('raw and runtime-prefixed stores close over write/restart/write/restart for %s', id => {
    const dir = directory(), title = join(dir, 'titles.json'), dismissed = join(dir, 'dismissed.json')
    const seenPath = join(dir, 'seen.json'), dispositionsPath = join(dir, 'dispositions.json')
    for (let generation = 1; generation <= 2; generation++) {
      new ThreadTitleStore(title).recordRename(id, { from: '', to: `Title ${generation}`, by: 'you' })
      new DismissedFailureStore(dismissed).dismiss(id, `run-${generation}`)
      const seen = new ThreadSeenStore(seenPath)
      seen.merge('owner', { initializedAt: 0, threads: { [`direct:${id}`]: { updatedAt: '2026-10-21T00:00:00Z', previewFingerprint: 'abc', seenAt: generation } } })
      new ThreadDispositionStore(dispositionsPath).set('owner', 'direct', id, generation === 1)
      expect(new ThreadTitleStore(title).get(id)).toMatchObject({ title: `Title ${generation}`, session_id: id })
      expect(new DismissedFailureStore(dismissed).isDismissed(id, `run-${generation}`)).toBe(true)
      expect(new ThreadSeenStore(seenPath).get('owner').threads[`direct:${id}`]).toMatchObject({ session_id: id, seenAt: generation })
      expect(new ThreadDispositionStore(dispositionsPath).get('owner')[`direct:${id}`]).toMatchObject({ session_id: id, deferred: generation === 1 })
      const registry = createAgentRegistry({ agentsDir: join(dir, 'agents') }); registry.pin(id, 'hermes')
      expect(createAgentRegistry({ agentsDir: join(dir, 'agents') }).pinnedAgent(id)).toBe('hermes')
      // These are externally authored raw journals, not service mutation APIs.
      const status = join(dir, 'status.json'), subject = join(dir, 'subjects.json'), locked = join(dir, 'locked.json'), journal = join(dir, 'journal.jsonl')
      writeFileSync(status, JSON.stringify({ threads: { [id]: { state: 'done', ask: `Done ${generation}`, assistant_at: generation } } }))
      writeFileSync(subject, JSON.stringify({ subjects: ['Main'], threads: { [id]: { subject: 'Main' } } }))
      writeFileSync(locked, JSON.stringify([['key', { sessionId: id, runId: `run-${generation}`, state: 'done' }]]))
      writeFileSync(journal, JSON.stringify({ sessionId: id }) + '\n')
      for (let restart = 0; restart < 2; restart++) {
        expect(new StatusBackfill(status).lookup(id, generation)?.state).toBe('done')
        expect(new SubjectCatalog(subject).resolve(id, 'Other')).toBe('Main')
        new LockedRunBridge({ origin: 'http://127.0.0.1:1', statePath: locked })
        expect(JSON.parse(readFileSync(locked, 'utf8'))[0][1].session_id).toBe(id)
        migrateJsonLines(journal)
        expect(JSON.parse(readFileSync(journal, 'utf8')).session_id).toBe(id)
      }
    }
  })

  it.each([ThreadTitleStore, SubjectCatalog, StatusBackfill])('malformed optional %s starts degraded without rewriting bytes', Type => {
    const path = join(directory(), 'bad.json'); writeFileSync(path, '{bad')
    const store = new Type(path)
    if (store instanceof ThreadTitleStore) { expect(store.get('id')).toBeNull(); store.recordRename('id', { from: '', to: 'Later', by: 'you' }) }
    if (store instanceof SubjectCatalog) expect(store.resolve('id', 'Original')).toBe('Original')
    if (store instanceof StatusBackfill) expect(store.lookup('id', 1)).toBeNull()
    expect(readFileSync(path, 'utf8')).toBe('{bad')
    expect(existsSync(path + suffix)).toBe(false)
  })
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

  it('status backfills and subject corrections preserve colon ids and independently qualify imported pairs', () => {
    const dir = directory(), statusPath = join(dir, 'status.json'), subjectPath = join(dir, 'subjects.json'), id = 'direct:same'
    const originals = {
      [statusPath]: JSON.stringify({ threads: { [id]: { state: 'done', ask: 'Complete', assistant_at: 10 }, [`agent/imported/${id}`]: { state: 'needs_you', ask: 'Review import', assistant_at: 10 } } }),
      [subjectPath]: JSON.stringify({ subjects: ['Main', 'Imported'], threads: { [id]: { subject: 'Main' }, [`agent/imported/${id}`]: { subject: 'Imported' } } }),
    }
    for (const [path, text] of Object.entries(originals)) writeFileSync(path, text)
    const load = () => {
      const status = new StatusBackfill(statusPath), subjects = new SubjectCatalog(subjectPath)
      expect(status.lookup(id, 10)?.state).toBe('done'); expect(status.lookup(id, 10, 'imported')?.state).toBe('needs_you')
      expect(subjects.resolve(id, 'Old')).toBe('Main'); expect(subjects.resolve(id, 'Old', 'imported')).toBe('Imported')
      expect(JSON.parse(readFileSync(statusPath, 'utf8')).threads[id]).toMatchObject({ agent_id: 'hermes', session_id: id })
    }
    load()
    const migrated = Object.fromEntries(Object.keys(originals).map(path => [path, readFileSync(path, 'utf8')]))
    load()
    for (const [path, original] of Object.entries(originals)) {
      expect(readFileSync(path, 'utf8')).toBe(migrated[path]); expect(readFileSync(path + suffix, 'utf8')).toBe(original)
      writeFileSync(path, original)
    }
    load()
    for (const path of Object.keys(originals)) expect(readFileSync(path, 'utf8')).toBe(migrated[path])
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
