// Disposable targets. Deliberately no filesystem, durable queue, catalog, or presentation-store dependency.
import { randomBytes } from 'node:crypto'
import { proxyToAgent } from './agents-http.mjs'
import { AgentError } from './agents.mjs'
import { principalOf } from './principals.mjs'

const SESSION = /^incog_[a-f0-9]{32}$/u
const ROUTE = /^\/wizard\/v1\/agents\/([a-z][a-z0-9-]{0,30})\/incognito(?:\/(incog_[a-f0-9]{32})(\/.*)?)?$/u
export const INCOGNITO_INSTRUCTIONS = 'This is an Incognito conversation. Your home, memories, facts, skills and history are a disposable RAM copy: read them, search past chats and use your normal tools. Memory, fact and skill writes inside this RAM home are allowed and vanish when it ends. Never write transcripts, summaries, titles or history from this session to the Wizard service or any durable store. Cron, schedules, kanban, delegation, heavy jobs and cross-platform send_message are unavailable. Before EVERY external write or action (including Wizard Notes, Calendar, Files and Messenger sends), explain exactly what will change, ask James for permission, and wait for an explicit yes in this conversation. A request to perform the action is not that confirmation. Read-only app access is allowed. Never change the normal private home. Never reference this conversation outside it. Use Markdown when useful.'
const failure = (status, code) => new AgentError(status, code, 'incognito')

