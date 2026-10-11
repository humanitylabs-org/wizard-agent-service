// Wizard OS agent bridge (spec/AGENT_BRIDGE.md in humanitylabs-org/wizard-os).
//
// One source, apps.json, turned into what every agent on the box needs:
//   1. tools:       one MCP gateway (/wizard/mcp) that proxies every running app's tools as <app>__<tool>,
//                   plus the wizard_apps meta tool, and says tools/list_changed when apps.json changes;
//   2. orientation: a FIXED kernel (GET /wizard/v1/agent-context), under 900 characters, no app list;
//   3. discovery:   one pointer skill per job (`provides`), <WIZARD_OS_HOME>/skills/wizard-job-<job>/SKILL.md,
//                   which skills.external_dirs puts into the agent's normal skills index.
// The Hermes plugin (hermes-plugin/wizard-os) renders the same kernel and pointers in Python;
// tests/agent-bridge.test.ts keeps the two renderers byte-identical.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unwatchFile, watchFile, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { dirname, join } from 'node:path'

export const MCP_SERVER_NAME = 'wizard'
export const META_TOOL = 'wizard_apps'
export const KERNEL_LIMIT = 900
export const JOB_SKILL_PREFIX = 'wizard-job-'
export const JOB_MAP_LINES = 12
export const DEFAULT_FILES_ROOT = '~/runtipi/media'
const JOB_STAMP = '.wizard-jobs'
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const SKIP_PROVIDES = new Set(['shell', 'agent-service', 'agent'])

function clean(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max) : ''
}

/** `defleur-video` -> `defleur_video`: the gateway prefix of an app's tools. */
export function toolPrefix(appId) {
  return String(appId || '').replace(/[^A-Za-z0-9_]/gu, '_')
}

/** `short-form-video` -> `short-form video`; the words an owner would say. */
export function jobWords(job) {
  return clean(String(job || '').replace(/[-_]+/gu, ' '), 60).replace(/^short form /u, 'short-form ')
}

