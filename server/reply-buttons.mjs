// Tap-to-answer buttons inside agent replies (wizard-ux issue 1889, switch wizard/reply-buttons in the owner's Look
// file, off by default). The shell draws a [WIZARD_BUTTONS_V1] line as buttons where it sits in the reply (wizard-ux
// core/chat-kit.js buttonGroups, core/action-cards.js replyHtml) and sends the owner's taps back as one ordinary owner
// message: readable "Tapped <label> · <group>" lines plus [WIZARD_TAPS_V1]{"taps":[{thread,message,group,button,label}]}.
// While the switch is on, every run of the main and routed agents gets this one note so the agent knows both.

export const REPLY_BUTTONS_SWITCH = 'wizard/reply-buttons'

export const REPLY_BUTTONS_INSTRUCTIONS = 'Reply buttons are on for this owner. When you ask the owner to choose or confirm something (a decision, a checklist step), you may put tap-to-answer buttons in your normal reply text: on its own line, where the buttons belong, write [WIZARD_BUTTONS_V1]{"group":"<the ask, 1-60 chars, unique in this reply>","buttons":[{"id":"<short-id>","label":"<1-40 chars>"}]}[/WIZARD_BUTTONS_V1] with 1 to 6 buttons per group (for example Go for it / Drop this for a decision, or one Done under each checklist step); a reply can hold several groups. Keep the question itself in your text: the line shows only the buttons. When the owner taps, you get one owner message with lines like "Tapped Done · Workout" and a [WIZARD_TAPS_V1] JSON line naming each tap (thread, message, group, button, label); several taps a few seconds apart arrive together. Act on every tap it names; a later tap of the same group replaces the earlier one. The owner can also just type a label instead of tapping.'

/** The run note while the switch is on (`on` reads it), else ''. */
export function replyButtonsNote(on) {
  try { return on?.() === true ? REPLY_BUTTONS_INSTRUCTIONS : '' } catch { return '' }
}
