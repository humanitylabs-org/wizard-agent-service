import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, existsSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPhotoProjection, createChatPhotoReconciler, readPhotoBytes } from '../server/chat-photo-projection.mjs'
import { createChatPhotoReferenceResolver } from '../server/service.mjs'
const PNG = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex')
const provenance = { role: 'user', agent_id: 'main', thread_id: 'wizard_123_abc', message_id: '1', sent_at: '2026-10-15T00:00:00.000Z' }
test('missing delivery authorization blocks activation before filesystem changes', () => {
  const statePath = join(tmpdir(), 'must-not-create-chat-photos', 'state.json')
  assert.equal(existsSync(statePath), false)
  assert.throws(() => createChatPhotoReconciler({ statePath }), /delivery-evidence adapter required/)
  assert.equal(existsSync(statePath), false)
})
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'chat-photos-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, projection: createPhotoProjection({ root, ownerLabel: 'Owner', agentLabel: 'Assistant' }) }
}
test('content dedupe retains both senders/all messages and retry is idempotent', t => {
  const { root, projection: p } = setup(t)
  const a = p.publish(PNG, 'image/png', provenance)
  assert.equal(p.publish(PNG, 'image/png', provenance).added, false)
  p.publish(PNG, 'image/png', { ...provenance, role: 'assistant', message_id: '2' })
  p.publish(PNG, 'image/png', { ...provenance, message_id: '3' })
  const m = JSON.parse(readFileSync(p.index))
  assert.equal(m.schema, 1); assert.equal(m.files.length, 1)
  assert.deepEqual(m.files[0].sources.map(s => s.sender_label), ['Owner', 'Assistant', 'Owner'])
  assert.deepEqual(readFileSync(join(root, a.path)), PNG)
})
test('no metadata or photo symlink traversal and existing bytes immutable', t => {
  const { root, projection: p } = setup(t)
  const a = p.publish(PNG, 'image/png', provenance)
  chmodSync(join(root, a.path), 0o600); writeFileSync(join(root, a.path), Buffer.from('different'))
  assert.throws(() => p.publish(PNG, 'image/png', provenance), /hash mismatch/)
  rmSync(p.index); symlinkSync(join(root, 'elsewhere'), p.index)
  assert.throws(() => p.publish(PNG, 'image/png', provenance))
})
test('refuses linked root and private agent evidence', t => {
  const { root, projection: p } = setup(t)
  const linked = join(root, 'alias'); symlinkSync(root, linked)
  assert.throws(() => createPhotoProjection({ root: linked, ownerLabel: 'O', agentLabel: 'A' }), /plain directory/)
  assert.throws(() => p.publish(PNG, 'image/png', { ...provenance, agent_id: 'private' }), /provenance/)
})
test('resolver checks canonical identity, hash, magic, allowlist and private denial', async t => {
  const { root } = setup(t)
  const path = join(root, 'image.png'); writeFileSync(path, PNG)
  const resolveRef = createChatPhotoReferenceResolver({ replayRoots: [root], resolveFiles: async () => [] })
  assert.deepEqual((await resolveRef({ kind: 'agent', path })).bytes, PNG)
  await assert.rejects(resolveRef({ kind: 'agent', path: join(root, 'profiles', 'secret.png') }), /private/)
  await assert.rejects(resolveRef({ kind: 'agent', path: '/elsewhere/file.png' }), /allowlist/)
  await assert.rejects(resolveRef({ kind: 'wizard', id: 'drop_bad', sha256: 'bad' }), /identity/)
  await assert.rejects(resolveRef({ kind: 'inline' }), /canonical replay/)
  const link = join(root, 'image-link.png'); symlinkSync(path, link)
  await assert.rejects(resolveRef({ kind: 'agent', path: link }), /unsafe/)
  assert.throws(() => readPhotoBytes(link))
})
test('storage cap and malformed existing manifest fail closed', t => {
  const { root } = setup(t)
  const p = createPhotoProjection({ root, ownerLabel: 'O', agentLabel: 'A', maxBytes: 1 })
  assert.throws(() => p.publish(PNG, 'image/png', provenance), /budget/)
  writeFileSync(p.index, JSON.stringify({ schema: 1, files: [{ path: '../bad', sha256: 'a'.repeat(64), sources: [] }] }))
  assert.throws(() => p.publish(PNG, 'image/png', provenance), /existing photo entry/)
})
