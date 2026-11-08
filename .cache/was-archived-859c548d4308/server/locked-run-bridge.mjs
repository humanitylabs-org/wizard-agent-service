import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const idPattern = /^[A-Za-z0-9._:-]{1,180}$/
// Connect-phase failures: the request never reached Hermes, so a replay cannot duplicate it.
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])
export function neverSent(error) {
  for (let e = error, depth = 0; e && depth < 4; e = e.cause, depth++) if (NOT_SENT_CODES.has(e.code)) return true
  return false
}
const fail = (message, status = 422) => Object.assign(new Error(message), { status })

export function runtimeMatches(runtime, route) {
  if (runtime?.model !== route.model) return false
  if (runtime.provider === route.provider) return true
  // Hermes names the transport "custom"; the requested slug may disambiguate ONLY that actual transport.
  return runtime.provider === 'custom' && route.provider.startsWith('custom:')
    && runtime.requested?.provider === route.provider
}

export function sessionMessage(input) {
  if (typeof input === 'string') return input
  if (!Array.isArray(input)) throw fail('Invalid locked-chat input', 400)
  if (input.every(item => !item?.role)) return input  // already multimodal content parts
  if (!input.every(item => item?.role === 'user')) throw fail('Locked chat input must contain user messages only', 400)
  return input.flatMap(item => typeof item.content === 'string' ? [{ type: 'text', text: item.content }]
    : Array.isArray(item.content) ? item.content : [])
}

// A distinctive slice of the user's own words, used to find this exact send in the Hermes transcript.
export function probeText(input) {
  let text = ''
  try {
    const message = sessionMessage(input)
    text = typeof message === 'string' ? message
      : message.filter(part => part?.type === 'text' || part?.type === 'input_text').map(part => part.text || '').join('\n')
  } catch { return '' }
  text = text.replace(/\[WIZARD_FILES_V1\][\s\S]*?\[\/WIZARD_FILES_V1\]/g, '').trim()
  return text.slice(0, 120)
}

