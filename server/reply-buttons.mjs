// Tap-to-answer buttons inside agent replies (wizard-ux issue 1889, on for everyone; the Look-file switch
// wizard/reply-buttons was removed). The shell draws a [WIZARD_BUTTONS_V1] line as buttons where it sits in the reply (wizard-ux
// core/chat-kit.js buttonGroups, core/action-cards.js replyHtml) and sends the owner's taps back as one ordinary owner
// message: readable "Tapped <label> · <group>" lines plus [WIZARD_TAPS_V1]{"taps":[{thread,message,group,button,label}]}.
// Every run of the main and routed agents gets this one note so the agent knows both.

// Every row has to explain itself (issue 696): agents used to stack identical Approve / Decline rows after the last
// paragraph, so the owner could not tell which item each row decided. Hence: one group directly under its item, the
// group named after the item (the shell shows it as the row's caption, wizard-ux 1963), outcome labels, and an example.
export const REPLY_BUTTONS_INSTRUCTIONS = [
  'Reply buttons are on for this owner. When you ask the owner to choose or confirm something (a decision, a checklist step), you may put tap-to-answer buttons in your normal reply text: on its own line write [WIZARD_BUTTONS_V1]{"group":"<the item it decides, 1-60 chars, unique in this reply>","buttons":[{"id":"<short-id>","label":"<1-40 chars>"}]}[/WIZARD_BUTTONS_V1] with 1 to 6 buttons per group. The owner sees each group as one row of buttons with its group as the caption, so every row must make sense on its own:',
  '- Put each group\'s line directly under the item or question it decides, never collected together at the end of the reply.',
  '- One decision per group. "group" names that item in the owner\'s words ("Smart inbox switch", "Typed messages go quiet"), never "Item 1", "Q2" or the action ("Approve").',
  '- Labels say the outcome as one short verb phrase ("Turn it on" / "Drop it" / "Test first"), not a bare Yes / No or Approve / Decline, so the row is clear without the paragraph above it.',
  '- When several items share one answer, use one group for all of them ("All four") instead of repeating identical rows. For a checklist, one Done under each step.',
  'Example with two items, each followed by its own group:',
  'Smart inbox: sorts new mail into Important and Other.',
  '[WIZARD_BUTTONS_V1]{"group":"Smart inbox switch","buttons":[{"id":"on","label":"Turn it on"},{"id":"drop","label":"Drop it"}]}[/WIZARD_BUTTONS_V1]',
  'Quiet typed messages: typed messages arrive without a sound.',
  '[WIZARD_BUTTONS_V1]{"group":"Typed messages go quiet","buttons":[{"id":"quiet","label":"Make them quiet"},{"id":"test","label":"Test first"}]}[/WIZARD_BUTTONS_V1]',
  'Keep the question itself in your text: the line shows only the caption and buttons. When the owner taps, you get one owner message with lines like "Tapped Turn it on · Smart inbox switch" and a [WIZARD_TAPS_V1] JSON line naming each tap (thread, message, group, button, label); several taps a few seconds apart arrive together. Act on every tap it names; a later tap of the same group replaces the earlier one. The owner can also just type a label instead of tapping.',
].join('\n')

/** The run note every main and routed run carries. */
export function replyButtonsNote() {
  return REPLY_BUTTONS_INSTRUCTIONS
}