export function createIncognito({ registry, runtime, fetchImpl = fetch, proxyContext, upstreamHost = '', now = Date.now, leaseMs = 90_000, maxMs = 2 * 60 * 60_000 }) {
  const sessions = new Map(), pendingAgents = new Set()
  let closing = false
  const destroy = async entry => {
    if (entry.destroying) return entry.destroying
    // Forget first: late start/poll/stream callbacks cannot revive a closed conversation.
    sessions.delete(entry.id)
    entry.abort.abort()
    for (const response of entry.streams) response.destroy()
    return entry.destroying = Promise.resolve(runtime.incognitoStop(entry.agent.id, { session_id: entry.id })).catch(() => undefined)
  }
  const sweep = () => Promise.all([...sessions.values()].filter(s => now() >= s.expires || now() >= s.deadline).map(destroy))
  const timer = setInterval(() => { void sweep() }, Math.min(10_000, leaseMs)); timer.unref?.()
  const context = entry => ({
    // Explicit allowlist: never spread the ordinary context. Its hooks write inputs, pins, titles, MEDIA mirrors etc.
    registry: {
      read: id => id === entry.agent.id ? entry.agent : null,
      apiKey: () => entry.key,
      threadAgent: () => ({ id: entry.agent.id, label: entry.agent.label, privacy: 'private', incognito: true }),
      pin() {}, noteRun() {}, observeSessions() {},
      fetchAgent: async (_agent, path, init) => {
        const reply = await fetchImpl(new URL(path, entry.origin), { ...init,
          signal: init.signal ? AbortSignal.any([init.signal, entry.abort.signal]) : entry.abort.signal })
        if (init.method === 'GET' && /^\/v1\/runs\/[^/]+$/u.test(path) && reply.ok) {
          try { const value = await reply.clone().json(); if (['completed', 'failed', 'cancelled', 'interrupted', 'expired'].includes(value.status)) entry.busy = false } catch {}
        }
        return reply
      },
    },
    sendJson: proxyContext.sendJson, isAllowedProxyRequest: proxyContext.isAllowedProxyRequest,
    secretGuard: proxyContext.secretGuard, mainSecrets: proxyContext.mainSecrets || [],
    projectStatusMarkers: value => value, projectWizardMessageHistory: value => value,
    runInstructions: INCOGNITO_INSTRUCTIONS,
  })
  async function handle(url, request, response) {
    if (!url.pathname.includes('/incognito')) return false
    const match = ROUTE.exec(url.pathname)
    if (!match) { proxyContext.sendJson(response, 404, { error: 'not_found' }); return true }
    if (principalOf(request).kind !== 'owner') throw failure(403, 'owner_required')
    // Same-origin owner requests, including best-effort unload fetch. No query/header switch grants the mode.
    if (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) throw failure(403, 'cross_origin_request')
    if (request.headers.origin) {
      let host = ''; try { host = new URL(request.headers.origin).host } catch {}
      if (host !== (request.headers['x-forwarded-host'] || request.headers.host)) throw failure(403, 'cross_origin_request')
    }
    if (url.search) throw failure(400, 'invalid_request')
    const [, agentId, id, suffix = ''] = match
    const agent = registry?.read(agentId)
    if (agentId === 'main' && !agent) throw failure(409, 'incognito_private_only')
    if (!agent || agent.role === 'recovery') throw failure(404, 'agent_not_found')
    if (agent.privacy !== 'private') throw failure(409, 'incognito_private_only')
    if (!runtime?.incognitoStart || !runtime?.incognitoStop || !runtime?.incognitoLease) throw failure(503, 'incognito_unavailable')
    if (!id && request.method === 'POST') {
      const value = await proxyContext.readJson(request)
      if (Object.keys(value).length) throw failure(400, 'invalid_request')
      if (closing || pendingAgents.has(agentId) || [...sessions.values()].some(s => s.agent.id === agentId)) throw failure(409, 'incognito_already_open')
      if (agent.model?.provider !== 'tinfoil') throw failure(409, 'confidential_provider_required')
      pendingAgents.add(agentId)
      const entry = { id: `incog_${randomBytes(16).toString('hex')}`, agent, expires: now() + leaseMs, deadline: now() + maxMs, abort: new AbortController(), streams: new Set(), runs: new Set(), busy: false }
      try {
        const target = await runtime.incognitoStart(agentId, { session_id: entry.id })
        const origin = new URL(target.origin)
        if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || !origin.port || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || typeof target.key !== 'string' || target.key.length < 24) throw failure(502, 'incognito_target_invalid')
        if (upstreamHost) origin.hostname = upstreamHost
        entry.origin = origin.origin; entry.key = target.key
        const created = await fetchImpl(new URL('/api/sessions', entry.origin), { method: 'POST', redirect: 'error', signal: entry.abort.signal,
          headers: { Authorization: `Bearer ${entry.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: entry.id }) })
        if (!created.ok) throw failure(503, 'incognito_unavailable')
        await created.body?.cancel()
        if (closing || request.aborted || response.destroyed) { await destroy(entry); return true }
        sessions.set(entry.id, entry)
        proxyContext.sendJson(response, 201, { session_id: entry.id, incognito: true, history_search: target.history_search === 'available' ? 'available' : 'unavailable', lease_seconds: Math.floor(leaseMs / 1000) })
      } catch (error) {
        await destroy(entry)
        // Never send helper exceptions or arbitrary Docker/model messages back to the browser or logs.
        throw error instanceof AgentError ? error : failure(503, 'incognito_unavailable')
      } finally { pendingAgents.delete(agentId) }
      return true
    }
    if (!id || !SESSION.test(id)) throw failure(404, 'not_found')
    const entry = sessions.get(id)
    if (request.method === 'DELETE' && !suffix) {
      if (entry && entry.agent.id !== agentId) throw failure(404, 'not_found')
      if (entry) await destroy(entry)
      proxyContext.sendJson(response, 200, { closed: true }); return true
    }
    if (!entry || entry.agent.id !== agentId) throw failure(410, 'incognito_closed')
    if (now() >= entry.expires || now() >= entry.deadline) { await destroy(entry); throw failure(410, 'incognito_closed') }
    if (suffix === '/lease' && request.method === 'POST') {
      const value = await proxyContext.readJson(request)
      if (Object.keys(value).length) throw failure(400, 'invalid_request')
      try { await runtime.incognitoLease(agentId, { session_id: id }) } catch { await destroy(entry); throw failure(410, 'incognito_closed') }
      entry.expires = Math.min(now() + leaseMs, entry.deadline)
      proxyContext.sendJson(response, 200, { open: true }); return true
    }
    // One session only; no list/search/model mutation/files endpoints and no client-selected provider or tools.
    let body, upstreamPath = suffix
    if (suffix === '/v1/runs' && request.method === 'POST') {
      if (entry.busy) throw failure(409, 'incognito_turn_in_progress')
      const value = await proxyContext.readJson(request)
      if (Object.keys(value).some(k => !['input'].includes(k)) || typeof value.input !== 'string' || !value.input.trim() || value.input.length > 64_000) throw failure(400, 'incognito_text_only')
      entry.deadline = now() + maxMs // Owner message activity, not a background browser heartbeat.
      entry.expires = Math.min(now() + leaseMs, entry.deadline)
      body = Buffer.from(JSON.stringify({ session_id: id, input: value.input }))
    } else if (request.method === 'GET' && suffix === `/api/sessions/${id}/messages`) {
      // Own session history only. No call to the normal registry's catalog/projection.
    } else {
      const run = /^\/v1\/runs\/([A-Za-z0-9._:-]{1,200})(?:\/(events|stop))?$/u.exec(suffix)
      if (!run || !entry.runs.has(run[1]) || !((request.method === 'GET' && run[2] !== 'stop') || (request.method === 'POST' && run[2] === 'stop'))) throw failure(404, 'not_found')
      if (request.method === 'POST') { body = Buffer.from('{}') }
    }
    const ctx = context(entry)
    // proxyToAgent already owns secret-safe JSON and SSE projection, aborts, and model policy.
    ctx.registry.noteRun = runId => { if (typeof runId === 'string') entry.runs.add(runId) }
    const turn = suffix === '/v1/runs'
    if (turn) entry.busy = true
    entry.streams.add(response)
    response.once('close', () => entry.streams.delete(response))
    const before = entry.runs.size
    try {
      await proxyToAgent(ctx, { agent, method: request.method, upstreamPath, searchParams: new URLSearchParams(), request, response, body, bodyRead: !!body })
    } finally { if (turn && entry.runs.size === before) entry.busy = false }
    return true
  }
  return { handle, sweep, async close() { closing = true; clearInterval(timer); await Promise.all([...sessions.values()].map(destroy)) } }
}
