// Auto channel emoji (wizard-ux issue 1580, with the Channels switch wizard/chat-channels on): a channel an agent
// creates with no emoji in front of its name gets a fitting one from this keyword map ("Money" -> "💰 Money"), stored as
// the start of the name, the way the shell stores a picked one (wizard-ux issue 1506). A name that already starts with
// an emoji, or matches no word here, is kept exactly as given (the shell shows 💬). The same list runs in the shell's
// New channel (wizard-ux web/core/chats.js `CHANNEL_AUTO_EMOJI`): change both together.
export const CHANNEL_AUTO_EMOJI = [
  ['💰', 'money finance finances budget budgets bank banking invest investing investment investments tax taxes savings expense expenses crypto bitcoin stocks accounting invoice invoices salary pension'],
  ['🧾', 'receipts receipt bills bill'],
  ['🎵', 'music song songs playlist playlists band guitar piano concert concerts spotify'],
  ['🎙️', 'podcast podcasts interview interviews radio'],
  ['🩺', 'health doctor doctors medical medicine clinic hospital symptoms dentist'],
  ['🧘', 'meditation mindfulness wellbeing wellness therapy mental'],
  ['🏋️', 'fitness gym workout workouts training exercise running yoga'],
  ['⚽', 'football soccer sport sports'],
  ['🍳', 'food cooking recipe recipes kitchen meal meals dinner lunch breakfast'],
  ['☕', 'coffee'],
  ['🛒', 'shop groceries grocery'],
  ['📦', 'shipping packages orders delivery deliveries'],
  ['✈️', 'travel travels trip trips flight flights vacation vacations holiday holidays'],
  ['🏠', 'home house household apartment chores'],
  ['👪', 'family kids parents children'],
  ['❤️', 'love dating relationship relationships partner'],
  ['💼', 'work job jobs career office business clients client'],
  ['📅', 'calendar schedule schedules meeting meetings events agenda planning plans'],
  ['🚀', 'launch launches startup release releases'],
  ['💡', 'ideas idea brainstorm brainstorming inspiration'],
  ['🛠️', 'dev development code coding engineering build builds tools repair'],
  ['🐛', 'bug bugs debugging'],
  ['🤖', 'ai agent agents bot bots automation automations'],
  ['📚', 'books book reading study studies learning learn school homework course courses university'],
  ['🔬', 'research science'],
  ['🧪', 'test tests testing experiment experiments lab'],
  ['📝', 'notes note writing journal diary blog drafts draft todo todos tasks'],
  ['🎨', 'design art drawing painting creative'],
  ['📷', 'photo photography pictures'],
  ['🎬', 'movies movie film films video videos tv netflix'],
  ['🎮', 'games game gaming'],
  ['🌱', 'garden gardening plants plant nature'],
  ['🐶', 'dog dogs pet pets puppy'],
  ['🐱', 'cat cats kitten'],
  ['🚗', 'car cars commute driving'],
  ['🎉', 'party parties birthday birthdays celebration wedding'],
  ['🎁', 'gifts gift presents christmas'],
  ['📰', 'news newsletter newsletters press'],
  ['⚖️', 'legal law lawyer contracts contract'],
  ['📈', 'marketing growth sales analytics metrics investors'],
  ['📊', 'reports report data dashboard stats'],
  ['👥', 'team teams people friends community social hiring'],
  ['🌍', 'world languages language translation'],
  ['🔒', 'security privacy passwords'],
  ['⚙️', 'settings admin system ops setup'],
  ['✉️', 'email emails mail inbox'],
  ['📞', 'calls call phone'],
  ['☀️', 'weather'],
  ['🙏', 'faith church prayer'],
  ['⭐', 'favorites favourites starred important'],
]

const LEAD = /^(?:\p{RI}\p{RI}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:[\u{E0020}-\u{E007E}]+\u{E007F})?[\uFE0E\uFE0F]?\p{EMod}?(?:\u200D\p{Extended_Pictographic}[\uFE0E\uFE0F]?\p{EMod}?)*)/u
const INDEX = new Map()
for (const [emoji, words] of CHANNEL_AUTO_EMOJI) for (const k of words.split(' ')) if (!INDEX.has(k)) INDEX.set(k, emoji)

/** Does the name already start with an emoji (the owner's or the agent's own)? */
export const startsWithEmoji = name => LEAD.test(String(name || ''))

/** The name's words without a leading emoji ("💰 Money" -> "Money"); an emoji-only name stays as it is. */
export function bareChannelName(name) {
  const n = String(name || '').trim(), m = n.match(LEAD)
  return (m && n.slice(m[0].length).replace(/^[\s\uFE0F]+/u, '')) || n
}

/** The fitting emoji for a name, or ''. Whole words first, then a word that starts with a keyword of 4+ letters. */
export function channelAutoEmoji(name) {
  const words = String(name || '').toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  for (const w of words) { const e = INDEX.get(w) || (w.length > 3 && w.endsWith('s') && INDEX.get(w.slice(0, -1))); if (e) return e }
  for (const w of words) for (const [k, e] of INDEX) if (k.length >= 4 && w.length > k.length && w.startsWith(k)) return e
  return ''
}

/** The name to store: the emoji in front when one fits and the name still fits in 60 characters, else as given. */
export function channelAutoName(name) {
  const n = String(name || '').trim()
  if (!n || startsWithEmoji(n)) return n
  const e = channelAutoEmoji(n), t = e ? `${e} ${n}` : n
  return t.length > 60 ? n : t
}
