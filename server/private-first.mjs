// Private first (wizard-os DECISIONS 115, spec/AGENTS.md section 10, issue 545). Behind the owner's
// `wizard/private-first-setup` switch (Look file, like the Channels switch); env WIZARD_PRIVATE_FIRST=1 forces it
// on and 0 forces it off, because a fresh box has no Look file when setup runs. Off by default: with it off nothing
// here runs and every route answers off.
//
// With it on:
// - Tinfoil connected first on a fresh box creates one private agent (private preset, Tinfoil, no fallback), makes
//   it the box's default agent, gives it every installed app and binds every app that sends work to an agent to it.
//   The standard agent (the main Hermes) stays off: hidden, with no apps.
// - A Claude or ChatGPT sign-in switches the standard agent on (shown again), attaches that provider to it and
//   suggests its model only when it has none. The private agent's model, providers and apps are never touched.
// - Apps installed later start on the default private agent only (agents.mjs syncApps, option privateFirstAgent).
// - The main-agent provider attach protection (issue 428) is on (service.mjs mainProviderAttachOn).
// No agent runtime on the box yet (issue 582): private first stays on (DECISIONS 115: Tinfoil never lands on the
// standard agent), names `reason: runtime_unavailable` in its state, refuses the hand-off with a 503 before writing
// anything and logs it. Freshness is kept as it was, so the box moves over by itself once its runtime is there (the
// App Manager installs it: `wam agent-runtime`).
// Existing installs are not migrated: a box that already has agents, an owner app choice for the main agent or a
// main model the first time this runs gets only what it asks for (a private Tinfoil agent, the provider attached),
// never a new default, new app lists or new bindings.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MAIN_AGENT_ID, isConfidentialProvider, isStandardOnlyApp } from './agents.mjs'

export const PRIVATE_FIRST_SWITCH = 'wizard/private-first-setup'
export const PRIVATE_FIRST_SCHEMA = 'wizard.private-first/1'
const SLUG_RE = /^[a-z0-9][a-z0-9._:-]{0,99}$/u
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,119}$/u

const readJson = (path) => {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null } catch { return null }
}
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}
const refusal = (status, error, detail = '') => Object.assign(new Error(detail || error), { status, code: error })

/**
 * on(): the switch. registry: the agent registry. agentsDir: where `.private-first.json` (this module's record) and
 * `.main-agent.json` live. mainOptions(): the main Hermes's GET /api/model/options. setDefaultAgent(id): writes the
 * owner's default agent. bindings(): the app bindings (or null). attach: the main-agent provider attach store.
 * runtime(): true when the box has an agent runtime that can create container agents (issue 582).
 */