export class LockedRunBridge {
  constructor({ fetchImpl = fetch, origin, statePath = '', sessionRoute = () => null, deliveryProbe = null, uncertainSettleMs = 15_000 }) {
    this.rawFetch = fetchImpl
    // deliveryProbe(sessionId, sinceMs) -> true (Hermes has a user turn since then), false (it does not), null (unknown).
    // Lets an uncertain send (connection lost mid-request, e.g. a gateway restart) be replayed once Hermes
    // provably never recorded it, instead of failing James's message permanently.
    this.deliveryProbe = deliveryProbe
    this.uncertainSettleMs = uncertainSettleMs
    this.origin = origin.replace(/\/$/, '')
    this.statePath = statePath
    this.sessionRoute = sessionRoute
    this.entries = new Map()
    this.pending = new Map()
    this.streams = new Set()
    if (statePath) {
      try { this.entries = new Map(JSON.parse(readFileSync(statePath, 'utf8'))) }
      catch (error) { if (error.code !== 'ENOENT') throw fail('Model-route journal is unreadable', 503) }
    }
  }
  save() {
    if (!this.statePath) return
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 })
    const p = this.statePath + '.' + process.pid + '.tmp'
    writeFileSync(p, JSON.stringify([...this.entries]), { mode: 0o600 })
    renameSync(p, this.statePath)
  }
  async fetch(url, init = {}) {
    const target = new URL(url)
    if (target.origin === new URL(this.origin).origin && /^\/v1\/runs\/[^/]+$/.test(target.pathname) && (!init.method || init.method === 'GET')) {
      const response = await this.rawFetch(url, init)
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return response
      const value = await response.json()
      const entry = [...this.entries.values()].find(e => e.runId === target.pathname.split('/').at(-1))
      const actual = value.runtime || value.usage?.runtime || entry?.runtime
      if (actual) value.runtime = actual
      if (entry && actual && !runtimeMatches(actual, entry)) {
        value.status = 'failed'; value.output = null; value.error = 'Selected model/provider did not match the observed runtime'
      }
      return new Response(JSON.stringify(value), { status: response.status, headers: response.headers })
    }
    if (target.origin !== new URL(this.origin).origin || target.pathname !== '/v1/runs' || init.method !== 'POST')
      return this.rawFetch(url, init)
    let value
    try { value = JSON.parse(init.body.toString()) }
    catch { throw fail('Invalid model-route request', 400) }
    // Explicit body route is the immutable send-time selection. Older clients inherit a confirmed stored selection.
    const stored = this.sessionRoute(value.session_id)
    if (!value.require_model_lock && !stored) return this.rawFetch(url, init)
    const route = value.model && value.provider ? { model: value.model, provider: value.provider }
      : stored ? { model: stored.model, provider: stored.provider } : null
    if (!route && !value.require_model_lock) return this.rawFetch(url, init)
    if (!route?.model || !route?.provider || !idPattern.test(value.session_id || ''))
      throw fail('No confirmed model/provider for this message', 400)
    return this.start(value, route, init)
  }
  async start(value, route, init) {
    const headers = new Headers(init.headers)
    const idem = headers.get('Idempotency-Key')
    if (!idem) throw fail('Model-locked sends need an idempotency key', 400)
    const key = createHash('sha256').update(value.session_id + '\0' + idem).digest('hex')
    const requestHash = createHash('sha256').update(JSON.stringify({ ...value, ...route })).digest('hex')
    const existing = this.entries.get(key)
    if (existing && existing.requestHash !== requestHash) throw fail('Idempotency key belongs to a different selected model or message')
    if (this.pending.has(key)) return this.response(await this.pending.get(key), true)
    if (existing?.runId) return this.response(existing, true)
    if (existing && !(await this.provablyUndelivered(key, existing, value.session_id, probeText(value.input))))
      throw fail('Model-locked delivery is uncertain; automatic replay is blocked to avoid a duplicate')
    const entry = { sessionId: value.session_id, ...route, requestHash, state: 'starting', createdAt: Date.now() }
    this.entries.set(key, entry); this.save()
    const task = this.launch(value, route, headers, entry)
    this.pending.set(key, task)
    try { return this.response(await task) }
    finally { this.pending.delete(key) }
  }
  async provablyUndelivered(key, existing, sessionId, text) {
    if (existing.state !== 'uncertain' || typeof this.deliveryProbe !== 'function') return false
    // Give a send that did reach Hermes time to land in its transcript before judging it missing.
    if (Date.now() - existing.createdAt < this.uncertainSettleMs)
      throw fail('Model-locked delivery is being confirmed; retrying shortly', 503)
    let seen
    try { seen = await this.deliveryProbe(sessionId, existing.createdAt - 1_000, text) }
    catch { seen = null }
    if (seen === null || seen === undefined) throw fail('Model-locked delivery could not be confirmed yet; retrying', 503)
    if (seen) return false
    this.entries.delete(key); this.save()
    return true
  }
  response(entry, replay = false) {
    return new Response(JSON.stringify({ object: 'run', run_id: entry.runId, session_id: entry.sessionId,
      status: 'running', runtime: { model: entry.model, provider: entry.provider, model_lock: 'accepted' },
      created_at: entry.createdAt / 1000 }), {
      status: 202, headers: { 'Content-Type': 'application/json', ...(replay ? { 'Idempotency-Replayed': 'true' } : {}) },
    })
  }
  async launch(value, route, headers, entry) {
    // This native endpoint passes confirmed_runtime_lock to _create_agent, disables fallbacks and overrides /model.
    // Its run id uses the same native registry: status, steer, stop and approvals keep their existing URLs.
    const body = { ...value, ...route, require_model_lock: true, message: sessionMessage(value.input) }
    delete body.input
    if (typeof body.instructions === 'string') body.instructions = body.instructions.replace(
      'Join any delegated work in this run, inspect its result, finish integration or release work, and verify the real target before giving one final answer.',
      'When you hand work to background helpers, say in one short line what is running and end the turn. Wizard returns their results as a follow-up turn; then finish and verify the original request.')
    headers.set('Accept', 'text/event-stream')
    headers.set('Content-Type', 'application/json')
    let upstream
    try {
      upstream = await this.rawFetch(this.origin + '/api/sessions/' + encodeURIComponent(value.session_id) + '/chat/stream', {
        method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual',
        // The stream belongs to the durable send, not the browser connection which may close on acknowledgement.
      })
      if (!upstream.ok) {
        const key = [...this.entries].find(([, e]) => e === entry)?.[0]
        if (key) this.entries.delete(key)
        this.save()
        throw fail('Selected model was rejected before execution (' + upstream.status + ')', upstream.status >= 500 ? 503 : 409)
      }
      if (!upstream.body || !upstream.headers.get('content-type')?.includes('text/event-stream'))
        throw fail('Selected model could not start (' + upstream.status + ')', upstream.status >= 500 ? 503 : 409)
    } catch (error) {
      if ([...this.entries.values()].includes(entry)) {
        if (neverSent(error)) {
          const key = [...this.entries].find(([, e]) => e === entry)?.[0]
          if (key) this.entries.delete(key)
        } else entry.state = 'uncertain'
        this.save()
      }
      throw error
    }
    const reader = upstream.body.getReader()
    let accept, reject
    const admitted = new Promise((yes, no) => { accept = yes; reject = no })
    let accepted = false
    const consume = async () => {
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        while (true) {
          const { value: chunk, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
          let pos
          while ((pos = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, pos); buffer = buffer.slice(pos + 2)
            const event = frame.match(/^event:\s*(.+)$/m)?.[1]
            const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
            if (!data) continue
            let payload
            try { payload = JSON.parse(data) } catch { throw fail('Invalid locked-run event') }
            if (!accepted && event === 'run.started') {
              const meta = payload.runtime
              const ackMatches = (meta?.model || meta?.provider)
                ? runtimeMatches(meta, route)
                : meta?.requested?.model === route.model && meta?.requested?.provider === route.provider
              if (!idPattern.test(payload.run_id || '') || meta?.model_lock !== 'accepted' || !ackMatches)
                throw fail('Hermes did not acknowledge the selected model lock')
              entry.runId = payload.run_id; entry.state = 'running'; this.save()
              accepted = true; accept(entry)
            }
            if (event === 'error' && !accepted) throw fail('Selected model failed before acknowledgement')
            if (payload.runtime?.model_lock === 'confirmed') { entry.runtime = payload.runtime; this.save() }
            if (event?.startsWith('run.') && ['completed','failed','cancelled','interrupted'].includes(event.slice(4))) {
              entry.state = event.slice(4)
              if (payload.runtime && !runtimeMatches(payload.runtime, route)) entry.state = 'runtime_mismatch'
              this.save()
            }
          }
          if (buffer.length > 32 * 1024 * 1024) throw fail('Locked-run event exceeded the bound')
        }
        if (!accepted) throw fail('Selected model stream ended without an admission receipt')
      } catch (error) {
        entry.state = accepted ? 'stream_disconnected' : 'uncertain'; this.save()
        if (!accepted) reject(error)
        await reader.cancel().catch(() => {})
      } finally { reader.releaseLock() }
    }
    const task = consume()
    this.streams.add(task)
    void task.finally(() => this.streams.delete(task))
    return admitted
  }
}
