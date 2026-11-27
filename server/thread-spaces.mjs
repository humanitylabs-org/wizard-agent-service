// Owner-created Spaces are scoped to one agent; legacy collections belong to main.
import { readUiPreferences, updateUiPreferences } from './ui-preferences.mjs'
import { subjectKey } from './thread-subjects.mjs'
const SPACE_ID = /^[a-z0-9-]{1,48}(?![\s\S])/u
const THREAD_ID = /^[A-Za-z0-9._:-]{1,180}(?![\s\S])/u
export const normalizeSpaceId = v => typeof v === 'string' && SPACE_ID.test(v) ? v : null
export const spaceAgent = s => s.agent || 'hermes'
export const SPACE_INSTRUCTIONS = 'Space filing is optional: add space (one exact existing Space ID from this agent’s catalogue) to the final WIZARD_STATUS_V1 JSON only when this thread clearly belongs to that Space. Omit it when uncertain or no Space fits; never invent Spaces or IDs. A thread is in one Space at a time: the service files only a thread that is in none of your Spaces yet and never moves one the owner (or an earlier status) already filed. '
// Chats channels phase 3 (issue 441, on wherever the channel store is): the
// status line's `channel` field files the thread (`space` stays an alias for one release), the catalogue and
// instructions speak of channels, and `title` becomes the post's short name. Alerts is never in the catalogue:
// it is where the service files agent-started chats, not a place for the agent to file an owner's chat.
export const CHANNEL_INSTRUCTIONS = 'Channels are on for this owner; this replaces the Space and title rules above. Channel filing is optional: add channel (one exact existing channel ID from the catalogue below) to the final WIZARD_STATUS_V1 JSON only when this chat clearly belongs to that channel. Omit it when uncertain or no channel fits; never invent channels or IDs. A chat is in one channel at a time: the service files only a chat that is in no channel yet and never moves one the owner already filed. In channels, title is this chat\u2019s post name: what this one chat is about, in two to five plain words and at most 32 characters ("Desk layout options", "Tokyo hotel booking", "Messenger sync bug"), not the project or app label, since the channel already names the project. It is a label, never a sentence: no leading verb, no trailing period, no emoji. Keep the same title while the chat stays on that topic. Owner-set titles stay fixed. A channel fits only when its name or its listed subjects cover this chat\u2019s subject; a chat about something no channel covers (for example an agent, Hermes or model chat when no channel is about that) gets no channel, never the closest-sounding one. The service refuses a channel that does not match the status subject, and never files a chat the owner took out of a channel.'
// Tags (issue 608, on wherever the store is): `channel` adds a tag. A chat can carry several, so the
// one-channel sentence above is replaced by this one.
export const TAG_INSTRUCTIONS = 'Tags are on for this owner: a chat can carry several channels as tags. Your channel adds this chat\u2019s tag for that channel next to the ones it already has; it never moves the chat or removes a tag, and a tag the owner removed from a chat is never put back.'
const ALERTS_KIND = 'alerts'
// Issue 520: the server-side check that a status line's `subject` belongs in the channel it names. A channel covers a
// subject when their names are the same, when every identifying word of the subject is in the channel name
// ("WizardOS" fits "WizardOS Apps"; "Google Apps" does not, since "apps" is generic), or when the owner has filed a
// chat with that subject there before (learned from later status lines of owner-filed chats). No subject: no filing.
const GENERIC = new Set(['the', 'and', 'for', 'with', 'your', 'our', 'my', 'misc', 'other', 'others', 'general', 'stuff', 'thing', 'things', 'note', 'notes',
  'chat', 'chats', 'new', 'old', 'all', 'app', 'apps', 'project', 'projects', 'work', 'team', 'bug', 'bugs', 'feature', 'features', 'idea', 'ideas', 'launch', 'misc'])
