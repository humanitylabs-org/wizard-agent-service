import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, existsSync, rmSync, chmodSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createPhotoProjection, createChatPhotoReconciler, acquirePhotoLock, atomicPhotoJson } from '../server/chat-photo-projection.mjs'
import { createCanonicalChatPhotoResolver, photoAuthorityId, eligiblePhotoSession, createPhotoRuntimeVerifier } from '../server/chat-photo-authority.mjs'
const PNG = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex')
const binding = { ownerId: '123', authorityId: 'a'.repeat(64), ownerLabel: 'Owner', agentLabel: 'Assistant', maxBytes: 1024 * 1024, verifyAuthority: async () => {} }
const provenance = { role: 'user', agent_id: 'main', owner_id: binding.ownerId, authority_id: binding.authorityId, thread_id: 'wizard_123_abc', message_id: '1', sent_at: '2026-10-15T00:00:00.000Z' }
function setup(t) { const root = mkdtempSync(join(tmpdir(), 'chat-photos-')); t.after(() => rmSync(root, { recursive: true, force: true })); return { root, projection: createPhotoProjection({ root, ...binding }) } }
test('off unless explicit authenticated single-owner runtime and adapter', t => {
  assert.throws(() => photoAuthorityId({}), /authenticated/)
  const statePath = join(tmpdir(), 'must-not-create-chat-photos', 'state.json')
  assert.throws(() => createChatPhotoReconciler({ statePath }), /canonical owner/)
  assert.equal(existsSync(statePath), false)
})
test('content dedupe retains both roles and idempotent replay', async t => {
  const { root, projection: p } = setup(t)
  const a = await p.publish(PNG, 'image/png', provenance)
  assert.equal((await p.publish(PNG, 'image/png', provenance)).added, false)
  await p.publish(PNG, 'image/png', { ...provenance, role: 'assistant', message_id: '2' })
  const m = JSON.parse(readFileSync(p.index)); assert.equal(m.files.length, 1)
  assert.deepEqual(m.files[0].sources.map(s => s.sender_label), ['Owner', 'Assistant'])
  assert.deepEqual(readFileSync(join(root, a.path)), PNG)
})
test('owner binding, wrong agent and forged existing source fail closed', async t => {
  const { projection: p } = setup(t)
  await assert.rejects(p.publish(PNG, 'image/png', { ...provenance, owner_id: 'other' }), /provenance/)
  await assert.rejects(p.publish(PNG, 'image/png', { ...provenance, agent_id: 'private' }), /provenance/)
  await p.publish(PNG, 'image/png', provenance)
  let m = JSON.parse(readFileSync(p.index)); m.owner_id = 'other'; writeFileSync(p.index, JSON.stringify(m))
  await assert.rejects(p.publish(PNG, 'image/png', provenance), /binding/)
  m.owner_id = binding.ownerId; m.files[0].sources[0].agent_id = 'private'; writeFileSync(p.index, JSON.stringify(m))
  await assert.rejects(p.publish(PNG, 'image/png', provenance), /photo entry/)
})
test('symlinks and changed immutable bytes fail closed', async t => {
  const { root, projection: p } = setup(t); const a = await p.publish(PNG, 'image/png', provenance)
  chmodSync(join(root, a.path), 0o600); writeFileSync(join(root, a.path), 'different')
  await assert.rejects(p.publish(PNG, 'image/png', provenance), /hash mismatch/)
  const linked = join(root, 'alias'); symlinkSync(root, linked)
  await assert.rejects(createPhotoProjection({ root: linked, ...binding }).publish(PNG, 'image/png', provenance), /plain directory/)
})
test('OS lock released when owning parent is killed', async t => {
  const { root } = setup(t); const path = join(root, 'crash.lock')
  const module = new URL('../server/chat-photo-projection.mjs', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {acquirePhotoLock} from ${JSON.stringify(module)}; await acquirePhotoLock(${JSON.stringify(path)}); console.log('ready'); setInterval(()=>{},1000)`], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise(r => child.stdout.once('data', r))
  await assert.rejects(acquirePhotoLock(path), /busy/)
  const exited = new Promise(r => child.once('exit', r)); child.kill('SIGKILL'); await exited
  let release; for (let i = 0; i < 20 && !release; i++) { try { release = await acquirePhotoLock(path) } catch { await new Promise(r => setTimeout(r, 50)) } }
  assert.ok(release); await release()
})
test('durable transient retry survives cursor advance and process reconstruction', async t => {
  const { root, projection } = setup(t); const statePath = join(root, 'state.json')
  const message = { thread_id: provenance.thread_id, message_id: '1', role: 'user', timestamp: 1792022400, refs: [{}] }
  const scanBatch = async state => ({ evidence: state.cursor ? [] : [message], counts: {}, cursor: 1, ceiling: 1, done: true })
  const r = createChatPhotoReconciler({ database: '', statePath, ...binding, projection, scanBatch, resolveMessage: async () => { throw new Error('temporary network') } })
  await r.step(); let state = JSON.parse(readFileSync(statePath)); assert.equal(state.cursor, 1); assert.equal(state.pending.length, 1)
  state.pending[0].after = 0; atomicPhotoJson(statePath, state)
  const r2 = createChatPhotoReconciler({ database: '', statePath, ...binding, projection, scanBatch, resolveMessage: async () => ({ photos: [{ bytes: PNG, mime: 'image/png' }], unavailable: [] }) })
  assert.equal((await r2.step()).pending, 0); assert.equal(JSON.parse(readFileSync(projection.index)).files.length, 1)
})
test('fatal publication failure does not commit cursor; recovery replays exactly once', async t => {
  const { root, projection } = setup(t); const statePath = join(root, 'state.json')
  const opts = { statePath, ...binding, scanBatch: async () => ({ evidence: [{ thread_id: provenance.thread_id, message_id: '1', role: 'user', timestamp: 1792022400 }], counts: {}, cursor: 1, ceiling: 1, done: true }), resolveMessage: async () => ({ photos: [{ bytes: PNG, mime: 'image/png' }], unavailable: [] }) }
  await assert.rejects(createChatPhotoReconciler({ ...opts, projection: { publish() { throw new Error('storage_placement_required') } } }).step(), /storage/)
  assert.equal(existsSync(statePath), false)
  await createChatPhotoReconciler({ ...opts, projection }).step(); assert.equal(JSON.parse(readFileSync(statePath)).cursor, 1)
})
function fixture(t) {
  const { root } = setup(t), database = join(root, 'history.db'), db = new DatabaseSync(database)
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT,user_id TEXT,chat_id TEXT,chat_type TEXT,profile_name TEXT,hidden INTEGER,parent_session_id TEXT,title TEXT,model_config TEXT,origin_json TEXT,created_source TEXT,transport_profile TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL,display_kind TEXT,tool_calls TEXT,_compressed_summary INTEGER);`)
  const session = { id: 'wizard_123_abc', source: 'api_server', user_id: null, chat_id: null, chat_type: null, profile_name: 'default', hidden: 0, parent_session_id: null, title: 'Owner conversation', model_config: '{}', origin_json: null, created_source: 'unknown', transport_profile: null }
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(session))
  const path = join(root, 'photo.png'); writeFileSync(path, PNG)
  const candidate = { thread_id: session.id, message_id: '1', role: 'assistant', timestamp: 10, refs: [{}] }
  db.prepare('INSERT INTO messages VALUES (1,?,?,?,10,NULL,NULL,0)').run(session.id, 'assistant', `MEDIA:${path}`)
  const opts = { database, ...binding, registry: { pinnedAgent: () => '', agentsDir: join(root, 'agents') }, artifactRoots: [root], resolveFiles: async () => [], resolveHelm: async () => null }
  t.after(() => db.close()); return { root, db, candidate, opts, session }
}
test('canonical main message resolves; pin, owner, hidden and synthetic reject', async t => {
  const { db, candidate, opts, session } = fixture(t)
  assert.equal((await createCanonicalChatPhotoResolver(opts)(candidate)).photos.length, 1)
  assert.equal((await createCanonicalChatPhotoResolver({ ...opts, registry: { pinnedAgent: () => 'private' } })(candidate)).photos.length, 0)
  db.prepare('UPDATE sessions SET user_id=?').run('other')
  assert.equal((await createCanonicalChatPhotoResolver(opts)(candidate)).photos.length, 0)
  for (const change of [{ hidden: 1 }, { parent_session_id: 'helper' }, { created_source: 'cron' }, { transport_profile: 'synthetic' }, { origin_json: '{"visibility":"private"}' }]) assert.equal(eligiblePhotoSession({ ...session, ...change }, '123', ''), false)
})
test('canonical inline and older incoming history; no prose/fenced/private file reads', async t => {
  const { root, db, candidate, opts } = fixture(t)
  const set = (role, content) => db.prepare('UPDATE messages SET role=?,content=?').run(role, content)
  set('user', `[Image attached at: ${join(root, 'photo.png')}]`)
  assert.equal((await createCanonicalChatPhotoResolver(opts)({ ...candidate, role: 'user' })).photos.length, 1)
  set('user', JSON.stringify([{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } }]))
  assert.equal((await createCanonicalChatPhotoResolver(opts)({ ...candidate, role: 'user' })).photos.length, 1)
  for (const content of [`look at ${join(root, 'photo.png')}`, `\u0060\u0060\u0060\nMEDIA:${join(root, 'photo.png')}\n\u0060\u0060\u0060`, `MEDIA:${join(root, 'agents', 'private.png')}`]) {
    set('assistant', content); assert.equal((await createCanonicalChatPhotoResolver(opts)(candidate)).photos.length, 0)
  }
})
