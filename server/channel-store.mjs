// Chats channels (issue 440, phase 2): the Agent Service's own store for channels and thread membership,
// ~/.wizard-os/channels.sqlite. It replaces the `spaces` arrays inside ui-preferences.json, whose size cap
// held roughly 790 memberships and never pruned deleted threads. Behind WIZARD_CHANNEL_STORE=1 (off by default).
//
// A channel is what the shell called a Space. A thread is in at most one channel of its agent: membership is
// keyed by (agent, session_id), because routed agents' thread ids are only unique within that agent.
// ui-preferences.json is never written here, so turning the switch off shows the Spaces as they were.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export const CHANNELS_SCHEMA = 'wizard.channels/1'
export const CHANNEL_ID = /^[a-z0-9-]{1,48}$/
export const CHANNEL_AGENT = /^[a-z0-9][a-z0-9-]{0,47}$/
const THREAD_ID = /^[A-Za-z0-9._:-]{1,180}$/
// Channels per agent. Memberships have no cap: that is the point of this store.
export const CHANNELS_PER_AGENT = 200
// The read-only `spaces` projection served to older shells keeps their limits (ui-preferences validSpace).
export const PROJECTION_SPACES = 50
export const PROJECTION_THREADS = 500
export const ALERTS_ID = 'alerts'
const FILED_BY = new Set(['owner', 'agent', 'migration'])

const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }) }
export const validChannelName = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 60 && !/[\u0000-\u001f\u007f]/u.test(v)
export const validThreadId = v => typeof v === 'string' && THREAD_ID.test(v) && v !== '.' && v !== '..'
const agentOf = v => v === undefined || v === null || v === '' ? 'hermes' : (typeof v === 'string' && CHANNEL_AGENT.test(v) ? v : fail(400, 'invalid_agent'))

