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
const REFUSED = Object.freeze({ kind: 'refused' })

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
  async function resolve(request) {
    // The agent-only listener (what agent containers are given): a valid agent credential or nothing.
    // Owner proof, access headers and the Service's own token are never honoured there.
    if (request?.[AGENT_INGRESS]) return agentPrincipal(request) ?? REFUSED
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
  return pathname === '/wizard/mcp' || pathname === '/wizard/v1/agent-context' || pathname.startsWith('/wizard/hermes/')
}
