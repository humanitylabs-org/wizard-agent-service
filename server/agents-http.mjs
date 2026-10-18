// HTTP side of the Agents MVP (wizard-os spec/AGENTS.md section 3):
//   /wizard/v1/agents, /wizard/v1/agents/<id>, /wizard/v1/agents/<id>/start|stop, /wizard/v1/agent-options
//   /wizard/v1/agents/<id>/deliveries  (internal: assistant-only recap delivery, bearer token)
//   /wizard/v1/apps/<app_id>/binding, /wizard/v1/app-bindings, /wizard/v1/apps/<app_id>/deliveries (app → agent binding)
//   /wizard/v1/apps/<app_id>/agents   (which agents can use an app, #58)
//   /wizard/v1/agent-grants           (agent-data grants; a private source is refused, #59)
// and the agent-scoped thread/run proxy used when a request names a non-main agent or a thread pinned to one.
import { Readable } from 'node:stream'
import { listPayload } from './session-list-view.mjs'
import { fullRetryInput, searchMessageText } from './session-detail.mjs'
import { createListWindows, selectWindow } from './session-list-window.mjs'
const listWindows = new WeakMap()
import { pipeline } from 'node:stream/promises'
import { AgentError, MAIN_AGENT_ID } from './agents.mjs'
import { ownerLike, principalOf } from './principals.mjs'
import { STATUS_INSTRUCTIONS } from './thread-status.mjs'

export const AGENT_RUN_INSTRUCTIONS = `You are serving the user through Wizard, a first-party client for their own agents. This is a separate agent with its own private history, memory and files; nothing from other agents is available here. Answer with the same care you would anywhere else, scaled to the request. Wizard renders Markdown.

${STATUS_INSTRUCTIONS}`

const AGENT_ROUTE = /^\/wizard\/v1\/agents(?:\/([a-z][a-z0-9-]{0,30})(?:\/(start|stop|deliveries))?)?$/u
const GRANT_ROUTE = /^\/wizard\/v1\/agent-grants(?:\/(grant_[a-f0-9]{12}))?$/u

/** True when the agent exists and is private. */
export function isPrivateAgent(registry, id) {
  return Boolean(id) && registry.read(id)?.privacy === 'private'
}

/** Owner (or the Service itself) may open any agent; an agent credential only its own. */
export function mayOpenAgent(request, agentId) {
  const principal = principalOf(request)
  return ownerLike(principal) || (principal.kind === 'agent' && principal.agentId === agentId)
}

/**
 * A private agent's work is the owner's alone: refuse every other principal, whatever it claims. The refusal is
 * the same answer as an agent that does not exist, so it does not tell anyone that the private agent is there.
 */
export function assertAgentTargets(registry, request, ids, missing = () => new AgentError(404, 'agent_not_found', 'agent.id')) {
  for (const id of ids) {
    if (id && isPrivateAgent(registry, id) && !mayOpenAgent(request, id)) throw missing(id)
  }
}

/** Only the owner makes an agent private (or creates a private one). */
function assertPrivacyChange(request, body) {
  const wantsPrivate = body?.privacy === 'private' || body?.permissions?.preset === 'private'
  if (wantsPrivate && !ownerLike(principalOf(request))) throw new AgentError(403, 'owner_required', 'agent.private_owner')
}

