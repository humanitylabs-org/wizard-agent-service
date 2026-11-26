// Private mode on an existing box (issue 626; spec "Private mode as an opt-in", sections 4, 6 and 8.1-8.2).
// Behind the owner's `wizard/private-mode` switch (Look file); env WIZARD_PRIVATE_MODE=1 forces it on and 0 off.
// Off by default: with it off nothing here runs, the state answers `on: false` and every change is refused.
//
// Turning private mode on is four steps the Settings › Privacy sheet runs one by one (or `on` runs them together):
//   agent    the private agent, made through the same registry path as #545/#115 (private preset, a confidential
//            provider, no fallback, sealed). An existing private agent is reused, never doubled.
//   apps     each chosen app leaves every standard agent's list and joins the private agent's (it then reaches only
//            private agents), its "Sends its work to" binding (#60) points at the private agent and the Service
//            schedules that run on it move to the private agent. The app's own logins are never touched.
//   context  Bring your context along (#81): the private agent reads the standard agent's chats and memory, one way.
//   default  Start new chats on private AI: the private agent becomes the default agent (voice follows the default).
// Every change is written to `agents/.private-mode.json` with what it replaced BEFORE it is made, so a retry skips
// what is done, leaving halfway keeps what's done, and turning private mode off puts back exactly what was there.
// Turning off keeps the private agent and its history (sealed, #59, never merged); deleting it stays a separate act.
// The Privacy check (`privacyCheck()`) lists installed apps x agents x the app's own personal-data declaration x the
// provider company each agent's model runs at. No extra router: the private agent keeps its own Tinfoil relay (#66).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { MAIN_AGENT_ID, PRIVATE_DATA_SLOTS, isConfidentialProvider, isPrivateApp, isStandardOnlyApp } from './agents.mjs'

export const PRIVATE_MODE_SWITCH = 'wizard/private-mode'
export const PRIVATE_MODE_SCHEMA = 'wizard.private-mode/1'
export const PRIVACY_CHECK_SCHEMA = 'wizard.privacy-check/1'
export const PRIVATE_MODE_STEPS = ['agent', 'apps', 'context', 'default']
const APP_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/u

const readJson = (path) => {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null } catch { return null }
}
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}
const refusal = (status, error, detail = '') => Object.assign(new Error(detail || error), { status, code: error })
const nowS = () => Math.floor(Date.now() / 1000)

/** The company whose servers a provider's model runs on, for the Privacy check ("Mail -> main agent -> Anthropic"). */
export function providerCompany(provider) {
  const id = String(provider ?? '').trim().toLowerCase()
  if (!id || id === 'host') return null
  if (id === 'tinfoil' || id.endsWith('-tinfoil') || id === 'wizard-tinfoil') return 'Tinfoil'
  if (id === 'local') return 'This box'
  if (id.startsWith('anthropic') || id.startsWith('claude')) return 'Anthropic'
  if (id.startsWith('openai') || id.startsWith('chatgpt') || id === 'codex') return 'OpenAI'
  if (id.startsWith('google') || id.startsWith('gemini')) return 'Google'
  const known = { openrouter: 'OpenRouter', xai: 'xAI', grok: 'xAI', nous: 'Nous Research', deepseek: 'DeepSeek', mistral: 'Mistral', groq: 'Groq', together: 'Together AI', zai: 'Z.ai', moonshot: 'Moonshot AI', kimi: 'Moonshot AI', minimax: 'MiniMax', qwen: 'Alibaba', huggingface: 'Hugging Face', ollama: 'This box' }
  for (const [prefix, company] of Object.entries(known)) if (id.startsWith(prefix)) return company
  return provider
}

/** The app's own personal-data declaration: the `privacy: private` tag or a private-data slot it provides. */
export const isPersonalDataApp = (app) => isPrivateApp(app) || (Array.isArray(app?.provides) && app.provides.some((slot) => PRIVATE_DATA_SLOTS.includes(slot)))

