// Private routing (issue 629; on for everyone, switch wizard/private-routing removed). With private mode on (the
// box's default agent is a private agent), the orb's route answer names the agent each take is for, and the shell sends the owner's exact words to that agent, never through another:
//   1. name     rules, no model: an agent's name, or a model name the box can run ("Opus", "Fable", "Claude",
//               "ChatGPT", "GPT"), said at the start ("Philosopher, ...") or as "ask / tell / use X". Names come from
//               the agent registry and the box's model list, never from this file.
//   2. private_label   the private router model's one extra label: the take touches personal data or a private app.
//               Yes -> the private agent. This step can only ever move a take TOWARD the private agent.
//   3. thread   a reply while a thread is in front stays in that thread.
//   4. default  the default agent (the private one).
// A topic alone never routes to a standard agent. The router model is used only when its endpoint is private
// (privateRouter); otherwise it is never called and rules 1, 3 and 4 decide (`chosen_by: rules_only`, `rule` says
// which). No private default agent: nothing here runs and the route answers as for a standard default agent.
import { MAIN_AGENT_ID } from './agents.mjs'

export const CHOSEN_BY = new Set(['name', 'private_label', 'thread', 'default', 'rules_only'])
export const AGENT_EXAMPLES = 50

// Words in model ids and labels that name no model on their own ("use the latest", "use pro").
const STOP = new Set(['latest', 'preview', 'instruct', 'chat', 'turbo', 'mini', 'nano', 'max', 'pro', 'plus', 'flash', 'fast',
  'thinking', 'reasoning', 'high', 'low', 'medium', 'beta', 'exp', 'experimental', 'model', 'base', 'large', 'small', 'lite',
  'free', 'the', 'and', 'new', 'old', 'this', 'that', 'with', 'for', 'agent', 'wizard', 'local', 'box', 'default', 'private', 'standard'])
// The family word a provider's models answer to ("use Claude", "ask ChatGPT").
const FAMILY = [[/^(?:anthropic|claude)/u, ['claude']], [/^(?:openai|chatgpt|codex)/u, ['chatgpt', 'gpt', 'openai']], [/^(?:google|gemini)/u, ['gemini']]]
const CONFIDENTIAL = new Set(['tinfoil', 'local'])
const SEP = String.raw`(?=$|[\s,:;.!?'’"”)—–-])`
const LEAD = String.raw`^(?:(?:hey|hi|ok|okay)[\s,]+)?`
const ASK = String.raw`(?:^|[\s,;:("“])(?:ask|tell|use|using)\s+(?:the\s+)?`

const clip = (value, max) => (typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, max) : '')
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const phrase = (name) => name.split(/\s+/u).filter(Boolean).map(escape).join(String.raw`\s+`)
const usable = (agent) => agent && agent.role !== 'recovery' && agent.hidden !== true && typeof agent.id === 'string'

/** The words a model answers to: its id and label tokens (letters only, 3+), plus its provider's family word. */
export function modelWords(provider, model, label = '') {
  const out = new Set()
  for (const part of `${model} ${label}`.toLowerCase().split(/[^a-z0-9]+/u)) if (/^[a-z]{3,}$/u.test(part) && !STOP.has(part)) out.add(part)
  const p = String(provider ?? '').toLowerCase()
  for (const [re, words] of FAMILY) if (re.test(p) || re.test(String(model).toLowerCase())) words.forEach((w) => out.add(w))
  return [...out]
}

/** The names an agent answers to: its label, the label without a trailing "agent" / "bot" / "AI", and its id. */
export function agentNames(agent) {
  const label = clip(agent?.label, 60).toLowerCase()
  const names = new Set()
  if (label) names.add(label)
  const bare = label.replace(/\s+(?:agent|bot|ai)$/u, '').trim()
  if (bare && bare !== label) names.add(bare)
  const id = String(agent?.id ?? '').replace(/-/gu, ' ').trim()
  if (id) names.add(id)
  return [...names].filter((n) => n.length >= 2 && !STOP.has(n))
}

/**
 * The box's routing names. agents: registry.list(). providers: registry.providers() ([{id, confidential, models:
 * [{id, label}]}]). mainModel: the main agent's current model id. The main agent is never addressed by name (its
 * label is the owner's own name); it is reached by naming a model it runs.
 */
export function routingNames({ agents = [], providers = [], mainModel = '' } = {}) {
  const list = (Array.isArray(agents) ? agents : []).filter(usable)
  const named = list.filter((agent) => agent.id !== MAIN_AGENT_ID).map((agent) => ({ id: agent.id, names: agentNames(agent) }))
  const taken = new Set(named.flatMap((a) => a.names))
  const models = []
  const seen = new Set()
  const add = (provider, id, label = '') => {
    const key = `${provider}\n${id}`
    if (!id || seen.has(key)) return
    seen.add(key)
    models.push({ provider, model: id, words: modelWords(provider, id, label).filter((w) => !taken.has(w)) })
  }
  for (const row of Array.isArray(providers) ? providers : []) for (const m of Array.isArray(row?.models) ? row.models : []) add(String(row.id ?? ''), String(m?.id ?? m ?? ''), String(m?.label ?? ''))
  for (const agent of list) for (const id of Array.isArray(agent.model?.allowed_models) ? agent.model.allowed_models : []) add(String(agent.model?.provider ?? ''), String(id))
  const mainProviders = new Set((Array.isArray(providers) ? providers : []).filter((row) => row && row.confidential !== true && !CONFIDENTIAL.has(row.id)).map((row) => String(row.id)))
  return { agents: list, named, models, mainModel: String(mainModel || ''), mainProviders }
}

