import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveVoiceRecoveryReceipt } from '../server/voice-recovery-receipt.mjs'

const temporaryDirectories: string[] = []
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const originalInput = 'Please keep the original recording and reconcile this exact completed request.'
const audio = Buffer.from('synthetic audio bytes: voice recovery fixture, never production data')
const context = '\n\n[Archimedes recovery context\nPrivate operator context and /private/audio/path; not part of the input fingerprint.]'

function editDatabase(path: string, callback: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(path)
  try { callback(db) } finally { db.close() }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'wizard-voice-receipt-'))
  temporaryDirectories.push(directory)
  const queueDbPath = join(directory, 'queue.sqlite3')
  const inboxDbPath = join(directory, 'inbox', 'uploads.sqlite3')
  const blobRoot = join(dirname(inboxDbPath), 'blobs')
  const audioSha256 = sha256(audio)
  const blobPath = join(blobRoot, audioSha256.slice(0, 2), audioSha256)
  mkdirSync(dirname(blobPath), { recursive: true })
  writeFileSync(blobPath, audio)
  const request = {
    sessionId: '20260920_120000_fixture-session',
    intentId: 'voice-intent-original-123',
    sourceFileId: 'drop_fixture_123',
    audioSha256,
    inputSha256: sha256(originalInput),
  }
  const entry = {
    sessionId: request.sessionId,
    sourceFileId: request.sourceFileId,
    audioSha256,
    inputSha256: request.inputSha256,
    recoveredRunId: 'wizardq_0123456789abcdef0123456789abcdef',
    recoveryIdempotencyKey: `recover-voice-${request.sourceFileId}`,
  }
  const manifestPath = join(directory, 'voice-recovery.json')
  const manifest = { version: 1, entries: [entry] }
  const saveManifest = () => writeFileSync(manifestPath, JSON.stringify(manifest))
  saveManifest()
  editDatabase(queueDbPath, (db) => {
    db.exec(`CREATE TABLE wizard_run_queue (
      public_run_id TEXT PRIMARY KEY, runtime TEXT, session_id TEXT,
      idempotency_key TEXT, status TEXT, body TEXT)`)
    db.prepare('INSERT INTO wizard_run_queue VALUES (?, ?, ?, ?, ?, ?)').run(
      entry.recoveredRunId, 'direct', request.sessionId, entry.recoveryIdempotencyKey, 'completed',
      JSON.stringify({ session_id: request.sessionId, input: originalInput + context }),
    )
  })
  editDatabase(inboxDbPath, (db) => {
    db.exec(`CREATE TABLE uploads (id TEXT PRIMARY KEY, device_id TEXT, client_upload_id TEXT,
      filename TEXT, mime TEXT, bytes INTEGER, sha256 TEXT, note TEXT, offset INTEGER,
      status TEXT, drop_id TEXT, created_at REAL, updated_at REAL);
      CREATE TABLE drops (id TEXT PRIMARY KEY, upload_id TEXT, device_id TEXT, filename TEXT,
      mime TEXT, bytes INTEGER, sha256 TEXT, note TEXT, duplicate_of TEXT, blob_path TEXT, created_at REAL)`)
    db.prepare('INSERT INTO uploads (id, drop_id, sha256, status, bytes) VALUES (?, ?, ?, ?, ?)').run(
      'upload-fixture-123', request.sourceFileId, audioSha256, 'RECEIVED', audio.length,
    )
    db.prepare('INSERT INTO drops (id, upload_id, sha256, bytes, blob_path) VALUES (?, ?, ?, ?, ?)').run(
      request.sourceFileId, 'upload-fixture-123', audioSha256, audio.length, relative(dirname(inboxDbPath), blobPath),
    )
  })
  const args = { request, manifestPath, queueDbPath, inboxDbPath, blobRoot }
  const receipt = { version: 1, ...request, runId: entry.recoveredRunId, status: 'completed' }
  return { directory, blobPath, entry, manifest, saveManifest, args, receipt }
}

function setRunBody(f: ReturnType<typeof fixture>, body: unknown) {
  editDatabase(f.args.queueDbPath, (db) => db.prepare('UPDATE wizard_run_queue SET body = ?').run(JSON.stringify(body)))
}

