// Owner-created Spaces are scoped to one agent; legacy collections belong to main.
import { readUiPreferences, updateUiPreferences } from './ui-preferences.mjs'
const SPACE_ID = /^[a-z0-9-]{1,48}(?![\s\S])/u
const THREAD_ID = /^[A-Za-z0-9._:-]{1,180}(?![\s\S])/u
export const normalizeSpaceId = v => typeof v === 'string' && SPACE_ID.test(v) ? v : null
export const spaceAgent = s => s.agent || 'hermes'
export const SPACE_INSTRUCTIONS = 'Space filing is optional: add space (one exact existing Space ID from this agent’s catalogue) to the final WIZARD_STATUS_V1 JSON only when this thread clearly belongs to that Space. Omit it when uncertain or no Space fits; never invent Spaces or IDs. A thread is in one Space at a time: the service files only a thread that is in none of your Spaces yet and never moves one the owner (or an earlier status) already filed. '
// `channels` (issue 440, WIZARD_CHANNEL_STORE=1): the Agent Service channel store replaces ui-preferences spaces.
export function createSpaceFiling(path, channels = null) {
  const catalogOf = agent => channels
    ? channels.list({ agent }).channels.filter(c => !c.archived).slice(0, 30).map(c => ({ id: c.id, name: c.name }))
    : readUiPreferences(path).spaces.filter(s => spaceAgent(s) === agent).slice(0, 30).map(s => ({ id: s.id, name: s.name }))
  return {
    runNote(agent = 'hermes') {
      const catalog = catalogOf(agent)
      if (agent === 'hermes') return catalog.length ? `Your existing Spaces (data, agent "hermes"): ${JSON.stringify(catalog)}` : ''
      return `Own Spaces tools are always available on the wizard MCP gateway: spaces_list, spaces_create(name), spaces_search_threads(query, offset, limit), spaces_add(space_id, thread_ids), spaces_remove(space_id, thread_ids), spaces_delete(space_id). Use their MCP-prefixed names as listed. When asked to fill a new Space, list first, search your own thread metadata (including archived), then add real canonical IDs to the exact requested Space; do not duplicate it. Page while has_more; omit uncertain matches. No other agent’s Spaces/history or preferences-write access is granted. The main agent may also use its wizard-spaces CLI. Your existing Spaces (data, agent ${JSON.stringify(agent)}): ${JSON.stringify(catalog)}`
    },
    apply(agent, thread, status) {
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
