// Owner-session-only, read-only view of every registered agent's notebook (`notes_dir`, else `wiki`).
//
// The Notes app shows these as extra sources beside the owner's own vault. It reuses the exact path gates of the
// wizard_agents__notes_list / notes_read tools (stateList/stateText in agent-bridge.mjs): no traversal, dotfiles,
// secret-looking names, symlinks, hardlinks or oversized files. What differs is who reads:
//   GET /wizard/v1/agent-notes                        → {sources:[{id,label,privacy,appearance}]}
//   GET /wizard/v1/agent-notes/<agent>                → {source, entries:[path], truncated}
//   GET /wizard/v1/agent-notes/<agent>/read?path=…    → {source, path, text}
//   GET /wizard/v1/agent-notes/<agent>/search?q=…     → {source, notes:[{path,title,snippet}], truncated}
// Only the owner session may call; service and agent credentials never reach this surface (principals.mjs).
// Every other method answers 405 read_only: an agent's notebook is its working memory, never edited from outside.
// Privacy/hidden flags seal agent-to-agent reads, not the owner's human Notes view. Main Archimedes stays out
// while its home is the host Hermes profile; an eventual registered container appears like any other agent.
import { principalOf } from './principals.mjs'
import { MAIN_AGENT_ID } from './agents.mjs'
import { stateList, stateText } from './agent-bridge.mjs'

const ROUTE = /^\/wizard\/v1\/agent-notes(?:\/([a-z][a-z0-9-]{0,30})(?:\/(read|search))?)?$/u
const SEARCH_RESULTS = 50
const SNIPPET = 160

/** All registered notebooks, fresh on every call. No per-agent setup, privacy or hidden filter for the owner. */
export function noteSources(registry) {
  return registry.list().filter((agent) => agent && (agent.id !== MAIN_AGENT_ID || agent.runtime?.kind === 'container'))
}
const notebookDir = (agent) => agent.notes_dir || 'wiki'

function sourceView(agent) {
  return { id: agent.id, label: agent.label, privacy: agent.privacy, ...(agent.appearance ? { appearance: agent.appearance } : {}) }
}

const titleOf = (path) => path.split('/').pop().replace(/\.(?:md|txt)$/iu, '')

function snippet(text, query) {
  const flat = text.replace(/^---\n[\s\S]*?\n---\n/u, '').replace(/\s+/gu, ' ').trim()
  if (!query) return flat.slice(0, SNIPPET)
  const at = flat.toLowerCase().indexOf(query)
  if (at < 0) return flat.slice(0, SNIPPET)
  const start = Math.max(0, at - 50)
  return (start ? '…' : '') + flat.slice(start, start + SNIPPET)
}

/** Returns true when the request was answered. ctx: { registry, sendJson, accessOk(request) } */
export async function handleAgentNotesApi(ctx, url, request, response) {
  const match = url.pathname.match(ROUTE)
  if (!match) {
    if (url.pathname.startsWith('/wizard/v1/agent-notes')) { ctx.sendJson(response, 404, { error: 'not_found', check: 'agent_notes.route' }); return true }
    return false
  }
  const { registry, sendJson } = ctx
  if (principalOf(request).kind !== 'owner') { sendJson(response, 403, { error: 'owner_required', check: 'agent_notes.owner' }); return true }
  if (!await ctx.accessOk(request)) { sendJson(response, 403, { error: 'access_required' }); return true }
  if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) {
    sendJson(response, 405, { error: 'read_only', check: 'agent_notes.read_only' }, { Allow: 'GET, HEAD' })
    return true
  }
  const noStore = { 'Cache-Control': 'no-store' }
  const [, id, action] = match
  const sources = noteSources(registry)
  if (!id) { sendJson(response, 200, { sources: sources.map(sourceView) }, noStore); return true }
  const agent = sources.find((item) => item.id === id)
  // Missing ids answer 404; missing notebook folders answer an empty list through stateList.
  if (!agent) { sendJson(response, 404, { error: 'agent_not_found', check: 'agent.id' }); return true }
  const home = registry.stateHome(agent.id)
  const folder = notebookDir(agent)
  const source = { id: agent.id, label: agent.label }
  try {
    if (!action) {
      sendJson(response, 200, { source, ...stateList(home, folder) }, noStore)
    } else if (action === 'read') {
      const path = url.searchParams.get('path') ?? ''
      if (!/\.(?:md|txt)$/iu.test(path)) throw new Error('agent.path_refused')
      sendJson(response, 200, { source, path, text: stateText(home, `${folder}/${path}`) }, noStore)
    } else {
      const query = (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 200)
      const { entries, truncated } = stateList(home, folder)
      const notes = []
      for (const path of entries) {
        if (notes.length >= SEARCH_RESULTS) break
        let text = ''
        try { text = stateText(home, `${folder}/${path}`) } catch { continue }
        const title = titleOf(path)
        if (query && !title.toLowerCase().includes(query) && !text.toLowerCase().includes(query)) continue
        notes.push({ path, title, snippet: snippet(text, query) })
      }
      if (query) notes.sort((a, b) => Number(b.title.toLowerCase().includes(query)) - Number(a.title.toLowerCase().includes(query)))
      sendJson(response, 200, { source, notes, truncated }, noStore)
    }
  } catch (error) {
    const code = /^agent\.[a-z_]+$/u.test(error?.message) ? error.message : error?.code === 'ENOENT' ? 'agent.not_found' : 'agent.state_unavailable'
    const status = code === 'agent.too_large' ? 413 : code === 'agent.not_found' ? 404 : code === 'agent.state_unavailable' ? 503 : 403
    // No paths, content or filesystem errors (which may reveal host paths) in the answer.
    sendJson(response, status, { error: code, check: 'agent_notes.read' })
  }
  return true
}
