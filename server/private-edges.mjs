// Private mode edges (issue 631; owner switch `wizard/private-routing`, off by default, the same switch as issue 629).
// With it on, nothing from a private agent's work leaks through the edges of the box:
//   pushes  an alert, a scheduled notification run, a phone chat-reply note or an app door's ping whose agent is a
//           private agent goes out content-free: the title "Wizard: 1 new item", one fixed neutral line instead of
//           the words (the Notifications app's `notify` refuses an empty message), and a link that opens Wizard
//           itself. The words stay on the box and show only inside Wizard. A standard agent's notes are unchanged.
//   Daily   with a private default agent, the Daily thread, the signal sweep card and scheduled sweeps are the private
//           agent's (service.mjs), so summaries of private work never land in a standard agent's thread.
//   History the private agent's read-only standard_chats tools also search the standard agent's imported History
//           (standard-chats.mjs `standard_history_search`).
// Switch off: every function here hands its input back untouched.

export const PRIVATE_PUSH_TITLE = 'Wizard: 1 new item'
export const PRIVATE_PUSH_BODY = 'Open Wizard to read it.'

/** The shell's own address for a content-free push: `view` ('alerts', ...) opens that inbox view; '' = home. */
export function privatePushLink(shellUrl, view = '') {
  if (typeof shellUrl !== 'string' || !shellUrl.startsWith('https://')) return ''
  try {
    const url = new URL(shellUrl)
    if (view) url.search = `?inbox=${encodeURIComponent(view)}`
    url.hash = ''
    return url.href
  } catch { return '' }
}

/** A note as the notifications slot sends it, with its words taken out. A link already into the shell (a thread's
 *  deep link carries ids, never words) is kept; any other link (an app's own page) becomes the shell's address. */
export function contentFreeNote(note, { shellUrl = '', view = '' } = {}) {
  const shell = privatePushLink(shellUrl)
  const keep = typeof note?.link === 'string' && shell && note.link.startsWith(shell)
  const link = keep ? note.link : privatePushLink(shellUrl, view)
  const { title: _title, message: _message, link: _link, ...rest } = note || {}
  return { ...rest, title: PRIVATE_PUSH_TITLE, message: PRIVATE_PUSH_BODY, ...(link ? { link } : {}) }
}

/**
 * A notifications slot (`{available, send}`) whose sends for a private agent are content-free while `on()`.
 * isPrivate(agent): the agent id ('main' / 'hermes' included) is a private agent. view: the inbox view a tap opens.
 */
export function privatePushes(notifier, { on = () => false, isPrivate = () => false, shellUrl = () => '', view = '' } = {}) {
  if (!notifier) return notifier
  const quiet = note => { try { return on() === true && isPrivate(note?.agent) === true } catch { return false } }
  return {
    ...notifier,
    available: (...args) => notifier.available(...args),
    send: note => notifier.send(quiet(note) ? contentFreeNote(note, { shellUrl: shellUrl(), view }) : note),
  }
}

/** An app door's ping for a private agent's alert: the same neutral title, no ask, the shell's Alerts view. */
export function contentFreePing(ping, shellUrl = '') {
  const link = privatePushLink(shellUrl, 'alerts') || '/wizard-os-home/?inbox=alerts'
  return { ...ping, title: PRIVATE_PUSH_TITLE, ask: '', link, content_free: true }
}
