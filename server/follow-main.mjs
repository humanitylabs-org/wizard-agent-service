// Follow main (issue 514, owner switch wizard/follow-main, off by default). The host step
// ops/wizard-agent-service-follow-main.py prepares the newest green main and deploys it, writing follow-main.json
// beside the releases. This side only reads that file: /wizard/health gains `follow_main` (the host step reads
// `on` from it), and once the box has been behind main for 30 min the owner gets one notification, but only when
// there is a step he can take, named in it (issue 638): the timer stopped, or a prepare/deploy still fails after its
// retry. A red check on main, checks still running or GitHub unreachable is CI's and the builder's (the "Red main"
// workflow reruns it once, then files a bug), so it shows in health and tells nobody. One notice per cause until
// the box catches up, never one per merge. With the switch off, health carries no field and nothing is sent.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const FOLLOW_MAIN_SWITCH = 'wizard/follow-main'
export const FOLLOW_MAIN_SCHEMA = 'wizard.follow-main/1'
export const FOLLOW_MAIN_NOTICE_MS = 30 * 60_000
// The timer runs every 5 min; a status this old means the host step is not running. A pass that is preparing or
// deploying may take up to its 60 min unit limit, so those states read stale only after that.
export const FOLLOW_MAIN_STALE_MS = 30 * 60_000
export const FOLLOW_MAIN_BUSY_STALE_MS = 75 * 60_000
const STATES = new Set(['current', 'waiting', 'preparing', 'deploying', 'behind', 'unknown'])
const CAUSES = new Set(['red-main', 'checks-pending', 'github', 'prepare', 'deploy'])
// The owner hears only about these, and only once the try has failed again after its 30-min retry.
const OWNER_CAUSES = new Set(['prepare', 'deploy'])
export const FOLLOW_MAIN_OWNER_FAILURES = 2
const SHA = /^[0-9a-f]{40}$/
const text = (v, max = 300) => typeof v === 'string' ? v.replace(/[\x00-\x1f]/g, ' ').slice(0, max) : undefined
const iso = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : undefined

