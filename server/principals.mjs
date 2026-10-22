// Who is calling the Service (owner vs agent authentication).
//
// Every request resolves to one principal before any route runs:
//   owner     the owner's own client. Proven by the configured access verifier (Tailscale Serve / Cloudflare
//             Access), or by the owner-proof header that the trusted front proxy adds after it authenticated
//             the owner. No query parameter, UI flag, Origin, Host, identity header or loopback peer counts.
//   service   this Service calling itself (share delivery and similar in-process work).
//   agent     an agent presenting its own gateway credential; scoped to that agent's own work.
//   anonymous anything else. Keeps whatever the deployment's auth mode allows for non-private routes.
//
// A box-only install (auth mode none) without an owner proof has no way to tell callers apart: there the
// box itself is the owner, as before. Configuring the owner proof switches it to strict mode, where only
// the proof makes the owner.
import { createHash, timingSafeEqual } from 'node:crypto'

export const OWNER_PROOF_HEADER = 'x-wizard-owner-proof'
const PRINCIPAL = Symbol.for('wizard.service.principal')
const AGENT_INGRESS = Symbol.for('wizard.service.agent_ingress')
const ANONYMOUS = Object.freeze({ kind: 'anonymous' })
const BOX_OWNER = Object.freeze({ kind: 'owner', via: 'box_only' })
const REFUSED = Object.freeze({ kind: 'refused', status: 401, error: 'agent_credential_required', check: 'principal.agent_ingress' })
const WRONG_NETWORK = Object.freeze({ kind: 'refused', status: 403, error: 'agent_network', check: 'principal.agent_network' })

/** Whether this request arrived on the agent-only listener. */
export function isAgentIngress(request) {
  return Boolean(request?.[AGENT_INGRESS])
}

/** Paths the agent-only listener serves at all: the app gateway and the agent's own context. */
export function agentIngressPathAllowed(method, pathname) {
  return (method === 'POST' && /^\/wizard\/v1\/agent-heavy\/(submit|status|cancel|artifacts)$/u.test(pathname)) || (pathname === '/wizard/standard-chats/mcp' && method === 'POST') || pathname === '/wizard/mcp' || (pathname === '/wizard/v1/agent-context' && method === 'GET')
}

function ipv4(address) {
  const text = String(address || '').replace(/^::ffff:/iu, '')
  const parts = text.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part) || Number(part) > 255)) return null
  return parts.reduce((sum, part) => sum * 256 + Number(part), 0)
}

/** True when `address` lies inside the IPv4 `cidr` (e.g. 10.250.0.16/28). */
export function inSubnet(address, cidr) {
  const [base, bitsText] = String(cidr || '').split('/')
  const bits = Number(bitsText)
  const ip = ipv4(address)
  const net = ipv4(base)
  if (ip === null || net === null || !Number.isInteger(bits) || bits < 8 || bits > 32) return false
  const size = 2 ** (32 - bits)
  return Math.floor(ip / size) === Math.floor(net / size)
}

/** Marks a request that arrived on the agent-only listener: there, only an agent credential counts. */
export function markAgentIngress(request) {
  Object.defineProperty(request, AGENT_INGRESS, { value: true, configurable: true })
  return request
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest()
}

/** Compares two secrets through fixed-size digests, so the comparison itself leaks nothing about the expected value. */
export function sameSecret(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string' || !supplied || !expected) return false
  return timingSafeEqual(digest(supplied), digest(expected))
}

function bearer(request) {
  const match = /^Bearer\s+(.+)$/iu.exec(String(request.headers?.authorization || ''))
  return match ? match[1].trim() : ''
}

/**
 * options: {
 *   ownerProof: string        shared secret the front proxy adds for the authenticated owner ('' = off),
 *   requireAccess: boolean    the verifier below gates every request (tailscale / cloudflare mode),
 *   accessVerified(request)   async verifier result,
 *   internalCall(request)     the Service's own in-process token,
 *   agentForToken(token)      id of the non-main agent whose gateway credential this is ('' = none),
 *   mainAgentId               id of the main agent (its credential is not an agent principal here),
 *   agentSubnet(agentId)      uplink subnet the agent's requests must come from on the agent-only listener,
 *   agentRestricted(agentId)  true for an agent in the restricted runtime: its key works only on the agent-only
 *                             listener, even when its stored network is missing or malformed (fail closed),
 * }
 */
