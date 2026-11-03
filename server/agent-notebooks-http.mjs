// Generic read-only notebook resource. No app presentation, source discovery defaults,
// browser owner-session authority or implicit access to an agent's home.
import { stateList, stateText } from './agent-bridge.mjs'
const ROOT = '/wizard/v1/agent-notebooks'
const ROUTE = /^\/wizard\/v1\/agent-notebooks(?:\/([a-z][a-z0-9-]{0,30})(?:\/(read|search))?)?$/u
export function notebookSources(registry, appId) {
  const granted = new Set(registry.grants().filter(grant => grant.kind === 'app-notebook'
    && grant.reader === `app:${appId}` && grant.scope === 'read').map(grant => grant.source))
  return registry.list().filter(agent => granted.has(agent?.id) && agent.role !== 'recovery'
    && agent.hidden !== true && agent.privacy === 'standard' && typeof agent.notes_dir === 'string' && agent.notes_dir)
}
const sourceView = agent => ({ id: agent.id, label: agent.label, privacy: agent.privacy, ...(agent.appearance ? { appearance: agent.appearance } : {}) })
const titleOf = path => path.split('/').pop().replace(/\.(?:md|txt)$/iu, '')
const snippet = (text, query) => {
  const flat = text.replace(/^---\n[\s\S]*?\n---\n/u, '').replace(/\s+/gu, ' ').trim()
  const at = query ? flat.toLowerCase().indexOf(query) : 0, start = Math.max(0, at - 50)
  return (start ? '…' : '') + flat.slice(start, start + 160)
}
export async function handleAgentNotebooksApi(ctx, url, request, response) {
  if (!url.pathname.startsWith(ROOT)) return false
  const { registry, sendJson, appGrants } = ctx
  const headers = { 'Cache-Control': 'no-store' }
  const appId = appGrants.caller(request)
  if (!appId) { sendJson(response, 403, { error: 'app_grant_required' }, headers); return true }
  const match = url.pathname.match(ROUTE)
  if (!match) { sendJson(response, 404, { error: 'not_found' }, headers); return true }
  if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) {
    sendJson(response, 405, { error: 'read_only' }, { ...headers, Allow: 'GET, HEAD' }); return true
  }
  const [, id, action] = match
  const sources = notebookSources(registry, appId)
  if (!id) { sendJson(response, 200, { sources: sources.map(sourceView) }, headers); return true }
  const agent = sources.find(source => source.id === id)
  // Including malformed stored grants: no metadata or filesystem access before this check.
  if (!agent) { sendJson(response, 404, { error: 'agent_not_found' }, headers); return true }
  const source = { id: agent.id, label: agent.label }
  try {
    const home = registry.stateHome(agent.id), folder = agent.notes_dir
    if (!action) sendJson(response, 200, { source, ...stateList(home, folder) }, headers)
    else if (action === 'read') {
      const path = url.searchParams.get('path') ?? ''
      if (!/\.(?:md|txt)$/iu.test(path)) throw new Error('agent.path_refused')
      sendJson(response, 200, { source, path, text: stateText(home, `${folder}/${path}`) }, headers)
    } else {
      const query = (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 200)
      const { entries, truncated } = stateList(home, folder), notes = []
      for (const path of entries) {
        if (notes.length >= 50) break
        let text
        try { text = stateText(home, `${folder}/${path}`) } catch { continue }
        const title = titleOf(path)
        if (query && !title.toLowerCase().includes(query) && !text.toLowerCase().includes(query)) continue
        notes.push({ path, title, snippet: snippet(text, query) })
      }
      if (query) notes.sort((a, b) => Number(b.title.toLowerCase().includes(query)) - Number(a.title.toLowerCase().includes(query)))
      sendJson(response, 200, { source, notes, truncated }, headers)
    }
  } catch (error) {
    const code = /^agent\.[a-z_]+$/u.test(error?.message) ? error.message : error?.code === 'ENOENT' ? 'agent.not_found' : 'agent.state_unavailable'
    sendJson(response, code === 'agent.too_large' ? 413 : code === 'agent.not_found' ? 404 : code === 'agent.state_unavailable' ? 503 : 403, { error: code }, headers)
  }
  return true
}
