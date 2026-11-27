// New chat quick links (wizard-ux issue 1965, switch wizard/new-chat-chips in the owner's Look file, off by default).
// James, 27 Nov 2026: a new chat offers one-tap chips that send at once: "catch me up", "What's waiting on me?" and
// "Plan my day". The shell draws and sends them (wizard-ux core/chats-status.js QUICK_LINKS). "catch me up" already
// runs the built catch-up (catch-up.mjs, issue 668); while the switch is on, every run also gets this one note so the
// agent answers the other two the same way every time, whether they come from a chip or are typed.

export const QUICK_LINKS_SWITCH = 'wizard/new-chat-chips'

export const QUICK_LINKS_INSTRUCTIONS = [
  'New chat quick links are on for this owner.',
  'When the owner asks "What\'s waiting on me?": answer with only the things blocked on them (decisions, approvals, missing info they must give), from their recent chats, the agent inbox and their apps; one short numbered line each with one link to where they answer it; nothing that is done or only informational. If nothing is waiting, say so in one line.',
  'When the owner asks "Plan my day": answer with one short plan for today in their timezone: today\'s calendar, their tasks due today, and anything waiting on them, read from their installed apps and chats, in time order where it has a time. Phone-friendly, no tables. Name in one line any source you could not read; never make one up.',
].join('\n')

/** The run note while the switch is on (`on` reads it), else ''. */
export function quickLinksNote(on) {
  try { return on?.() === true ? QUICK_LINKS_INSTRUCTIONS : '' } catch { return '' }
}
