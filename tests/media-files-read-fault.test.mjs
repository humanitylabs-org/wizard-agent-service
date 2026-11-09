// Synthetic only. Run directly: node --test tests/media-files-read-fault.test.mjs
// MEDIA_FILES_SOURCE permits the identical fixture to exercise pinned source snapshots.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const { createMediaFiles } = await import(process.env.MEDIA_FILES_SOURCE
  ? pathToFileURL(resolve(process.env.MEDIA_FILES_SOURCE)).href
  : new URL('../server/media-files.mjs', import.meta.url).href)
const originalRead = fs.readFileSync
const originalStat = fs.statSync
const fixed = () => new Date('2026-11-09T12:00:00Z')
const meta = { filename: 'synthetic.txt', mime: 'text/plain' }

function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'media-read-fault-'))
  const indexPath = join(dir, 'state', 'media.json')
  const options = { indexPath, mediaRoot: join(dir, 'media'), agentRoot: '/synthetic-files', now: fixed }
  const fresh = () => createMediaFiles(options)
  const first = fresh().save(Buffer.from('healthy synthetic attachment'), meta)
  t.after(() => {
    fs.readFileSync = originalRead
    fs.statSync = originalStat
    syncBuiltinESMExports()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { dir, indexPath, fresh, first }
}

function inject(indexPath, kind, code = 'EIO', once = false) {
  let calls = 0
  const key = kind === 'stat' ? 'statSync' : 'readFileSync'
  const original = kind === 'stat' ? originalStat : originalRead
  fs[key] = function (path, ...args) {
    if (String(path) === indexPath && (!once || calls === 0)) {
      calls += 1
      if (kind === 'parse') return '{ transient truncated JSON'
      throw Object.assign(new Error(`synthetic ${code}`), { code })
    }
    return original(path, ...args)
  }
  syncBuiltinESMExports()
  return () => calls
}

for (const kind of ['read', 'parse']) {
  test(`transient ${kind} on get: unchanged stamp recovers before save without losing records`, (t) => {
    const { indexPath, fresh, first } = fixture(t)
    const store = fresh()
    const before = originalRead(indexPath, 'utf8')
    const stamp = originalStat(indexPath, { bigint: true })
    const calls = inject(indexPath, kind, 'EIO', true)
    // Old implementations return null; the repair fails closed. Both must retry after recovery.
    let initial
    try { initial = store.get(first.id) } catch (error) { initial = error.code || error.name }
    const recovered = store.get(first.id)
    const stable = store.get(first.id)
    const after = originalStat(indexPath, { bigint: true })
    const added = store.save(Buffer.from('later synthetic attachment'), { ...meta, filename: 'later.txt' })
    const ids = JSON.parse(originalRead(indexPath, 'utf8')).files.map((r) => r.id)
    const oldRetained = ids.includes(first.id)
    t.diagnostic(JSON.stringify({ kind, initial: initial === null ? null : typeof initial, recovered: !!recovered, stable: !!stable, oldRetained, count: ids.length, injected: calls() }))
    assert.equal(originalRead(indexPath, 'utf8') === before, false, 'the later save adds a record')
    assert.deepEqual([after.ino, after.size, after.mtimeNs], [stamp.ino, stamp.size, stamp.mtimeNs], 'fault and recovery do not rewrite metadata')
    assert.equal(recovered?.id, first.id, 'healthy index must be reread after the one-shot fault')
    assert.equal(stable?.id, first.id)
    assert.deepEqual(new Set(ids), new Set([first.id, added.id]), 'save after recovery retains the pre-fault record')
  })
}

for (const kind of ['read', 'stat']) for (const code of ['EACCES', 'EIO']) {
  test(`${kind} ${code}: get/list/save/adopt fail closed and recovery preserves metadata`, (t) => {
    const { dir, indexPath, fresh, first } = fixture(t)
    const store = fresh()
    // Prime a stale cache, then replace the index as an external sequential writer would.
    assert.equal(store.get(first.id)?.id, first.id)
    const replacement = `${indexPath}.external`
    fs.writeFileSync(replacement, originalRead(indexPath))
    fs.renameSync(replacement, indexPath)
    const before = originalRead(indexPath)
    const stage = join(dir, 'synthetic-stage')
    fs.writeFileSync(stage, 'staged bytes')
    inject(indexPath, kind, code)
    const expected = (e) => e.code === code
    assert.throws(() => store.get(first.id), expected)
    assert.throws(() => store.list(), expected)
    assert.throws(() => store.save(Buffer.from('must not save'), meta), expected)
    assert.throws(() => store.adopt(stage, { ...meta, bytes: 12, sha256: 'synthetic' }), expected)
    assert.deepEqual(originalRead(indexPath), before)
    assert.equal(fs.existsSync(stage), true, 'failed adopt leaves staging intact')
    fs.readFileSync = originalRead
    fs.statSync = originalStat
    syncBuiltinESMExports()
    assert.equal(store.get(first.id)?.id, first.id)
    store.save(Buffer.from('recovered save'), { ...meta, filename: 'recovered.txt' })
    assert.equal(JSON.parse(originalRead(indexPath, 'utf8')).files.length, 2)
  })
}

for (const bad of ['{', '{"files":{}}', '{"files":null}', '{}']) {
  test(`invalid metadata ${bad}: no empty cache or destructive save`, (t) => {
    const { indexPath, fresh, first } = fixture(t)
    const healthy = originalRead(indexPath)
    fs.writeFileSync(indexPath, bad)
    const store = fresh()
    let getError, saveError
    try { store.get(first.id) } catch (error) { getError = error }
    try { store.save(Buffer.from('must not overwrite'), meta) } catch (error) { saveError = error }
    const preserved = originalRead(indexPath, 'utf8') === bad
    t.diagnostic(JSON.stringify({ invalid: bad, getFailedClosed: !!getError, saveFailedClosed: !!saveError, preserved }))
    assert.ok(getError, 'invalid metadata must fail closed on get')
    assert.ok(saveError, 'invalid metadata must fail closed before saving')
    assert.equal(preserved, true, 'existing invalid metadata must not be overwritten')
    fs.writeFileSync(indexPath, healthy)
    assert.equal(store.get(first.id)?.id, first.id)
  })
}

test('ENOENT new store, restart and external sequential writer remain supported', (t) => {
  const { dir, indexPath, fresh, first } = fixture(t)
  const missing = join(dir, 'new-state', 'index.json')
  const blank = createMediaFiles({ mediaRoot: join(dir, 'new-media'), agentRoot: '/synthetic-files', indexPath: missing, now: fixed })
  assert.deepEqual(blank.list(), [])
  assert.equal(blank.get(first.id), null)
  const saved = blank.save(Buffer.from('new store'), meta)
  assert.equal(blank.get(saved.id)?.id, saved.id)
  const store = fresh()
  assert.equal(store.get(first.id)?.id, first.id, 'restart')
  const other = fresh().save(Buffer.from('external sequential writer'), { ...meta, filename: 'external.txt' })
  assert.equal(store.get(other.id)?.id, other.id)
  assert.equal(store.list().length, 2)
  const before = originalRead(indexPath)
  store.get(first.id)
  assert.deepEqual(originalRead(indexPath), before, 'ordinary lookup does not rewrite index')
})
