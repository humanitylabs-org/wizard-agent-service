// One Channels switch (wizard-ux issue 1358): the owner's Settings > Try new features > Channels in Chats switch
// (`wizard/chat-channels`, kept in the synced Look file Pages/wizard-look/look.json, the same file the Thread tracker
// reads) turns on every Channels part of this service at runtime, with no restart: the channel store (issue 440),
// channel posts (issue 446), agent filing (issue 441) and read watermarks (issue 471). Turning it off goes back to
// Spaces; channels.sqlite stays on disk, so turning it on again brings the same channels and memberships back.
// The old env settings still win when a box sets them: `1` forces a part on, `0` forces it off.
export const CHANNELS_SWITCH = 'wizard/chat-channels'

/** Is tweak `id` on in the owner's Look file text (version 1, `tweaks[id].on === true`)? */
export function lookSwitchOn(lookText, id = CHANNELS_SWITCH) {
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
export function createChannelsSwitch({ readLook, now = Date.now, ttlMs = 3000 } = {}) {
  let last = { at: -Infinity, on: false }
  return () => {
    const t = now()
    if (t - last.at < ttlMs) return last.on
    let on = false
    try { on = lookSwitchOn(readLook?.()) } catch { on = false }
    last = { at: t, on }
    return on
  }
}

/** One Channels part: a forced env/option choice wins, otherwise the owner's switch decides. */
export function channelPart(forced, switchOn) {
  if (forced === true) return true
  if (forced === false) return false
  try { return switchOn() === true } catch { return false }
}
