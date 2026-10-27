// Pure finish-report policy. Runtime evidence is read from Hermes state.db by
// owned-open-work-follow-through.mjs: assistant tool_calls paired by tool_call_id
// with persisted tool results, strictly after the triggering user row. SSE logs
// omit arguments/results, are bounded/in-memory, and disappear on restart; queue
// records alone do not cover native/locked runs. Never infer dispatch from prose.
const OFFER = /\b(?:say the word|want me to|shall I|if you want me to\s+queue|I can\s+queue)\b/iu
const AGENT = /\b(?:mine|me|I|I['’]ll|Archimedes|agent)\b/iu

export function ownedOpenItems(replyText) {
  const text = String(replyText ?? '')
  const label = /\*\*Still open:\*\*/iu.exec(text)
  if (!label) return []
  const section = text.slice(label.index + label[0].length).split(/\*\*[^*\n]+:\*\*|\[WIZARD_STATUS_V1\]/u)[0]
  const items = section.split(/(?:^|\n)\s*(?:[-*+]\s+|\d+[.)]\s+)/u).slice(1)
    .map(item => item.trim()).filter(item => AGENT.test(item) || OFFER.test(item))
  // An inline/non-bullet offer is also owned, but do not count it twice.
  if (OFFER.test(section) && !items.some(item => OFFER.test(item))) items.push(section.trim())
  return items
}

const json = value => {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return null }
}
const toolName = name => String(name ?? '').split('.').at(-1)
const isCreate = (name, args) => {
  if (['wizard_schedule', 'wizard_heavy_submit', 'kanban_create', 'supervisor_build'].includes(name)) return true
  if (name === 'delegate_task') return !args?.action || ['spawn', 'create'].includes(args.action)
  return name === 'cronjob' && args?.action === 'create'
}
const failed = value => value && typeof value === 'object' && (value.error || value.success === false
  || value.ok === false || ['failed', 'error', 'cancelled', 'declined'].includes(value.status))
const liveHandle = value => {
  if (!value || typeof value !== 'object' || failed(value)) return false
  if (Array.isArray(value)) return value.some(liveHandle)
  if (['id', 'job_id', 'schedule_id', 'task_id', 'delegation_id', 'run_id', 'thread_id', 'conversation_id', 'handle']
    .some(key => ['string', 'number'].includes(typeof value[key]) && String(value[key]).length)) return true
  return ['data', 'result', 'receipt', 'job', 'schedule', 'task'].some(key => liveHandle(json(value[key])))
}

// Accept transcript rows (assistant tool_calls + role=tool results), not merely
// tool.started/tool.completed frames. Unknown/missing/failed evidence counts zero.
export function countDispatchHandles(runToolEvents = []) {
  const results = new Map(runToolEvents.filter(row => row.role === 'tool' && row.tool_call_id)
    .map(row => [row.tool_call_id, json(row.content)]))
  const seen = new Set()
  let count = 0
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
      if (isCreate(name, args)) { if (liveHandle(result)) count++; continue }
      if (name !== 'tool_call' || !Array.isArray(args.calls)) continue
      const innerResults = Array.isArray(result) ? result : result?.results
      if (!Array.isArray(innerResults)) continue
      // Match names and position: a successful sibling cannot pay for a failed call.
      args.calls.forEach((inner, index) => {
        const returned = innerResults[index]
        const innerName = toolName(inner.name)
        if (!returned || failed(returned) || (returned.name ?? returned.tool) && toolName(returned.name ?? returned.tool) !== innerName) return
        if (isCreate(innerName, json(inner.arguments) ?? {}) && liveHandle(json(returned.result ?? returned))) count++
      })
    }
  }
  return count
}

export function guardOwnedOpenWork(status, { agentId, ownedCount = 0, handleCount = 0, continuation = false } = {}) {
  if (agentId !== 'hermes' || !['done', 'fyi'].includes(status?.state) || ownedCount <= handleCount) return status
  // fyi is the marker vocabulary; the session projection below overrides the list's
  // execution state. A failed correction stops after one turn without changing its ask.
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