/** Agents a non-owner may see in admin listings: private agents are the owner's alone. */
function visibleAgent(registry, request, id) {
  return !isPrivateAgent(registry, id) || mayOpenAgent(request, id)
}

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
  const publicAgent = async (agent) => ({ ...await registry.publicAgent(agent), bound_apps: ctx.bindings ? ctx.bindings.appsFor(agent.id) : [] })
  const isOptions = url.pathname === '/wizard/v1/agent-options'
  const grantMatch = url.pathname.match(GRANT_ROUTE)
  if (grantMatch || url.pathname.startsWith('/wizard/v1/agent-grants')) {
    if (!grantMatch) { sendJson(response, 404, { error: 'not_found', check: 'grant.route' }); return true }
    if (!await ctx.accessOk(request)) { sendJson(response, 403, { error: 'access_required' }); return true }
    const method = request.method ?? 'GET'
    try {
      if (grantMatch[1]) {
        if (method !== 'DELETE') throw new AgentError(405, 'method_not_allowed', 'grant.route')
        const existing = registry.grants().find((grant) => grant.id === grantMatch[1])
        if (existing) assertAgentTargets(registry, request, [existing.reader, existing.source])
        registry.removeGrant(grantMatch[1])
        sendJson(response, 200, { ok: true })
      } else if (method === 'GET') {
        const reader = url.searchParams.get('reader') ?? ''
        if (reader && (!registry.read(reader) || !visibleAgent(registry, request, reader))) throw new AgentError(404, 'agent_not_found', 'grant.reader')
        const grants = registry.grants().filter((grant) => (!reader || grant.reader === reader)
          && visibleAgent(registry, request, grant.reader) && visibleAgent(registry, request, grant.source))
        sendJson(response, 200, { grants, ...(reader ? { readable_sources: registry.readableSources(reader) } : {}) })
      } else if (method === 'POST') {
        const body = await readJson(ctx, request)
        // Check exactly the ids addGrant will store: anything but a plain string is refused before any check.
        for (const field of ['reader', 'source']) if (typeof body[field] !== 'string') throw new AgentError(400, 'invalid_request', `grant.${field}`)
        // Hidden ids get byte-for-byte the answer addGrant gives an id that does not exist.
        assertAgentTargets(registry, request, [body.reader], () => new AgentError(404, 'agent_not_found', 'grant.reader'))
        assertAgentTargets(registry, request, [body.source], () => new AgentError(404, 'agent_not_found', 'grant.source'))
        sendJson(response, 201, { grant: registry.addGrant(body) })
      } else throw new AgentError(405, 'method_not_allowed', 'grant.route')
    } catch (error) { sendAgentError(ctx, response, error) }
    return true
  }
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
      // The delivery token is a host writer's, not the owner's: it never opens a private agent.
      assertAgentTargets(registry, request, [agent.id])
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
      sendJson(response, 200, { ...await registry.agentOptions(), binding_apps: ctx.bindings ? ctx.bindings.list().filter((binding) => visibleAgent(registry, request, bindingAgent(binding))) : [] })
      return true
    }
    if (!id) {
      if (method === 'GET') {
        const agents = await Promise.all(registry.list().filter((agent) => visibleAgent(registry, request, agent.id)).map((agent) => publicAgent(agent)))
        sendJson(response, 200, { agents })
        return true
      }
      if (method === 'POST') {
        const body = await readJson(ctx, request)
        const idempotencyKey = typeof request.headers['idempotency-key'] === 'string' ? request.headers['idempotency-key'] : ''
        assertPrivacyChange(request, body)
        const created = await registry.create(body, { idempotencyKey })
        // A replayed key never counts as permission: the caller must be able to see the agent it gets back.
        if (!visibleAgent(registry, request, created.agent?.id)) throw new AgentError(404, 'agent_not_found', 'agent.id')
        sendJson(response, created.replayed ? 200 : 201, { agent: await publicAgent(created.agent) }, created.replayed ? { 'Idempotency-Replayed': 'true' } : {})
        return true
      }
      throw new AgentError(405, 'method_not_allowed', 'agent.route')
    }
    // A private agent is invisible to everyone but the owner: same answer as an agent that does not exist.
    if (!visibleAgent(registry, request, id)) throw new AgentError(404, 'agent_not_found', 'agent.id')
    if (action) {
      if (method !== 'POST') throw new AgentError(405, 'method_not_allowed', 'agent.route')
      requireJsonOrEmpty(request)
      const agent = await registry.setRunning(id, action === 'start')
      sendJson(response, 202, { agent: await publicAgent(agent) })
      return true
    }
    if (method === 'GET') {
      const agent = registry.read(id)
      if (!agent) throw new AgentError(404, 'agent_not_found', 'agent.id')
      sendJson(response, 200, { agent: await publicAgent(agent) })
      return true
    }
    if (method === 'PATCH') {
      const body = await readJson(ctx, request)
      assertPrivacyChange(request, body)
      const agent = await registry.update(id, body)
      sendJson(response, 200, { agent: await publicAgent(agent) })
      return true
    }
    throw new AgentError(405, 'method_not_allowed', 'agent.route')
  } catch (error) { sendAgentError(ctx, response, error) }
  return true
}

