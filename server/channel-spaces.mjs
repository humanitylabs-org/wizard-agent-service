// Issue 440: with the channel store on, ui-preferences `spaces` is a projection of channels.sqlite.
// GET serves the projection. A PUT's `spaces` is ignored (read-only for older shells' full snapshots,
// which could otherwise erase memberships beyond the projection). PATCH item operations on spaces name
// exactly one change each, so they are applied to the store; every other key still goes to the file.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { readUiPreferences, patchUiPreferences, updateUiPreferences, applyUiPreferenceOps, sanitizeUiPreferences, UI_PREFERENCES_MAX_BYTES } from './ui-preferences.mjs'

const SPACE_KEY = /^spaces\/([a-z0-9-]{1,48})\/(threads|name)$/
const isSpaceOp = o => !!o && typeof o === 'object' && typeof o.key === 'string' && (o.key === 'spaces' || SPACE_KEY.test(o.key))
const invalid = () => { throw Object.assign(new Error('invalid_preferences'), { status: 400 }) }
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

// The Spaces to copy on first boot, or null when the file exists but can't be trusted yet (unparseable,
// oversized, or a `spaces` value this version rejects): the copy waits instead of recording zero Spaces.
export function spacesForMigration(path) {
  if (!existsSync(path)) return []
  let stored
  try { if (statSync(path).size > UI_PREFERENCES_MAX_BYTES) return null; stored = JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
  if (!isObject(stored)) return null
  if (!Object.hasOwn(stored, 'spaces')) return []
  const spaces = sanitizeUiPreferences({ spaces: stored.spaces }).spaces
  return JSON.stringify(spaces) === JSON.stringify(stored.spaces) ? spaces : null
}

export function readWithChannels(path, store) {
  return { ...readUiPreferences(path), spaces: store.spacesProjection() }
}

export function putWithChannels(path, store, patch) {
  if (!isObject(patch)) invalid()
  const { spaces, ...rest } = patch
  if (spaces !== undefined) sanitizeCheck(spaces)
  if (Object.keys(rest).length) updateUiPreferences(path, rest)
  return readWithChannels(path, store)
}

// The same validation as before (malformed space values are still a 400), without writing them.
function sanitizeCheck(spaces) {
  if (JSON.stringify(sanitizeUiPreferences({ spaces }).spaces) !== JSON.stringify(spaces)) invalid()
}

export function patchWithChannels(path, store, body) {
  if (!isObject(body) || Object.keys(body).some(k => k !== 'ops') || !Array.isArray(body.ops) || !body.ops.length || body.ops.length > 100) invalid()
  const spaceOps = body.ops.filter(isSpaceOp), other = body.ops.filter(o => !isSpaceOp(o))
  // Validate every space operation against the current projection first, exactly as the file path does.
  if (spaceOps.length) applyUiPreferenceOps({ ...readUiPreferences(path), spaces: store.spacesProjection() }, spaceOps)
  if (other.length) patchUiPreferences(path, { ops: other })
  for (const o of spaceOps) applySpaceOp(store, o)
  return readWithChannels(path, store)
}

function applySpaceOp(store, { op, key, item }) {
  const exists = id => { try { store.get(id); return true } catch { return false } }
  if (key === 'spaces') {
    if (op === 'add') {
      if (exists(item.id)) return
      const made = store.create({ id: item.id, name: item.name, agent: item.agent })
      for (const thread of item.threads) store.move({ sessionId: thread, channelId: made.id })
    } else if (op === 'remove' && exists(item)) store.remove(item)
    return
  }
  const [, id, field] = SPACE_KEY.exec(key)
  if (!exists(id)) return
  if (field === 'name') { store.update(id, { name: item }); return }
  const channel = store.get(id)
  if (op === 'add') store.move({ sessionId: item, channelId: id })
  else if (store.channelOf(channel.agent, item) === id) store.move({ sessionId: item, channelId: null, agent: channel.agent })
}
