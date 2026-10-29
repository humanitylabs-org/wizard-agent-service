// Always-on gateway capability. Identity is supplied by the authenticated bridge, never tool arguments.
import { randomUUID } from 'node:crypto'
import { readUiPreferences, updateUiPreferences } from './ui-preferences.mjs'
import { spaceAgent, normalizeSpaceId } from './thread-spaces.mjs'
const threadId = /^[A-Za-z0-9._:-]{1,180}(?![\s\S])/u
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const sid = { type: 'string', description: 'Exact existing own Space ID.' }
const ids = { type: 'array', items: { type: 'string' }, maxItems: 500 }
const definitions = [
  ['spaces_list', 'List only your own Spaces (id, name, count).', schema()],
  ['spaces_create', 'Create an empty Space for yourself when the owner asks. Reuses an existing same-name Space.', schema({ name: { type: 'string', minLength: 1, maxLength: 60 } }, ['name'])],
  ...['add', 'remove'].map(op => [`spaces_${op}`, `${op === 'add' ? 'Add' : 'Remove'} your own canonical thread IDs ${op === 'add' ? 'to' : 'from'} your own Space. Idempotent.`, schema({ space_id: sid, thread_ids: ids }, ['space_id', 'thread_ids'])]),
  ['spaces_delete', 'Delete your own Space only when asked; never deletes threads.', schema({ space_id: sid }, ['space_id'])],
  ['spaces_search_threads', 'Search your own thread metadata (IDs, titles, subjects), including archived threads. No message content or other agents. Page with offset; empty query lists candidates.', schema({ query: { type: 'string', maxLength: 200 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } })],
].map(([name, description, inputSchema]) => ({ name, description: `[Wizard Spaces] ${description}`, inputSchema }))
const fail = message => { throw new Error(message) }
const summary = s => ({ id: s.id, name: s.name, count: s.threads.length })
export function createSpacesTools({ path, loadThreads, threadExists, agentExists = () => true }) {
  return {
    list: () => definitions,
    async call(name, args, agent) {
      const def = definitions.find(t => t.name === name)
      if (!def) return null
      try {
        if (!agent || !agentExists(agent)) fail('not_found')
        if (!args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).some(k => !Object.hasOwn(def.inputSchema.properties, k)) || def.inputSchema.required.some(k => !Object.hasOwn(args, k))) fail('invalid_arguments')
        let result
        if (name === 'spaces_search_threads') {
          const { query = '', offset = 0, limit = 100 } = args
          if (typeof query !== 'string' || query.length > 200 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('invalid_arguments')
          const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
          const rows = await loadThreads(agent)
          const seen = new Set()
          const matches = rows.filter(row => {
            if (!row || typeof row.id !== 'string' || !threadId.test(row.id) || seen.has(row.id) || row.hidden || row.parent_session_id || row.source === 'tool') return false
            seen.add(row.id); return true
          }).map(row => ({ id: row.id, title: String(row.title || row.name || ''), subject: String(row.wizard_attention?.subject || row.subject || ''), archived: Boolean(row.archived) }))
            .filter(row => words.every(word => `${row.id} ${row.title} ${row.subject}`.toLowerCase().includes(word)))
          result = { threads: matches.slice(offset, offset + limit), total: matches.length, offset, has_more: offset + limit < matches.length }
        } else if (name === 'spaces_list') {
          result = { spaces: readUiPreferences(path).spaces.filter(s => spaceAgent(s) === agent).map(summary) }
        } else {
          if (name === 'spaces_create') {
            if (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 60 || /[\u0000-\u001f\u007f]/u.test(args.name)) fail('invalid_arguments')
          } else {
            if (!normalizeSpaceId(args.space_id)) fail('not_found')
            // Refuse a foreign target before history lookup (same answer as missing).
            if (!readUiPreferences(path).spaces.some(s => s.id === args.space_id && spaceAgent(s) === agent)) fail('not_found')
            if (name !== 'spaces_delete') {
              if (!Array.isArray(args.thread_ids) || args.thread_ids.length > 500 || args.thread_ids.some(id => typeof id !== 'string' || !threadId.test(id))) fail('invalid_arguments')
              for (const id of new Set(args.thread_ids)) if (!await threadExists(agent, id)) fail('thread_not_found')
            }
          }
          // No await from this fresh read through atomic rename. Owner PUTs and status filing share this process.
          let spaces = readUiPreferences(path).spaces
          let space
          if (name === 'spaces_create') {
            space = spaces.find(s => spaceAgent(s) === agent && s.name.toLowerCase() === args.name.trim().toLowerCase())
            if (!space) {
              if (spaces.length >= 50) fail('spaces_limit')
              space = { id: `space-${randomUUID()}`, name: args.name.trim(), agent, threads: [], createdAt: new Date().toISOString() }
              spaces.push(space)
            }
          } else {
            space = spaces.find(s => s.id === args.space_id && spaceAgent(s) === agent)
            if (!space) fail('not_found') // may have been deleted while checking thread ownership
            if (name === 'spaces_delete') spaces = spaces.filter(s => s !== space)
            else if (name === 'spaces_add') {
              const threads = [...new Set([...space.threads, ...args.thread_ids])]
              if (threads.length > 500) fail('threads_limit')
              space.threads = threads
            } else space.threads = space.threads.filter(id => !args.thread_ids.includes(id))
          }
          const saved = updateUiPreferences(path, { spaces })
          result = name === 'spaces_delete' ? { deleted: space.id } : { space: summary(saved.spaces.find(s => s.id === space.id)) }
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      } catch (error) {
        // Never echo arguments, runtime exceptions, titles or foreign metadata in errors.
        const allowed = new Set(['not_found', 'thread_not_found', 'invalid_arguments', 'spaces_limit', 'threads_limit'])
        return { isError: true, content: [{ type: 'text', text: allowed.has(error.message) ? error.message : 'spaces_unavailable' }] }
      }
    },
  }
}
