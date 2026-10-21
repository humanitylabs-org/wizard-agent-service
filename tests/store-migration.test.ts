import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { migrateJson, qualifyRawThreadRecords } from '../server/thread-reference.mjs'
import { atomicStoreWrite, withSqliteMigration, migrationEntry, validateBackup, restoreStoreSet, INVENTORY_NAME, BACKUP_SUFFIX } from '../server/store-migration.mjs'
import { createAgentRegistry } from '../server/agents.mjs'
import { ThreadSeenStore } from '../server/thread-seen.mjs'
import { DurableHeavyQueue } from '../server/heavy-queue.mjs'
import { archivedMainDir } from './support/archived-main'
// These compare against archived main and spawn helpers; under CI load they exceed the 5 s default.
vi.setConfig({ testTimeout: 60_000 })

const dirs: string[] = []
const directory = () => { const d = mkdtempSync(join(tmpdir(), 'migration-proof-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const hash = (s: Buffer) => createHash('sha256').update(s).digest('hex')
const qualify = (v: any) => ({ ...v, threads: qualifyRawThreadRecords(v.threads) })

describe('transactional pair migration and restoration', () => {
  it.each(['', '{partial'])('never trusts an interrupted backup (%s)', partial => {
    const path = join(directory(), 'pins.json'), old = JSON.stringify({ threads: { 'direct:x': {} } })
    writeFileSync(path, old); writeFileSync(path + BACKUP_SUFFIX, partial)
    expect(migrateJson(path, qualify)).toBe(true)
    const entry = migrationEntry(path), backup = readFileSync(validateBackup(path))
    expect(backup.toString()).toBe(old)
    expect(entry).toMatchObject({ phase: 'complete', disposition: 'migrated', size: backup.length, sha256: hash(backup) })
    expect(entry.source_generation).toBeTruthy()
    expect(readdirSync(resolve(path, '..')).some(f => f.endsWith('.tmp') || f.endsWith('.lock'))).toBe(false)
  })

  it('detects a corrupt completed backup before further authority mutation', () => {
    const path = join(directory(), 'state.json')
    writeFileSync(path, JSON.stringify({ threads: { x: {} } })); migrateJson(path, qualify)
    const before = readFileSync(path); writeFileSync(path + BACKUP_SUFFIX, '')
    expect(() => migrateJson(path, qualify)).toThrow(/checksum\/size mismatch/)
    expect(readFileSync(path)).toEqual(before)
  })

  it('refuses changed source after backup without replacing the original baseline', () => {
    const dir = directory(), path = join(dir, 'state.json'), old = '{"threads":{"x":{}}}'
    writeFileSync(path, old); migrateJson(path, qualify)
    const manifest = join(dir, INVENTORY_NAME), value = JSON.parse(readFileSync(manifest, 'utf8'))
    value.stores['state.json'].phase = 'backed_up'; writeFileSync(manifest, JSON.stringify(value))
    expect(() => migrateJson(path, qualify)).toThrow(/keep source, keep backup; operator chooses/)
    expect(readFileSync(validateBackup(path), 'utf8')).toBe(old)
    expect(migrationEntry(path).phase).toBe('backed_up')
  })

  it('authority corruption is explicit and never replaced with an empty store', () => {
    const path = join(directory(), 'pins.json'); writeFileSync(path, '{bad')
    expect(() => migrateJson(path, qualify)).toThrow(/authority store migration could not be validated/)
    expect(readFileSync(path, 'utf8')).toBe('{bad')
  })

  it('malformed qualified pin and run-index authority is not treated as missing/empty', () => {
    for (const [name, value] of [['.threads.json', { schema: 2, threads: null }], ['.threads.json', { schema: 2, threads: { wrong: { agent_id: 'hermes', session_id: 'x' } } }], ['.run-threads.json', { schema: 1, runs: { id: [{}] } }]] as const) {
      const dir = directory(), path = join(dir, name), bytes = JSON.stringify(value)
      writeFileSync(path, bytes)
      expect(() => createAgentRegistry({ agentsDir: dir })).toThrow(/authority store migration could not be validated/)
      expect(readFileSync(path, 'utf8')).toBe(bytes)
    }
  })

  it('retries a concurrent legacy writer generation without losing its row or rollback bytes', () => {
    const path = join(directory(), 'state.json')
    writeFileSync(path, JSON.stringify({ threads: { before: {} } }))
    let raced = false
    migrateJson(path, (value: any) => {
      if (!raced) { raced = true; writeFileSync(path, JSON.stringify({ threads: { before: {}, concurrent: {} } })) }
      return qualify(value)
    })
    expect(JSON.parse(readFileSync(path, 'utf8')).threads.concurrent.session_id).toBe('concurrent')
    expect(JSON.parse(readFileSync(validateBackup(path), 'utf8')).threads.concurrent).toEqual({})
  })

  it('enforces cross-process writer ownership during read/transform/backup/replace', () => {
    const path = join(directory(), 'state.json'); writeFileSync(path, '{"threads":{"before":{}}}')
    const module = resolve('server/store-migration.mjs')
    migrateJson(path, (value: any) => {
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { atomicStoreWrite } from ${JSON.stringify(module)};
        try { atomicStoreWrite(process.argv[1], '{}'); process.exit(4) }
        catch(e) { if(!e.message.includes('exclusive writer ownership')) throw e; console.log('writer blocked') }
      `, path], { encoding: 'utf8' })
      expect(output.trim()).toBe('writer blocked')
      return qualify(value)
    })
    expect(JSON.parse(readFileSync(path, 'utf8')).threads.before.session_id).toBe('before')
  })

  it('SQLite backup includes WAL, repairs a partial backup and fences concurrent native SQL writers', () => {
    const path = join(directory(), 'queue.sqlite'), db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE rows(id TEXT); INSERT INTO rows VALUES(\'committed-wal\')')
    writeFileSync(path + BACKUP_SUFFIX, '')
    withSqliteMigration(db, path, true, () => {
      const writer = new DatabaseSync(path); writer.exec('PRAGMA busy_timeout=1')
      expect(() => writer.exec("INSERT INTO rows VALUES('racer')")).toThrow(/locked/)
      writer.close(); db.exec('ALTER TABLE rows ADD COLUMN agent_id TEXT DEFAULT \'hermes\'')
    })
    const backup = new DatabaseSync(validateBackup(path), { readOnly: true })
    expect(backup.prepare('SELECT * FROM rows').all()).toEqual([{ id: 'committed-wal' }]); backup.close(); db.close()
  })

  it('new stores are inventoried; restore validates the entire set and requires stopped service', () => {
    const dir = directory(), existing = join(dir, 'existing.json'), fresh = join(dir, 'new.json')
    writeFileSync(existing, '{"threads":{"x":{}}}'); migrateJson(existing, qualify)
    atomicStoreWrite(fresh, '{"new":true}')
    expect(migrationEntry(fresh)).toMatchObject({ disposition: 'created', source_generation: 'absent' })
    expect(() => restoreStoreSet([dir])).toThrow(/stopped-service/)
    writeFileSync(existing + BACKUP_SUFFIX, 'broken')
    expect(() => restoreStoreSet([dir], { serviceStopped: true })).toThrow()
    expect(existsSync(fresh)).toBe(true)
  })

  it('migrate -> restore -> actual archived 859c548 modules preserve pins, seen and heavy submissions', context => {
    const archived = archivedMainDir()
    if (!archived) { const reason = 'Rollback rehearsal needs WAS_ROLLBACK_BASE_DIR or git object 859c548'; console.warn(reason); context.skip(reason); return }
    const dir = directory(), old = archived, stores = join(dir, 'stores'), agentsDir = join(stores, 'agents')
    mkdirSync(stores)
    const driver = `
      import { createAgentRegistry } from ${JSON.stringify(join(old, 'server/agents.mjs'))};
      import { ThreadSeenStore } from ${JSON.stringify(join(old, 'server/thread-seen.mjs'))};
      import { DurableHeavyQueue } from ${JSON.stringify(join(old, 'server/heavy-queue.mjs'))};
      const [dir, mode] = process.argv.slice(1);
      const registry = createAgentRegistry({agentsDir:dir+'/agents',runtime:{apply:async()=>({}),start:async()=>({}),stop:async()=>({})},fetchImpl:async()=>Response.json({providers:[]})});
      const seen = new ThreadSeenStore(dir+'/seen.json');
      const heavy = new DurableHeavyQueue({statePath:dir+'/heavy.sqlite',intervalMs:0,transport:async()=>({}),continuation:async()=>({}),current:async()=>true});
      if(mode==='seed') {
        const {agent}=await registry.create({label:'Legacy Private',permissions:{preset:'private'},model:{provider:'tinfoil',model:'glm-5-3'}});
        registry.pin('direct:literal',agent.id);
        seen.merge('owner',{initializedAt:0,threads:{'direct:direct:literal':{updatedAt:'2026-10-21T00:00:00Z',previewFingerprint:'abc',seenAt:1}}});
      }
      const job=heavy.submit({sessionId:'operator:literal',origin:'origin',key:mode,spec:{cwd:'/Volumes/ThalesMedia/tests',argv:['true'],timeout_seconds:1}});
      console.log(JSON.stringify({pin:registry.pinnedAgent('direct:literal'),seen:seen.get('owner'),job:job.job_id}));heavy.close();
    `
    const runOld = (mode: string) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', driver, stores, mode], { encoding: 'utf8' }).trim())
    const before = runOld('seed')
    const registry = createAgentRegistry({ agentsDir }); expect(registry.pinnedAgent('direct:literal')).toBe(before.pin)
    new ThreadSeenStore(join(stores, 'seen.json'))
    const heavy = new DurableHeavyQueue({ statePath: join(stores, 'heavy.sqlite'), intervalMs: 0, transport: async () => ({}), continuation: async () => ({}), current: async () => true }); heavy.close()
    // Simulate new-only indexes and metadata written after the rollback baseline.
    registry.noteRun('new-run', 'hermes', 'new-thread')
    atomicStoreWrite(join(stores, 'new-only.json'), '{"post_backup":true}')
    writeFileSync(join(stores, 'heavy.sqlite-wal'), 'stale'); writeFileSync(join(stores, 'heavy.sqlite-shm'), 'stale')
    restoreStoreSet([stores, agentsDir], { serviceStopped: true })
    expect(existsSync(join(stores, 'new-only.json'))).toBe(false)
    expect(existsSync(join(stores, 'heavy.sqlite-wal'))).toBe(false)
    expect(existsSync(join(stores, 'heavy.sqlite-shm'))).toBe(false)
    const after = runOld('restored')
    expect(after.pin).toBe(before.pin); expect(after.seen).toEqual(before.seen); expect(after.job).toMatch(/^heavy_/)
    expect(after.job).not.toBe(before.job)
  })
})
