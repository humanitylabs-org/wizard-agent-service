// Signal sweep card (issue 550, step 3 of the agent inbox series; owner switch `wizard/agent-inbox`, off by default).
//
// One capped card, posted as the last message of today's Daily thread when the owner says or types "signal sweep" (or
// a sweep he scheduled fires): what is waiting on him (with a recommendation and one button per answer token), what
// finished, and counts for what is running, later/FYI and parked. The caps are enforced here, in code, never in a
// prompt, and the card has no free-text summary field: every line is a record field (title, ask, recommendation).
//
// The card is not a Hermes message (Hermes stays stock and has no way to add one): the Service keeps the latest card
// in the inbox store and adds it as the last row of that Daily thread's newest history page (display_kind
// `agent_sweep`, with a plain-markdown `content` for a shell that does not draw the buttons yet).

export const SWEEP_SCHEMA = 'wizard.agent-sweep/1'
export const WAITING_CAP = 7
export const DONE_CAP = 10
// An unanswered item is shown on this many sweeps; at the next one it parks.
export const PARK_AFTER = 3
export const SWEEP_KIND = 'agent_sweep'
// "signal sweep" said or typed on its own (a trailing full stop or exclamation mark is fine).
const PHRASE = /^\s*signal[\s-]+sweep[\s.!?]*$/iu
const SEVERITY_RANK = { urgent: 3, high: 2, normal: 1, low: 0 }
// Alerts are their own loud channel; they never ride on the card.
const LATER_KINDS = new Set(['fyi', 'note'])

export const isSweepPhrase = text => typeof text === 'string' && PHRASE.test(text)
/** A scheduled sweep: a schedule brief (`[Wizard schedule] ...`) whose prompt is the phrase on its own line. */
export const isScheduledSweep = text => typeof text === 'string' && text.trimStart().startsWith('[Wizard schedule]')
  && text.split('\n').some(line => PHRASE.test(line))

/** Where the card's links go. Thread links are the shell's own deep link; the list views belong to the Running
 *  view (wizard-ux issue 1569) and the inbox views that follow it. */
export const DEFAULT_LINKS = Object.freeze({
  thread: (thread, agent) => `/wizard-os-home/?session=${encodeURIComponent(thread)}${agent && agent !== 'hermes' ? `&agent=${encodeURIComponent(agent)}` : ''}`,
  waiting: '/wizard-os-home/?inbox=waiting',
  done: '/wizard-os-home/?inbox=done',
  running: '/wizard-os-home/?inbox=running',
  later: '/wizard-os-home/?inbox=later',
  parked: '/wizard-os-home/?inbox=parked',
})

const byWaiting = (a, b) => (SEVERITY_RANK[b.severity] ?? 1) - (SEVERITY_RANK[a.severity] ?? 1)
  || (Date.parse(a.deadline || '') || Infinity) - (Date.parse(b.deadline || '') || Infinity)
  || (a.created_at || 0) - (b.created_at || 0) || a.id.localeCompare(b.id)
const byNewest = (a, b) => (b.updated_at || 0) - (a.updated_at || 0) || a.id.localeCompare(b.id)

export const isWaiting = r => r.kind === 'needs_you' && (r.state === 'new' || r.state === 'surfaced')
export const isDone = r => r.kind === 'result' && (r.state === 'new' || r.state === 'surfaced')
export const isLater = r => LATER_KINDS.has(r.kind) && (r.state === 'new' || r.state === 'surfaced')
export const isRunning = r => r.state === 'running' || r.state === 'stale'

/** Which records a sweep shows and counts. Pure: the store applies the state changes (`plan.surface`,
 *  `plan.archive`, `plan.park`). Records that already sat on PARK_AFTER sweeps unanswered park first. */
export function planSweep(records, { waitingCap = WAITING_CAP, doneCap = DONE_CAP } = {}) {
  const list = Array.isArray(records) ? records : []
  const park = list.filter(r => isWaiting(r) && (r.surfaced_count || 0) >= PARK_AFTER)
  const parked = new Set(park.map(r => r.id))
  const waiting = list.filter(r => isWaiting(r) && !parked.has(r.id)).sort(byWaiting)
  const done = list.filter(isDone).sort(byNewest)
  const later = list.filter(isLater)
  return {
    waiting: waiting.slice(0, waitingCap), waitingMore: Math.max(0, waiting.length - waitingCap),
    done: done.slice(0, doneCap), doneMore: Math.max(0, done.length - doneCap),
    running: list.filter(isRunning).length,
    stale: list.filter(r => r.state === 'stale').length,
    later,
    parked: list.filter(r => r.state === 'parked').length + park.length,
    park,
  }
}

const optionList = record => Object.keys(record.options || {}).map(token => ({ token }))

/** The stored card (what was shown, at the moment of the sweep). `seen` is how many sweeps showed the item. */
export function composeCard(plan, { id, at, day = '', thread_id = '', agent = 'hermes', missing = 0, links = DEFAULT_LINKS } = {}) {
  const threadLink = r => r.link || links.thread(r.thread_id, r.agent)
  return {
    schema: SWEEP_SCHEMA, id, at, day, thread_id, agent,
    waiting: {
      items: plan.waiting.map(r => ({ id: r.id, agent: r.agent, thread_id: r.thread_id, title: r.title, ask: r.ask || r.last_update || '',
        recommendation: r.recommendation || '', options: optionList(r), default_option: r.default_option || null,
        confirm: r.confirm === true, seen: (r.surfaced_count || 0) + 1, link: threadLink(r) })),
      more: plan.waitingMore, link: links.waiting,
    },
    done: { items: plan.done.map(r => ({ id: r.id, title: r.title, link: threadLink(r) })), more: plan.doneMore, link: links.done },
    running: { count: plan.running, stale: plan.stale, link: links.running },
    later: { count: plan.later.length, link: links.later },
    parked: { count: plan.parked, link: links.parked },
    // Finished worker runs with no inbox record at the last nightly check (issue 549); the target is zero.
    missing: Math.max(0, Number(missing) || 0),
  }
}