export function createPrivateFirst({ on, registry, agentsDir, mainOptions, setDefaultAgent, bindings = () => null, attach = () => null, runtime = () => true, log = () => {} }) {
  const recordPath = join(agentsDir, '.private-first.json')
  const record = () => {
    const value = readJson(recordPath)
    return value?.schema === 1 ? value : null
  }
  const save = (patch) => writeJson(recordPath, { ...(record() ?? { schema: 1 }), ...patch, schema: 1 })
  const isOn = () => { try { return on() === true } catch { return false } }
  const hasRuntime = () => { try { return runtime() === true } catch { return false } }
  let toldNoRuntime = false
  const noRuntime = (what) => {
    if (toldNoRuntime && what === 'state') return
    toldNoRuntime = true
    log(`${what}: switch on, but this box has no agent runtime yet (WIZARD_AGENT_RUNTIME_URL/TOKEN unset), so the private agent can't be made; it is made once the runtime is there`)
  }
  // One change at a time: the provider images call on every start, and two images can start together.
  let chain = Promise.resolve()
  const serial = (fn) => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }

  const otherAgents = () => registry.list().filter((agent) => agent.id !== MAIN_AGENT_ID && agent.runtime?.kind !== 'external')

  /** The default private agent this switch set up, while it still exists and is private. */
  function privateAgentId() {
    const id = record()?.private_agent
    const agent = typeof id === 'string' ? registry.read(id) : null
    return agent?.privacy === 'private' ? agent.id : null
  }

  /**
   * Fresh or not is decided once, at the first call with the switch on, and kept: a fresh box has no other agent,
   * no owner app choice for the main agent and no main model yet. Hermes unreachable: no decision (503, retried).
   */
  async function freshness() {
    const kept = record()
    if (kept && typeof kept.fresh === 'boolean') return kept.fresh
    let options = null
    try { options = await mainOptions() } catch { options = null }
    if (!options || typeof options !== 'object') throw refusal(503, 'main_agent_unavailable')
    const fresh = !otherAgents().length && !existsSync(join(agentsDir, '.main-agent.json')) && !String(options.model ?? '').trim()
    save({ fresh, decided_at: Math.floor(Date.now() / 1000) })
    return fresh
  }

  function state() {
    const kept = record()
    // Decided as early as the switch is seen on (issue 575), not at the first hand-off: a provider image asks for the
    // state before it registers anything, so a model it adds to the main Hermes later never makes a fresh box look old.
    // Kept with no runtime too (issue 582): once one is there, the box moves over as the first run it was.
    const switchOn = isOn()
    if (switchOn && typeof kept?.fresh !== 'boolean') serial(() => freshness()).catch(() => undefined)
    const ready = switchOn && hasRuntime()
    if (switchOn && !ready) noRuntime('state')
    return {
      schema: PRIVATE_FIRST_SCHEMA, on: switchOn, ...(switchOn && !ready ? { reason: 'runtime_unavailable' } : {}),
      standard_agent: MAIN_AGENT_ID, private_agent: privateAgentId(),
      // Off only on a fresh box whose private agent was set up and no Claude or ChatGPT sign-in has come yet.
      standard_on: !(privateAgentId() && kept?.fresh === true && kept?.standard_on !== true),
    }
  }

  /** Tinfoil (or another confidential provider) connected: the box's private agent, created on first run. */
  function ensurePrivateAgent(body) {
    return serial(async () => {
      if (!isOn()) throw refusal(409, 'private_first_off')
      const provider = typeof body?.provider === 'string' ? body.provider.trim() : ''
      if (!isConfidentialProvider(provider)) throw refusal(400, 'confidential_provider_required')
      const existing = privateAgentId()
      if (existing) return { ok: true, agent: existing, created: false }
      if (!hasRuntime()) {
        noRuntime('private agent refused')
        throw refusal(503, 'runtime_unavailable', 'this box has no agent runtime')
      }
      const fresh = await freshness()
      if (!fresh) {
        // Not migrated: an existing box keeps its default and app lists. Its oldest private agent on this provider
        // answers; with none, a plain private agent is added (the private preset's own app rules apply).
        const mine = otherAgents().filter((agent) => agent.privacy === 'private' && agent.model?.provider === provider)
          .sort((a, b) => (Number(a.created_at) || 0) - (Number(b.created_at) || 0) || String(a.id).localeCompare(String(b.id)))[0]
        if (mine) return { ok: true, agent: mine.id, created: false }
      }
      const known = ((await registry.agentOptions()).providers ?? []).find((item) => item.id === provider)?.models?.map((m) => m.id) ?? []
      if (!known.length) throw refusal(409, 'provider_has_no_models')
      const asked = [body?.model, ...(Array.isArray(body?.models) ? body.models : [])].filter((m) => typeof m === 'string' && known.includes(m))
      const allowed = [...new Set(asked.length ? asked : [known[0]])]
      const apps = fresh ? (await registry.agentOptions()) : null
      // Every installed app but the Claude and ChatGPT connection apps: those only ever serve the standard agent
      // (issue 598). agentOptions entries carry no provides line, so ask the registry.
      const standardOnly = registry.standardOnlyApps?.() ?? new Set()
      const ids = (list) => list.map((app) => app.id).filter((id) => !standardOnly.has(id))
      const { agent } = await registry.create({
        label: 'Private',
        permissions: {
          preset: 'private',
          // First run: the private agent is the box's agent, so it gets every installed app (spec section 10).
          ...(fresh ? { wizard_apps: ids(apps.wizard_apps), agent_apps: ids(apps.agent_apps) } : {}),
        },
        model: { provider, model: allowed[0], allowed_models: allowed, fallback: false },
      })
      if (!fresh) return { ok: true, agent: agent.id, created: true }
      save({ private_agent: agent.id, private_at: Math.floor(Date.now() / 1000) })
      setDefaultAgent(agent.id)
      for (const binding of bindings()?.list() ?? []) {
        try { bindings().set(binding.app_id, { agent: agent.id, is_default: false }) } catch (error) { log(`binding ${binding.app_id}: ${error?.code || error?.message}`) }
      }
      if (record()?.standard_on !== true) {
        // The standard agent stays off until Claude or ChatGPT is connected: hidden, with no apps.
        await registry.update(MAIN_AGENT_ID, { hidden: true, permissions: { wizard_apps: [], agent_apps: [] } })
      }
      return { ok: true, agent: agent.id, created: true }
    })
  }

  /** Claude or ChatGPT connected: the standard agent (the main Hermes) on, with that provider attached. */
  function ensureStandardAgent(body) {
    return serial(async () => {
      if (!isOn()) throw refusal(409, 'private_first_off')
      const provider = typeof body?.provider === 'string' ? body.provider.trim() : ''
      if (!SLUG_RE.test(provider) || isConfidentialProvider(provider)) throw refusal(400, 'invalid_provider')
      const model = typeof body?.model === 'string' ? body.model.trim() : ''
      if (model && !MODEL_RE.test(model)) throw refusal(400, 'invalid_model')
      // Claude or ChatGPT connected before Tinfoil: the box now runs on the standard agent, so a later Tinfoil sign-in
      // is no first run any more and never takes over the default, the apps or the bindings (Codex review on PR 547).
      if (await freshness() && !privateAgentId()) save({ fresh: false })
      const main = registry.read(MAIN_AGENT_ID)
      // After a private first run the standard agent is shown again with the no apps it was left with; the owner
      // ticks each one (spec section 5).
      if (main?.hidden === true && main?.role !== 'recovery') await registry.update(MAIN_AGENT_ID, { hidden: false })
      save({ standard_on: true, standard_at: Math.floor(Date.now() / 1000) })
      await attach()?.attach(provider)
      let options = null
      try { options = await mainOptions() } catch { options = null }
      // The model is only a suggestion: applied (by the caller, inside Hermes) only when the agent has none.
      const applyModel = Boolean(model) && Boolean(options) && !String(options.model ?? '').trim()
      return { ok: true, agent: MAIN_AGENT_ID, apply_model: applyModel, ...(applyModel ? { model } : {}) }
    })
  }

  return { on: isOn, state, privateAgentId, ensurePrivateAgent, ensureStandardAgent }
}