export function createChannelStore(path, { now = () => new Date().toISOString() } = {}) {
  mkdirSync(dirname(path), { recursive: true })
  const fresh = !existsSync(path)
  const db = new DatabaseSync(path)
  if (fresh) { try { chmodSync(path, 0o600) } catch { /* best effort */ } }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;
    CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY, agent TEXT NOT NULL, name TEXT NOT NULL, ord INTEGER NOT NULL,
      created_at TEXT NOT NULL, archived TEXT, pinned INTEGER, kind TEXT);
    CREATE TABLE IF NOT EXISTS membership(agent TEXT NOT NULL, session_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      filed_at TEXT NOT NULL, filed_by TEXT NOT NULL CHECK(filed_by IN ('owner','agent','migration')), PRIMARY KEY(agent, session_id));
    CREATE INDEX IF NOT EXISTS membership_channel ON membership(channel_id, filed_at);
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  const q = sql => db.prepare(sql)
  const st = {
    meta: q('SELECT value FROM meta WHERE key=?'), setMeta: q('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
    channel: q('SELECT * FROM channels WHERE id=?'),
    all: q('SELECT c.*, (SELECT COUNT(*) FROM membership m WHERE m.channel_id=c.id) AS count FROM channels c ORDER BY c.ord, c.created_at, c.id'),
    agentCount: q('SELECT COUNT(*) AS n FROM channels WHERE agent=?'),
    maxOrd: q('SELECT COALESCE(MAX(ord),-1) AS n FROM channels WHERE agent=?'),
    maxPin: q('SELECT COALESCE(MAX(pinned),-1) AS n FROM channels WHERE agent=? AND pinned IS NOT NULL'),
    insert: q('INSERT INTO channels(id,agent,name,ord,created_at,archived,pinned,kind) VALUES(?,?,?,?,?,?,?,?)'),
    sameName: q('SELECT * FROM channels WHERE agent=? AND lower(name)=lower(?) ORDER BY ord LIMIT 1'),
    rename: q('UPDATE channels SET name=? WHERE id=?'), archive: q('UPDATE channels SET archived=? WHERE id=?'),
    pin: q('UPDATE channels SET pinned=? WHERE id=?'), ord: q('UPDATE channels SET ord=? WHERE id=?'),
    remove: q('DELETE FROM channels WHERE id=?'), removeMembers: q('DELETE FROM membership WHERE channel_id=?'),
    member: q('SELECT * FROM membership WHERE agent=? AND session_id=?'),
    members: q('SELECT session_id, filed_at, filed_by FROM membership WHERE channel_id=? ORDER BY filed_at, session_id'),
    agentMembers: q('SELECT session_id FROM membership WHERE agent=?'),
    file: q(`INSERT INTO membership(agent,session_id,channel_id,filed_at,filed_by) VALUES(?,?,?,?,?)
      ON CONFLICT(agent,session_id) DO UPDATE SET channel_id=excluded.channel_id, filed_at=excluded.filed_at, filed_by=excluded.filed_by`),
    fileNew: q('INSERT OR IGNORE INTO membership(agent,session_id,channel_id,filed_at,filed_by) VALUES(?,?,?,?,?)'),
    unfile: q('DELETE FROM membership WHERE agent=? AND session_id=?'),
  }
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const v = fn(); db.exec('COMMIT'); return v } catch (e) { try { db.exec('ROLLBACK') } catch {} throw e } }
  const view = r => ({ id: r.id, agent: r.agent, name: r.name, order: r.ord, createdAt: r.created_at, archived: !!r.archived,
    ...(r.archived ? { archivedAt: r.archived } : {}), pinned: r.pinned !== null && r.pinned !== undefined, ...(r.pinned !== null && r.pinned !== undefined ? { pinOrder: r.pinned } : {}),
    ...(r.kind ? { kind: r.kind } : {}), ...(r.count !== undefined ? { count: Number(r.count) } : {}) })
  const mustChannel = id => { const r = typeof id === 'string' && CHANNEL_ID.test(id) ? st.channel.get(id) : null; return r || fail(404, 'channel_not_found') }
  const meta = key => st.meta.get(key)?.value ?? null
  const sort = () => meta('sort') === 'za' ? 'za' : 'az'
  const insertChannel = ({ id, agent, name, ord, createdAt, archived = null, pinned = null, kind = null }) => {
    if (st.agentCount.get(agent).n >= CHANNELS_PER_AGENT) fail(409, 'channels_limit')
    st.insert.run(id, agent, name, ord, createdAt, archived, pinned, kind)
  }
  const freeId = base => { let id = base; while (st.channel.get(id)) id = `${base}-${randomUUID().slice(0, 8)}`; return id }

  const store = {
    path,
    sort,
    list({ agent } = {}) {
      const rows = st.all.all().filter(r => !agent || r.agent === agent).map(view)
      return { schema: CHANNELS_SCHEMA, sort: sort(), migratedAt: meta('spaces_migrated'), channels: rows }
    },
    get: id => view({ ...mustChannel(id), count: st.members.all(id).length }),
    // `id` (an old shell's Space id) is a no-op when that channel exists, like ui-preferences' spaces add.
    create({ name, agent, reuseName = false, id: wanted } = {}) {
      if (!validChannelName(name)) fail(400, 'invalid_name')
      if (wanted !== undefined && !(typeof wanted === 'string' && CHANNEL_ID.test(wanted))) fail(400, 'invalid_channel')
      const owner = agentOf(agent)
      return tx(() => {
        if (wanted && st.channel.get(wanted)) return store.get(wanted)
        if (reuseName) { const same = st.sameName.get(owner, name.trim()); if (same) return store.get(same.id) }
        const id = wanted || freeId(`channel-${randomUUID()}`)
        insertChannel({ id, agent: owner, name: name.trim(), ord: st.maxOrd.get(owner).n + 1, createdAt: now() })
        return store.get(id)
      })
    },
    // {name?, archived?: boolean, pinned?: boolean}. Pinning appends to the agent's pin order.
    update(id, change = {}) {
      return tx(() => {
        const r = mustChannel(id)
        if (Object.hasOwn(change, 'name')) { if (!validChannelName(change.name)) fail(400, 'invalid_name'); st.rename.run(change.name.trim(), id) }
        if (Object.hasOwn(change, 'archived')) {
          if (typeof change.archived !== 'boolean') fail(400, 'invalid_archived')
          if (change.archived !== !!r.archived) st.archive.run(change.archived ? now() : null, id)
        }
        if (Object.hasOwn(change, 'pinned')) {
          if (typeof change.pinned !== 'boolean') fail(400, 'invalid_pinned')
          if (change.pinned && r.pinned === null) st.pin.run(st.maxPin.get(r.agent).n + 1, id)
          if (!change.pinned) st.pin.run(null, id)
        }
        return store.get(id)
      })
    },
    // These first, in this order; the agent's other channels keep their relative order after them.
    reorder(ids, field = 'order') {
      if (!Array.isArray(ids) || !ids.length || ids.length > CHANNELS_PER_AGENT || new Set(ids).size !== ids.length) fail(400, 'invalid_order')
      return tx(() => {
        const rows = ids.map(mustChannel), agent = rows[0].agent
        if (rows.some(r => r.agent !== agent)) fail(400, 'mixed_agents')
        const rest = st.all.all().filter(r => r.agent === agent && !ids.includes(r.id) && (field === 'order' || r.pinned !== null))
          .sort((a, b) => field === 'order' ? 0 : a.pinned - b.pinned)
        ;[...rows, ...rest].forEach((r, i) => (field === 'order' ? st.ord : st.pin).run(i, r.id))
        return store.list({ agent })
      })
    },
    setSort(value) { if (value !== 'az' && value !== 'za') fail(400, 'invalid_sort'); st.setMeta.run('sort', value); return sort() },
    // Owner action only (an old shell's "remove Space", spaces_delete). Never deletes threads.
    remove(id) { return tx(() => { mustChannel(id); st.removeMembers.run(id); st.remove.run(id); return { deleted: id } }) },
    channelOf(agent, sessionId) { return validThreadId(sessionId) ? st.member.get(agentOf(agent), sessionId)?.channel_id || '' : '' },
    members(id) { mustChannel(id); return st.members.all(id).map(r => ({ sessionId: r.session_id, filedAt: r.filed_at, filedBy: r.filed_by })) },
    memberSet(id) { const r = typeof id === 'string' && CHANNEL_ID.test(id) ? st.channel.get(id) : null; return r ? { agent: r.agent, ids: new Set(st.members.all(id).map(m => m.session_id)) } : null },
    // The atomic move: into channelId (dropping any other channel of the same agent), or out of every channel (null).
    move({ sessionId, channelId, agent, filedBy = 'owner' }) {
      if (!validThreadId(sessionId)) fail(400, 'invalid_session')
      if (!FILED_BY.has(filedBy)) fail(400, 'invalid_filed_by')
      return tx(() => {
        if (channelId === null) { const owner = agentOf(agent); st.unfile.run(owner, sessionId); return { sessionId, agent: owner, channel: null } }
        const r = mustChannel(channelId)
        if (agent !== undefined && agent !== null && agent !== '' && agentOf(agent) !== r.agent) fail(409, 'agent_mismatch')
        const had = st.member.get(r.agent, sessionId)
        if (had?.channel_id !== r.id) st.file.run(r.agent, sessionId, r.id, now(), filedBy)
        return { sessionId, agent: r.agent, channel: r.id }
      })
    },
    // Agent filing (status line `space`): only a thread in none of that agent's channels, never a move.
    fileIfUnfiled(agent, sessionId, channelId, filedBy = 'agent') {
      if (!validThreadId(sessionId) || typeof channelId !== 'string' || !CHANNEL_ID.test(channelId)) return false
      return tx(() => {
        const r = st.channel.get(channelId)
        if (!r || r.agent !== agentOf(agent) || r.archived) return false
        return st.fileNew.run(r.agent, sessionId, r.id, now(), filedBy).changes === 1
      })
    },
    // A deleted thread leaves its channel.
    forget(agent, sessionId) { if (validThreadId(sessionId)) st.unfile.run(agentOf(agent), sessionId) },
    // exists(id) -> true | false | null (unknown: kept). Returns how many memberships were dropped.
    prune(agent, exists) {
      const owner = agentOf(agent), gone = st.agentMembers.all(owner).map(r => r.session_id).filter(id => exists(id) === false)
      if (gone.length) tx(() => { for (const id of gone) st.unfile.run(owner, id) })
      return gone.length
    },
    // First boot with the switch on: copy ui-preferences `spaces` once. Ids, names, agents, order and
    // creation times are kept; a thread listed in two Spaces of one agent (legacy data) stays in the first.
    migrateSpaces(spaces) {
      if (meta('spaces_migrated')) return { migrated: false, channels: 0, memberships: 0, duplicates: 0 }
      return tx(() => {
        if (meta('spaces_migrated')) return { migrated: false, channels: 0, memberships: 0, duplicates: 0 }
        let channels = 0, memberships = 0, duplicates = 0
        const at = now()
        ;(Array.isArray(spaces) ? spaces : []).forEach((s, i) => {
          const agent = agentOf(s.agent)
          if (!st.channel.get(s.id)) { insertChannel({ id: s.id, agent, name: s.name, ord: i, createdAt: s.createdAt }); channels++ }
          const target = st.channel.get(s.id)
          if (target.agent !== agent) return
          for (const thread of s.threads) {
            if (st.fileNew.run(agent, thread, s.id, at, 'migration').changes === 1) memberships++
            else if (st.member.get(agent, thread)?.channel_id !== s.id) duplicates++
          }
        })
        st.setMeta.run('spaces_migrated', at)
        return { migrated: true, channels, memberships, duplicates }
      })
    },
    // The default Alerts channel (James, 10 Nov 2026): pinned at the top, renamable and archivable, never
    // re-created once seeded, so an owner's archive or delete sticks and a second migration adds no second one.
    seedAlerts() {
      if (meta('alerts_seeded')) return null
      return tx(() => {
        if (meta('alerts_seeded')) return null
        const id = freeId(ALERTS_ID)
        const minOrd = st.all.all().filter(r => r.agent === 'hermes').reduce((m, r) => Math.min(m, r.ord), 0)
        for (const r of st.all.all().filter(r => r.agent === 'hermes' && r.pinned !== null)) st.pin.run(r.pinned + 1, r.id)
        insertChannel({ id, agent: 'hermes', name: 'Alerts', ord: minOrd - 1, createdAt: now(), pinned: 0, kind: 'alerts' })
        st.setMeta.run('alerts_seeded', id)
        return id
      })
    },
    // What older shells read as `spaces` (read-only). Archived channels are left out; each keeps its
    // newest-filed 500 threads so the projection always passes the shell's Space validation.
    spacesProjection() {
      return st.all.all().filter(r => !r.archived).slice(0, PROJECTION_SPACES).map(r => {
        const threads = st.members.all(r.id).map(m => m.session_id)
        return { id: r.id, name: r.name, ...(r.agent === 'hermes' ? {} : { agent: r.agent }), threads: threads.slice(-PROJECTION_THREADS), createdAt: r.created_at }
      })
    },
    close() { try { db.close() } catch { /* already closed */ } },
  }
  return store
}

