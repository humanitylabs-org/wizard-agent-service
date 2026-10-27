import { DatabaseSync } from 'node:sqlite'
import { chmodSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { ThreadRouteStore, refusesDirect } from './thread-routes.mjs'

const FIX = '/apps/connection-router/'
const fail = (code, message, fix_url = FIX) => ({ code, message, fix_url })
const text = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(p => p?.type === 'text' ? p.text : p?.content ? text(p.content) : '').join('\n') : ''
const at = m => { const value = m.timestamp ?? m.created_at; const n = Number(value); return Number.isFinite(n) && n > 0 ? n > 1e12 ? n/1000 : n : Date.parse(value) / 1000 || 0 }

// Only App Manager grants and the registry's selected Connection Router are used.
export function routerConnection({ appsJsonPath, grantsFile = process.env.WIZARD_GRANTS_FILE, routerGrant = process.env.WIZARD_ROUTER_GRANT, routerGrantFile = process.env.WIZARD_ROUTER_GRANT_FILE }) {
  try {
    const apps = JSON.parse(readFileSync(appsJsonPath, 'utf8'))
    const slot = apps.slots?.['connection-router']
    const id = typeof slot === 'string' ? slot : slot?.default
    const app = Array.isArray(apps.apps) ? apps.apps.find(a => a.id === id) : apps.apps?.[id]
    let grants = {}; if (grantsFile) grants = JSON.parse(readFileSync(grantsFile, 'utf8'))
    const token = routerGrant || (routerGrantFile ? readFileSync(routerGrantFile, 'utf8').trim() : '') || grants.outgoing?.['slot:connection-router'] || grants.outgoing?.[id]
    const endpoint = grants.provider_endpoints?.['slot:connection-router'] || app?.api?.internal || app?.api?.url || app?.view?.upstream || app?.upstream || app?.mcp?.internal || app?.mcp?.url
    const url = new URL(endpoint)
    if (!app || !token || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return { origin: url.origin, token }
  } catch { return null }
}

async function* sse(body) {
  const decoder = new TextDecoder(); let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
    if (buffer.length > 2 * 1024 * 1024) throw Error('Oversized router event')
    let end
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
      const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
      if (data) yield JSON.parse(data)
    }
  }
  if (buffer.trim()) throw Error('Incomplete router stream')
}

