// Owner-created Spaces are scoped to one agent; legacy collections belong to main.
import { readUiPreferences, updateUiPreferences } from './ui-preferences.mjs'
const SPACE_ID = /^[a-z0-9-]{1,48}(?![\s\S])/u
const THREAD_ID = /^[A-Za-z0-9._:-]{1,180}(?![\s\S])/u
export const normalizeSpaceId = v => typeof v === 'string' && SPACE_ID.test(v) ? v : null
export const spaceAgent = s => s.agent || 'hermes'
export const SPACE_INSTRUCTIONS = 'Space filing is optional: add space (one exact existing Space ID from this agent’s catalogue) to the final WIZARD_STATUS_V1 JSON only when this thread clearly belongs to that Space. Omit it when uncertain or no Space fits; never invent Spaces or IDs. A thread is in one Space at a time: the service files only a thread that is in none of your Spaces yet and never moves one the owner (or an earlier status) already filed. '
// Chats channels phase 3 (issue 441, WIZARD_CHANNEL_AGENT_FILING=1 with the channel store, off by default): the
// status line's `channel` field files the thread (`space` stays an alias for one release), the catalogue and
// instructions speak of channels, and `title` becomes the post's short name. Alerts is never in the catalogue:
// it is where the service files agent-started chats, not a place for the agent to file an owner's chat.
export const CHANNEL_INSTRUCTIONS = 'Channels are on for this owner; this replaces the Space and title rules above. Channel filing is optional: add channel (one exact existing channel ID from the catalogue below) to the final WIZARD_STATUS_V1 JSON only when this chat clearly belongs to that channel. Omit it when uncertain or no channel fits; never invent channels or IDs. A chat is in one channel at a time: the service files only a chat that is in no channel yet and never moves one the owner already filed. In channels, title is this chat\u2019s post name: what this one chat is about, in two to five plain words and at most 32 characters ("Desk layout options", "Tokyo hotel booking", "Messenger sync bug"), not the project or app label, since the channel already names the project. It is a label, never a sentence: no leading verb, no trailing period, no emoji. Keep the same title while the chat stays on that topic. Owner-set titles stay fixed.'
const ALERTS_KIND = 'alerts'
const SPACES_TOOLS_NOTE = 'Own Spaces tools are always available on the wizard MCP gateway: spaces_list, spaces_create(name), spaces_search_threads(query, offset, limit), spaces_add(space_id, thread_ids), spaces_remove(space_id, thread_ids), spaces_delete(space_id). Use their MCP-prefixed names as listed. When asked to fill a new Space, list first, search your own thread metadata (including archived), then add real canonical IDs to the exact requested Space; do not duplicate it. Page while has_more; omit uncertain matches. No other agent’s Spaces/history or preferences-write access is granted. The main agent may also use its wizard-spaces CLI.'
// `agentFiling`: phase 3 above. `scheduledThread(agent, thread)`: a chat the scheduler opened; its filing is the
// job's own channel setting (or Alerts), never the status line, so a cron run never floods a project channel.
export function createSpaceFiling(path, channels = null, { agentFiling = false, scheduledThread = () => false } = {}) {
  const phase3 = Boolean(channels && agentFiling)
  const catalogOf = agent => channels
    ? channels.list({ agent }).channels.filter(c => !c.archived && !(phase3 && c.kind === ALERTS_KIND)).slice(0, 30).map(c => ({ id: c.id, name: c.name }))
    : readUiPreferences(path).spaces.filter(s => spaceAgent(s) === agent).slice(0, 30).map(s => ({ id: s.id, name: s.name }))
  return {
    runNote(agent = 'hermes') {
      const catalog = catalogOf(agent)
      // The Spaces tools keep their names (a channel is a Space to them); only the filing and title rules change.
      if (phase3) return `${CHANNEL_INSTRUCTIONS}${agent === 'hermes' ? '' : ` ${SPACES_TOOLS_NOTE} Channels are the Spaces these tools list.`} Your existing channels (data, agent ${JSON.stringify(agent)}): ${JSON.stringify(catalog)}`
      if (agent === 'hermes') return catalog.length ? `Your existing Spaces (data, agent "hermes"): ${JSON.stringify(catalog)}` : ''
      return `${SPACES_TOOLS_NOTE} Your existing Spaces (data, agent ${JSON.stringify(agent)}): ${JSON.stringify(catalog)}`
    },
    apply(agent, thread, status) {
      if (phase3) {
        const id = normalizeSpaceId(status?.channel) || normalizeSpaceId(status?.space)
        if (!id || typeof thread !== 'string' || !THREAD_ID.test(thread)) return false
        try { if (scheduledThread(agent, thread)) return false } catch { return false }
        let target
        try { target = channels.get(id) } catch { return false }
        if (target.kind === ALERTS_KIND) return false
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