function readJson(path, limit = 2 * 1024 * 1024) {
  try {
    if (!path || !existsSync(path) || statSync(path).size > limit) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch { return null }
}

/**
 * The apps an agent can use: running, with an MCP endpoint, not the shell/agent itself. Sorted by id so the
 * kernel is byte-stable (prompt caching). `mcpAddress` 'internal' picks mcp.internal (agent in a container).
 */
export function bridgeApps(registry, { mcpAddress = 'url' } = {}) {
  const out = []
  const seen = new Set()
  for (const app of Array.isArray(registry?.apps) ? registry.apps : []) {
    const id = clean(app?.id, 64)
    if (!id || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id) || seen.has(id)) continue
    const provides = Array.isArray(app.provides) ? app.provides.map((v) => clean(v, 40)).filter(Boolean) : []
    if (provides.some((p) => SKIP_PROVIDES.has(p))) continue
    const mcp = app.mcp && typeof app.mcp === 'object' ? app.mcp : null
    const url = clean(mcpAddress === 'internal' ? (mcp?.internal || mcp?.url) : (mcp?.url || mcp?.internal), 300)
    if (!url || !/^https?:\/\//u.test(url)) continue
    seen.add(id)
    out.push({
      id, prefix: toolPrefix(id), name: clean(app.name, 60) || id, summary: clean(app.summary, 200),
      status: clean(app.status, 24) || 'unknown', jobs: provides.filter((p) => !SKIP_PROVIDES.has(p)),
      url, transport: clean(mcp?.transport, 40) || 'streamable-http',
      skill: typeof app.skill === 'string' && app.skill && !app.skill.includes('..') ? app.skill : '',
    })
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The full name an agent sees for a gateway tool. Hermes prefixes MCP tools with mcp__<server>__. */
export function agentToolName(prefix, tool, harness = 'hermes') {
  const base = `${prefix}__${tool}`
  return harness === 'hermes' ? `mcp__${MCP_SERVER_NAME}__${base}` : base
}

/** The pointer skill name for a job: what the owner's words match in the skills index. */
export function jobSkillName(job) {
  return `${JOB_SKILL_PREFIX}${job}`
}

/** Jobs (provides) the apps offer, each with the apps that do it, sorted (byte-stable). */
function jobsOf(apps) {
  const byJob = new Map()
  for (const app of apps) for (const job of app.jobs) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/u.test(job)) continue
    if (!byJob.has(job)) byJob.set(job, [])
    byJob.get(job).push(app)
  }
  return [...byJob.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
}

/**
 * The kernel (spec v2): FIXED and short, the same text on every box, with no per-app list. Discovery
 * happens through the wizard-job-* pointer skills in the agent's normal skills index. Keep this function
 * and hermes-plugin/wizard-os/kernel.py in lockstep (the parity test compares them).
 * `jobMap` adds the fallback job -> app map (max 12 lines); the generic harness, which has no skills index,
 * always gets it.
 */
export function renderKernel(apps = [], { harness = 'hermes', filesRoot = DEFAULT_FILES_ROOT, jobMap = false } = {}) {
  const hermes = harness === 'hermes'
  const meta = hermes ? `mcp__${MCP_SERVER_NAME}__${META_TOOL}` : META_TOOL
  const name = hermes ? `mcp__${MCP_SERVER_NAME}__<app>__<tool>` : '<app>__<tool>'
  const text = [
    'Wizard OS: you are the owner\'s agent on this box. Installed Wizard apps do jobs for the owner.',
    `The owner's files are in the Files root, ${filesRoot}. App tools take paths relative to it.`,
    hermes
      ? 'When a request matches a wizard-job-<job> skill in your skills list:'
      : 'When a request matches a job below:',
    ...(hermes ? ['1. Load that skill with skill_view. It lists the app\'s tools and what each does.'] : ['1. Use the app named for that job.']),
    `2. Call the app's tool on the \`${MCP_SERVER_NAME}\` MCP server, named \`${name}\`.${hermes ? ' If it is not in your tool list, run it with tool_call and that exact name.' : ''}`,
    '3. Never search the disk, read apps.json, run wam or write a client to find or reach an app.',
    'An installed app beats your built-in tools for its job (its browser, not yours).',
    `"What apps do I have?": call \`${meta}\`. If an app tool fails, tell the owner it is not reachable (\`wam doctor\`).`,
    'Save only short pointer skills for app jobs, never a copy of an app\'s workflow.',
  ]
  if (jobMap || !hermes) {
    const rows = jobsOf(apps).slice(0, JOB_MAP_LINES).map(([job, owners]) =>
      `- ${jobWords(job)} -> ${owners.map((a) => `${a.name} (\`${agentToolName(a.prefix, '*', harness)}\`)`).join(', ')}`)
    text.push('', 'Jobs on this box:', ...(rows.length ? rows : ['- (no apps installed yet)']))
  }
  return text.join('\n')
}

/** Apps installed or changed since `before` (a map id -> status), for the per-run delta. */
export function appsDelta(apps, before) {
  return apps.filter((app) => before?.[app.id] !== app.status)
}

/** Mid-thread installs: one line per new or changed app, pointing at its wizard-job skill. */
export function renderDelta(apps, { harness = 'hermes' } = {}) {
  if (!apps.length) return ''
  return apps.map((app) => {
    const job = app.jobs.find((j) => /^[a-z0-9][a-z0-9-]{0,39}$/u.test(j))
    const state = app.status === 'running' ? 'new app' : `app ${app.status}`
    const how = job && harness === 'hermes' ? `load \`${jobSkillName(job)}\`` : `tools \`${agentToolName(app.prefix, '*', harness)}\``
    return `Wizard OS, ${state}: ${app.name} for ${job ? jobWords(job) : 'other jobs'}; ${how}.`
  }).join('\n')
}

// ---------- pointer skills ----------

/**
 * One tiny skill per job, so the job words the owner says match a skill description in the agent's
 * normal skills index. Routing only: which app, its skill, its tool names. `tools` maps app id -> tool
 * names when the gateway knows them; without it the pointer names the app's tool prefix.
 */
/** A tool as the pointer shows it: name plus the first sentence of its description (max 100 chars). */
function toolEntry(tool) {
  if (typeof tool === 'string') return { name: tool, purpose: '' }
  const first = clean(String(tool?.description || '').split(/(?<=[.!?])\s/u)[0], 100)
  return { name: String(tool?.name || ''), purpose: first.replace(/\.$/u, '') }
}

export function pointerSkills(apps, { harness = 'hermes', tools = {} } = {}) {
  const out = {}
  for (const [job, owners] of jobsOf(apps)) {
    const words = jobWords(job)
    const names = owners.map((a) => a.name).join(' or ')
    const lines = owners.flatMap((a) => {
      const known = (tools[a.id] || []).slice(0, 8).map(toolEntry)
      const down = a.status === 'running' ? '' : ` It is ${a.status} right now: tell the owner (\`wam doctor\`).`
      const head = `- ${a.name}: pick the tool whose purpose matches the request and call it.${down}`
      const rows = known.length
        ? known.map((t) => `  - \`${agentToolName(a.prefix, t.name, harness)}\`${t.purpose ? `: ${t.purpose}` : ''}`)
        : [`  - \`${agentToolName(a.prefix, '*', harness)}\``]
      const skill = a.skill ? [`  Its skill \`${a.id}\` (skill_view) has details for long or unusual jobs; the tools above come first.`] : []
      return [head, ...rows, ...skill]
    })
    out[jobSkillName(job)] = [
      '---',
      `name: ${jobSkillName(job)}`,
      `description: Use when the owner asks for ${words}. The installed ${names} app does it; call its tools, never search files.`,
      '---',
      '',
      `# ${words}`,
      '',
      ...lines,
      '',
      `Tools are on the \`${MCP_SERVER_NAME}\` MCP server.${harness === 'hermes' ? ' If one is not in your tool list, run it with tool_call and that exact name.' : ''} Paths are relative to the owner's Files root.`,
      '',
      'Written by Wizard OS from apps.json and rebuilt when apps change. Do not edit.',
      '',
    ].join('\n')
  }
  return out
}

/**
 * Write <osHome>/skills/wizard-job-<job>/SKILL.md and delete stale ones (and the v1 `_jobs` folder).
 * The App Manager rewrites <osHome>/skills on every install, so this runs after each apps.json change.
 * Returns the skill names written, or null when the folder is read-only.
 */
export function writePointerSkills(osHome, apps, opts = {}) {
  const root = join(osHome, 'skills')
  try {
    mkdirSync(root, { recursive: true })
    const skills = pointerSkills(apps, opts)
    for (const entry of readdirSync(root)) {
      if ((entry.startsWith(JOB_SKILL_PREFIX) && !skills[entry]) || entry === '_jobs') rmSync(join(root, entry), { recursive: true, force: true })
    }
    for (const [name, text] of Object.entries(skills)) {
      const file = join(root, name, 'SKILL.md')
      let current = ''
      try { current = readFileSync(file, 'utf8') } catch { /* new */ }
      if (current === text) continue
      mkdirSync(join(root, name), { recursive: true })
      writeFileSync(`${file}.tmp`, text)
      renameSync(`${file}.tmp`, file)
    }
    writeFileSync(join(root, JOB_STAMP), `${Date.now()}\n`)
    return Object.keys(skills)
  } catch {
    return null
  }
}

// ---------- MCP client (to the apps) ----------

function decodeMcpBody(contentType, text, wantId) {
  if (/text\/event-stream/iu.test(contentType || '')) {
    for (const block of text.split(/\r?\n\r?\n/u)) {
      const data = block.split(/\r?\n/u).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
      if (!data) continue
      try {
        const msg = JSON.parse(data)
        if (msg && msg.id === wantId) return msg
      } catch { /* keep looking */ }
    }
    throw new Error('no response in event stream')
  }
  const parsed = JSON.parse(text || 'null')
  const msg = Array.isArray(parsed) ? parsed.find((m) => m?.id === wantId) : parsed
  if (!msg) throw new Error('empty response')
  return msg
}

class AppClient {
  constructor(app, { fetchImpl, timeoutMs }) {
    this.app = app
    this.fetch = fetchImpl
    this.timeoutMs = timeoutMs
    this.session = ''
    this.ready = false
    this.nextId = 1
  }

  async post(message, wantId) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL_VERSIONS[0] }
      if (this.session) headers['Mcp-Session-Id'] = this.session
      const response = await this.fetch(this.app.url, { method: 'POST', headers, body: JSON.stringify(message), signal: controller.signal })
      const sid = response.headers.get('mcp-session-id')
      if (sid) this.session = sid
      const text = await response.text()
      if (wantId === undefined) return null
      if (response.status === 404 && this.session) { this.session = ''; this.ready = false; throw Object.assign(new Error('session expired'), { retry: true }) }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const msg = decodeMcpBody(response.headers.get('content-type'), text, wantId)
      if (msg.error) throw Object.assign(new Error(clean(msg.error.message, 300) || 'app error'), { rpc: msg.error })
      return msg.result
    } finally { clearTimeout(timer) }
  }

  async open() {
    if (this.ready) return
    const id = this.nextId++
    await this.post({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: 'wizard-agent-bridge', version: '1' } } }, id)
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    this.ready = true
  }

  async request(method, params) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.open()
        const id = this.nextId++
        return await this.post({ jsonrpc: '2.0', id, method, params }, id)
      } catch (error) {
        if (!error?.retry || attempt) throw error
      }
    }
    throw new Error('unreachable')
  }
}