function databaseSnapshot(path: string) {
  return { bytes: readFileSync(path), mtime: statSync(path).mtimeMs }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('read-only voice recovery receipt', () => {
  it('binds an exact synthetic legacy recovery to the caller intent without exposing private data', () => {
    const f = fixture()
    expect(resolveVoiceRecoveryReceipt(f.args)).toEqual(f.receipt)
    expect(resolveVoiceRecoveryReceipt({ ...f.args, request: { ...f.args.request, intentId: 'another-local-intent' } }))
      .toEqual({ ...f.receipt, intentId: 'another-local-intent' })
    expect(Object.keys(resolveVoiceRecoveryReceipt(f.args)!)).toEqual([
      'version', 'sessionId', 'intentId', 'sourceFileId', 'audioSha256', 'inputSha256', 'runId', 'status',
    ])
  })

  it('normalizes whitespace only and fingerprints the prefix before the literal recovery marker', () => {
    const f = fixture()
    setRunBody(f, { input: ` \t${originalInput.replaceAll(' ', '\t \n')} \r\n${context}` })
    expect(resolveVoiceRecoveryReceipt(f.args)).toEqual(f.receipt)
    setRunBody(f, { input: originalInput })
    expect(resolveVoiceRecoveryReceipt(f.args)).toEqual(f.receipt)
    setRunBody(f, { input: originalInput + '\n\n[archimedes recovery context: wrong case]' })
    expect(resolveVoiceRecoveryReceipt(f.args)).toBeNull()
  })

  it.each(['sessionId', 'sourceFileId', 'audioSha256'] as const)(
    'requires exact manifest %s rather than matching hashes alone', (field) => {
      const f = fixture()
      const wrong = field.endsWith('Sha256') ? '0'.repeat(64) : 'wrong-safe-id'
      expect(resolveVoiceRecoveryReceipt({ ...f.args, request: { ...f.args.request, [field]: wrong } })).toBeNull()
    },
  )

  it('blocks retry with 409 when the same attested audio has different saved text', () => {
    const f = fixture()
    expect(() => resolveVoiceRecoveryReceipt({ ...f.args, request: { ...f.args.request, inputSha256: sha256('extra saved text') } }))
      .toThrow(expect.objectContaining({ status: 409, message: 'Saved text differs from recovered request; recording retained' }))
  })

  it.each([
    ['public_run_id', 'wizardq_ffffffffffffffffffffffffffffffff'],
    ['runtime', 'operator'],
    ['session_id', 'another-session'],
    ['idempotency_key', 'another-key'],
    ['status', 'queued'], ['status', 'running'], ['status', 'failed'],
    ['status', 'cancelled'], ['status', 'interrupted'], ['status', 'COMPLETED'],
  ])('rejects a queue row with mismatched %s=%s', (column, value) => {
    const f = fixture()
    editDatabase(f.args.queueDbPath, (db) => db.prepare(`UPDATE wizard_run_queue SET ${column} = ?`).run(value))
    expect(resolveVoiceRecoveryReceipt(f.args)).toBeNull()
  })

  it('requires the exact recover-voice-sourceFileId key even when manifest and queue agree', () => {
    const f = fixture()
    f.entry.recoveryIdempotencyKey = 'recover-voice-another-drop'
    f.saveManifest()
    editDatabase(f.args.queueDbPath, (db) => db.prepare('UPDATE wizard_run_queue SET idempotency_key = ?').run(f.entry.recoveryIdempotencyKey))
    expect(resolveVoiceRecoveryReceipt(f.args)).toBeNull()
  })

  it.each([
    { input: 'An unrelated request with the same audio file.' },
    { input: originalInput.toLowerCase() },
    { input: originalInput.slice(0, -1) },
    { input: ['not a string'] },
    { title: originalInput },
    { input: originalInput, session_id: 'another-session' },
    null,
  ])('rejects a body without the exact normalized input and session binding: %j', (body) => {
    const f = fixture()
    setRunBody(f, body)
    expect(resolveVoiceRecoveryReceipt(f.args)).toBeNull()
  })

  it.each([
    ['drop_id', 'another-drop'], ['sha256', '0'.repeat(64)], ['status', 'PENDING'],
    ['status', 'received'], ['bytes', audio.length + 1], ['bytes', -1], ['bytes', 1.5],
  ])('rejects mismatched upload %s=%s', (column, value) => {
    const f = fixture()
    editDatabase(f.args.inboxDbPath, (db) => db.prepare(`UPDATE uploads SET ${column} = ?`).run(value))
    expect(resolveVoiceRecoveryReceipt(f.args)).toBeNull()
  })

  it.each([
    ['id', 'another-drop'], ['upload_id', 'another-upload'],
    ['sha256', '0'.repeat(64)], ['bytes', audio.length + 1],
  ])('requires the drop to agree with its upload: %s=%s', (column, value) => {
    const f = fixture()
    editDatabase(f.args.inboxDbPath, (db) => db.prepare(`UPDATE drops SET ${column} = ?`).run(value))
    expect(resolveVoiceRecoveryReceipt(f.args)).toBeNull()
  })

  it('requires actual audio bytes, not just the recorded hash and size', () => {
    const f = fixture()
    writeFileSync(f.blobPath, Buffer.alloc(audio.length, 'x'))
    expect(resolveVoiceRecoveryReceipt(f.args)).toBeNull()
  })

  it.each(['traversal', 'sibling-prefix', 'symlink', 'parent-symlink', 'absolute', 'directory'])('rejects unsafe blob path: %s', (kind) => {
    const f = fixture()
    const outside = join(dirname(f.args.inboxDbPath), 'blobs-untrusted', 'audio')
    mkdirSync(dirname(outside), { recursive: true })
    writeFileSync(outside, audio)
    let blobPath = relative(dirname(f.args.inboxDbPath), outside)
    if (kind === 'traversal') blobPath = 'blobs/../blobs-untrusted/audio'
    if (kind === 'absolute') blobPath = f.blobPath
    if (kind === 'symlink') {
      rmSync(f.blobPath)
      symlinkSync(outside, f.blobPath)
      blobPath = relative(dirname(f.args.inboxDbPath), f.blobPath)
    }
    if (kind === 'parent-symlink') {
      symlinkSync(dirname(outside), join(f.args.blobRoot, 'escape'))
      blobPath = 'blobs/escape/audio'
    }
    if (kind === 'directory') blobPath = relative(dirname(f.args.inboxDbPath), dirname(f.blobPath))
    editDatabase(f.args.inboxDbPath, (db) => db.prepare('UPDATE drops SET blob_path = ?').run(blobPath))
    expect(resolveVoiceRecoveryReceipt(f.args)).toBeNull()
  })

  it.each(['manifestPath', 'queueDbPath', 'inboxDbPath', 'blobRoot', 'blobPath'] as const)('returns null for missing %s without creating it', (field) => {
    const f = fixture()
    const path = field === 'blobPath' ? f.blobPath : f.args[field]
    rmSync(path, { recursive: true })
    const before = readdirSync(f.directory, { recursive: true }).sort()
    expect(resolveVoiceRecoveryReceipt(f.args)).toBeNull()
    expect(readdirSync(f.directory, { recursive: true }).sort()).toEqual(before)
  })

  it.each(['queue', 'upload', 'manifest'])('returns null when the exact %s record is absent', (kind) => {
    const f = fixture()
    if (kind === 'queue') editDatabase(f.args.queueDbPath, (db) => db.exec('DELETE FROM wizard_run_queue'))
    if (kind === 'upload') editDatabase(f.args.inboxDbPath, (db) => db.exec('DELETE FROM uploads'))
    if (kind === 'manifest') { f.manifest.entries = []; f.saveManifest() }
    expect(resolveVoiceRecoveryReceipt(f.args)).toBeNull()
  })

  it('rejects ambiguous manifest matches instead of selecting a candidate', () => {
    const f = fixture()
    f.manifest.entries.push({ ...f.entry, recoveredRunId: 'another-completed-run' })
    f.saveManifest()
    expect(resolveVoiceRecoveryReceipt(f.args)).toBeNull()
  })

  it.each([null, [], 'request', {}, { extra: true }])('rejects malformed request shape %j with status 400', (request) => {
    const f = fixture()
    expect(() => resolveVoiceRecoveryReceipt({ ...f.args, request })).toThrow(expect.objectContaining({ status: 400 }))
  })

  it.each(['sessionId', 'intentId', 'sourceFileId'] as const)('validates safe IDs without normalizing %s', (field) => {
    const f = fixture()
    for (const value of ['', '../escape', 'bad/id', 'bad\\id', 'bad.id', 'bad id', 'id\n', ' id', 'é', 'a'.repeat(257), 123, null]) {
      expect(() => resolveVoiceRecoveryReceipt({ ...f.args, request: { ...f.args.request, [field]: value } }))
        .toThrow(expect.objectContaining({ status: 400 }))
    }
  })

  it.each(['audioSha256', 'inputSha256'] as const)('validates lowercase 64-hex %s without normalization', (field) => {
    const f = fixture()
    for (const value of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), `${'a'.repeat(64)}\n`, 123, null]) {
      expect(() => resolveVoiceRecoveryReceipt({ ...f.args, request: { ...f.args.request, [field]: value } }))
        .toThrow(expect.objectContaining({ status: 400 }))
    }
  })

  it('rejects extra and inherited request fields and missing required fields', () => {
    const f = fixture()
    const { intentId: _intentId, ...missingIntent } = f.args.request
    const inherited = Object.create(f.args.request)
    for (const request of [{ ...f.args.request, input: originalInput }, missingIntent, inherited]) {
      expect(() => resolveVoiceRecoveryReceipt({ ...f.args, request })).toThrow(expect.objectContaining({ status: 400 }))
    }
  })

  it.each(['invalid-json', 'version', 'entry', 'extra', 'queue', 'inbox', 'body', 'schema'])('fails closed on broken %s with a sanitized 503', (kind) => {
    const f = fixture()
    if (kind === 'invalid-json') writeFileSync(f.args.manifestPath, '{private/path')
    if (kind === 'version') writeFileSync(f.args.manifestPath, JSON.stringify({ ...f.manifest, version: 2 }))
    if (kind === 'entry') writeFileSync(f.args.manifestPath, JSON.stringify({ version: 1, entries: [null] }))
    if (kind === 'extra') writeFileSync(f.args.manifestPath, JSON.stringify({ ...f.manifest, transcript: originalInput }))
    if (kind === 'queue') writeFileSync(f.args.queueDbPath, 'not a sqlite database')
    if (kind === 'inbox') writeFileSync(f.args.inboxDbPath, 'not a sqlite database')
    if (kind === 'body') editDatabase(f.args.queueDbPath, (db) => db.exec("UPDATE wizard_run_queue SET body = '{private'"))
    if (kind === 'schema') editDatabase(f.args.inboxDbPath, (db) => db.exec('DROP TABLE uploads'))
    expect(() => resolveVoiceRecoveryReceipt(f.args)).toThrow(expect.objectContaining({ status: 503, message: 'Voice recovery receipt unavailable' }))
  })

  it('leaves database bytes, mtimes, blob, manifest, and directory entries unchanged', () => {
    const f = fixture()
    const paths = [f.args.queueDbPath, f.args.inboxDbPath, f.args.manifestPath, f.blobPath]
    const before = paths.map(databaseSnapshot)
    const files = readdirSync(f.directory, { recursive: true }).sort()
    const close = vi.spyOn(DatabaseSync.prototype, 'close')
    for (let index = 0; index < 3; index++) expect(resolveVoiceRecoveryReceipt(f.args)).toEqual(f.receipt)
    expect(paths.map(databaseSnapshot)).toEqual(before)
    expect(readdirSync(f.directory, { recursive: true }).sort()).toEqual(files)
    expect(close).toHaveBeenCalledTimes(6)
  })

  it('closes both connections on a negative lookup and a query failure', () => {
    const f = fixture()
    editDatabase(f.args.inboxDbPath, (db) => db.exec('DROP TABLE uploads'))
    const close = vi.spyOn(DatabaseSync.prototype, 'close')
    expect(() => resolveVoiceRecoveryReceipt(f.args)).toThrow(expect.objectContaining({ status: 503 }))
    expect(close).toHaveBeenCalledTimes(2)
    close.mockClear()
    f.entry.recoveredRunId = 'absent-run'
    f.saveManifest()
    expect(resolveVoiceRecoveryReceipt(f.args)).toBeNull()
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('opens both actual SQLite connections in enforced read-only mode', () => {
    const f = fixture()
    const prepare = DatabaseSync.prototype.prepare
    const connections = new Set<DatabaseSync>()
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (!connections.has(this)) {
        connections.add(this)
        expect(() => this.exec('CREATE TABLE receipt_must_not_write (id TEXT)')).toThrow(/readonly/i)
      }
      return prepare.call(this, sql)
    })
    expect(resolveVoiceRecoveryReceipt(f.args)).toEqual(f.receipt)
    expect(connections.size).toBe(2)
  })

  it('reads committed WAL evidence without changing database or WAL bytes', () => {
    const f = fixture()
    const writer = new DatabaseSync(f.args.queueDbPath)
    try {
      writer.exec("PRAGMA journal_mode = WAL; UPDATE wizard_run_queue SET status = 'running'")
      expect(resolveVoiceRecoveryReceipt(f.args)).toBeNull()
      writer.exec("UPDATE wizard_run_queue SET status = 'completed'")
      const paths = [f.args.queueDbPath, `${f.args.queueDbPath}-wal`, f.args.inboxDbPath]
      const before = paths.map(databaseSnapshot)
      expect(resolveVoiceRecoveryReceipt(f.args)).toEqual(f.receipt)
      expect(paths.map(databaseSnapshot)).toEqual(before)
    } finally { writer.close() }
  })
})