/** A Service schedule that runs on an app: it names the app's skill, or its prompt or name names the app. */
export function jobRunsOnApp(job, app) {
  const id = String(app?.id ?? '')
  if (!id) return false
  const skill = String(job?.skill ?? '').trim().toLowerCase()
  if (skill && (skill === id || skill === `skills/${id}` || skill === `skills/${id}/skill.md`)) return true
  const text = `${job?.name ?? ''}\n${job?.prompt ?? ''}`.toLowerCase()
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  if (new RegExp(`(^|[^a-z0-9-])${escape(id)}($|[^a-z0-9-])`, 'u').test(text)) return true
  const name = typeof app.name === 'string' ? app.name.trim().toLowerCase() : ''
  return name.length >= 4 && new RegExp(`(^|[^\\p{L}\\p{N}])${escape(name)}($|[^\\p{L}\\p{N}])`, 'u').test(text)
}

/**
 * on(): the switch. registry: the agent registry. agentsDir: where `.private-mode.json` lives. appsJsonPath: the
 * installed apps. bindings(): the app bindings (or null). scheduler(): the Service scheduler (or null).
 * defaultAgent()/setDefaultAgent(id): the owner's default agent. mainOptions(): the main Hermes's model options.
 * privateFirstAgent(): the private agent #545 set up, when there is one.
 */