const APP_ROUTE = /^\/wizard\/v1\/apps\/([a-z0-9][a-z0-9._-]{0,63})\/(binding|deliveries|agents)$/u
// Delivery failures that mean "the bound agent is not there right now": fail loudly, never reroute.
const UNAVAILABLE = new Set(['agent_not_running', 'runtime_unreachable', 'agent_unavailable', 'docker_failed', 'runtime_unavailable'])

/**
 * App → agent binding (spec/AGENTS.md "App → agent binding"). Returns true when the request was answered.
 *   GET  /wizard/v1/app-bindings                → {bindings:[Binding]}            (owner)
 *   GET  /wizard/v1/apps/<app_id>/binding       → {binding}                      (owner)
 *   PUT  /wizard/v1/apps/<app_id>/binding       {agent} → {binding}              (owner)
 *   POST /wizard/v1/apps/<app_id>/deliveries    {delivery_key,title,body,thread?,metadata?}  (app token)
 */
export async function handleAppBindingApi(ctx, url, request, response) {
  const { registry, bindings, sendJson } = ctx
  const method = request.method ?? 'GET'
  const isList = url.pathname === '/wizard/v1/app-bindings'
  const match = isList ? null : url.pathname.match(APP_ROUTE)
  if (!isList && !match) return false
  const [, appId, action] = match ?? []
  // Which agents can use this app (#58): GET {app_id, kind, agents:[{id,label,privacy,appearance,enabled}]},
  // PUT {agents:[ids]} sets exactly that set (ticked agents gain the app, unticked agents lose it).
  if (action === 'agents') {
    if (!await ctx.accessOk(request)) { sendJson(response, 403, { error: 'access_required' }); return true }
    try {
      if (method === 'GET') {
        const value = registry.appAgents(appId)
        sendJson(response, 200, Array.isArray(value?.agents) ? { ...value, agents: value.agents.filter((agent) => visibleAgent(registry, request, agent?.id)) } : value)
      } else if (method === 'PUT') {
        const body = await readJson(ctx, request)
        const current = registry.appAgents(appId)
        let next = body
        if (Array.isArray(body.agents) && Array.isArray(current?.agents)) {
          // A caller who cannot see a private agent cannot change it either: its membership stays as it is,
          // and only the memberships this request actually changes are checked.
          const hiddenEnabled = current.agents.filter((agent) => agent?.enabled && !visibleAgent(registry, request, agent.id)).map((agent) => agent.id)
          const wanted = new Set([...body.agents, ...hiddenEnabled])
          next = { ...body, agents: [...wanted] }
          const changed = current.agents.filter((agent) => Boolean(agent?.enabled) !== wanted.has(agent?.id)).map((agent) => agent.id)
          assertAgentTargets(registry, request, [...changed, ...body.agents.filter((item) => typeof item === 'string')], (id) => new AgentError(404, 'agent_not_found', 'agent.id', id))
        }
        const result = await registry.setAppAgents(appId, next)
        sendJson(response, 200, Array.isArray(result?.agents) ? { ...result, agents: result.agents.filter((agent) => visibleAgent(registry, request, agent?.id)) } : result)
      }
      else throw new AgentError(405, 'method_not_allowed', 'app.route')
    } catch (error) { sendAgentError(ctx, response, error) }
    return true
  }
  if (!bindings) return false
  if (action === 'deliveries') {
    if (method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed', check: 'app.route' }); return true }
    const bearer = /^Bearer\s+(.+)$/iu.exec(String(request.headers.authorization || ''))?.[1]?.trim() || ''
    if (!bindings.tokenOk(appId, bearer)) { sendJson(response, 403, { error: 'app_token_required', check: 'app.delivery_token' }); return true }
    try {
      const body = await readJson(ctx, request)
      bindings.get(appId)   // the app must still be installed and declare a binding
      const payload = bindings.deliveryPayload(appId, body)
      const agentId = bindings.agentFor(appId)
      const agent = registry.read(agentId)
      if (!agent) throw new AgentError(409, 'bound_agent_missing', 'app.binding.agent', `bound to ${agentId}`)
      if (agentId !== MAIN_AGENT_ID) {
        const state = await registry.status(agent, { fresh: true })   // never deliver on a stale 'running'
        if (state.status !== 'running') throw new AgentError(503, 'bound_agent_unavailable', 'app.binding.agent_running', `${agentId} is ${state.status}`)
      }
      let receipt
      try { receipt = await ctx.deliver(agent, payload) } catch (error) {
        const code = error instanceof AgentError ? error.error : ''
        if (UNAVAILABLE.has(code)) throw new AgentError(503, 'bound_agent_unavailable', 'app.binding.agent_running', `${agentId}: ${code}`)
        throw error
      }
      if (receipt?.verified !== true) throw new AgentError(502, 'delivery_not_verified', 'agent.delivery')
      registry.pin(payload.session_id, agent.id)
      if (typeof receipt.session_id === 'string' && receipt.session_id !== payload.session_id) registry.pin(receipt.session_id, agent.id)
      sendJson(response, 200, {
        verified: true, already_delivered: receipt.already_delivered === true, session_id: receipt.session_id ?? payload.session_id,
        agent: registry.threadAgent(agent),
      })
    } catch (error) { sendAgentError(ctx, response, error) }
    return true
  }
  if (!await ctx.accessOk(request)) { sendJson(response, 403, { error: 'access_required' }); return true }
  try {
    if (isList) {
      if (method !== 'GET') throw new AgentError(405, 'method_not_allowed', 'app.route')
      sendJson(response, 200, { bindings: bindings.list().filter((binding) => visibleAgent(registry, request, bindingAgent(binding))) })
      return true
    }
    if (method === 'GET') {
      const binding = bindings.get(appId)
      assertAgentTargets(registry, request, [bindingAgent(binding)])
      sendJson(response, 200, { binding })
      return true
    }
    if (method === 'PUT') {
      const body = await readJson(ctx, request)
      // Moving an app onto or off a private agent re-routes what the app delivers: owner only.
      assertAgentTargets(registry, request, [bindingAgent(bindings.get(appId)), typeof body.agent === 'string' ? body.agent : ''])
      sendJson(response, 200, { binding: bindings.set(appId, body) })
      return true
    }
    throw new AgentError(405, 'method_not_allowed', 'app.route')
  } catch (error) { sendAgentError(ctx, response, error) }
  return true
}

function bindingAgent(binding) {
  const value = binding?.agent
  return typeof value === 'string' ? value : typeof value?.id === 'string' ? value.id : typeof binding?.agent_id === 'string' ? binding.agent_id : ''
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
  let pinned = (sessionId && registry.pinnedAgent(sessionId)) || (runId && registry.runAgent(runId)) || ''
  // Authorize against the resolved target before anything else can answer (or hint) about it.
  assertAgentTargets(registry, request, [explicit])
  // A read by id alone of a thread or run the caller may not open goes where an unknown id goes (the main
  // agent, which does not have it): the answer is the same as for an id that does not exist.
  if (!explicit && pinned && method === 'GET' && isPrivateAgent(registry, pinned) && !mayOpenAgent(request, pinned)) pinned = ''
  assertAgentTargets(registry, request, [pinned])
  if (explicit && pinned && explicit !== pinned) throw new AgentError(409, 'thread_agent_pinned', 'thread.agent_pinned')
  // #59: a private agent's threads are read only through that agent's own Chats, which always names it. The operator
  // surface (other agents' work) never reaches a non-main agent, and a thread read that arrives by id alone (a link,
  // another view, another agent) is refused instead of being routed by the pin.
  const target = explicit || pinned
  if (target && target !== MAIN_AGENT_ID) {
    const agent = registry.read(target)
    if (operator) throw new AgentError(agent?.privacy === 'private' ? 409 : 404, agent?.privacy === 'private' ? 'private_agent_sealed' : 'agent_not_found', agent?.privacy === 'private' ? 'agent.private_sealed' : 'agent.id')
    // Session reads only: a run id is returned to the one who started the run and polled by it.
    if (agent?.privacy === 'private' && method === 'GET' && !explicit && sessionId && !runId) {
      throw new AgentError(409, 'private_agent_sealed', 'agent.private_sealed', 'open this thread in its own agent\'s Chats')
    }
  }
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
  // A thread is pinned only once its agent has accepted it, so a refused request never claims an id.
  let pinOnSuccess = ''
  const claim = (sessionId) => {
    const existing = registry.pinnedAgent(sessionId)
    if (existing && existing !== agent.id) registry.pin(sessionId, agent.id) // raises the usual pin conflict
    pinOnSuccess = sessionId
  }
  if (method === 'POST' && upstreamPath === '/v1/runs') {
    const sessionId = typeof value.session_id === 'string' ? value.session_id : ''
    if (!sessionId) throw new AgentError(400, 'session_required', 'thread.session_id')
    claim(sessionId)
    value = { ...value, instructions: AGENT_RUN_INSTRUCTIONS }
    delete value.delegation_delivery
    delete value.response_rendering
  }
  if (method === 'POST' && upstreamPath === '/api/sessions') {
    const sessionId = typeof (value.id ?? value.session_id) === 'string' ? (value.id ?? value.session_id) : ''
    if (sessionId) claim(sessionId)
    else pinAfter = 'session'
  }
  const key = registry.apiKey(agent.id)
  if (!key) throw new AgentError(503, 'agent_not_ready', 'agent.runtime.key')
  const headers = new Headers({ Authorization: `Bearer ${key}` })
  if (hasBody) headers.set('Content-Type', 'application/json')
  if (typeof request.headers.accept === 'string') headers.set('Accept', request.headers.accept)
  if (typeof request.headers['idempotency-key'] === 'string') headers.set('Idempotency-Key', request.headers['idempotency-key'])
  const query = new URLSearchParams(searchParams)
  for (const key of ['window','q','overrides','snapshot','cursor']) query.delete(key)
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
  if (upstream.ok && pinOnSuccess) registry.pin(pinOnSuccess, agent.id)
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
    // A thread read through its agent is that agent's from now on, even if it never appeared in a list.
    const readSession = method === 'GET' ? sessionIdFromPath(upstreamPath) : ''
    if (readSession) { try { registry.pin(readSession, agent.id) } catch { /* already another agent's */ } }
    const messageHistory = method === 'GET' && /^\/api\/sessions\/[^/]+\/messages$/u.test(upstreamPath)
    if (method === 'GET' && upstreamPath === '/api/sessions') {
      if (searchParams.get('window') === 'archive-50' || searchParams.has('q')) {
        if (!listWindows.has(ctx)) listWindows.set(ctx, createListWindows())
        const payload = await listWindows.get(ctx)({ params: searchParams, scope: agent.id, load: async () => {
          const all=[]; let offset=0
          // Read only this already-authorized agent runtime. Gateway controls never reach it.
          while (true) {
            const q=new URLSearchParams({limit:'100',offset:String(offset),include_children:'false'})
            const page=await ctx.fetchImpl(`${registry.upstream(agent)}/api/sessions?${q}`,{headers,redirect:'manual',signal:controller.signal})
            if(!page.ok) throw new AgentError(502,'upstream_unavailable','agent.runtime')
            const raw=Buffer.from(await page.arrayBuffer())
            if(secrets.some(secret=>raw.includes(Buffer.from(secret)))) throw new AgentError(502,'unsafe_upstream_response','agent.response')
            const value=JSON.parse(raw.toString('utf8')), rows=value.data||value.sessions||value.items||[]
            if(!Array.isArray(rows)) throw new AgentError(502,'upstream_unavailable','agent.runtime')
            all.push(...rows.filter(row=>!ctx.isThreadVisible||ctx.isThreadVisible(row)))
            if(value.has_more===false || (value.has_more!==true && rows.length<100)) break
            if(!rows.length || offset>=100000) throw new AgentError(502,'incomplete_listing','agent.runtime')
            offset+=rows.length
          }
          if (searchParams.get('q')) {
            const q=searchParams.get('q'), pending=all.filter(row=>!selectWindow([row],{q}).search_total);
            let index=0;
            await Promise.all(Array.from({length:Math.min(4,pending.length)},async()=>{
              while(index<pending.length) {
                const row=pending[index++];
                row.wizard_search_text=await searchMessageText(async offset=>{
                  const page=await ctx.fetchImpl(`${registry.upstream(agent)}/api/sessions/${encodeURIComponent(row.id)}/messages?order=latest&limit=100&offset=${offset}&include_compacted=true`,{headers,redirect:'manual',signal:controller.signal});
                  if(!page.ok) throw new AgentError(502,'upstream_unavailable','agent.runtime');
                  const raw=Buffer.from(await page.arrayBuffer());
                  if(secrets.some(secret=>raw.includes(Buffer.from(secret)))) throw new AgentError(502,'unsafe_upstream_response','agent.response');
                  return JSON.parse(raw.toString('utf8'));
                },q);
              }
            }));
          }
          return all
        }})
        result=Buffer.from(JSON.stringify(payload))
      }
      result = filterThreads(result, ctx.isThreadVisible)
      result = decorateThreadAgent(result, info)
      // One thread already claimed by another agent must not break this agent's whole list.
      for (const id of sessionIdsIn(result)) { try { registry.pin(id, agent.id) } catch { /* pinned elsewhere */ } }
      if(searchParams.get('view') === 'list') result=Buffer.from(JSON.stringify(listPayload(JSON.parse(result.toString('utf8')), searchParams.get('q'))))
    } else if (/^\/api\/sessions(?:\/[^/]+)?$/u.test(upstreamPath)) result = decorateThreadAgent(result, info)
    if (method === 'GET' && searchParams.get('view') === 'detail' && /^\/api\/sessions\/[^/]+$/u.test(upstreamPath)) {
      const payload=JSON.parse(result.toString('utf8')), row=payload.session||payload;
      row.wizard_retry_input=await fullRetryInput(async offset=> {
        const page=await ctx.fetchImpl(`${registry.upstream(agent)}${upstreamPath}/messages?order=latest&limit=100&offset=${offset}&include_compacted=true`,{headers,redirect:'manual',signal:controller.signal});
        if(!page.ok) throw new AgentError(502,'upstream_unavailable','agent.runtime');
        const raw=Buffer.from(await page.arrayBuffer());
        if(secrets.some(secret=>raw.includes(Buffer.from(secret)))) throw new AgentError(502,'unsafe_upstream_response','agent.response');
        return JSON.parse(raw.toString('utf8'));
      });
      result=Buffer.from(JSON.stringify(payload));
      if (ctx.projectAgentHistory) result=ctx.projectAgentHistory(result,agent);
    }
    const historySource = result
    if (messageHistory || /^\/v1\/runs\/[^/]+$/u.test(upstreamPath)) result = ctx.projectStatusMarkers(result)
    if (messageHistory && searchParams.get('view') === 'wizard') result = ctx.projectWizardMessageHistory(result, historySource)
    if (messageHistory && ctx.projectAgentHistory) result = ctx.projectAgentHistory(result, agent)
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
