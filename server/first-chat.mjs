// Five-choice first chat (issue 650; on for everyone since show-and-tell, the `wizard/first-chat-goals` switch was
// removed). James, 25 Nov 2026: give a new owner examples of what Wizard is good for instead of an
// open prompt, without putting a goal method into the core agent (goals are context only).
//
// The Service's part is small:
//  - FIRST_CHAT_NOTE: one run-note line in every run that sends a first chat to the wizard-guide system skill's
//    "First chat: five choices" section (wizard-app-manager). Its words stay as they were: older guides key on them.
//  - personalTips(): the day 2-5 tips built from the owner's pick and their own words (wizard_tips start
//    {pick, about}), instead of the five fixed topics. A goal-shaped pick (business, job) may get the Goals app
//    offered in a later tip, and only when one is installed.
// No pick: wizard_tips starts the five fixed tips.
//
// The tap-to-pick replies themselves are a Chats reply-button marker the agent writes,
// [WIZARD_CHOICES_V1]{"choices":[...]}[/WIZARD_CHOICES_V1] (wizard-ux core/chat-kit.js choiceList);
// session-list-view.mjs keeps it out of the list preview.

export const FIRST_CHAT_CHOICES = Object.freeze(['Get on top of my inbox', 'Organize my digital life', 'Grow my business', 'Find a job', 'Something else'])
export const FIRST_CHAT_NOTE = 'Five-choice first chat is on: for the owner\'s first chat, or when they ask what you can do, load `wizard-guide` and follow its "First chat: five choices" section.'
export const PICK_MAX = 80
export const ABOUT_MAX = 400

const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max).trim()

/** The owner's pick: one of the five (any case) in its own words, else their own short text; '' when empty. */
export function normalizePick(value) {
  const text = clean(value, PICK_MAX)
  return FIRST_CHAT_CHOICES.find((choice) => choice.toLowerCase() === text.toLowerCase()) || text
}

/** Business and job picks are goal-shaped: only they may later be offered the Goals app (never in the first chat). */
export const goalShaped = (pick) => /\b(business|job|career)\b/iu.test(String(pick || '')) && !/^something else$/iu.test(String(pick || ''))

/** One angle per tip, days 2-5. Each is something to offer, never a check-in on how they are doing. */
const ANGLES = [
  'the next concrete thing you can do for them on this, building on what you did together in the first chat',
  'one small thing you could do for them regularly on this (for example a short morning summary); offer it and set it up only if they say yes',
  'one more account or app that would help with this, only if it is not connected yet; say what it unlocks in one line and that they can connect it in Setup or just ask',
  'another way you can help with this that they may not have thought of',
]
const GOALS_ANGLE = 'if `wizard_apps` lists a Goals app, offer it in one line as a place to keep this goal; if there is none, use this angle instead: another way you can help with this that they may not have thought of'

/** The four day 2-5 tip prompts for one owner. Context only: no predictions, check-ins or tracking. */
export function personalTips({ pick, about = '' }) {
  const what = normalizePick(pick)
  const words = clean(about, ABOUT_MAX)
  const angles = ANGLES.map((angle, index) => (index === 3 && goalShaped(what) ? GOALS_ANGLE : angle))
  return angles.map((angle, index) => ({
    topic: `${what}: ${['next step', 'a regular help', 'one more connection', goalShaped(what) && index === 3 ? 'a place for the goal' : 'another way to help'][index]}`,
    prompt: [
      `Wizard tip ${index + 1} of ${angles.length} for this owner. In their first chat they picked "${what}"${words ? ` and said: "${words}"` : ''}.`,
      'Use what you know about them (your About me note and that first chat). In two or three friendly sentences, share',
      `${angle}, and offer to do it now.`,
      'Never ask how they are getting on, predict anything or track progress. Do not mention other tips.',
      'End with: "Say stop tips to turn these off."',
    ].join(' '),
  }))
}