export function createPrivateMode({ on, registry, agentsDir, appsJsonPath = '', bindings = () => null, scheduler = () => null, defaultAgent, setDefaultAgent, mainOptions = async () => null, privateFirstAgent = () => null, log = () => {} }) {
  const recordPath = join(agentsDir, '.private-mode.json')
  const record = () => {
    const value = readJson(recordPath)
    return value?.schema === 1 ? value : { schema: 1 }
  }
  const save = (patch) => { const next = { ...record(), ...patch, schema: 1 }; writeJson(recordPath, next); return next }
  const isOn = () => { try { return on() === true } catch { return false } }
  let chain = Promise.resolve()
  const serial = (fn) => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }
  const needOn = () => { if (!isOn()) throw refusal(409, 'private_mode_off') }
  const installed = () => {
    const apps = readJson(appsJsonPath)?.apps
    return (Array.isArray(apps) ? apps : []).filter((app) => typeof app?.id === 'string' && APP_ID_RE.test(app.id))
  }
  const currentDefault = () => { try { return defaultAgent() || MAIN_AGENT_ID } catch { return MAIN_AGENT_ID } }
  const usable = (agent) => agent && agent.role !== 'recovery' && (agent.id === MAIN_AGENT_ID || agent.runtime?.kind !== 'external')

  /** The private agent private mode uses, while it still exists and is private. */
  function privateAgentId() {
    const id = record().private_agent
    const agent = typeof id === 'string' ? registry.read(id) : null
    return agent?.privacy === 'private' && usable(agent) ? agent.id : null
  }
  /** An earlier private agent to reuse: #545's, else the oldest one on a confidential provider. */
  function existingPrivateAgent() {
    let first = null
    try { first = privateFirstAgent?.() || null } catch { first = null }
    const agent = first ? registry.read(first) : null
    if (agent?.privacy === 'private' && usable(agent)) return agent.id
    return registry.list().filter((item) => item.id !== MAIN_AGENT_ID && item.privacy === 'private' && usable(item) && !item.imported && isConfidentialProvider(item.model?.provider))
      .sort((a, b) => (Number(a.created_at) || 0) - (Number(b.created_at) || 0) || String(a.id).localeCompare(String(b.id)))[0]?.id ?? null
  }

  function state() {
    const kept = record()
    const switchOn = isOn()
    const privateId = privateAgentId()
    const steps = kept.steps && typeof kept.steps === 'object' ? kept.steps : {}
    const next = !privateId ? 'agent' : PRIVATE_MODE_STEPS.find((step) => !steps[step]) ?? 'done'
    const mode = !privateId || kept.mode === 'off' && !Object.keys(steps).length ? 'off' : next === 'done' ? 'on' : 'setting_up'
    const apps = kept.apps && typeof kept.apps === 'object' ? kept.apps : {}
    return {
      schema: PRIVATE_MODE_SCHEMA, on: switchOn,
      ...(switchOn ? {
        mode, next_step: mode === 'off' && privateId ? 'agent' : next, standard_agent: MAIN_AGENT_ID, private_agent: privateId,
        agent_created: kept.agent_created === true,
        moved_apps: Object.keys(apps).filter((id) => apps[id]?.state === 'moved').sort(),
        context: kept.context?.granted === true ? { granted: true, how: kept.context.how } : { granted: false, ...(kept.context?.reason ? { reason: kept.context.reason } : {}) },
        default_agent: currentDefault(),
        ...(kept.turned_off_at ? { turned_off_at: kept.turned_off_at } : {}),
      } : {}),
    }
  }

  // ---- step 1: the private agent ----
  async function agentStep(body = {}) {
    const existing = privateAgentId()
    if (existing) {
      // Turned on again after a turn off: the same agent, kept sealed with its history, is used again.
      const steps = record().steps ?? {}
      if (!steps.agent || record().mode === 'off') save({ mode: 'setting_up', steps: { ...steps, agent: steps.agent ?? nowS() } })
      return { agent: existing, created: false }
    }
    const reuse = existingPrivateAgent()
    if (reuse) {
      save({ private_agent: reuse, agent_created: false, mode: 'setting_up', steps: { agent: nowS() } })
      log(`private agent: reusing ${reuse}`)
      return { agent: reuse, created: false }
    }
    const provider = typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : 'tinfoil'
    if (!isConfidentialProvider(provider)) throw refusal(400, 'confidential_provider_required')
    const known = ((await registry.agentOptions()).providers ?? []).find((item) => item.id === provider)?.models?.map((m) => m.id) ?? []
    if (!known.length) throw refusal(409, 'provider_has_no_models')
    const asked = [body.model, ...(Array.isArray(body.models) ? body.models : [])].filter((m) => typeof m === 'string' && known.includes(m))
    const allowed = [...new Set(asked.length ? asked : [known[0]])]
    // The idempotency key is saved before the create, so a create that ran but whose answer was lost is found again.
    const key = record().create_key || save({ create_key: `private-mode-${randomBytes(8).toString('hex')}` }).create_key
    const { agent } = await registry.create({
      label: 'Private', permissions: { preset: 'private' },
      model: { provider, model: allowed[0], allowed_models: allowed, fallback: false },
    }, { idempotencyKey: key })
    save({ private_agent: agent.id, agent_created: true, mode: 'setting_up', steps: { agent: nowS() } })
    log(`private agent: created ${agent.id} on ${provider}`)
    return { agent: agent.id, created: true }
  }
  const requirePrivate = () => {
    const id = privateAgentId()
    if (!id) throw refusal(409, 'private_agent_required')
    return id
  }
  const markStep = (step) => { const kept = record(); save({ steps: { ...(kept.steps ?? {}), [step]: nowS() } }) }

  // ---- step 2: apps (the Privacy check's moves) ----
  async function moveApp(appId, privateId) {
    const apps = { ...(record().apps ?? {}) }
    const app = installed().find((item) => item.id === appId)
    if (!app) return { app_id: appId, ok: false, error: 'app_not_found' }
    if (isStandardOnlyApp(app)) return { app_id: appId, ok: false, error: 'standard_only_app' }
    let entry = apps[appId]
    if (entry?.state === 'moved') return { app_id: appId, ok: true, moved: false }
    if (!entry) {
      // What it replaces, saved before any change: which agents had it, where it sent its work, which schedules.
      let view
      try { view = registry.appAgents(appId) } catch (error) { return { app_id: appId, ok: false, error: error?.error || error?.code || 'app_not_found' } }
      const priorAgents = view.agents.filter((agent) => agent.enabled).map((agent) => agent.id)
      const wanted = [...new Set([...priorAgents.filter((id) => registry.read(id)?.privacy === 'private'), privateId])]
      const binding = bindings()?.list().find((item) => item.app_id === appId) ?? null
      const jobs = (scheduler()?.list() ?? []).filter((job) => ['run', 'remind'].includes(job.kind ?? 'run') && !wanted.includes(job.agent === 'main' ? MAIN_AGENT_ID : job.agent) && jobRunsOnApp(job, app))
        .map((job) => ({ id: job.id, agent: job.agent, thread: job.thread ?? null, ...(job.channel ? { channel: job.channel } : {}) }))
      entry = { state: 'moving', prior_agents: priorAgents, agents: wanted, prior_binding: binding ? { agent: binding.agent, is_default: binding.is_default === true } : null, jobs, at: nowS() }
      apps[appId] = entry
      save({ apps })
    }
    // Lists, binding, schedules: each is set to an exact value, so a retry after a halfway stop repeats safely.
    await registry.setAppAgents(appId, { agents: entry.agents.filter((id) => registry.read(id)) })
    if (entry.prior_binding) bindings()?.set(appId, { agent: privateId, is_default: false })
    const moved = []
    for (const job of entry.jobs) {
      const sched = scheduler()
      try {
        const current = sched?.get(job.id)
        if (!current || current.agent === privateId) continue
        sched.update(job.id, { agent: privateId, thread: null, ...(job.channel ? { channel: null } : {}) })
        moved.push(job.id)
      } catch (error) { log(`schedule ${job.id}: ${error?.message || error}`) }
    }
    entry.state = 'moved'
    save({ apps: { ...(record().apps ?? {}), [appId]: entry } })
    log(`moved ${appId} to ${privateId}${entry.jobs.length ? ` with ${entry.jobs.length} schedule(s)` : ''}`)
    return { app_id: appId, ok: true, moved: true, schedules: entry.jobs.map((job) => job.id) }
  }

  async function restoreApp(appId, privateId) {
    const apps = { ...(record().apps ?? {}) }
    const entry = apps[appId]
    const app = installed().find((item) => item.id === appId)
    if (!entry) {
      // Moved by hand (or by private first): Move to standard puts it on the standard agent and off this private one.
      if (!app) return { app_id: appId, ok: false, error: 'app_not_found' }
      if (isStandardOnlyApp(app)) return { app_id: appId, ok: true, moved: false }
      let view
      try { view = registry.appAgents(appId) } catch (error) { return { app_id: appId, ok: false, error: error?.error || 'app_not_found' } }
      const agents = [...new Set([...view.agents.filter((agent) => agent.enabled && agent.id !== privateId).map((agent) => agent.id), MAIN_AGENT_ID])]
      await registry.setAppAgents(appId, { agents })
      const binding = bindings()?.list().find((item) => item.app_id === appId)
      if (binding && binding.agent === privateId) bindings().set(appId, { agent: 'default' })
      return { app_id: appId, ok: true, moved: true }
    }
    if (app) {
      await registry.setAppAgents(appId, { agents: entry.prior_agents.filter((id) => registry.read(id)) })
      if (entry.prior_binding) {
        const back = entry.prior_binding.is_default || !registry.read(entry.prior_binding.agent) ? { agent: 'default' } : { agent: entry.prior_binding.agent, is_default: false }
        try { bindings()?.set(appId, back) } catch (error) { log(`binding ${appId}: ${error?.code || error?.message}`) }
      }
    }
    for (const job of entry.jobs ?? []) {
      const sched = scheduler()
      try {
        const current = sched?.get(job.id)
        if (!current || current.agent !== privateId) continue
        sched.update(job.id, { agent: job.agent, thread: job.thread, ...(job.channel ? { channel: job.channel } : {}) })
      } catch (error) { log(`schedule ${job.id}: ${error?.message || error}`) }
    }
    delete apps[appId]
    save({ apps })
    log(`moved ${appId} back`)
    return { app_id: appId, ok: true, moved: true }
  }

  const ids = (value, field) => {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > 128 || !value.every((id) => typeof id === 'string' && APP_ID_RE.test(id))) throw refusal(400, 'invalid_apps', field)
    return [...new Set(value)]
  }
  async function appsStep(body = {}) {
    const privateId = requirePrivate()
    const move = ids(body.move ?? body.apps, 'move')
    const back = ids(body.back, 'back')
    const results = []
    for (const id of move) results.push(await moveApp(id, privateId))
    for (const id of back.filter((id) => !move.includes(id))) results.push(await restoreApp(id, privateId))
    markStep('apps')
    return results
  }

  // ---- step 3: Bring your context along ----
  async function contextStep(body = {}) {
    const privateId = requirePrivate()
    const want = body.grant !== false
    const kept = record().context ?? {}
    if (want && kept.granted === true) { markStep('context'); return { granted: true } }
    if (!want) {
      await revokeContext(privateId)
      // A private agent made with a standard-chats transport reads it by default: an explicit No turns that off.
      const agent = registry.read(privateId)
      if (agent?.permissions?.read_standard_chats === true) {
        const prior = record().context?.prior_read_standard ?? true
        await registry.update(privateId, { permissions: { read_standard_chats: false } })
        save({ context: { granted: false, declined: true, prior_read_standard: prior } })
      } else save({ context: { granted: false, declined: true, ...(record().context?.prior_read_standard !== undefined ? { prior_read_standard: record().context.prior_read_standard } : {}) } })
      markStep('context')
      return { granted: false }
    }
    const agent = registry.read(privateId)
    const priorRead = kept.prior_read_standard ?? agent?.permissions?.read_standard_chats === true
    try {
      // #81: the private agent's read-only standard_chats tools (history and memory), where the box has the transport.
      await registry.update(privateId, { permissions: { read_standard_chats: true } })
      save({ context: { granted: true, how: 'read_standard_chats', prior_read_standard: priorRead } })
    } catch (error) {
      if (error?.error !== 'standard_chats_unconfigured') throw error
      // No standard-chats transport on this box: the same one-way read as an agent-data grant (#59 allows it from a
      // standard source to any reader; a private agent is never a source).
      const existed = registry.grants().find((grant) => grant.reader === privateId && grant.source === MAIN_AGENT_ID) ?? null
      try {
        const grant = registry.addGrant({ reader: privateId, source: MAIN_AGENT_ID, scope: 'read' })
        save({ context: { granted: true, how: 'grant', grant_id: grant.id, prior_grant: existed ? { scope: existed.scope } : null, prior_read_standard: priorRead } })
      } catch (grantError) {
        const reason = grantError?.error || grantError?.code || 'grant_refused'
        save({ context: { granted: false, reason } })
        markStep('context')
        return { granted: false, reason }
      }
    }
    markStep('context')
    return { granted: true }
  }
  async function revokeContext(privateId) {
    const kept = record().context ?? {}
    if (kept.granted !== true) return
    if (kept.how === 'read_standard_chats' && kept.prior_read_standard !== true && registry.read(privateId)) {
      await registry.update(privateId, { permissions: { read_standard_chats: false } })
    }
    if (kept.how === 'grant' && kept.grant_id) {
      try {
        if (kept.prior_grant) registry.addGrant({ reader: privateId, source: MAIN_AGENT_ID, scope: kept.prior_grant.scope })
        else registry.removeGrant(kept.grant_id)
      } catch { /* already gone */ }
    }
    save({ context: { granted: false } })
  }

  // ---- step 4: Start new chats on private AI ----
  function defaultStep(body = {}) {
    const privateId = requirePrivate()
    const want = body.private !== false && body.make_default !== false
    const kept = record().default ?? {}
    if (want) {
      const prior = kept.set === true ? kept.prior : currentDefault()
      const standard = prior === privateId ? MAIN_AGENT_ID : prior
      // Apps the owner did not move keep sending their work where it went: a binding left on "the default" would
      // otherwise follow the new default to the private agent. Pinned to the old default, put back on undo.
      const moved = record().apps ?? {}
      const pinned = kept.set === true ? (kept.pinned ?? []) : []
      if (kept.set !== true) {
        for (const binding of bindings()?.list() ?? []) {
          if (!binding.is_default || moved[binding.app_id]) continue
          try { bindings().set(binding.app_id, { agent: standard, is_default: false }); pinned.push(binding.app_id) } catch (error) { log(`binding ${binding.app_id}: ${error?.code || error?.message}`) }
        }
      }
      save({ default: { set: true, prior: standard, pinned } })
      if (currentDefault() !== privateId) setDefaultAgent(privateId)
    } else {
      if (kept.set === true) undoDefault(privateId)
      save({ default: { set: false } })
    }
    markStep('default')
    return { default_agent: currentDefault() }
  }
  /** Start new chats on the standard agent again, and the bindings pinned when the private agent became the default
   *  back on "the default". */
  function undoDefault(privateId) {
    const kept = record().default ?? {}
    if (currentDefault() === privateId) setDefaultAgent(standardDefault(kept.prior, privateId))
    for (const appId of kept.pinned ?? []) {
      const binding = bindings()?.list().find((item) => item.app_id === appId)
      if (binding && !binding.is_default && binding.agent === kept.prior) {
        try { bindings().set(appId, { agent: 'default' }) } catch (error) { log(`binding ${appId}: ${error?.code || error?.message}`) }
      }
    }
  }
  const standardDefault = (prior, privateId) => {
    const agent = typeof prior === 'string' && prior !== privateId ? registry.read(prior) : null
    return agent && agent.privacy !== 'private' && usable(agent) ? agent.id : MAIN_AGENT_ID
  }

  // ---- the operations ----
  const run = (fn) => serial(async () => { needOn(); return fn() })
  return {
    on: isOn, state, privateAgentId,
    agent: (body) => run(async () => ({ ...(await agentStep(body)), state: state() })),
    apps: (body) => run(async () => ({ results: await appsStep(body), state: state() })),
    context: (body) => run(async () => ({ ...(await contextStep(body)), state: state() })),
    setDefault: (body) => run(async () => ({ ...defaultStep(body), state: state() })),
    /** All four steps in order: {provider?, model?, apps?, grant_read? (default on), make_default? (default on)}. */
    turnOn: (body = {}) => run(async () => {
      const agent = await agentStep(body)
      const results = await appsStep({ move: body.apps ?? [] })
      const context = await contextStep({ grant: body.grant_read !== false })
      defaultStep({ private: body.make_default !== false })
      save({ mode: 'on', turned_on_at: nowS() })
      log('private mode on')
      return { ok: true, agent: agent.agent, created: agent.created, results, context, state: state() }
    }),
    /** Apps back where they were, the standard agent the default again; the private agent and its history are kept. */
    turnOff: () => run(async () => {
      const privateId = privateAgentId()
      const results = []
      if (privateId) {
        for (const appId of Object.keys(record().apps ?? {})) results.push(await restoreApp(appId, privateId))
        await revokeContext(privateId)
        undoDefault(privateId)
      }
      save({ mode: 'off', apps: {}, steps: {}, default: {}, context: {}, turned_off_at: nowS() })
      log('private mode off')
      return { ok: true, results, state: state() }
    }),
    async privacyCheck() {
      if (!isOn()) throw refusal(409, 'private_mode_off')
      let options = null
      try { options = await mainOptions() } catch { options = null }
      const defaultId = currentDefault()
      const agents = registry.list().filter(usable).filter((agent) => agent.hidden !== true || agent.id === defaultId).map((agent) => {
        const provider = agent.id === MAIN_AGENT_ID ? (typeof options?.provider === 'string' ? options.provider : '') : agent.model?.provider ?? ''
        const model = agent.id === MAIN_AGENT_ID ? (typeof options?.model === 'string' ? options.model : '') : agent.model?.model ?? ''
        return {
          id: agent.id, label: agent.label, privacy: agent.privacy, is_default: agent.id === defaultId,
          provider: provider || null, model: model || null, company: providerCompany(provider),
          private_inference: agent.privacy === 'private' && isConfidentialProvider(provider),
        }
      })
      const byId = new Map(agents.map((agent) => [agent.id, agent]))
      const moved = record().apps ?? {}
      const boundTo = new Map((bindings()?.list() ?? []).map((item) => [item.app_id, item.agent]))
      const apps = []
      for (const app of installed()) {
        let view
        try { view = registry.appAgents(app.id) } catch { continue }   // shells, agent images: not an app an agent uses
        const using = view.agents.filter((agent) => agent.enabled && byId.has(agent.id)).map((agent) => byId.get(agent.id))
        const sendsTo = boundTo.has(app.id) ? byId.get(boundTo.get(app.id)) ?? null : null
        apps.push({
          app_id: app.id, label: typeof app.name === 'string' && app.name.trim() ? app.name.trim() : app.id,
          personal_data: isPersonalDataApp(app), standard_only: isStandardOnlyApp(app),
          agents: using.map((agent) => ({ id: agent.id, label: agent.label, privacy: agent.privacy, company: agent.company })),
          lines: using.map((agent) => `${app.name || app.id} → ${agent.label} → ${agent.company ?? 'unknown'}`),
          ...(sendsTo ? { sends_work_to: { id: sendsTo.id, label: sendsTo.label, privacy: sendsTo.privacy, company: sendsTo.company } } : {}),
          private_only: using.length > 0 && using.every((agent) => agent.privacy === 'private') && (!sendsTo || sendsTo.privacy === 'private'),
          moved: moved[app.id]?.state === 'moved',
        })
      }
      apps.sort((a, b) => Number(b.personal_data) - Number(a.personal_data) || a.label.localeCompare(b.label))
      return { schema: PRIVACY_CHECK_SCHEMA, private_mode: state().mode, default_agent: defaultId, agents, apps }
    },
  }
}