const stem = w => w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w
const words = text => (String(text || '').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []).map(stem)
const plain = text => words(text).join(' ')
export function subjectFitsChannel(subject, channel, learned = () => false) {
  const key = subjectKey(subject || '')
  if (!key || !channel) return false
  if (learned(channel.id, key)) return true
  if (plain(key) && plain(key) === plain(channel.name)) return true
  const name = new Set(words(channel.name))
  const own = words(key).filter(w => !GENERIC.has(w) && !GENERIC.has(`${w}s`))
  return own.length > 0 && own.every(w => name.has(w))
}
const SPACES_TOOLS_NOTE = 'Own Spaces tools are always available on the wizard MCP gateway: spaces_list, spaces_create(name), spaces_search_threads(query, offset, limit), spaces_add(space_id, thread_ids), spaces_remove(space_id, thread_ids), spaces_delete(space_id). Use their MCP-prefixed names as listed. When asked to fill a new Space, list first, search your own thread metadata (including archived), then add real canonical IDs to the exact requested Space; do not duplicate it. Page while has_more; omit uncertain matches. No other agent’s Spaces/history or preferences-write access is granted. The main agent may also use its wizard-spaces CLI.'
// `agentFiling`: phase 3 above. `scheduledThread(agent, thread)`: a chat the scheduler opened; its filing is the
// job's own channel setting (or Alerts), never the status line, so a cron run never floods a project channel.
export function createSpaceFiling(path, channels = null, { agentFiling = false, scheduledThread = () => false, tags = false } = {}) {
  const phase3 = Boolean(channels && agentFiling)
  const tagging = phase3 && tags === true && typeof channels.tagIfAllowed === 'function'
  const catalogOf = agent => channels
    ? channels.list({ agent }).channels.filter(c => !c.archived && !(phase3 && c.kind === ALERTS_KIND)).slice(0, 30).map(c => {
      const subjects = phase3 && channels.channelSubjects ? channels.channelSubjects(c.id, 5) : []
      return { id: c.id, name: c.name, ...(subjects.length ? { subjects } : {}) }
    })
    : readUiPreferences(path).spaces.filter(s => spaceAgent(s) === agent).slice(0, 30).map(s => ({ id: s.id, name: s.name }))
  // Status lines repeat on every listing: write each (channel, subject) pair at most once per process.
  const learned = new Set()
  const tried = new Set()
  const learnFrom = (agent, thread, subject, known = null) => {
    try {
      const row = known || channels.memberOf?.(agent, thread)
      // Owner-filed only: migrated rows came from old Space filings, many made by the agent, so they would teach a
      // channel the very misfiles this guard exists to stop (Hermes chats in WizardOS Launch).
      if (!row || row.filed_by !== 'owner') return
      const key = `${row.channel_id}\u0000${subject}`
      if (learned.has(key)) return
      if (learned.size > 5000) learned.clear()
      learned.add(key)
      channels.learnSubject(row.channel_id, subject)
    } catch { /* learning is best effort */ }
  }
  return {
    runNote(agent = 'hermes') {
      const catalog = catalogOf(agent)
      // The Spaces tools keep their names (a channel is a Space to them); only the filing and title rules change.
      if (phase3) return `${CHANNEL_INSTRUCTIONS}${tagging ? ` ${TAG_INSTRUCTIONS}` : ''}${agent === 'hermes' ? '' : ` ${SPACES_TOOLS_NOTE} Channels are the Spaces these tools list.`} Your existing channels (data, agent ${JSON.stringify(agent)}): ${JSON.stringify(catalog)}`
      if (agent === 'hermes') return catalog.length ? `Your existing Spaces (data, agent "hermes"): ${JSON.stringify(catalog)}` : ''
      return `${SPACES_TOOLS_NOTE} Your existing Spaces (data, agent ${JSON.stringify(agent)}): ${JSON.stringify(catalog)}`
    },
    apply(agent, thread, status) {
      if (phase3) {
        if (typeof thread !== 'string' || !THREAD_ID.test(thread)) return false
        const subject = subjectKey(status?.subject || '')
        // Learn what belongs in a channel from the subjects of chats the owner put there.
        let member = null
        try { member = channels.memberOf?.(agent, thread) || null } catch { /* unknown: the store decides below */ }
        if (subject && member) learnFrom(agent, thread, subject, member)
        const id = normalizeSpaceId(status?.channel) || normalizeSpaceId(status?.space)
        if (!id) return false
        // Already in a channel: filing never moves a chat, so a list rebuild stops here (issue 584). With Tags on it may
        // add one more tag; a chat that already carries this one stops here after one indexed read.
        if (member && !tagging) return false
        if (member && (member.channel_id === id || channels.hasTag(agent, thread, id))) return false
        try { if (scheduledThread(agent, thread)) return false } catch { return false }
        let target
        try { target = (channels.peek || channels.get)(id) } catch { return false }
        if (target.kind === ALERTS_KIND) return false
        if (!subjectFitsChannel(subject, target, (c, k) => channels.hasChannelSubject(c, k))) return false
        if (tagging) {
          // One try per (chat, tag) per process: a refused tag (the owner removed it) is not asked again on every list.
          const key = `${agent}\u0000${thread}\u0000${id}`
          if (tried.has(key)) return false
          if (tried.size > 5000) tried.clear()
          tried.add(key)
          return channels.tagIfAllowed(agent, thread, id, 'agent')
        }
        return channels.fileIfUnfiled(agent, thread, id, 'agent')
      }
      if (!normalizeSpaceId(status?.space) || typeof thread !== 'string' || !THREAD_ID.test(thread)) return false
      // Same rule in the store: only a thread in none of this agent's channels, never a move.
      if (channels) return channels.fileIfUnfiled(agent, thread, status.space, 'agent')
      // No await between read and atomic replacement: serialized with owner PUTs on this service.
      const spaces = readUiPreferences(path).spaces
      const space = spaces.find(s => s.id === status.space && spaceAgent(s) === agent)
      // One Space per thread: an already-filed thread stays where the owner (or an earlier status) put it.
      if (!space || spaces.some(s => spaceAgent(s) === agent && s.threads.includes(thread)) || space.threads.length >= 500) return false
      space.threads = [...space.threads, thread]
      updateUiPreferences(path, { spaces })
      return true
    },
  }
}