// HTTP: /wizard/v1/channels (GET ?agent=, POST {name, agent?}, PATCH one of {id, name?, archived?, pinned?} |
// {order:[ids]} | {pinOrder:[ids]} | {sort:'az'|'za'}) and /wizard/v1/channels/membership (GET ?channel= |
// ?sessionId=&agent=, PUT {sessionId, channelId|null, agent?}). Unknown keys are a 400, like ui-preferences.
export function channelRequest(store, method, membership, params, body) {
  const only = (...keys) => { if (Object.keys(body).some(k => !keys.includes(k))) fail(400, 'invalid_request') }
  if (membership) {
    if (method === 'GET') {
      if (params.has('channel')) return { channel: params.get('channel'), members: store.members(params.get('channel')) }
      const sessionId = params.get('sessionId')
      if (!validThreadId(sessionId)) fail(400, 'invalid_session')
      const agent = agentOf(params.get('agent'))
      return { sessionId, agent, channel: store.channelOf(agent, sessionId) || null }
    }
    only('sessionId', 'channelId', 'agent')
    if (!Object.hasOwn(body, 'channelId') || !(body.channelId === null || typeof body.channelId === 'string')) fail(400, 'invalid_channel')
    return store.move({ sessionId: body.sessionId, channelId: body.channelId, agent: body.agent, filedBy: 'owner' })
  }
  if (method === 'GET') {
    const agent = params.get('agent')
    if (agent !== null && !CHANNEL_AGENT.test(agent)) fail(400, 'invalid_agent')
    return store.list(agent ? { agent } : {})
  }
  if (method === 'POST') { only('name', 'agent'); return store.create({ name: body.name, agent: body.agent }) }
  const keys = Object.keys(body)
  if (keys.length === 1 && keys[0] === 'sort') { store.setSort(body.sort); return store.list() }
  if (keys.length === 1 && keys[0] === 'order') return store.reorder(body.order, 'order')
  if (keys.length === 1 && keys[0] === 'pinOrder') return store.reorder(body.pinOrder, 'pin')
  only('id', 'name', 'archived', 'pinned')
  if (keys.length < 2) fail(400, 'invalid_request')
  const { id, ...change } = body
  return store.update(id, change)
}
