// Owner switches kept in the synced Look file Pages/wizard-look/look.json (`tweaks[id].on`), read at runtime with no
// restart (private first, agent inbox). Channels are on for everyone (wizard-ux issue 1258, switch removed): every
// Channels part (store, posts, read marks, Daily) is on unless a box's WIZARD_CHANNEL_* env sets `0`; agent filing
// (issue 441) has no setting of its own and follows the store.

// Tags (issue 608): a chat carries several channels as tags. Off by default; the owner's switch or WIZARD_CHANNEL_TAGS.
export const CHAT_TAGS_SWITCH = 'wizard/chat-tags'

/** Is tweak `id` on in the owner's Look file text (version 1, `tweaks[id].on === true`)? */
export function lookSwitchOn(lookText, id) {
  try {
    const look = typeof lookText === 'string' ? JSON.parse(lookText) : lookText
    return look?.version === 1 && look?.tweaks?.[id]?.on === true
  } catch { return false }
}

/** An env value as a forced choice: '1' on, '0' off, anything else follows the switch (undefined). */
export function envChoice(value) {
  return value === '1' ? true : value === '0' ? false : undefined
}

/** The switch, read from the Look file at most every `ttlMs`; an unreadable file reads as off. */
export function createChannelsSwitch({ readLook, now = Date.now, ttlMs = 3000, id } = {}) {
  let last = { at: -Infinity, on: false }
  return () => {
    const t = now()
    if (t - last.at < ttlMs) return last.on
    let on = false
    try { on = lookSwitchOn(readLook?.(), id) } catch { on = false }
    last = { at: t, on }
    return on
  }
}

/** One switched part: a forced env/option choice wins, otherwise the owner's switch decides. */
export function channelPart(forced, switchOn) {
  if (forced === true) return true
  if (forced === false) return false
  try { return switchOn() === true } catch { return false }
}

/** One Channels part: on for everyone; only a box's forced env/option `false` (`0`) turns it off. */
export function channelOn(forced) {
  return forced !== false
}
