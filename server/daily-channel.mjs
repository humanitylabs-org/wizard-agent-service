// Daily channel (issue 527): one pinned channel per agent that holds one real thread per day, so the shell can show it
// as one continuous chat while every day stays its own Hermes session (a never-ending session would re-send and
// compress its whole history every turn). Part of the Channels switch (wizard/chat-channels); WIZARD_CHANNEL_DAILY
// '1'/'0' forces it on or off. The store half (kind 'daily', daily_days) lives in channel-store.mjs.
import { randomBytes } from 'node:crypto'
import { SCHEDULE_INPUT } from './scheduler.mjs'

// James's day runs to 2-3am, so midnight would split one evening across two days.
export const DAY_STARTS_AT = '05:00'
export const DAILY_NAME = 'Daily'
export const DAYS_PAGE = 14
export const DAYS_PAGE_MAX = 60
export const OPENER_CHARS = 200
const DAY = /^\d{4}-\d{2}-\d{2}$/
export const validDay = v => typeof v === 'string' && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))

const partsCache = new Map()
const formatter = timeZone => {
  if (!partsCache.has(timeZone)) {
    partsCache.set(timeZone, new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))
  }
  return partsCache.get(timeZone)
}
const zoneOr = timeZone => { try { formatter(timeZone); return timeZone } catch { return 'UTC' } }

/** The Daily day (YYYY-MM-DD) an instant belongs to in `timeZone`: before `startsAt` local time it is still yesterday. */
export function dayOf(ms, timeZone = 'UTC', startsAt = DAY_STARTS_AT) {
  const parts = Object.fromEntries(formatter(zoneOr(timeZone)).formatToParts(new Date(ms)).map(p => [p.type, p.value]))
  const [h, m] = startsAt.split(':').map(Number)
  let date = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))
  if (Number(parts.hour) * 60 + Number(parts.minute) < h * 60 + m) date -= 86_400_000
  return new Date(date).toISOString().slice(0, 10)
}

/** A thread id in the shell's own fresh-chat shape (wizard_<13 digits>_<12 hex>), so every runtime accepts it. */
export const mintDailyThreadId = (now = Date.now()) => `wizard_${String(Math.floor(now)).padStart(13, '0').slice(-13)}_${randomBytes(6).toString('hex')}`

/** The day thread's Hermes title, e.g. "Daily · Sat 15 Nov". */
export function dailyTitle(day, name = DAILY_NAME) {
  const d = new Date(`${day}T12:00:00Z`)
  return `${String(name || DAILY_NAME).slice(0, 40)} · ${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}`
}

const textOf = content => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').join(' ')
  return ''
}
// Service-injected inputs (a schedule brief, out-of-band notes) are not what the day opens with: the agent's answer is.
const INJECTED = [SCHEDULE_INPUT, '[OUT-OF-BAND', '[reporter]', 'Morning reconciliation']
/** The day's opener: the first shown message (normally the day's Signal post), cut to 200 characters. */
export function openerOf(messages) {
  for (const row of Array.isArray(messages) ? messages : []) {
    if (!row || (row.role !== 'user' && row.role !== 'assistant')) continue
    if (row.role === 'assistant' && ['commentary', 'hidden'].includes(row.display_kind)) continue
    const text = textOf(row.content).replace(/\s+/g, ' ').trim()
    if (!text || (row.role === 'user' && INJECTED.some(prefix => text.startsWith(prefix)))) continue
    return text.length > OPENER_CHARS ? `${text.slice(0, OPENER_CHARS - 1)}…` : text
  }
  return ''
}

/** The carry-over note for a run in a Daily thread: yesterday's thread and its still-open tracker items. */
export function dailyRunNote({ day, previous, openItems = [] }) {
  const lines = [`Daily channel: this thread is the owner's Daily thread for ${day} (one thread per day; a new one starts at ${DAY_STARTS_AT} local time).`]
  if (previous) {
    lines.push(`The previous Daily thread is ${previous.sessionId} (${previous.day}); continue its plan and look it up if you need it.`)
    if (openItems.length) lines.push(`Still open from that day (data): ${JSON.stringify(openItems.slice(0, 20))}`)
  }
  return lines.join('\n')
}