// ---------- the gateway ----------

function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

/** The gateway token: $WIZARD_MCP_TOKEN, else <osHome>/mcp-token (created 0600 on first start). */
export function gatewayToken({ osHome, env = process.env, create = true }) {
  if (env.WIZARD_MCP_TOKEN) return env.WIZARD_MCP_TOKEN
  const path = join(osHome, 'mcp-token')
  try { const t = readFileSync(path, 'utf8').trim(); if (t) return t } catch { /* create below */ }
  if (!create) return ''
  try {
    mkdirSync(osHome, { recursive: true })
    const t = randomBytes(24).toString('base64url')
    writeFileSync(path, `${t}\n`, { mode: 0o600, flag: 'wx' })
    return t
  } catch {
    try { return readFileSync(path, 'utf8').trim() } catch { return '' }
  }
}

/**
 * The gateway. `handle(request, response, url)` serves /wizard/mcp; everything else is plain functions so
 * the kernel route, the per-run delta and the pointer skills share one apps.json read.
 */
export function createAgentBridge({
  appsJsonPath, osHome = appsJsonPath ? dirname(appsJsonPath) : '', mcpAddress = 'url', token = '',
  fetchImpl = fetch, timeoutMs = 4000, callTimeoutMs = 120_000, log = () => {}, watchIntervalMs = 2000,
  writeSkills = true, harness = 'hermes', filesRoot = DEFAULT_FILES_ROOT, jobMap = false,
}) {
  let mtime = null
  let apps = []
  const toolCache = new Map() // app id -> { tools, at }
  const clients = new Map()
  const sessions = new Map() // session id -> { streams: Set<response> }

  const refresh = () => {
    let m = ''
    try { const st = statSync(appsJsonPath); m = `${st.mtimeMs}:${st.size}:${st.ino}` } catch { m = '' }
    if (m === mtime) return false
    mtime = m
    apps = bridgeApps(readJson(appsJsonPath), { mcpAddress })
    toolCache.clear()
    for (const id of [...clients.keys()]) if (!apps.some((a) => a.id === id)) clients.delete(id)
    if (writeSkills && osHome) {
      const written = writePointerSkills(osHome, apps, { harness })
      log(written ? `pointer skills: ${written.length} job(s)` : 'pointer skills: skills folder not writable, skipped')
      // Second pass with real tool names once the apps answer (unchanged files are not rewritten).
      const snapshot = apps
      collectTools().then((tools) => { if (apps === snapshot) writePointerSkills(osHome, apps, { harness, tools }) }).catch(() => {})
    }
    return true
  }

  const notifyChanged = () => {
    const frame = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`
    let sent = 0
    for (const s of sessions.values()) for (const res of s.streams) { try { res.write(frame); sent += 1 } catch { /* closed */ } }
    log(`apps.json changed: tools/list_changed sent on ${sent} stream(s)`)
  }
  const onChange = () => { if (refresh()) notifyChanged() }
  if (appsJsonPath && watchIntervalMs > 0) watchFile(appsJsonPath, { interval: watchIntervalMs, persistent: false }, onChange)

  const client = (app) => {
    let c = clients.get(app.id)
    if (!c || c.app.url !== app.url) { c = new AppClient(app, { fetchImpl, timeoutMs }); clients.set(app.id, c) }
    return c
  }

  async function appTools(app) {
    const cached = toolCache.get(app.id)
    if (cached && Date.now() - cached.at < 60_000) return cached.tools
    if (app.status !== 'running') return cached?.tools ?? []
    try {
      const result = await client(app).request('tools/list', {})
      const tools = (Array.isArray(result?.tools) ? result.tools : []).filter((t) => typeof t?.name === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(t.name))
      toolCache.set(app.id, { tools, at: Date.now() })
      return tools
    } catch (error) {
      log(`tools/list ${app.id} failed: ${clean(error?.message, 120)}`)
      toolCache.set(app.id, { tools: cached?.tools ?? [], at: Date.now() - 50_000 }) // retry in ~10 s
      return cached?.tools ?? []
    }
  }

  async function collectNames() {
    const out = {}
    await Promise.all(apps.map(async (app) => { out[app.id] = (await appTools(app)).map((t) => t.name) }))
    return out
  }

  /** Name + description per app tool, for the pointer skills. */
  async function collectTools() {
    const out = {}
    await Promise.all(apps.map(async (app) => { out[app.id] = (await appTools(app)).map((t) => ({ name: t.name, description: t.description || '' })) }))
    return out
  }

  async function toolNames() {
    refresh()
    return collectNames()
  }

  function metaTool() {
    return {
      name: META_TOOL,
      description: '[Wizard OS] List the apps installed on this box: what job each does, whether it is running, and its tool names. Use for "what apps do I have?" or "what can you do here?".',
      inputSchema: { type: 'object', properties: {} },
    }
  }

  async function listTools() {
    refresh()
    const out = [metaTool()]
    const lists = await Promise.all(apps.map(async (app) => [app, await appTools(app)]))
    for (const [app, tools] of lists) {
      const tag = `[${app.name} · ${(app.jobs.length ? app.jobs : ['other']).map(jobWords).join(', ')}]`
      for (const t of tools) {
        const name = `${app.prefix}__${t.name}`
        if (name.length > 51) continue // mcp__wizard__ + name must stay within 64 characters
        out.push({ ...t, name, description: `${tag} ${clean(t.description, 1000)}`.trim(), inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} } })
      }
    }
    return out
  }

  async function wizardApps() {
    const names = await toolNames()
    const lines = apps.map((app) => `- ${app.name} (${app.id}), ${app.status}: ${(app.jobs.length ? app.jobs : ['other']).map(jobWords).join(', ')}. ${app.summary} Tools: ${(names[app.id] || []).map((t) => agentToolName(app.prefix, t, harness)).join(', ') || 'none reachable right now'}.`)
    return { content: [{ type: 'text', text: lines.length ? `Installed Wizard apps:\n${lines.join('\n')}` : 'No apps with tools are installed yet. The owner can add some with `wam search` and `wam install <id>`.' }] }
  }

  const failure = (text) => ({ content: [{ type: 'text', text }], isError: true })

  async function callTool(name, args) {
    refresh()
    const started = Date.now()
    if (name === META_TOOL) {
      const r = await wizardApps()
      log(JSON.stringify({ event: 'call', app: 'wizard', tool: META_TOOL, ms: Date.now() - started, ok: true }))
      return r
    }
    const app = apps.find((a) => typeof name === 'string' && name.startsWith(`${a.prefix}__`))
    const tool = app ? name.slice(app.prefix.length + 2) : ''
    if (!app || !tool) {
      log(JSON.stringify({ event: 'call', app: '', tool: clean(String(name), 80), ms: 0, ok: false }))
      return failure(`No installed Wizard app has a tool called ${clean(String(name), 80)}. Call ${META_TOOL} to see what is installed.`)
    }
    let result
    let ok = false
    if (app.status !== 'running') result = failure(`${app.name} is installed but ${app.status}. Tell the owner; \`wam doctor\` shows why.`)
    else {
      const c = client(app)
      const saved = c.timeoutMs
      c.timeoutMs = callTimeoutMs
      try {
        result = await c.request('tools/call', { name: tool, arguments: args && typeof args === 'object' ? args : {} })
        ok = !result?.isError
      } catch (error) {
        const reason = error?.rpc ? clean(error.message, 200) : error?.name === 'AbortError' ? 'it did not answer in time' : 'it is not reachable'
        result = failure(`${app.name} could not run ${tool}: ${reason}. Tell the owner; \`wam doctor\` checks the app.`)
        if (!error?.rpc) c.ready = false
      } finally { c.timeoutMs = saved }
    }
    log(JSON.stringify({ event: 'call', app: app.id, tool, ms: Date.now() - started, ok }))
    return result
  }

  // ---------- streamable HTTP server side ----------

  function authorized(request) {
    if (!token) return false
    const header = String(request.headers.authorization || '')
    const m = /^Bearer\s+(.+)$/iu.exec(header)
    return Boolean(m && safeEqual(m[1].trim(), token))
  }

  /** Requests that came through a proxy from outside the box (tailnet, tunnel) are refused: box-only. */
  function viaProxy(request) {
    const h = request.headers
    return Boolean(h['x-forwarded-for'] || h['tailscale-user-login'] || h['cf-access-jwt-assertion'] || h['cf-connecting-ip'] || h.forwarded)
  }

  function send(response, status, value, headers = {}) {
    const body = value === undefined ? '' : JSON.stringify(value)
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
    response.end(body)
  }

  async function rpc(message, sessionId) {
    const { id, method, params } = message || {}
    const reply = (result) => ({ jsonrpc: '2.0', id, result })
    const error = (code, msg) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message: msg } })
    if (!message || message.jsonrpc !== '2.0' || typeof method !== 'string') return error(-32600, 'invalid request')
    if (id === undefined || id === null) return null // notification
    try {
      if (method === 'initialize') {
        const asked = params?.protocolVersion
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'wizard-os', version: '1' },
          instructions: renderKernel(apps, { harness, filesRoot, jobMap }),
        })
      }
      if (method === 'ping') return reply({})
      if (method === 'tools/list') return reply({ tools: await listTools() })
      if (method === 'tools/call') return reply(await callTool(params?.name, params?.arguments))
      if (method === 'resources/list') return reply({ resources: [] })
      if (method === 'prompts/list') return reply({ prompts: [] })
      return error(-32601, `method not found: ${clean(method, 60)}`)
    } catch (err) {
      return error(-32603, clean(err?.message, 200) || 'internal error')
    }
  }

  async function readBody(request, limit = 4 * 1024 * 1024) {
    const parts = []
    let size = 0
    for await (const part of request) {
      size += part.length
      if (size > limit) throw Object.assign(new Error('too large'), { status: 413 })
      parts.push(part)
    }
    return Buffer.concat(parts).toString('utf8')
  }

  async function handle(request, response) {
    if (viaProxy(request)) { send(response, 403, { error: 'box_only' }); return }
    if (!authorized(request)) { send(response, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' }); return }
    const sid = String(request.headers['mcp-session-id'] || '')
    if (request.method === 'GET') {
      const s = sessions.get(sid)
      if (!s) { send(response, sid ? 404 : 400, { error: 'unknown_session' }); return }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
      response.write(': wizard-os\n\n')
      s.streams.add(response)
      const keepAlive = setInterval(() => { try { response.write(': ping\n\n') } catch { /* closed */ } }, 25_000)
      keepAlive.unref?.()
      request.on('close', () => { clearInterval(keepAlive); s.streams.delete(response) })
      return
    }
    if (request.method === 'DELETE') {
      const s = sessions.get(sid)
      if (s) { for (const res of s.streams) res.end(); sessions.delete(sid) }
      send(response, 200, {})
      return
    }
    if (request.method !== 'POST') { send(response, 405, { error: 'method_not_allowed' }, { Allow: 'GET, POST, DELETE' }); return }
    let body
    try { body = JSON.parse(await readBody(request)) } catch (error) {
      send(response, error?.status === 413 ? 413 : 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      return
    }
    const batch = Array.isArray(body) ? body : [body]
    const isInit = batch.some((m) => m?.method === 'initialize')
    let session = sid
    if (isInit) {
      session = randomUUID()
      sessions.set(session, { streams: new Set() })
      if (sessions.size > 200) sessions.delete(sessions.keys().next().value)
    } else if (sid && !sessions.has(sid)) {
      send(response, 404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'session not found; initialize again' } })
      return
    }
    const replies = (await Promise.all(batch.map((m) => rpc(m, session)))).filter(Boolean)
    const headers = session ? { 'Mcp-Session-Id': session } : {}
    if (!replies.length) { response.writeHead(202, headers); response.end(); return }
    send(response, 200, Array.isArray(body) ? replies : replies[0], headers)
  }

  async function kernel({ harness: h = harness } = {}) {
    const tools = await toolNames()
    const text = renderKernel(apps, { harness: h, filesRoot, jobMap })
    return {
      text, chars: text.length, harness: h, mcp_server: MCP_SERVER_NAME, job_map: Boolean(jobMap || h !== 'hermes'),
      job_skills: jobsOf(apps).map(([job]) => jobSkillName(job)),
      apps: apps.map((a) => ({ id: a.id, name: a.name, status: a.status, jobs: a.jobs, tools: (tools[a.id] || []).map((t) => `${a.prefix}__${t}`), skill: a.skill ? a.id : '' })),
    }
  }

  refresh()

  return {
    handle, kernel, listTools, callTool, refresh: () => { if (refresh()) notifyChanged() },
    kernelText: (h = harness) => { refresh(); return renderKernel(apps, { harness: h, filesRoot, jobMap }) },
    apps: () => { refresh(); return apps },
    snapshot: () => { refresh(); return Object.fromEntries(apps.map((a) => [a.id, a.status])) },
    close: () => { if (appsJsonPath) unwatchFile(appsJsonPath, onChange); for (const s of sessions.values()) for (const r of s.streams) r.end() },
  }
}

/** Remembers which apps each thread started with, so a Hermes-plugin run gets only what changed. */
export class ThreadAppSnapshots {
  constructor(path, max = 4000) {
    this.path = path
    this.max = max
    this.data = readJson(path, 4 * 1024 * 1024) || {}
  }

  /** Returns the snapshot for `sessionId`, recording `current` first when the thread is new. */
  take(sessionId, current) {
    if (!sessionId) return current
    if (!this.data[sessionId]) {
      this.data[sessionId] = current
      const keys = Object.keys(this.data)
      for (const k of keys.slice(0, Math.max(0, keys.length - this.max))) delete this.data[k]
      if (this.path) {
        try {
          mkdirSync(dirname(this.path), { recursive: true })
          writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data))
          renameSync(`${this.path}.tmp`, this.path)
        } catch { /* in memory only */ }
      }
    }
    return this.data[sessionId]
  }
}

export function listJobSkills(osHome) {
  try { return readdirSync(join(osHome, 'skills')).filter((n) => n.startsWith(JOB_SKILL_PREFIX)).sort() } catch { return [] }
}