/** Items "Yes to all" may answer: only the Waiting items on this card, never a `confirm` item (sends, spends) and
 *  never one without a default answer; an item already answered, snoozed away or parked since is skipped. */
export function yesToAllTargets(card, current) {
  const out = []
  for (const item of card?.waiting?.items || []) {
    const record = current(item.id)
    if (!record || record.confirm === true || item.confirm) continue
    if (record.state !== 'surfaced' && record.state !== 'new') continue
    if (record.kind !== 'needs_you') continue
    const option = record.default_option
    if (!option || !Object.hasOwn(record.options || {}, option)) continue
    out.push({ id: record.id, option })
  }
  return out
}

/** The card as the shell reads it now: each Waiting item carries its record's current state and answer. */
export function cardView(card, current) {
  if (!card) return null
  const items = (card.waiting?.items || []).map(item => {
    const record = current(item.id)
    const state = !record ? 'archived' : record.state === 'answered' || (record.state === 'archived' && record.answer) ? 'answered' : record.state
    return { ...item, state, ...(record?.answer ? { answer: record.answer } : {}) }
  })
  const yes = yesToAllTargets(card, current).length
  return { ...card, waiting: { ...card.waiting, items }, yes_to_all: { count: yes, skipped: items.filter(i => i.confirm && (i.state === 'surfaced' || i.state === 'new')).length } }
}

const line = text => String(text ?? '').replace(/\s+/gu, ' ').replace(/([\\`*_[\]])/gu, '\\$1').trim()

/** The plain-markdown copy of the card, for a shell that does not draw its buttons. Record fields only. */
export function cardMarkdown(view) {
  if (!view) return ''
  const out = ['**Signal sweep**']
  const w = view.waiting
  out.push('', `**Waiting on you** (${w.items.length + w.more})`)
  if (!w.items.length) out.push('Nothing is waiting on you.')
  w.items.forEach((item, n) => {
    const age = item.seen > 1 ? ` (sweep ${item.seen})` : ''
    out.push(`${n + 1}. [${line(item.title)}](${item.link})${age}: ${line(item.ask)}`)
    if (item.recommendation) out.push(`   Recommendation: ${line(item.recommendation)}`)
    if (item.state === 'answered') out.push(`   Answered: ${line(item.answer || '')}`)
    else if (item.confirm) out.push('   Open to confirm.')
    else if (item.options.length) out.push(`   Answers: ${item.options.map(o => o.token).join(' · ')}`)
  })
  if (w.more) out.push(`[and ${w.more} more](${w.link})`)
  const d = view.done
  out.push('', `**Done** (${d.items.length + d.more})`)
  if (!d.items.length) out.push('Nothing new finished.')
  for (const item of d.items) out.push(`- [${line(item.title)}](${item.link})`)
  if (d.more) out.push(`[more](${d.link})`)
  out.push('', `[Running: ${view.running.count}](${view.running.link})${view.running.stale ? `, ${view.running.stale} with no news for 6 h` : ''}`)
  out.push(`[Later and FYI: ${view.later.count}](${view.later.link})`)
  if (view.parked.count) out.push(`[${view.parked.count} parked](${view.parked.link})`)
  if (view.missing) out.push(`${view.missing} finished task(s) had no inbox record at the last check.`)
  return out.join('\n')
}

/** The card as a history row: always the last row of its Daily thread's newest page. */
export function cardRow(view) {
  const content = cardMarkdown(view)
  return {
    id: view.id, role: 'assistant', author: 'assistant', session_id: view.thread_id,
    timestamp: view.at / 1000, created_at: new Date(view.at).toISOString(),
    display_kind: SWEEP_KIND, content, display_content: content, shareable: false, agent_sweep: view,
  }
}

/** Add the card as the last row of one history page (`{data|messages|items: [...]}`) when it is the thread's newest
 *  page: order=oldest with fewer rows than the limit (the last page), or order=latest at offset 0 (Hermes returns the
 *  newest page in chronological order, so the card goes last there too). */
export function withCardRow(payload, view, searchParams) {
  if (!view || !payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  const key = ['data', 'messages', 'items'].find(k => Array.isArray(payload[k]))
  if (!key) return payload
  const rows = payload[key]
  const order = searchParams?.get?.('order') || 'oldest'
  const offset = Number(searchParams?.get?.('offset') || 0) || 0
  const limit = Number(searchParams?.get?.('limit') || 0) || 0
  if (rows.some(row => row?.id === view.id)) return payload
  if (order === 'latest') return offset === 0 ? { ...payload, [key]: [...rows, cardRow(view)] } : payload
  if (payload.has_more === true || payload.pagination?.has_more === true) return payload
  if (limit && rows.length >= limit) return payload
  if (offset > 0 && !rows.length) return payload
  return { ...payload, [key]: [...rows, cardRow(view)] }
}
