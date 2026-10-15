// Deployment-bound main-agent history adapter. Never opens another agent's DB.
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { projectWizardMessageHistory, projectWizardFileMarkers, projectAgentMedia, resolveAgentImage, durableInlineImage } from './service.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export function photoAuthorityId({ database, runtimeHome, registryPath, upstreamOrigin, hermesKey, ownerId, singleOwner }) {
  // The upstream key authenticates this exact main runtime. requireAccess describes
  // only the service's HTTP verifier: some deployments authenticate at their edge.
  // The operator must explicitly bind the single-owner inventory; no HTTP body can
  // set this option. Runtime key, DB, registry home and owner all enter the seal.
  if (!singleOwner || !hermesKey || !ownerId || !runtimeHome || !database || !registryPath || !upstreamOrigin) throw new Error('authenticated single-owner main runtime required')
  return digest(JSON.stringify(['wizard-main-photos-v2', realpathSync(database), realpathSync(runtimeHome), realpathSync(registryPath), upstreamOrigin, digest(hermesKey), ownerId]))
}
export function createPhotoRuntimeVerifier({ database, registry, ownerId, upstreamOrigin, hermesKey, fetchImpl = fetch }) {
  let verifiedUntil = 0
  return async () => {
    if (Date.now() < verifiedUntil) return
    const db = new DatabaseSync(database, { readOnly: true })
    let session
    try {
      const rows = db.prepare("SELECT id,source,user_id,chat_id,chat_type,profile_name,hidden,parent_session_id,title,model_config,origin_json,created_source,transport_profile FROM sessions WHERE hidden=0 AND parent_session_id IS NULL ORDER BY rowid DESC LIMIT 200").all()
      session = rows.find(s => eligiblePhotoSession(s, ownerId, registry.pinnedAgent(s.id)))
    } finally { db.close() }
    if (!session) throw new Error('no canonical owner session to authenticate')
    const response = await fetchImpl(`${upstreamOrigin}/api/sessions/${encodeURIComponent(session.id)}`, { headers: { Authorization: `Bearer ${hermesKey}` }, redirect: 'manual', signal: AbortSignal.timeout(5000) })
    if (!response.ok) { await response.body?.cancel(); throw new Error('main runtime authentication failed') }
    const raw = await response.text()
    if (raw.length > 1024 * 1024) throw new Error('main runtime identity response limit')
    const payload = JSON.parse(raw), actual = payload.data && !Array.isArray(payload.data) ? payload.data : payload.session || payload
    if (actual.id !== session.id) throw new Error('main runtime history identity mismatch')
    verifiedUntil = Date.now() + 60000
  }
}
export function eligiblePhotoSession(s, ownerId, pinnedAgent) {
  if (!s || pinnedAgent && pinnedAgent !== 'main' || s.hidden || s.parent_session_id || ![null, '', 'default'].includes(s.profile_name)) return false
  if (s.user_id && s.user_id !== ownerId) return false
  let config, origin
  try { config = JSON.parse(s.model_config || '{}'); origin = JSON.parse(s.origin_json || '{}') } catch { return false }
  if (!config || !origin || config._delegate_from) return false
  const provenance = [s.created_source, s.transport_profile, origin.source, origin.kind, origin.type, origin.runtime, origin.visibility].filter(Boolean).join(' ')
  if (/cron|subagent|helper|internal|synthetic|canary|worker|test|private/i.test(provenance)) return false
  if (/\bqa\b|canary|smoke|fixture|probe|test[-_ ]session/i.test(`${s.title || ''} ${s.id}`)) return false
  if (s.source === 'telegram') return s.user_id === ownerId && s.chat_id === ownerId && s.chat_type === 'dm'
  // These are candidates inside the bound single-owner runtime, not authority by themselves.
  if (s.source === 'webui') return true
  return ['api_server', 'wizard-mobile'].includes(s.source) && /^wizard_\d+_[a-f0-9]+$/.test(s.id)
}
export function createCanonicalChatPhotoResolver({ database, ownerId, authorityId, registry, resolveFiles, resolveHelm, artifactRoots, aliases = [] }) {
  if (!/^[0-9a-f]{64}$/.test(authorityId || '') || !ownerId || !registry?.pinnedAgent) throw new Error('canonical owner registry required')
  const databasePath = realpathSync(database)
  return async candidate => {
    const denied = reason => ({ photos: [], unavailable: Array(Math.max(1, candidate.refs?.length || 0)).fill(reason) })
    // Registry check precedes even the main history read. A private pin never routes to its store.
    const pin = registry.pinnedAgent(candidate.thread_id)
    if (pin && pin !== 'main') return denied('non_main_agent')
    const db = new DatabaseSync(databasePath, { readOnly: true })
    let s, m
    try {
      s = db.prepare('SELECT id,source,user_id,chat_id,chat_type,profile_name,hidden,parent_session_id,title,model_config,origin_json,created_source,transport_profile FROM sessions WHERE id=?').get(candidate.thread_id)
      if (!eligiblePhotoSession(s, ownerId, pin)) return denied('not_owner_visible_main')
      // Read content only after thread authority. Revalidate row identity, role and finality.
      m = db.prepare('SELECT id,session_id,role,content,timestamp,display_kind,tool_calls,_compressed_summary FROM messages WHERE id=? AND session_id=?').get(candidate.message_id, candidate.thread_id)
    } finally { db.close() }
    if (!m || m.role !== candidate.role || m.timestamp !== candidate.timestamp || !['user', 'assistant'].includes(m.role) || m._compressed_summary || ![null, '', 'final'].includes(m.display_kind) || m.role === 'assistant' && m.tool_calls && !['[]', 'null'].includes(m.tool_calls)) return denied('not_visible_message')
    let content = m.content
    if (typeof content === 'string' && content.trimStart().startsWith('[')) { try { const parsed = JSON.parse(content); if (Array.isArray(parsed)) content = parsed } catch {} }
    let raw = projectWizardMessageHistory(Buffer.from(JSON.stringify({ data: [{ ...m, content }] })))
    raw = projectWizardFileMarkers(raw, true)
    const photos = new Map(), unavailable = [], local = new Map()
    const put = photo => { if (photo) photos.set(digest(photo.bytes), { bytes: photo.bytes, mime: photo.mime }) }
    // Invoke the history projector itself. The injected image registrar observes the
    // exact images it would deliver, without creating a second artifact copy.
    raw = projectAgentMedia(raw, 'projection-only', artifactRoots, aliases, path => {
      const photo = resolveAgentImage(path.trim(), artifactRoots, aliases, [registry.agentsDir].filter(Boolean))
      if (!photo) { unavailable.push('local_bytes_unavailable_or_denied'); return null }
      const sha256 = digest(photo.bytes), id = sha256.slice(0, 32)
      local.set(id, photo)
      return { id, sha256, mime: photo.mime, kind: 'image', bytes: photo.bytes.length }
    })
    const projected = JSON.parse(raw)
    if (!projected.data?.length) return denied('not_visible_message')
    const text = []
    const visit = value => {
      if (typeof value === 'string') text.push(value.replace(/```[^\n]*\n[\s\S]*?```/g, ''))
      else if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') {
        if (value.type === 'image_url') {
          const inline = durableInlineImage(value)
          if (inline) { const match = inline.image_url.url.match(/^data:([^;]+);base64,(.+)$/); put({ mime: match[1], bytes: Buffer.from(match[2], 'base64') }) }
          else unavailable.push('remote_or_invalid_inline_image')
        } else Object.values(value).forEach(visit)
      }
    }
    // Only content, never echoed tool arguments/display metadata.
    for (const row of projected.data) visit(row.content)
    const fileIds = new Set(), helmIds = new Set()
    for (const value of text) {
      for (const match of value.matchAll(/\[WIZARD_FILE_CHIPS_V1\]\s*([\s\S]*?)\s*\[\/WIZARD_FILE_CHIPS_V1\]/g)) {
        for (const f of JSON.parse(match[1])) {
          if (!String(f.mime).startsWith('image/') || fileIds.has(f.id)) continue
          fileIds.add(f.id)
          let resolved
          try { [resolved] = await resolveFiles([f.id]) } catch (error) {
            if (error.upstreamStatus >= 500) throw error
            if ([400, 404].includes(error.status)) { unavailable.push('attachment_not_found'); continue }
            throw error
          }
          if (!resolved || resolved.id !== f.id || !f.sha256 || resolved.sha256 !== f.sha256) { unavailable.push('attachment_identity_mismatch'); continue }
          const photo = resolveAgentImage(resolved.localPath || resolved.trusted_path, artifactRoots, aliases, [registry.agentsDir].filter(Boolean))
          if (!photo || digest(photo.bytes) !== f.sha256) unavailable.push('attachment_bytes_unavailable_or_changed')
          else put(photo)
        }
      }
      for (const match of value.matchAll(/<helm_attachments>([^\n]+)<\/helm_attachments>/g)) {
        let items; try { items = JSON.parse(match[1]).items } catch { continue }
        for (const f of Array.isArray(items) ? items : []) {
          if (!String(f.mime).startsWith('image/') || !/^[0-9a-f]{32}$/.test(f.id || '') || helmIds.has(f.id)) continue
          helmIds.add(f.id)
          const photo = local.get(f.id) || await resolveHelm(f.id)
          if (!photo || f.sha256 && digest(photo.bytes) !== f.sha256) unavailable.push('helm_bytes_unavailable_or_changed')
          else put(photo)
        }
      }
    }
    if (!photos.size && !unavailable.length) return denied('no_canonical_image_resolution')
    // Candidates not projected as images (e.g. remote Markdown intents) stay explicit.
    const accounted = photos.size + unavailable.length
    for (let i = accounted; i < (candidate.refs?.length || 0); i++) unavailable.push('unresolved_or_duplicate_candidate')
    return { photos: [...photos.values()], unavailable }
  }
}