const firstMatch = (text, candidates) => {
  // Earliest in the take wins; at the same place, the longest name.
  let best = null
  for (const c of candidates) {
    const m = c.re.exec(text)
    if (!m) continue
    const at = m.index
    if (!best || at < best.at || (at === best.at && c.name.length > best.name.length)) best = { ...c, at }
  }
  return best
}

/** Rule 1: the agent or model the owner named, or null. -> { agent_id, model?, provider?, said } */
export function nameRule(text, names) {
  const t = clip(text, 600).toLowerCase().replace(/^[\s"'“]+/u, '')
  if (!t || !names) return null
  const agentCands = names.named.flatMap((a) => a.names.map((name) => ({ kind: 'agent', id: a.id, name,
    re: new RegExp(`${LEAD}${phrase(name)}${SEP}|${ASK}${phrase(name)}${SEP}`, 'u') })))
  const words = [...new Set(names.models.flatMap((m) => m.words))]
  // A model word at the start needs a pause after it ("Opus, ..."): "Claude Monet's paintings" is a topic.
  const modelCands = words.map((name) => ({ kind: 'model', name, re: new RegExp(`${LEAD}${phrase(name)}\\s*[,:;—–-]|${ASK}${phrase(name)}${SEP}`, 'u') }))
  const agentHit = firstMatch(t, agentCands)
  const modelHit = firstMatch(t, modelCands)
  const matching = (word) => names.models.filter((m) => m.words.includes(word))
  if (agentHit) {
    const agent = names.agents.find((a) => a.id === agentHit.id)
    const allowed = new Set(Array.isArray(agent?.model?.allowed_models) ? agent.model.allowed_models : [])
    const asked = modelHit ? matching(modelHit.name).find((m) => allowed.has(m.model)) : null
    return { agent_id: agentHit.id, said: agentHit.name, ...(asked ? { model: asked.model, provider: asked.provider } : {}) }
  }
  if (!modelHit) return null
  const pick = agentForModels(matching(modelHit.name), names)
  return pick ? { ...pick, said: modelHit.name } : null
}

/** The agent that runs one of these models: one already on it (main first), else main, else one that may use it. */
export function agentForModels(models, names) {
  if (!models.length) return null
  const ids = new Set(models.map((m) => m.model))
  const byId = (id) => models.find((m) => m.model === id)
  const ordered = [...names.agents].sort((a, b) => (a.id === MAIN_AGENT_ID ? -1 : b.id === MAIN_AGENT_ID ? 1 : 0)
    || (a.privacy === 'private') - (b.privacy === 'private') || (Number(a.created_at) || 0) - (Number(b.created_at) || 0) || a.id.localeCompare(b.id))
  const current = (agent) => (agent.id === MAIN_AGENT_ID ? names.mainModel : String(agent.model?.model ?? ''))
  for (const agent of ordered) if (ids.has(current(agent))) { const m = byId(current(agent)); return { agent_id: agent.id, model: m.model, provider: m.provider } }
  if (names.agents.some((a) => a.id === MAIN_AGENT_ID)) {
    const m = models.find((x) => names.mainProviders.has(x.provider))
    if (m) return { agent_id: MAIN_AGENT_ID, model: m.model, provider: m.provider }
  }
  for (const agent of ordered) {
    if (agent.id === MAIN_AGENT_ID) continue
    const allowed = Array.isArray(agent.model?.allowed_models) ? agent.model.allowed_models : []
    const m = allowed.map(byId).find(Boolean)
    if (m) return { agent_id: agent.id, model: m.model, provider: m.provider }
  }
  return null
}

/**
 * Rules 2-4 after the name rule: personal (the private label said yes; null = the model was not asked), thread (the
 * thread in front: { id, agent, private }), privateId (the default, private agent). rulesOnly: no model step ran.
 */
export function chooseAgent({ named = null, personal = null, thread = null, privateId, rulesOnly = false }) {
  const chosen = (by, fields) => (rulesOnly ? { ...fields, chosen_by: 'rules_only', rule: by } : { ...fields, chosen_by: by })
  if (named) return chosen('name', { agent_id: named.agent_id, ...(named.model ? { model: named.model, provider: named.provider } : {}) })
  // Personal data never stays in a standard agent's thread; a private thread in front keeps it.
  if (personal === true && !(thread && thread.private)) return chosen('private_label', { agent_id: privateId })
  if (thread) return chosen('thread', { agent_id: thread.agent, thread_id: thread.id })
  return chosen('default', { agent_id: privateId })
}

/** The private label the private router adds to its one answer, with the owner's latest agent corrections. */
export function privateLabelBlock({ apps = [], examples = [] } = {}) {
  const names = (Array.isArray(apps) ? apps : []).map((a) => clip(a, 40)).filter(Boolean).slice(0, 30)
  const lines = (Array.isArray(examples) ? examples : [])
    .filter((e) => e && typeof e.utterance === 'string' && e.utterance.trim() && typeof e.personal === 'boolean')
    .slice(0, 8).map((e) => `- ${JSON.stringify(clip(e.utterance, 200))} -> "personal": ${e.personal}`)
  return '\n\nPRIVATE LABEL: always add "personal": true or false to your JSON. true when the utterance touches the owner\'s'
    + ' personal data or a private app: his contacts, messages, mail, money, recordings, health'
    + (names.length ? `, or these private apps: ${names.join(', ')}` : '') + '. Otherwise false.'
    + (lines.length ? `\nThe owner corrected where these earlier requests went; label similar requests the same way:\n${lines.join('\n')}` : '')
}