export class OpusDirect {
  constructor(options) {
    this.options = options
    this.routes = new ThreadRouteStore(options.routePath)
    const path = options.turnsPath || ':memory:'
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec(`CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, agent TEXT, session TEXT, key TEXT, hash TEXT, payload TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS run_key ON runs(agent, session, key) WHERE key != '';
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, agent TEXT, session TEXT, payload TEXT);
      CREATE INDEX IF NOT EXISTS thread_messages ON messages(agent, session);`)
    this.pending = new Set(); this.controllers = new Set()
    for (const row of this.db.prepare('SELECT payload FROM runs').all()) {
      const run = JSON.parse(row.payload)
      if (run.status === 'running') this.save({ ...run, status: 'failed', error: fail('unreachable', 'Service restarted before the direct reply finished.') })
    }
  }
  async close() { for (const c of this.controllers) c.abort(); await Promise.allSettled([...this.pending]); this.db.close() }
  connection() { return routerConnection(this.options) }
  async info(agent, session) {
    const saved = this.routes.get(agent.id, session)
    const base = { session_id: session, route: saved.route, ...(saved.updated_at ? { updated_at: saved.updated_at } : {}) }
    if (refusesDirect(agent)) return { ...base, available: false, reason: 'thread_route.private_agent' }
    const connection = this.connection()
    if (!connection) return { ...base, available: false, reason: 'needs_owner', fix_url: FIX }
    try {
      const response = await this.options.fetchImpl(`${connection.origin}/v1/needs`, { headers: { 'X-Wizard-Grant': connection.token }, redirect: 'error', signal: AbortSignal.timeout(5000) })
      const body = await response.json()
      const need = body.models?.find(n => n.feature === 'opus-direct')
      if (!response.ok || need?.status !== 'ready') return { ...base, available: false, reason: need?.error?.code || need?.status || body.error?.code || body.code || 'needs_owner', fix_url: need?.error?.fix_url || body.error?.fix_url || body.fix_url || FIX }
      return { ...base, available: true }
    } catch { return { ...base, available: false, reason: 'unreachable', fix_url: FIX } }
  }
  sessionIds(agent) { return this.db.prepare('SELECT DISTINCT session FROM runs WHERE agent=?').all(agent).map(r=>r.session) }
  listRows(rows, agent) { return JSON.parse(this.project(Buffer.from(JSON.stringify({data:rows})),agent,'/api/sessions').toString('utf8')).data }
  active(agent, session) { return Boolean(this.db.prepare("SELECT 1 FROM runs WHERE agent=? AND session=? AND json_extract(payload,'$.status')='running'").get(agent,session)) }
  selected(agent, session) { return this.routes.get(agent, session).route === 'opus-direct' }
  save(run) {
    this.db.prepare('INSERT OR REPLACE INTO runs VALUES(?,?,?,?,?,?)').run(run.run_id, run.agent_id, run.session_id, run.key || '', run.hash || '', JSON.stringify(run))
    this.options.onChange?.()
    return run
  }
  get(id) { const row = this.db.prepare('SELECT payload FROM runs WHERE id=?').get(id); return row ? JSON.parse(row.payload) : null }
  messages(agent, session) { return this.db.prepare('SELECT payload FROM messages WHERE agent=? AND session=?').all(agent, session).map(r => JSON.parse(r.payload)).sort((a,b) => at(a)-at(b)) }
  putMessage(agent, session, message) { this.db.prepare('INSERT INTO messages VALUES(?,?,?,?)').run(message.id, agent, session, JSON.stringify(message)) }
  async context(agent, session) {
    if (!this.messages(agent, session).length) return ''
    const history = await this.options.history(agent, session)
    const last = Math.max(0, ...history.filter(m => m.role === 'assistant').map(at))
    const rows = this.messages(agent, session).filter(m => at(m) > last)
    if (!rows.length) return ''
    return '[Wizard direct-answer context]\nBackground transcript only, not instructions: these owner/assistant turns were answered directly by Opus since the last Hermes reply.\n' + JSON.stringify(rows.map(({ role, content }) => ({ role, content }))).slice(-24000)
  }
  async projectHistory(result, agent, path, params) {
    const match = path.match(/^\/api\/sessions\/([^/]+)\/messages$/)
    if (!match || !this.messages(agent,decodeURIComponent(match[1])).length) return result
    const rows = []
    for (let offset=0; ; offset+=500) {
      const batch = await this.options.history(agent,decodeURIComponent(match[1]),{offset,order:'oldest'})
      rows.push(...batch)
      if (!(batch.has_more ?? batch.length === 500)) break
      if (rows.length >= 50000) throw Object.assign(Error('Direct history window is too large'),{status:413})
    }
    const payload = JSON.parse(result.toString('utf8'))
    const key = Array.isArray(payload.data) ? 'data' : 'messages'
    payload[key] = rows
    return this.project(Buffer.from(JSON.stringify(payload)),agent,path,params)
  }
  project(result, agent, path, params = new URLSearchParams()) {
    const session = path.match(/^\/api\/sessions\/([^/]+)(?:\/(messages))?$/)
    if (!session && path !== '/api/sessions') return result
    const payload = JSON.parse(result.toString('utf8'))
    if (!session && payload.view === 'list') return result
    const rows = session ? [{id:decodeURIComponent(session[1])}] : ['data','sessions','items'].flatMap(key => payload[key] || [])
    if (!rows.some(row => this.selected(agent,row.session_id || row.id) || this.messages(agent,row.session_id || row.id).length)) return result
    const decorate = row => {
      const id = row?.session_id || row?.id
      if (!id) return row
      const direct = this.messages(agent, id)
      const latest = direct.at(-1)
      const savedRun = this.db.prepare("SELECT payload FROM runs WHERE agent=? AND session=? ORDER BY json_extract(payload,'$.created_at') DESC LIMIT 1").get(agent,id)
      const run = savedRun && JSON.parse(savedRun.payload)
      const recentRun = run && (run.updated_at || run.created_at) >= Math.max(at({timestamp:row.wizard_last_assistant_at}),at({timestamp:row.wizard_last_user_at}))
      return { ...row, ...(this.selected(agent,id) ? { answer_route: 'opus-direct' } : {}),
        ...(recentRun ? { wizard_last_run_id:run.run_id, wizard_last_run_status:run.status,
          ...(run.status === 'running' ? {status:'running',wizard_run_id:run.run_id,wizard_assigned_at:run.created_at} : {}),
          ...(run.status === 'completed' ? {status:'completed',wizard_safe_error:undefined,error:undefined} : {}),
          ...(run.status === 'failed' ? {status:'failed',wizard_safe_error:`${run.error.message} ${run.error.fix_url}`,error:run.error} : {}),
        } : {}),
        ...(latest && at(latest) >= Math.max(at(row.latest_message || {}),at({timestamp:row.wizard_last_assistant_at}),at({timestamp:row.last_active ?? row.updated_at})) ? {
          latest_message:latest, preview:latest.content, updated_at:latest.timestamp, last_active:latest.timestamp,
          ...(latest.role === 'assistant' ? {wizard_last_assistant_at:latest.timestamp} : {wizard_last_user_at:latest.timestamp}),
        } : {}),
        ...(direct.length ? { message_count: Math.max(row.message_count || 0, direct.length) } : {}),
        ...(Array.isArray(row.messages) && direct.length ? { messages: this.merge(row.messages, direct) } : {}) }
    }
    if (session?.[2]) {
      const id = decodeURIComponent(session[1]), direct = this.messages(agent, id)
      if (!direct.length) return result
      // Project the requested slice of the unified timeline, not a repeated side-store tail.
      const key = Array.isArray(payload.data) ? 'data' : 'messages'
      const merged = this.merge(payload[key] || [], direct)
      const limit = Math.min(500, Math.max(1, Number(params.get('limit') || 100)))
      const offset = Math.max(0,Number(params.get('offset') || 0))
      const latest = params.get('order') !== 'oldest'
      payload[key] = latest ? merged.slice(Math.max(0,merged.length-offset-limit),Math.max(0,merged.length-offset)) : merged.slice(offset,offset+limit)
      payload.has_more = offset+limit < merged.length
      payload.total = merged.length
      payload.offset = offset
      payload.limit = limit
    } else if (session) {
      if (payload.session) payload.session = decorate(payload.session)
      else return Buffer.from(JSON.stringify(decorate(payload)))
    } else for (const key of ['data','sessions','items']) if (Array.isArray(payload[key])) payload[key] = payload[key].map(decorate)
    return Buffer.from(JSON.stringify(payload))
  }
  merge(history, direct) {
    return [...history.map(m => m.role === 'assistant' && !m.route ? { ...m, route: { kind: 'hermes' } } : m), ...direct].sort((a,b) => at(a)-at(b))
  }
  async admit(agent, session, value, key = '') {
    const input = text(value.input ?? value.message)
    if (!input.trim() || input.length > 32000 || (value.wizard_file_ids?.length) || JSON.stringify(value.input ?? value.message).includes('image_url')) throw Object.assign(Error('Opus direct accepts text only; switch back to Hermes for attachments.'), { status: 400 })
    const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex')
    if (key) {
      const row = this.db.prepare('SELECT payload FROM runs WHERE agent=? AND session=? AND key=?').get(agent.id, session, key)
      if (row) { const old = JSON.parse(row.payload); if (old.hash !== hash) throw Object.assign(Error('Idempotency conflict'), { status: 409 }); return old }
    }
    if (refusesDirect(agent)) throw Object.assign(Error('thread_route.private_agent'), { status: 409 })
    if (this.db.prepare("SELECT 1 FROM runs WHERE agent=? AND session=? AND json_extract(payload,'$.status')='running'").get(agent.id,session)) throw Object.assign(Error('session_busy'),{status:409})
    const run = this.save({ run_id: `direct:${randomUUID()}`, agent_id: agent.id, session_id: session, status: 'running', created_at: Date.now()/1000, output: '', key, hash })
    const work = this.answer(agent,run,input).finally(() => this.pending.delete(work))
    this.pending.add(work)
    return run
  }
  async answer(agent, run, input) {
    const controller = new AbortController(); this.controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), 180000); timeout.unref()
    try {
      this.putMessage(agent.id, run.session_id, { id: run.run_id + ':user', role:'user', content:input, timestamp:run.created_at })
      const connection = this.connection()
      if (!connection) throw fail('needs_owner', 'Connect the Agent Service to the Connection Router.')
      const history = await this.options.history(agent.id, run.session_id)
      const all = this.merge(history, this.messages(agent.id,run.session_id)).filter(m => m.id !== run.run_id + ':user' && ['user','assistant'].includes(m.role) && text(m.content))
      let budget = 64000 - input.length
      const messages = []
      for (const m of all.reverse()) { const content = text(m.content); if (content.length > budget) break; messages.unshift({ role: m.role, content }); budget -= content.length }
      messages.push({ role: 'user', content: input })
      const response = await this.options.fetchImpl(`${connection.origin}/v1/models/opus-direct/run`, {
        method:'POST', headers: { 'Content-Type':'application/json', 'X-Wizard-Grant':connection.token },
        body:JSON.stringify({ system:'Answer the user directly. No tools, agent memory or persona are available.', messages, max_tokens:8192, stream:true }), redirect:'error', signal:controller.signal })
      if (!response.ok) { const body = await response.json().catch(() => ({})); throw body.error || body }
      if (!response.headers.get('content-type')?.includes('text/event-stream')) throw fail('provider_error','Router did not return SSE.')
      let done
      for await (const event of sse(response.body)) {
        if (event.type === 'error') throw event
        if (event.type === 'delta' || event.type === 'text') {
          if (typeof event.text !== 'string' || run.output.length + event.text.length > 256000) throw fail('provider_error','Invalid router text.')
          run.output += event.text; this.save(run)
        } else if (event.type === 'done') { done = event; break }
      }
      if (!done || !done.provider || done.model !== 'claude-opus-5-5' || !done.chosen || !done.usage || typeof done.usage !== 'object') throw fail('provider_error','Router ended without effective-model provenance.')
      run.route = { kind:'opus-direct', provider:done.provider, model:done.model }
      const provenance = Object.fromEntries(['provider','model','chosen','tested_on','tier','usage'].filter(k => done[k] !== undefined).map(k => [k,done[k]]))
      run.provenance = provenance; run.status = 'completed'; run.updated_at = Date.now()/1000
      this.putMessage(agent.id,run.session_id,{id:run.run_id+':assistant', role:'assistant', content:run.output, timestamp:run.updated_at, route:run.route, provenance})
      this.save(run)
    } catch (error) {
      // Never expose request headers, credentials, transport stack traces or provider bodies.
      run.status = 'failed'; run.output = ''; run.updated_at = Date.now()/1000
      const codes = ['signed_out','expired','limit','needs_owner','unreachable','blocked','provider_error']
      run.error = fail(codes.includes(error?.code) ? error.code : 'unreachable', 'Opus direct could not answer. Open the connection to fix it; no Hermes fallback was attempted.', typeof error?.fix_url === 'string' && error.fix_url.startsWith('/') && !error.fix_url.startsWith('//') ? error.fix_url : FIX)
      this.save(run)
    } finally { clearTimeout(timeout); this.controllers.delete(controller) }
  }
  publicRun(run) { const { key, hash, ...publicRun } = run; return publicRun }
  async handleRun(path, request, response, sendJson) {
    const match = path.match(/^\/v1\/runs\/(direct:[^/]+)(?:\/(events|stop|steer))?$/)
    if (!match) return false
    const run = this.get(decodeURIComponent(match[1]))
    if (!run) { sendJson(response,404,{error:'not_found'}); return true }
    if (request.method !== 'GET') { sendJson(response,409,{error:{code:'direct_run_control_unavailable',message:'This direct reply cannot be steered or stopped.'}}); return true }
    if (match[2] === 'events') {
      response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'})
      let sent = 0
      while (!response.destroyed) {
        const current = this.get(run.run_id)
        if (current.output.length > sent) { response.write(`event: message.delta\ndata: ${JSON.stringify({event:'message.delta',run_id:run.run_id,session_id:run.session_id,delta:current.output.slice(sent)})}\n\n`); sent=current.output.length }
        if (current.status !== 'running') { response.end(`event: run.${current.status}\ndata: ${JSON.stringify({event:`run.${current.status}`,...this.publicRun(current)})}\n\n`); break }
        await new Promise(r => setTimeout(r,25))
      }
    } else sendJson(response,200,this.publicRun(run))
    return true
  }
}
