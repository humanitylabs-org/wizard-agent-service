// HTTP side of the Agents MVP (wizard-os spec/AGENTS.md section 3):
//   /wizard/v1/agents, /wizard/v1/agents/<id>, /wizard/v1/agents/<id>/start|stop, /wizard/v1/agent-options
//   /wizard/v1/agents/<id>/deliveries  (internal: assistant-only recap delivery, bearer token)
// and the agent-scoped thread/run proxy used when a request names a non-main agent or a thread pinned to one.
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AgentError, MAIN_AGENT_ID } from './agents.mjs'
import { STATUS_INSTRUCTIONS } from './thread-status.mjs'

export const AGENT_RUN_INSTRUCTIONS = `You are serving the user through Wizard, a first-party client for their own agents. This is a separate agent with its own private history, memory and files; nothing from other agents is available here. Answer with the same care you would anywhere else, scaled to the request. Wizard renders Markdown.

${STATUS_INSTRUCTIONS}`

const AGENT_ROUTE = /^\/wizard\/v1\/agents(?:\/([a-z][a-z0-9-]{0,30})(?:\/(start|stop|deliveries))?)?$/u

function agentErrorBody(error) {
  return error instanceof AgentError ? error.payload : null
}

export function sessionIdFromPath(upstreamPath) {
  const match = upstreamPath.match(/^\/api\/sessions\/([^/]+)(?:\/(?:messages|model))?$/u)
  if (!match) return ''
  try { return decodeURIComponent(match[1]) } catch { return '' }
}

export function runIdFromPath(upstreamPath) {
  return upstreamPath.match(/^\/v1\/runs\/([A-Za-z0-9._:-]+)/u)?.[1] ?? ''
}

/** Adds the server-side `agent` object to every thread in a session list or session response. */
export function decorateThreadAgent(result, agentInfo) {
  try {
    const payload = JSON.parse(result.toString('utf8'))
    let changed = false
    for (const key of ['data', 'sessions']) {
      if (!Array.isArray(payload?.[key])) continue
      payload[key] = payload[key].map((item) => (item && typeof item === 'object' ? { ...item, agent: typeof agentInfo === 'function' ? agentInfo(item) : agentInfo } : item))
      changed = true
    }
    if (payload?.session && typeof payload.session === 'object') {
      payload.session = { ...payload.session, agent: typeof agentInfo === 'function' ? agentInfo(payload.session) : agentInfo }
      changed = true
    }
    return changed ? Buffer.from(JSON.stringify(payload)) : result
  } catch { return result }
}

/**
 * Handles /wizard/v1/agents* and /wizard/v1/agent-options. Returns true when the request was answered.
 * ctx: { registry, sendJson, readBoundedBody, accessOk(request), deliveryToken, deliver(agent, payload) }
 */
