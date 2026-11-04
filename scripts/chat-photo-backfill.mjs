// Explicit operator command; runtime future coverage is inside service.mjs, not cron.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { createAgentRegistry } from '../server/agents.mjs'
import { createMediaFiles } from '../server/media-files.mjs'
import { createCanonicalFileResolver, createCanonicalHelmPhotoResolver } from '../server/service.mjs'
import { createCanonicalChatPhotoResolver, photoAuthorityId, createPhotoRuntimeVerifier } from '../server/chat-photo-authority.mjs'
import { createPhotoProjection, createChatPhotoReconciler } from '../server/chat-photo-projection.mjs'
const e = process.env, home = e.HERMES_HOME || resolve(homedir(), '.hermes'), osHome = e.WIZARD_OS_HOME || resolve(homedir(), '.wizard-os')
const database = e.WIZARD_HERMES_STATE_PATH, ownerId = e.WIZARD_CHAT_PHOTOS_OWNER_ID
const registry = createAgentRegistry({ agentsDir: e.WIZARD_AGENTS_DIR || resolve(osHome, 'agents') })
const upstreamOrigin = e.HERMES_ORIGIN || 'http://127.0.0.1:8642'
const authorityId = photoAuthorityId({ database, runtimeHome: osHome, ownerId, hermesKey: e.WIZARD_HERMES_API_KEY,
  registryPath: registry.agentsDir, upstreamOrigin, singleOwner: e.WIZARD_CHAT_PHOTOS_SINGLE_OWNER === '1' })
const verifyAuthority = createPhotoRuntimeVerifier({ database, registry, ownerId, upstreamOrigin, hermesKey: e.WIZARD_HERMES_API_KEY })
await verifyAuthority()
const roots = (e.WIZARD_AGENT_ARTIFACT_ROOTS || '').split(':').filter(Boolean)
const mediaFiles = !e.WIZARD_INBOX_INTERNAL_TOKEN && e.WIZARD_MEDIA_ROOT ? createMediaFiles({ mediaRoot: e.WIZARD_MEDIA_ROOT, agentRoot: e.WIZARD_MEDIA_AGENT_ROOT || e.WIZARD_MEDIA_ROOT, indexPath: e.WIZARD_MEDIA_INDEX_PATH || resolve(home, 'state/wizard-mobile/media-files.json') }) : null
const inboxJson = async path => {
  const response = await fetch(`${e.WIZARD_INBOX_ORIGIN || 'http://127.0.0.1:8941'}${path}`, { headers: { Authorization: `Bearer ${e.WIZARD_INBOX_INTERNAL_TOKEN}` }, redirect: 'manual', signal: AbortSignal.timeout(8000) })
  if (!response.ok) throw Object.assign(new Error('inbox_request_failed'), { status: response.status, upstreamStatus: response.status })
  const raw = await response.text(); if (raw.length > 2 * 1024 * 1024) throw new Error('inbox_response_limit'); return JSON.parse(raw)
}
const resolver = createCanonicalChatPhotoResolver({ database, ownerId, authorityId, registry, artifactRoots: roots,
  aliases: mediaFiles && mediaFiles.agentRoot !== mediaFiles.root ? [[mediaFiles.agentRoot, mediaFiles.root]] : [],
  resolveFiles: createCanonicalFileResolver({ mediaFiles, inboxJson, inboxTrustedRoots: (e.WIZARD_INBOX_TRUSTED_ROOT || '').split(':').filter(Boolean).map(p => `${resolve(p)}${sep}`) }),
  resolveHelm: createCanonicalHelmPhotoResolver({ artifactDir: e.WIZARD_AGENT_ARTIFACT_DIR || resolve(home, 'data/apps/wizard-mobile/agent-artifacts'), helmOrigin: e.WIZARD_HELM_ORIGIN || 'http://127.0.0.1:8836', legacyRoot: e.WIZARD_HELM_ATTACHMENTS_ROOT }) })
if (process.argv[2] === '--survey') {
  const directory = process.argv[3], output = process.argv[4]
  if (!directory || !output) throw new Error('--survey requires retained enumeration directory and output receipt')
  const files = new Map(), reasons = {}, samples = {}, examples = []
  let messages = 0, refs = 0
  for (const name of readdirSync(directory).filter(p => /^evidence-.*\.json$/.test(p)).sort()) {
    for (const m of JSON.parse(readFileSync(resolve(directory, name))).evidence) {
      messages++; refs += m.refs.length
      let result
      try { result = await resolver(m) } catch (err) { result = { photos: [], unavailable: [`transient_${err.status || err.code || err.message}`] } }
      for (const reason of result.unavailable) reasons[reason] = (reasons[reason] || 0) + 1
      for (const photo of result.photos) {
        const sha = createHash('sha256').update(photo.bytes).digest('hex')
        const file = files.get(sha) || { sha256: sha, bytes: photo.bytes.length, roles: [] }
        if (!file.roles.includes(m.role)) file.roles.push(m.role)
        files.set(sha, file)
        samples[m.role] ||= { thread_id: m.thread_id, message_id: m.message_id, gateway: m.gateway, sha256: sha }
        if (examples.length < 10) examples.push({ ...samples[m.role], role: m.role })
      }
    }
  }
  const list = [...files.values()]
  const result = { authority_id: authorityId, owner_id: ownerId, messages, refs, unique: list.length, bytes: list.reduce((n, x) => n + x.bytes, 0), max_bytes: Math.max(0, ...list.map(x => x.bytes)), roles: Object.fromEntries(['user', 'assistant'].map(role => [role, list.filter(f => f.roles.includes(role)).length])), reasons, samples, files: list }
  writeFileSync(output, JSON.stringify(result, null, 2), { mode: 0o600 }); console.log(JSON.stringify({ ...result, files: undefined }))
} else if (process.argv[2] === '--backfill') {
  if (e.WIZARD_CHAT_PHOTOS_ENABLED !== '1') throw new Error('explicit activation required')
  const projection = createPhotoProjection({ root: e.WIZARD_USER_FILES_ROOT, ownerId, authorityId, ownerLabel: e.WIZARD_CHAT_PHOTOS_OWNER_LABEL, agentLabel: e.WIZARD_CHAT_PHOTOS_AGENT_LABEL, maxBytes: Number(e.WIZARD_CHAT_PHOTOS_MAX_BYTES) })
  const reconciler = createChatPhotoReconciler({ database, registryPath: registry.agentsDir, ownerId, authorityId, verifyAuthority, statePath: e.WIZARD_CHAT_PHOTOS_STATE_PATH, projection, resolveMessage: resolver })
  for (let i = 0; i < 2000; i++) {
    const result = await reconciler.step(); console.log(JSON.stringify(result))
    if (result?.done) break
    if (result?.pending) await new Promise(r => setTimeout(r, 2000))
    if (i === 1999) throw new Error('bounded backfill needs resume')
  }
} else throw new Error('choose --survey or --backfill')