/** The host step's status file, keeping only the fields Wizard shows; null when absent or not ours. */
export function readFollowMainStatus(path) {
  let data
  try { data = JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
  if (!data || data.schema !== FOLLOW_MAIN_SCHEMA || !STATES.has(data.state)) return null
  const out = { state: data.state }
  for (const key of ['live', 'main']) if (SHA.test(data[key] ?? '')) out[key] = data[key]
  if (Number.isSafeInteger(data.behind_by) && data.behind_by >= 0) out.behind_by = data.behind_by
  for (const key of ['behind_since', 'checked_at', 'deployed_at']) if (iso(data[key])) out[key] = data[key]
  if (text(data.reason)) out.reason = text(data.reason)
  const cause = CAUSES.has(data.cause) ? data.cause : causeOf(out)
  if (cause) out.cause = cause
  if (Number.isSafeInteger(data.failures) && data.failures > 0) out.failures = data.failures
  return out
}

/** The cause a host step older than issue 638 meant, read from its reason (it wrote no `cause`). */
function causeOf({ state, reason = '' }) {
  if (state === 'current') return undefined
  if (reason.startsWith('the newest change on main failed its checks')) return 'red-main'
  if (reason.startsWith("waiting for main's checks")) return 'checks-pending'
  if (reason.startsWith("couldn't read main")) return 'github'
  if (reason.startsWith("couldn't prepare the release")) return 'prepare'
  if (reason.startsWith('the deploy')) return 'deploy'
  return undefined
}

/** The owner-notice key for this status, or '' when nothing in it is the owner's to act on. */
export function ownerCause(status) {
  if (status.state === 'stale') return 'stale'
  if (status.state !== 'behind' || !OWNER_CAUSES.has(status.cause)) return ''
  return (status.failures ?? 0) >= FOLLOW_MAIN_OWNER_FAILURES ? status.cause : ''
}

/** Plain words for the owner: how far behind, since when, why, and the one step he can take. */
export function behindMessage(status) {
  if (status.state === 'stale') {
    return `This Wizard has stopped following main: ${status.reason}. Merged changes won't go live until it runs again. ` +
      'To restart it, run: systemctl --user enable --now wizard-agent-service-follow-main.timer'
  }
  const count = status.behind_by ? `${status.behind_by} merged change${status.behind_by === 1 ? '' : 's'}` : 'The newest merged changes'
  const since = status.behind_since ? ` since ${status.behind_since.slice(0, 16).replace('T', ' ')} UTC` : ''
  const why = status.reason ? `: ${status.reason}` : ''
  return `${count} on main ${status.behind_by === 1 ? "hasn't" : "haven't"} gone live on this Wizard${since}${why}. ` +
    `It failed again after a retry. Ask your agent to run wizard-agent-service-deploy ${status.main ?? 'with the newest main'} on this Wizard and fix what it reports.`
}

export function createFollowMain({ statusPath, on, notifier = null, now = Date.now, noticeMs = FOLLOW_MAIN_NOTICE_MS, staleMs = FOLLOW_MAIN_STALE_MS, busyStaleMs = FOLLOW_MAIN_BUSY_STALE_MS, log = console.error } = {}) {
  const enabled = () => { try { return Boolean(statusPath) && on?.() === true } catch { return false } }
  const sentPath = statusPath ? join(dirname(statusPath), 'follow-main-notified.json') : ''
  let sent = null
  const sentKey = () => {
    if (sent !== null) return sent
    try { sent = String(JSON.parse(readFileSync(sentPath, 'utf8')).key || '') } catch { sent = '' }
    return sent
  }
  const remember = key => {
    sent = key
    try {
      mkdirSync(dirname(sentPath), { recursive: true })
      const tmp = `${sentPath}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ key, at: new Date(now()).toISOString() }) + '\n')
      renameSync(tmp, sentPath)
    } catch { /* kept in memory; at worst one repeat after a restart */ }
  }
  /** The status as health shows it: a missing file reads not_installed, an old one stale. */
  function status() {
    const found = readFollowMainStatus(statusPath)
    if (!found) return { state: 'not_installed', reason: 'the follow-main timer has not run on this box' }
    const checked = Date.parse(found.checked_at ?? '')
    const limit = ['preparing', 'deploying'].includes(found.state) ? Math.max(staleMs, busyStaleMs) : staleMs
    if (!Number.isFinite(checked) || now() - checked > limit) {
      return { ...found, state: 'stale', reason: `the follow-main timer has not run since ${found.checked_at ?? 'an unknown time'}`, last_state: found.state }
    }
    return found
  }
  return {
    /** null while off (health unchanged); otherwise { on: true, state, live, main, behind_by, behind_since, reason }. */
    health() {
      if (!enabled()) return null
      return { on: true, ...status() }
    },
    /** Tell the owner once per cause, after the box has been behind for noticeMs, and only when it is his to act on. */
    async tick() {
      if (!enabled()) return null
      const s = status()
      if (s.state === 'current') {
        if (sentKey()) remember('') // caught up: the next episode of the same cause is news again
        return null
      }
      const behindAt = Date.parse(s.behind_since ?? '')
      const late = s.state === 'stale' || (Number.isFinite(behindAt) && now() - behindAt >= noticeMs)
      const key = ownerCause(s)
      if (!late || !key) return null
      if (sentKey() === key || !notifier?.available?.('main')) return null
      try {
        await notifier.send({ agent: 'main', title: 'Wizard is behind', message: behindMessage(s) })
        remember(key)
        log('[follow-main] owner told the box is behind main')
        return key
      } catch {
        log('[follow-main] behind notice pending: notifications unavailable')
        return null
      }
    },
  }
}
