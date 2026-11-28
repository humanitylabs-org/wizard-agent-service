// Chat replies on the phone through the per-app notification path (wizard-ux issue 1619; on for everyone, its switch
// wizard/phone-chat-replies was removed).
//
// Before this, only the phone learnt that a reply was ready: its native ReplyWatcher polled each run it had sent.
// Now the phone hands the run to the box instead (POST /wizard/v1/phone/reply-notes). The box follows
// the run with its own internal read and, when the reply lands (or the run waits for the owner's approval), posts one
// item to the Notifications app tagged `app:chats` + `chat-reply`, linked to the thread. The phone's per-app reader
// (wizard-ux AppNotify) shows it on the Android channel for Chats, also with Wizard closed; a tap opens that thread.
//
// Watches are kept in one small JSON file so a Service restart does not lose a reply in flight, and expire after 6 h.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const CHAT_REPLY_TAG = 'chat-reply'
export const CHATS_APP = 'chats'
const SESSION_ID = /^(?!\.{1,2}$)[A-Za-z0-9._:-]{1,180}$/u
const RUN_ID = /^[A-Za-z0-9._:-]{1,200}$/u
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u
const SETTLED = new Set(['completed', 'failed', 'cancelled', 'stopped', 'interrupted', 'expired'])
export const MAX_WATCHES = 50
export const MAX_AGE_MS = 6 * 3600_000

/** The start of a reply without Markdown noise, at most 280 characters (same rule as the phone's ReplyPolicy). */
export function replyExcerpt(text) {
  const t = String(text ?? '')
    .replace(/```[\s\S]*?```/gu, ' [code] ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gmu, '')
    .replace(/[*_`~]+/gu, '')
    .replace(/\[SILENT\]/gu, '')
    .replace(/\s+/gu, ' ').trim()
  if (t.length <= 280) return t
  const cut = t.lastIndexOf(' ', 279)
  return `${t.slice(0, cut > 200 ? cut : 279)}…`
}

/** What the phone shows for a run in this state, or null while there is nothing to say yet. */
export function replyNote(run, title) {
  const status = String(run?.status ?? '')
  const name = String(title ?? '').trim().slice(0, 120)
  if (status === 'waiting_for_approval') return { kind: 'ask', title: name || 'Waiting on you', message: 'Your Wizard is waiting on you' }
  if (!SETTLED.has(status)) return null
  const message = status === 'completed' ? replyExcerpt(run.output) || 'Reply ready'
    : ['failed', 'interrupted', 'expired'].includes(status) ? 'That request stopped with an error' : 'That request was stopped'
  return { kind: 'reply', title: name || 'Reply ready', message }
}

/** The thread's own link on this Wizard's shell (https, as the notify tool requires), or '' when unknown. */
export function threadLink(shellUrl, session) {
  let u
  try { u = new URL(String(shellUrl || '')) } catch { return '' }
  if (u.protocol !== 'https:' || u.username || u.password) return ''
  u.search = ''; u.hash = ''
  u.searchParams.set('session', session)
  return u.href
}

/** How long until a watch is worth another read: often while young, then less (a long job is read every 2 min). */
export function nextReadMs(age, asked) {
  if (asked) return 60_000
  if (age < 10 * 60_000) return 4_000
  return age < 3600_000 ? 30_000 : 120_000
}

/**
 * readRun(run, agent) -> {status, payload}; notify({title, message, link}, agent) -> sends one Notifications item as
 * the thread's own agent ('' = main); shellUrl() -> the shell's https address; available(agent) -> that agent can
 * reach the Notifications app.
 */
export function createPhoneReplyNotes({ statePath = '', readRun, notify, shellUrl = () => '', available = () => true, now = Date.now, log = () => {}, tickMs = 2_000 } = {}) {
  let watches = []
  let timer = null
  let busy = false
  if (statePath) {
    try {
      const doc = JSON.parse(readFileSync(statePath, 'utf8'))
      if (Array.isArray(doc?.watches)) watches = doc.watches.filter(w => w && SESSION_ID.test(w.session) && RUN_ID.test(w.run)).slice(-MAX_WATCHES)
    } catch { watches = [] }
  }
  const save = () => {
    if (!statePath) return
    try {
      mkdirSync(dirname(statePath), { recursive: true })
      const tmp = `${statePath}.tmp`
      writeFileSync(tmp, JSON.stringify({ schema: 1, watches }), { mode: 0o600 })
      renameSync(tmp, statePath)
    } catch (error) { log(`save failed: ${error?.message || error}`) }
  }
  const schedule = () => {
    if (timer || !watches.length) return
    timer = setTimeout(() => { timer = null; tick().catch(() => {}).finally(schedule) }, tickMs)
    timer.unref?.()
  }
  const drop = w => { watches = watches.filter(x => x !== w); save() }

  async function readOnce(w, t) {
    w.lastRead = t
    let result
    try { result = await readRun(w.run, w.agent) } catch { return } // the box is busy or restarting: next time
    if (result?.status === 404) { drop(w); return }
    if (!result || result.status !== 200) return
    const note = replyNote(result.payload, w.title)
    if (!note || (note.kind === 'ask' && w.asked)) return
    const link = threadLink(shellUrl(), w.session)
    try {
      await notify({ title: note.title, message: note.message, link }, w.agent)
    } catch (error) { log(`notify failed: ${error?.message || error}`); return } // kept: tried again on the next read
    log(`${note.kind} ${w.session}`)
    if (note.kind === 'ask') { w.asked = true; save() } else drop(w)
  }

  async function tick() {
    if (busy) return
    busy = true
    try {
      const t = now()
      for (const w of [...watches]) {
        if (t - w.at > MAX_AGE_MS) { drop(w); continue }
        if (w.lastRead && t - w.lastRead < nextReadMs(t - w.at, w.asked)) continue
        await readOnce(w, t)
      }
    } finally { busy = false }
  }

  return {
    /** The phone's handover of one accepted send. Throws {status, code} when it cannot be taken. */
    watch(value) {
      const session = typeof value?.session === 'string' ? value.session : ''
      const run = typeof value?.run === 'string' ? value.run : ''
      const agent = typeof value?.agent === 'string' && value.agent ? value.agent : ''
      if (!SESSION_ID.test(session) || !RUN_ID.test(run) || (agent && !AGENT_ID.test(agent))) throw Object.assign(new Error('invalid'), { status: 400, code: 'invalid_request' })
      if (!available(agent)) throw Object.assign(new Error('no notifications'), { status: 409, code: 'notifications_unavailable' })
      if (!threadLink(shellUrl(), session)) throw Object.assign(new Error('no shell address'), { status: 409, code: 'shell_url_unknown' })
      const title = typeof value?.title === 'string' ? value.title.replace(/\s+/gu, ' ').trim().slice(0, 120) : ''
      // The newest run per thread wins, as on the phone.
      watches = watches.filter(w => !(w.session === session && w.agent === agent))
      watches.push({ session, run, agent, title, at: now(), asked: false, lastRead: 0 })
      if (watches.length > MAX_WATCHES) watches = watches.slice(-MAX_WATCHES)
      save()
      schedule()
      return { ok: true, watching: watches.length }
    },
    list: () => watches.map(({ session, run, agent, asked }) => ({ session, run, agent, asked })),
    tick,
    start: schedule,
    stop() { if (timer) clearTimeout(timer); timer = null },
  }
}