export async function handleAgentsApi(ctx, url, request, response) {
  const { registry, sendJson } = ctx
  const isOptions = url.pathname === '/wizard/v1/agent-options'
  const match = isOptions ? null : url.pathname.match(AGENT_ROUTE)
  if (!isOptions && !match) {
    if (url.pathname.startsWith('/wizard/v1/agents')) { sendJson(response, 404, { error: 'not_found', check: 'agent.route' }); return true }
    return false
  }
  const method = request.method ?? 'GET'
  const [, id, action] = match ?? []
  // Internal recap delivery: a host writer with the delivery token, never the browser.
  if (action === 'deliveries') {
    const bearer = /^Bearer\s+(.+)$/iu.exec(String(request.headers.authorization || ''))?.[1]?.trim() || ''
    if (method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed', check: 'agent.route' }); return true }
    if (!ctx.deliveryToken || bearer !== ctx.deliveryToken) { sendJson(response, 403, { error: 'delivery_token_required', check: 'agent.delivery_token' }); return true }
    try {
      const agent = registry.read(id)
      if (!agent || id === MAIN_AGENT_ID) throw new AgentError(404, 'agent_not_found', 'agent.id')
      const body = await readJson(ctx, request)
      const receipt = await ctx.deliver(agent, body)
      if (typeof receipt?.session_id === 'string') registry.pin(receipt.session_id, agent.id)
      sendJson(response, 200, { ...receipt, agent: registry.threadAgent(agent) })
    } catch (error) { sendAgentError(ctx, response, error) }
    return true
  }
  if (!await ctx.accessOk(request)) { sendJson(response, 403, { error: 'access_required' }); return true }
  try {
    if (isOptions) {
      if (method !== 'GET') throw new AgentError(405, 'method_not_allowed', 'agent.route')
      sendJson(response, 200, await registry.agentOptions())
      return true
    }
    if (!id) {
      if (method === 'GET') {
        const agents = await Promise.all(registry.list().map((agent) => registry.publicAgent(agent)))
        sendJson(response, 200, { agents })
        return true
      }
      if (method === 'POST') {
        const body = await readJson(ctx, request)
        const idempotencyKey = typeof request.headers['idempotency-key'] === 'string' ? request.headers['idempotency-key'] : ''
        const created = await registry.create(body, { idempotencyKey })
        sendJson(response, created.replayed ? 200 : 201, { agent: await registry.publicAgent(created.agent) }, created.replayed ? { 'Idempotency-Replayed': 'true' } : {})
        return true
      }
      throw new AgentError(405, 'method_not_allowed', 'agent.route')
    }
    if (action) {
      if (method !== 'POST') throw new AgentError(405, 'method_not_allowed', 'agent.route')
      requireJsonOrEmpty(request)
      const agent = await registry.setRunning(id, action === 'start')
      sendJson(response, 202, { agent: await registry.publicAgent(agent) })
      return true
    }
    if (method === 'GET') {
      const agent = registry.read(id)
      if (!agent) throw new AgentError(404, 'agent_not_found', 'agent.id')
      sendJson(response, 200, { agent: await registry.publicAgent(agent) })
      return true
    }
    if (method === 'PATCH') {
      const body = await readJson(ctx, request)
      const agent = await registry.update(id, body)
      sendJson(response, 200, { agent: await registry.publicAgent(agent) })
      return true
    }
    throw new AgentError(405, 'method_not_allowed', 'agent.route')
  } catch (error) { sendAgentError(ctx, response, error) }
  return true
}

function requireJsonOrEmpty(request) {
  const length = Number(request.headers['content-length'] ?? 0)
  const type = String(request.headers['content-type'] ?? '').toLowerCase()
  // Same CSRF floor as the rest of the Service: a write carries JSON (a cross-site form cannot).
  if (!type.startsWith('application/json') && (length > 0 || request.headers['transfer-encoding'])) throw new AgentError(415, 'json_required', 'request.content_type')
  if (!type.startsWith('application/json')) throw new AgentError(415, 'json_required', 'request.content_type')
}

async function readJson(ctx, request) {
  requireJsonOrEmpty(request)
  const raw = await ctx.readBoundedBody(request, 256 * 1024)
  try {
    const value = JSON.parse(raw.toString('utf8') || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch { throw new AgentError(400, 'invalid_json', 'request.body') }
}

function sendAgentError(ctx, response, error) {
  if (response.headersSent) { response.destroy(); return }
  const payload = agentErrorBody(error)
  if (payload) { ctx.sendJson(response, error.status, payload); return }
  if (error?.status === 413) { ctx.sendJson(response, 413, { error: 'body_too_large', check: 'request.size' }); return }
  ctx.sendJson(response, 502, { error: 'agent_service_error', check: 'agent.internal' })
}

/**
 * Work out which agent a proxied thread/run request belongs to, before the main-agent proxy runs.
 * Returns { agentId, body } where body is the (already read) request body with any `agent` field removed.
 * Throws AgentError 409 thread.agent_pinned when the request names a different agent from the thread's pin.
 */
export async function resolveProxyAgent(ctx, { method, upstreamPath, searchParams, request, operator }) {
  const { registry } = ctx
  const explicitQuery = searchParams.get('agent') ?? ''
  searchParams.delete('agent')
  let body
  const hasBody = method === 'PATCH' || (method === 'POST' && !upstreamPath.endsWith('/stop'))
  let explicitBody = ''
  let bodyValue = null
  if (hasBody && String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    body = await ctx.readBoundedBody(request)
    try {
      bodyValue = JSON.parse(body.toString('utf8'))
      if (bodyValue && typeof bodyValue === 'object' && !Array.isArray(bodyValue) && 'agent' in bodyValue) {
        explicitBody = typeof bodyValue.agent === 'string' ? bodyValue.agent : ''
        const { agent: _agent, ...rest } = bodyValue
        bodyValue = rest
        body = Buffer.from(JSON.stringify(rest))
      }
    } catch { bodyValue = null }
  }
  if (explicitQuery && explicitBody && explicitQuery !== explicitBody) throw new AgentError(400, 'agent_mismatch', 'request.agent')
  const explicit = explicitQuery || explicitBody
  if (explicit && !registry.read(explicit)) throw new AgentError(404, 'agent_not_found', 'agent.id')
  if (operator && explicit && explicit !== MAIN_AGENT_ID) throw new AgentError(404, 'agent_not_found', 'agent.id')
  const sessionId = sessionIdFromPath(upstreamPath)
    || (upstreamPath === '/v1/runs' && typeof bodyValue?.session_id === 'string' ? bodyValue.session_id : '')
    || (upstreamPath === '/api/sessions' && method === 'POST' && typeof (bodyValue?.id ?? bodyValue?.session_id) === 'string' ? (bodyValue.id ?? bodyValue.session_id) : '')
  const runId = runIdFromPath(upstreamPath)
  const pinned = (sessionId && registry.pinnedAgent(sessionId)) || (runId && registry.runAgent(runId)) || ''
  if (explicit && pinned && explicit !== pinned) throw new AgentError(409, 'thread_agent_pinned', 'thread.agent_pinned')
  // A thread already on the main agent cannot be continued under another agent.
  if (explicit && explicit !== MAIN_AGENT_ID && !pinned && sessionId && await ctx.mainHasSession(sessionId)) {
    throw new AgentError(409, 'thread_agent_pinned', 'thread.agent_pinned')
  }
  return { agentId: explicit || pinned || MAIN_AGENT_ID, body, bodyRead: body !== undefined, sessionId }
}

function modelAllowed(agent, value) {
  const model = typeof value?.model === 'string' ? value.model.trim() : ''
  const provider = typeof value?.provider === 'string' ? value.provider.trim() : ''
  if (provider && provider !== agent.model.provider && !(agent.model.provider === 'tinfoil' && provider === 'custom')) return false
  if (!model) return true
  if (agent.model.allowed_models.includes(model)) return true
  // `custom/glm-5-3` or `tinfoil/glm-5-3` name the same model through this agent's own provider.
  const [prefix, bare, ...more] = model.split('/')
  return !more.length && Boolean(bare) && [agent.model.provider, 'custom'].includes(prefix) && agent.model.allowed_models.includes(bare)
}

/**
 * Forward a thread/run request to a non-main agent's own Hermes API. Never touches the main Hermes, its
 * state.db, the run queue or the main memory. ctx adds: { isAllowedProxyRequest, sendJson, secretGuard,
 * projectStatusMarkers, projectWizardMessageHistory, fetchImpl, mainSecrets }
 */
export async function proxyToAgent(ctx, { agent, method, upstreamPath, searchParams, request, response, body, bodyRead }) {
  const { registry, sendJson } = ctx
  if (!ctx.isAllowedProxyRequest(method, upstreamPath, searchParams)) { sendJson(response, 404, { error: 'not_found' }); return }
  const hasBody = method === 'PATCH' || (method === 'POST' && !upstreamPath.endsWith('/stop'))
  if (hasBody && !bodyRead) throw new AgentError(415, 'json_required', 'request.content_type')
  let value = null
  if (hasBody) {
    try { value = JSON.parse(body.toString('utf8')) } catch { throw new AgentError(400, 'invalid_json', 'request.body') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentError(400, 'invalid_json', 'request.body')
  }
  // The model picker shows only this agent's allowed models.
  if (method === 'GET' && upstreamPath === '/api/model/options') {
    sendJson(response, 200, {
      provider: agent.model.provider, model: agent.model.model,
      providers: [{ slug: agent.model.provider, name: agent.model.provider === 'tinfoil' ? 'Tinfoil (confidential)' : agent.model.provider, is_current: true, authenticated: true, models: [...agent.model.allowed_models] }],
      agent: registry.threadAgent(agent),
    })
    return
  }
  const isModelChange = /^\/api\/sessions\/[^/]+\/model$/u.test(upstreamPath)
  if (value && (isModelChange || upstreamPath === '/v1/runs' || upstreamPath === '/api/sessions' || method === 'PATCH')) {
    if (isModelChange && !value.model) throw new AgentError(409, 'model_not_allowed', 'agent.allowed_models')
    if (!modelAllowed(agent, value)) throw new AgentError(409, 'model_not_allowed', 'agent.allowed_models')
    if (value.model || value.provider) {
      // The agent's Hermes knows the model under its own provider; never forward a provider switch.
      const { provider: _provider, ...rest } = value
      value = typeof rest.model === 'string' && rest.model.includes('/') ? { ...rest, model: rest.model.split('/')[1] } : rest
      // The agent's default model needs no per-request route.
      if (!isModelChange && value.model === agent.model.model) delete value.model
    }
  }
  let pinAfter = ''
  if (method === 'POST' && upstreamPath === '/v1/runs') {
    const sessionId = typeof value.session_id === 'string' ? value.session_id : ''
    if (!sessionId) throw new AgentError(400, 'session_required', 'thread.session_id')
    registry.pin(sessionId, agent.id)
    value = { ...value, instructions: AGENT_RUN_INSTRUCTIONS }
    delete value.delegation_delivery
    delete value.response_rendering
  }
  if (method === 'POST' && upstreamPath === '/api/sessions') {
    const sessionId = typeof (value.id ?? value.session_id) === 'string' ? (value.id ?? value.session_id) : ''
    if (sessionId) registry.pin(sessionId, agent.id)
    else pinAfter = 'session'
  }
  const key = registry.apiKey(agent.id)
  if (!key) throw new AgentError(503, 'agent_not_ready', 'agent.runtime.key')
  const headers = new Headers({ Authorization: `Bearer ${key}` })
  if (hasBody) headers.set('Content-Type', 'application/json')
  if (typeof request.headers.accept === 'string') headers.set('Accept', request.headers.accept)
  if (typeof request.headers['idempotency-key'] === 'string') headers.set('Idempotency-Key', request.headers['idempotency-key'])
  const query = new URLSearchParams(searchParams)
  query.delete('view')
  query.delete('snapshot')
  const controller = new AbortController()
  request.once('aborted', () => controller.abort())
  response.once('close', () => { if (!response.writableEnded) controller.abort() })
  let upstream
  try {
    upstream = await ctx.fetchImpl(`${registry.upstream(agent)}${upstreamPath}${query.size ? `?${query}` : ''}`, {
      method, headers, body: hasBody ? JSON.stringify(value) : undefined, redirect: 'manual', signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof AgentError) throw error
    throw new AgentError(503, 'agent_unavailable', 'agent.running')
  }
  const secrets = [key, ...ctx.mainSecrets].filter(Boolean)
  const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream'
  const responseHeaders = { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Wizard-Agent': agent.id }
  const replayed = upstream.headers.get('idempotency-replayed')
  if (replayed) responseHeaders['Idempotency-Replayed'] = replayed
  if (contentType.includes('text/event-stream') && upstream.body) {
    response.writeHead(upstream.status, { ...responseHeaders, Connection: 'keep-alive' })
    void pipeline(Readable.fromWeb(upstream.body), ctx.secretGuard(secrets), response).catch(() => { if (!response.destroyed) response.destroy() })
    return
  }
  let result = Buffer.from(await upstream.arrayBuffer())
  if (secrets.some((secret) => result.includes(Buffer.from(secret)))) { sendJson(response, 502, { error: 'unsafe_upstream_response', check: 'agent.response' }); return }
  if (upstream.ok && contentType.includes('application/json')) {
    const info = registry.threadAgent(agent)
    if (method === 'POST' && upstreamPath === '/v1/runs') {
      try {
        const admission = JSON.parse(result.toString('utf8'))
        registry.noteRun(typeof admission.run_id === 'string' ? admission.run_id : admission.id, agent.id)
      } catch { /* the client validates the admission */ }
    }
    if (pinAfter) {
      try {
        const created = JSON.parse(result.toString('utf8'))
        const sessionId = created?.session?.id ?? created?.id
        if (typeof sessionId === 'string') registry.pin(sessionId, agent.id)
      } catch { /* nothing to pin */ }
    }
    const messageHistory = method === 'GET' && /^\/api\/sessions\/[^/]+\/messages$/u.test(upstreamPath)
    if (method === 'GET' && upstreamPath === '/api/sessions') {
      result = filterThreads(result, ctx.isThreadVisible)
      result = decorateThreadAgent(result, info)
      for (const id of sessionIdsIn(result)) registry.pin(id, agent.id)
    } else if (/^\/api\/sessions(?:\/[^/]+)?$/u.test(upstreamPath)) result = decorateThreadAgent(result, info)
    if (messageHistory || /^\/v1\/runs\/[^/]+$/u.test(upstreamPath)) result = ctx.projectStatusMarkers(result)
    if (messageHistory && searchParams.get('view') === 'wizard') result = ctx.projectWizardMessageHistory(result)
  }
  response.writeHead(upstream.status, { ...responseHeaders, 'Content-Length': result.length })
  response.end(result)
}

/** Same visibility rule as the main list (chats the owner had, not internal sessions such as cron or titles). */
function filterThreads(result, visible) {
  if (typeof visible !== 'function') return result
  try {
    const payload = JSON.parse(result.toString('utf8'))
    for (const key of ['data', 'sessions']) if (Array.isArray(payload?.[key])) payload[key] = payload[key].filter((session) => visible(session))
    return Buffer.from(JSON.stringify(payload))
  } catch { return result }
}

function sessionIdsIn(result) {
  try {
    const payload = JSON.parse(result.toString('utf8'))
    return ['data', 'sessions'].flatMap((key) => (Array.isArray(payload?.[key]) ? payload[key] : [])).map((item) => item?.id).filter((id) => typeof id === 'string')
  } catch { return [] }
}
