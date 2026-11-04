// Pure finish-report policy. Dispatch evidence comes from paired canonical tool
// calls/results, never from prose, SSE starts or queue admission alone.
const OFFER = /\b(?:say the word|want me to|shall I|if you want|I can\s+queue)\b/iu
const AGENT = /\b(?:mine|me|I|I['’]ll|Archimedes|agent)\b/iu
const OWNER = /^(?:\*\*)?\s*(?:You|James|Owner|Yours)\s*:/iu
const QUESTION = /\b(?:want me to|would you like me to|should I|shall I|may I|can I)\b[^?\n]+\?/iu
const CLAIMED_HANDLE = /\b(?:started|already\s+(?:scheduled|queued|running|dispatched|submitted)|scheduled\s+for|running\s+now|is\s+running|queued\s+(?:job|as)|in\s+the\s+queue)\b/iu
export const claimsExistingHandle = item => CLAIMED_HANDLE.test(String(item ?? ''))

export function openWorkItems(replyText) {
  const label = /\*\*Still open:\*\*/iu.exec(String(replyText ?? ''))
  if (!label) return []
  const section = String(replyText).slice(label.index + label[0].length).split(/\*\*[^*\n]+:\*\*|\[WIZARD_STATUS_V1\]/u)[0]
  const bullets = section.split(/(?:^|\n)\s*(?:[-*+]\s+|\d+[.)]\s+)/u).slice(1)
  return (bullets.length ? bullets : [section]).map(item => item.trim()).filter(Boolean)
}
export function ownedOpenItems(replyText) {
  return openWorkItems(replyText).filter(item => !OWNER.test(item) && !QUESTION.test(item)
    && (AGENT.test(item) || OFFER.test(item)))
}

const json = value => {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return null }
}
const toolName = name => String(name ?? '').split('.').at(-1).replace(/^mcp__/u, '')
const isCreate = (name, args) => {
  if (['wizard_schedule', 'wizard_heavy_submit', 'kanban_create', 'supervisor_build'].includes(name)) return true
  if (name === 'delegate_task') return !args?.action || ['spawn', 'create'].includes(args.action)
  return name === 'cronjob' && args?.action === 'create'
}
const failed = value => value && typeof value === 'object' && (value.error || value.success === false
  || value.ok === false || ['failed', 'error', 'cancelled', 'declined'].includes(value.status))
const handleIds = value => {
  value = json(value)
  if (!value || typeof value !== 'object' || failed(value)) return []
  if (Array.isArray(value)) return value.flatMap(handleIds)
  const ids = ['id', 'job_id', 'schedule_id', 'task_id', 'delegation_id', 'run_id', 'thread_id', 'conversation_id', 'handle', 'build_id']
    .flatMap(key => ['string', 'number'].includes(typeof value[key]) && String(value[key]).length ? [String(value[key])] : [])
  return [...ids, ...['data', 'result', 'receipt', 'job', 'schedule', 'task'].flatMap(key => handleIds(value[key]))]
}

// A one-call deferred wrapper returns the tool's bare JSON, not {results:[...]}.
// In that shape `name` is a human schedule title, not the called tool's name.
export function dispatchHandles(runToolEvents = []) {
  const results = new Map(runToolEvents.filter(row => row.role === 'tool' && row.tool_call_id)
    .map(row => [row.tool_call_id, json(row.content)]))
  const seen = new Set(), handles = []
  for (const row of runToolEvents) {
    if (row.role !== 'assistant') continue
    const calls = json(row.tool_calls)
    if (!Array.isArray(calls)) continue
    for (const call of calls) {
      if (!call.id || seen.has(call.id) || !results.has(call.id)) continue
      seen.add(call.id)
      const name = toolName(call.function?.name ?? call.name)
      const args = json(call.function?.arguments ?? call.arguments) ?? {}
      const result = results.get(call.id)
      if (failed(result)) continue
      const add = (name, args, result) => {
        const ids = handleIds(result)
        if (isCreate(name, args) && ids.length) handles.push({ name, ids, at: Number(row.timestamp), rowId: row.id })
      }
      if (isCreate(name, args)) { add(name, args, result); continue }
      if (name !== 'tool_call' || !Array.isArray(args.calls)) continue
      const innerResults = Array.isArray(result) ? result : result?.results
      if (!Array.isArray(innerResults)) {
        if (args.calls.length === 1) add(toolName(args.calls[0].name), json(args.calls[0].arguments) ?? {}, result)
        continue // ambiguous multi-call bare results fail closed
      }
      args.calls.forEach((inner, index) => {
        const returned = innerResults[index], innerName = toolName(inner.name)
        if (!returned || failed(returned) || (returned.name ?? returned.tool) && toolName(returned.name ?? returned.tool) !== innerName) return
        add(innerName, json(inner.arguments) ?? {}, json(returned.result ?? returned))
      })
    }
  }
  return handles
}
export const countDispatchHandles = rows => dispatchHandles(rows).length

// Exempt only explicitly identified, started follow-ups from an already verified
// outcome. Required builds/handoffs, missing markers, old handles and ambiguous
// descriptions still hold. Identity is matched to this reply's actual dispatch.
export function nonHoldingFollowUpIds(replyText, status, handles = []) {
  if (!['done', 'fyi'].includes(status?.state)) return []
  const before = String(replyText ?? '').split(/\*\*Still open:\*\*/iu)[0]
  if (!/\b(?:verified|tested|passed|fixed|checks? pass(?:es|ed)?)\b/iu.test(before)) return []
  const items = ownedOpenItems(replyText).filter(item => /\b(?:follow[- ]?up|optional|extra)\b/iu.test(item) && claimsExistingHandle(item))
  return handles.flatMap(handle => handle.ids.filter(id => items.some(item => item.split(/[^\p{L}\p{N}_:-]+/u).includes(id))))
}

export function guardOwnedOpenWork(status, { agentId, ownedCount = 0, handleCount = 0, continuation = false } = {}) {
  if (agentId !== 'hermes' || !['done', 'fyi'].includes(status?.state) || ownedCount <= handleCount) return status
  return { ...status, state: 'fyi', ...(continuation ? {} : { ask: 'Starting the follow-up work it listed.' }) }
}
export function projectOwnedOpenWork(session, evidence) {
  if (!evidence || evidence.status && !['done', 'fyi'].includes(evidence.status.state)) return session
  const guarded = guardOwnedOpenWork(session.wizard_attention, evidence)
  return guarded === session.wizard_attention ? session : {
    ...session, wizard_attention: guarded,
    ...(!evidence.continuation ? { status: 'running', wizard_waiting_on: 'owned_work' } : {}),
  }
}
