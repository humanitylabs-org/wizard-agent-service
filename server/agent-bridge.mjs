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
import { constants, opendirSync, openSync, closeSync, fstatSync, lstatSync, realpathSync, readSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unwatchFile, watchFile, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'

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

/** `photo-tools` -> `photo_tools`: the gateway prefix of an app's tools. */
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
      url, address: url.replace(/^(https?:\/\/[^/]+).*$/u, '$1'), transport: clean(mcp?.transport, 40) || 'streamable-http',
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
export function renderKernel(apps = [], { harness = 'hermes', filesRoot = DEFAULT_FILES_ROOT, jobMap = false, skillsIndex } = {}) {
  const hermes = harness === 'hermes'
  // Only the main agent's skills index holds wizard-job-* pointers (#58). Any other agent on the gateway is told the
  // jobs directly, limited to the apps on its own list.
  const pointers = hermes && skillsIndex !== false
  const meta = hermes ? `mcp__${MCP_SERVER_NAME}__${META_TOOL}` : META_TOOL
  const name = hermes ? `mcp__${MCP_SERVER_NAME}__<app>__<tool>` : '<app>__<tool>'
  const idNote = ' (<app> = app id, - as _)'
  const text = [
    'Wizard OS: you are the owner\'s agent on this box. Its apps do jobs for them.',
    ...(hermes ? ['To build, port, redesign or modify an app for Wizard OS, first load `wizard-builder` with skill_view; follow its coding and wam workflow.',
      'Help, reminders, tips: load `wizard-guide`.'] : []),
    `Files root: ${filesRoot}; app tool paths are relative to it.`,
    pointers
      ? 'When a request matches a wizard-job-<job> skill in your skills:'
      : 'When a request matches a job below:',
    ...(pointers ? ['1. Load it with skill_view for tool names and purposes.'] : ['1. Use the app named for that job.']),
    `2. Call the app's tool on the \`${MCP_SERVER_NAME}\` MCP server, named \`${name}\`${idNote}.${hermes ? ' If it is not in your tool list, run it with tool_call and that exact name.' : ''}`,
    '3. For ordinary app use: Never search the disk, read apps.json, run wam or write a client to reach it.',
    'Use the installed app for its job.',
    `"What apps do I have?": call \`${meta}\`. Report unreachable ones (\`wam doctor\`).`,
    'Save routing-only app-job skills.',
  ]
  if (jobMap || !pointers) {
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
      const how = a.skill
        ? `load its skill \`${a.id}\` with skill_view first (it holds the app's workflow and model rules), then call the tool whose purpose matches the request.`
        : 'pick the tool whose purpose matches the request and call it.'
      const head = `- ${a.name}: ${how}${down}`
      const rows = known.length
        ? known.map((t) => `  - \`${agentToolName(a.prefix, t.name, harness)}\`${t.purpose ? `: ${t.purpose}` : ''}`)
        : [`  - \`${agentToolName(a.prefix, '*', harness)}\``]
      const address = [`  Its address (for files it serves): ${a.address}`]
      return [head, ...rows, ...address]
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

/** The id the main agent is known by on the gateway (its token is the gateway's own). */
export const GATEWAY_MAIN_AGENT = 'hermes'

/**
 * The gateway. `handle(request, response, url)` serves /wizard/mcp; everything else is plain functions so
 * the kernel route, the per-run delta and the pointer skills share one apps.json read.
 *
 * Per-agent apps (wizard-os spec/AGENTS.md section 5, #58): each agent reaches the gateway with its own token.
 * `token` is the main agent's; `agentForToken(token)` names any other agent's. `appsFor(agentId)` returns the
 * Set of app ids that agent may use (null = every app, the gateway's behaviour before #58). The gateway lists,
 * describes and calls only those apps for that agent.
 */
export function createAgentBridge({
  appsJsonPath, osHome = appsJsonPath ? dirname(appsJsonPath) : '', mcpAddress = 'url', token = '',
  fetchImpl = fetch, timeoutMs = 4000, callTimeoutMs = 120_000, log = () => {}, watchIntervalMs = 2000,
  writeSkills = true, harness = 'hermes', filesRoot = DEFAULT_FILES_ROOT, jobMap = false,
  agentForToken = () => '', appsFor = () => null, builtins = null, agents = () => null,
}) {
  const shared = sharedAgentTools(agents, log)
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
    rewriteSkills()
    return true
  }

  // The pointer skills in <osHome>/skills are the main agent's skills index: only the apps it may use (#58).
  function rewriteSkills() {
    if (!writeSkills || !osHome) return
    const mine = visible(GATEWAY_MAIN_AGENT)
    const written = writePointerSkills(osHome, mine, { harness })
    log(written ? `pointer skills: ${written.length} job(s)` : 'pointer skills: skills folder not writable, skipped')
    // Second pass with real tool names once the apps answer (unchanged files are not rewritten).
    const snapshot = apps
    collectTools(mine).then((tools) => { if (apps === snapshot) writePointerSkills(osHome, mine, { harness, tools }) }).catch(() => {})
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

  /** The apps one agent may use (#58). */
  const visible = (agentId = GATEWAY_MAIN_AGENT) => {
    let allowed = null
    try { allowed = appsFor(agentId) } catch { allowed = new Set() }
    return allowed ? apps.filter((app) => allowed.has(app.id)) : apps
  }

  async function collectNames(list = apps) {
    const out = {}
    await Promise.all(list.map(async (app) => { out[app.id] = (await appTools(app)).map((t) => t.name) }))
    return out
  }

  /** Name + description per app tool, for the pointer skills. */
  async function collectTools(list = apps) {
    const out = {}
    await Promise.all(list.map(async (app) => { out[app.id] = (await appTools(app)).map((t) => ({ name: t.name, description: t.description || '' })) }))
    return out
  }

  async function toolNames(agentId = GATEWAY_MAIN_AGENT) {
    refresh()
    return collectNames(visible(agentId))
  }

  function metaTool() {
    return {
      name: META_TOOL,
      description: '[Wizard OS] List the apps installed on this box: what job each does, whether it is running, and its tool names. Use for "what apps do I have?" or "what can you do here?".',
      inputSchema: { type: 'object', properties: {} },
    }
  }

  async function listTools(agentId = GATEWAY_MAIN_AGENT) {
    refresh()
    const out = [metaTool(), ...(builtins?.list?.(agentId) || []), ...shared.list()]
    const lists = await Promise.all(visible(agentId).map(async (app) => [app, await appTools(app)]))
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

  async function wizardApps(agentId = GATEWAY_MAIN_AGENT) {
    const names = await toolNames(agentId)
    const lines = visible(agentId).map((app) => `- ${app.name} (${app.id}), ${app.status}: ${(app.jobs.length ? app.jobs : ['other']).map(jobWords).join(', ')}. ${app.summary} Tools: ${(names[app.id] || []).map((t) => agentToolName(app.prefix, t, harness)).join(', ') || 'none reachable right now'}.`)
    return { content: [{ type: 'text', text: lines.length ? `Installed apps:\n${lines.join('\n')}` : 'No apps with tools are installed yet. The owner can add some with `wam search` and `wam install <id>`.' }] }
  }

  const failure = (text) => ({ content: [{ type: 'text', text }], isError: true })

  async function callTool(name, args, agentId = GATEWAY_MAIN_AGENT) {
    refresh()
    const started = Date.now()
    const sharedResult = shared.call(name, args, agentId)
    if (sharedResult) return sharedResult
    const builtin = builtins && await builtins.call(name, args && typeof args === 'object' ? args : {}, agentId)
    if (builtin) {
      log(JSON.stringify({ event: 'call', app: 'wizard', tool: clean(String(name), 80), agent: agentId, ms: Date.now() - started, ok: !builtin.isError }))
      return builtin
    }
    if (name === META_TOOL) {
      const r = await wizardApps(agentId)
      log(JSON.stringify({ event: 'call', app: 'wizard', tool: META_TOOL, agent: agentId, ms: Date.now() - started, ok: true }))
      return r
    }
    // An app this agent may not use is answered exactly like an app that is not installed (#58).
    const app = visible(agentId).find((a) => typeof name === 'string' && name.startsWith(`${a.prefix}__`))
    const tool = app ? name.slice(app.prefix.length + 2) : ''
    if (!app || !tool) {
      log(JSON.stringify({ event: 'call', app: '', tool: clean(String(name), 80), agent: agentId, ms: 0, ok: false }))
      return failure(`No installed app has a tool called ${clean(String(name), 80)}. Call ${META_TOOL} to see what is installed.`)
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
    log(JSON.stringify({ event: 'call', app: app.id, tool, agent: agentId, ms: Date.now() - started, ok }))
    return result
  }

  // ---------- streamable HTTP server side ----------

  /** The agent this request speaks for: the main agent's token, or another agent's own token. '' = refused. */
  function authorized(request) {
    const header = String(request.headers.authorization || '')
    const m = /^Bearer\s+(.+)$/iu.exec(header)
    const supplied = m ? m[1].trim() : ''
    if (!supplied) return ''
    if (token && safeEqual(supplied, token)) return GATEWAY_MAIN_AGENT
    try { return agentForToken(supplied) || '' } catch { return '' }
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

  async function rpc(message, agentId) {
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
          instructions: renderKernel(visible(agentId), { harness, filesRoot, jobMap, skillsIndex: agentId === GATEWAY_MAIN_AGENT && writeSkills && Boolean(osHome) }),
        })
      }
      if (method === 'ping') return reply({})
      if (method === 'tools/list') return reply({ tools: await listTools(agentId) })
      if (method === 'tools/call') return reply(await callTool(params?.name, params?.arguments, agentId))
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
    const agentId = authorized(request)
    if (!agentId) { send(response, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' }); return }
    const sid = String(request.headers['mcp-session-id'] || '')
    // A session belongs to the agent that opened it; another agent's token cannot ride it.
    const owned = (s) => Boolean(s) && s.agent === agentId
    if (request.method === 'GET') {
      const s = sessions.get(sid)
      if (!owned(s)) { send(response, sid ? 404 : 400, { error: 'unknown_session' }); return }
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
      if (owned(s)) { for (const res of s.streams) res.end(); sessions.delete(sid) }
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
      sessions.set(session, { streams: new Set(), agent: agentId })
      if (sessions.size > 200) sessions.delete(sessions.keys().next().value)
    } else if (sid && !owned(sessions.get(sid))) {
      send(response, 404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'session not found; initialize again' } })
      return
    }
    const replies = (await Promise.all(batch.map((m) => rpc(m, agentId)))).filter(Boolean)
    const headers = session ? { 'Mcp-Session-Id': session } : {}
    if (!replies.length) { response.writeHead(202, headers); response.end(); return }
    send(response, 200, Array.isArray(body) ? replies : replies[0], headers)
  }

  async function kernel({ harness: h = harness, agent: agentId = GATEWAY_MAIN_AGENT } = {}) {
    const tools = await toolNames(agentId)
    const mine = visible(agentId)
    const text = renderKernel(mine, { harness: h, filesRoot, jobMap })
    return {
      text, chars: text.length, harness: h, mcp_server: MCP_SERVER_NAME, job_map: Boolean(jobMap || h !== 'hermes'),
      job_skills: jobsOf(mine).map(([job]) => jobSkillName(job)),
      apps: mine.map((a) => ({ id: a.id, name: a.name, status: a.status, jobs: a.jobs, tools: (tools[a.id] || []).map((t) => `${a.prefix}__${t}`), skill: a.skill ? a.id : '' })),
    }
  }

  refresh()

  return {
    handle, kernel, listTools, callTool, refresh: () => { if (refresh()) notifyChanged() }, agentFor: authorized,
    // An agent's app list changed (#58): rewrite the main agent's pointer skills and tell open sessions.
    appsChanged: () => { refresh(); rewriteSkills(); notifyChanged() },
    kernelText: (h = harness, agentId = GATEWAY_MAIN_AGENT) => { refresh(); return renderKernel(visible(agentId), { harness: h, filesRoot, jobMap }) },
    // No argument: every installed app. With an agent id: only the apps that agent may use (#58), same as callTool.
    apps: (agentId) => { refresh(); return agentId === undefined ? apps : visible(agentId) },
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

// Read-only cross-agent state. Sessions belong to Agent History, not this gateway.
export const SHARED_AGENT_TOOLS = ['list', 'memory_read', 'skills_list', 'skill_read', 'notes_list', 'notes_read'].map(name => `wizard_agents__${name}`)
const SHARED_READ_CAP = 64 * 1024
const SHARED_LIST_CAP = 200
const stateFailure = code => { throw new Error(code) }
const safeStateParts = path => {
  if (typeof path !== 'string' || !path || path.length > 300 || path.includes('\\')) return false
  return path.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/u.test(part)
    && !/(?:^|[._ -])(?:env|auth|keys?|credentials?|secrets?|tokens?|passwords?|config|state)(?:[._ -]|$)/iu.test(part))
}

/** Walk every component without symlinks, then realpath-check against the configured home. */
function statePath(home, relative) {
  if (!home || !safeStateParts(relative)) stateFailure('agent.path_refused')
  const homeStat = lstatSync(home)
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) stateFailure('agent.path_refused')
  const root = realpathSync(home)
  let target = root
  for (const part of relative.split('/')) {
    target = join(target, part)
    const st = lstatSync(target)
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()) || (st.isFile() && st.nlink !== 1)) stateFailure('agent.path_refused')
  }
  const actual = realpathSync(target)
  if (!actual.startsWith(`${root}${sep}`)) stateFailure('agent.path_refused')
  return actual
}

/** Bounded descriptor reads; special files and hardlinks cannot masquerade as notes. */
function stateText(home, relative) {
  const file = statePath(home, relative)
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.nlink !== 1) stateFailure('agent.path_refused')
    if (st.size > SHARED_READ_CAP) stateFailure('agent.too_large')
    const current = lstatSync(statePath(home, relative))
    if (current.ino !== st.ino || current.dev !== st.dev) stateFailure('agent.path_refused')
    const buffer = Buffer.alloc(SHARED_READ_CAP + 1)
    let size = 0, n
    while (size <= SHARED_READ_CAP && (n = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += n
    if (size > SHARED_READ_CAP) stateFailure('agent.too_large')
    if (buffer.subarray(0, size).includes(0)) stateFailure('agent.path_refused')
    return buffer.subarray(0, size).toString('utf8')
  } finally { closeSync(fd) }
}

function stateList(home, folder, skills = false) {
  const entries = []
  let visited = 0, truncated = false
  function walk(relative, depth) {
    if (depth > 10 || visited >= SHARED_LIST_CAP) { truncated = true; return }
    let dir
    try { dir = statePath(home, relative) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    // Read at most the remaining budget, even when the source has millions of entries.
    const handle = opendirSync(dir)
    const children = []
    try {
      let entry
      while ((entry = handle.readSync())) {
        if (children.length >= SHARED_LIST_CAP - visited) { truncated = true; break }
        children.push(entry)
      }
    } finally { handle.closeSync() }
    children.sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      if (visited++ >= SHARED_LIST_CAP) { truncated = true; break }
      const path = `${relative}/${child.name}`
      if (!safeStateParts(path) || child.isSymbolicLink()) continue
      try {
        statePath(home, path)
        if (child.isDirectory()) walk(path, depth + 1)
        else if (child.isFile() && (skills ? child.name === 'SKILL.md' : /\.(?:md|txt)$/iu.test(child.name))) {
          entries.push(skills ? path.slice(folder.length + 1, -'/SKILL.md'.length) : path.slice(folder.length + 1))
        }
      } catch { /* Never expose unsafe/inaccessible names. */ }
    }
  }
  walk(folder, 0)
  return { entries, truncated }
}

/** Registry is lazy because the bridge is created before the registry in service.mjs. */
export function sharedAgentTools(registry, log = () => {}) {
  const specs = [
    ['list', 'List readable agents (id, label, privacy and purpose).', {}],
    ['memory_read', 'Read another agent\'s always-loaded memory and labelled read-only persona, on demand.', { agent: { type: 'string' } }],
    ['skills_list', 'List another agent\'s skills; requires search or read.', { agent: { type: 'string' } }],
    ['skill_read', 'Read a source-labelled skill; adapt before relying on its tools and paths.', { agent: { type: 'string' }, name: { type: 'string' } }],
    ['notes_list', 'List files in an agent\'s declared owner-visible notes folder.', { agent: { type: 'string' } }],
    ['notes_read', 'Read a safe text note in an agent\'s declared notes folder.', { agent: { type: 'string' }, path: { type: 'string' } }],
  ]
  return {
    list: () => specs.map(([name, description, properties]) => ({ name: `wizard_agents__${name}`, description: `[Wizard OS] ${description}`, inputSchema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } })),
    call(name, args, reader) {
      if (!SHARED_AGENT_TOOLS.includes(name)) return null
      const kind = name.slice('wizard_agents__'.length)
      const r = registry()
      const textResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
      const audit = (source, scope, ok) => log(JSON.stringify({ event: 'agent_state_read', reader, source, kind, scope, ok }))
      try {
        if (!r) stateFailure('agent.unavailable')
        const sources = r.readableSources(reader) // Always fresh; stored grants never bypass a source seal.
        if (kind === 'list') {
          const listed = sources.slice(0, SHARED_LIST_CAP).map(({ source, scope }) => {
            const agent = r.read(source)
            audit(source, scope, true)
            return { id: source, label: agent.label, privacy: agent.privacy, ...(agent.purpose ? { purpose: clean(agent.purpose, 200) } : {}) }
          })
          return textResult({ agents: listed, truncated: sources.length > SHARED_LIST_CAP })
        }
        if (!args || typeof args.agent !== 'string') stateFailure('agent.invalid_arguments')
        const granted = sources.find(entry => entry.source === args.agent)
        const need = kind.endsWith('_list') ? 'search' : 'read'
        if (!granted || ['none', 'titles', 'search', 'read'].indexOf(granted.scope) < ['none', 'titles', 'search', 'read'].indexOf(need)) stateFailure('agent.read_denied')
        const source = r.read(args.agent)
        if (!source || source.privacy !== 'standard' || source.permissions.shared_with_agents !== true) stateFailure('agent.read_denied')
        const home = r.stateHome(source.id)
        let result
        if (kind === 'memory_read') {
          let total = 0
          const optional = path => {
            try {
              const value = stateText(home, path)
              total += Buffer.byteLength(value)
              if (total > SHARED_READ_CAP) stateFailure('agent.too_large')
              return value
            } catch (error) { if (error.code === 'ENOENT') return ''; throw error }
          }
          result = { memory: optional('memories/MEMORY.md'), user: optional('memories/USER.md'), 'persona (read-only)': optional('SOUL.md') }
        } else if (kind === 'skills_list') result = stateList(home, 'skills', true)
        else if (kind === 'skill_read') {
          if (!safeStateParts(args.name)) stateFailure('agent.path_refused')
          result = { text: `Written by ${source.id} for the ${source.harness} harness. Tools and paths it names may not exist for you. Adapt it into your own skill before relying on it.\n\n${stateText(home, `skills/${args.name}/SKILL.md`)}` }
        } else if (!source.notes_dir) {
          if (kind === 'notes_read') stateFailure('agent.notes_unavailable')
          result = { entries: [], truncated: false }
        } else if (kind === 'notes_list') result = stateList(home, source.notes_dir)
        else {
          if (!safeStateParts(args.path) || !/\.(?:md|txt)$/iu.test(args.path)) stateFailure('agent.path_refused')
          result = { text: stateText(home, `${source.notes_dir}/${args.path}`) }
        }
        audit(source.id, granted.scope, true)
        return textResult({ source: { id: source.id, label: source.label, harness: source.harness }, ...result })
      } catch (error) {
        // Log no arguments, paths, content or filesystem errors (which may reveal host paths).
        audit(typeof args?.agent === 'string' && /^[a-z][a-z0-9-]{0,30}$/u.test(args.agent) ? args.agent : '', '', false)
        const code = /^agent\.[a-z_]+$/u.test(error.message) ? error.message : 'agent.state_unavailable'
        return { content: [{ type: 'text', text: code }], isError: true }
      }
    },
  }
}