export function createPrincipalResolver(options = {}) {
  const ownerProof = typeof options.ownerProof === 'string' ? options.ownerProof.trim() : ''
  if (ownerProof && ownerProof.length < 32) throw new Error('The owner proof secret must be at least 32 characters')
  const mainAgentId = options.mainAgentId ?? 'hermes'
  function agentPrincipal(request) {
    const token = bearer(request)
    if (!token || typeof options.agentForToken !== 'function') return null
    let agentId = ''
    try { agentId = options.agentForToken(token) || '' } catch { agentId = '' }
    return agentId && agentId !== mainAgentId ? { kind: 'agent', agentId } : null
  }
  function networkBound(agentId) {
    try {
      if (typeof options.agentRestricted === 'function' && options.agentRestricted(agentId)) return true
      return typeof options.agentSubnet === 'function' && Boolean(options.agentSubnet(agentId))
    } catch {
      return true
    }
  }
  async function resolve(request) {
    // The agent-only listener (what agent containers are given): a valid agent credential or nothing.
    // Owner proof, access headers and the Service's own token are never honoured there.
    if (request?.[AGENT_INGRESS]) {
      const agent = agentPrincipal(request)
      if (!agent) return REFUSED
      // Each agent key works only from that agent's own uplink network (its edge sidecar).
      const subnet = typeof options.agentSubnet === 'function' ? options.agentSubnet(agent.agentId) : ''
      return subnet && inSubnet(request.socket?.remoteAddress, subnet) ? agent : WRONG_NETWORK
    }
    if (ownerProof) {
      const supplied = request.headers?.[OWNER_PROOF_HEADER]
      if (typeof supplied === 'string' && sameSecret(supplied, ownerProof)) return { kind: 'owner', via: 'proxy_proof' }
    }
    // With an owner proof configured, the proof alone makes the owner: header-based verifiers can be
    // imitated by a local caller, so they keep gating access but never grant the owner.
    if (!ownerProof && options.requireAccess && typeof options.accessVerified === 'function') {
      try { if (await options.accessVerified(request)) return { kind: 'owner', via: 'access_verifier' } } catch { /* not the owner */ }
    }
    if (typeof options.internalCall === 'function' && options.internalCall(request)) return { kind: 'service' }
    const agent = agentPrincipal(request)
    // A restricted agent's key is bound to its own network and works only on the agent-only listener.
    if (agent && networkBound(agent.agentId)) return WRONG_NETWORK
    if (agent) return agent
    if (!ownerProof && !options.requireAccess) return BOX_OWNER
    return ANONYMOUS
  }
  return {
    strict: Boolean(ownerProof) || Boolean(options.requireAccess),
    async attach(request) {
      const principal = await resolve(request)
      Object.defineProperty(request, PRINCIPAL, { value: principal, configurable: true })
      return principal
    },
    resolve,
  }
}

/** The principal attached to this request (anonymous when none was resolved). */
export function principalOf(request) {
  return request?.[PRINCIPAL] ?? ANONYMOUS
}

/** Owner or the Service itself: the only principals that may open a private agent's work. */
export function ownerLike(principal) {
  return principal?.kind === 'owner' || principal?.kind === 'service'
}

/** Paths an agent credential may use at all; everything else is the owner's surface. */
export function agentPathAllowed(pathname) {
  return /^\/wizard\/v1\/agent-heavy\/(submit|status|cancel|artifacts)$/u.test(pathname) || pathname === '/wizard/standard-chats/mcp' || pathname === '/wizard/mcp' || pathname === '/wizard/v1/agent-context' || pathname.startsWith('/wizard/hermes/')
}
