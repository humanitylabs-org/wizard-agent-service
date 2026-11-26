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
// Daily channel (issue 527): one per agent, one real thread per day (daily-channel.mjs).
export const DAILY_ID = 'daily'
export const DAILY_DAY_STARTS_AT = '05:00'
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/
export const CHANNEL_SUBJECTS_MAX = 12
const FILED_BY = new Set(['owner', 'agent', 'migration'])
// Read watermarks (issue 471): the shell's keys are `general`, `general|<agent>` and `<agent>|<channel id>`.
export const CHANNEL_READS_SCHEMA = 'wizard.channel-reads/1'
export const READ_MARKS_MAX = 1000
export const READ_MARKS_PER_WRITE = 300
const READ_MARK_SKEW_MS = 60_000
const READ_KEY = /^(?:general(?:\|[a-z0-9][a-z0-9-]{0,47})?|[a-z0-9][a-z0-9-]{0,47}\|[a-z0-9-]{1,48})$/
export const validReadKey = v => typeof v === 'string' && READ_KEY.test(v)

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
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS read_marks(key TEXT PRIMARY KEY, at INTEGER NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS read_marks_at ON read_marks(at);
    CREATE TABLE IF NOT EXISTS owner_unfiled(agent TEXT NOT NULL, session_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(agent, session_id));
    CREATE TABLE IF NOT EXISTS channel_subjects(channel_id TEXT NOT NULL, subject TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(channel_id, subject));
    CREATE TABLE IF NOT EXISTS daily_days(channel_id TEXT NOT NULL, day TEXT NOT NULL, agent TEXT NOT NULL, session_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(channel_id, day));
    CREATE INDEX IF NOT EXISTS daily_days_session ON daily_days(agent, session_id);
    CREATE TABLE IF NOT EXISTS tags(agent TEXT NOT NULL, session_id TEXT NOT NULL, channel_id TEXT NOT NULL, tagged_at TEXT NOT NULL,
      tagged_by TEXT NOT NULL CHECK(tagged_by IN ('owner','agent','migration')), PRIMARY KEY(agent, session_id, channel_id));
    CREATE INDEX IF NOT EXISTS tags_channel ON tags(channel_id, tagged_at);
    CREATE TABLE IF NOT EXISTS tag_removed(agent TEXT NOT NULL, session_id TEXT NOT NULL, channel_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(agent, session_id, channel_id));`)
  const q = sql => db.prepare(sql)
  // Issue 520 follow-up: the first build also learned subjects from migration-filed chats. Drop what it learned once;
  // owner-filed chats teach their subjects again on their next status line.
  if (!db.prepare("SELECT 1 AS y FROM meta WHERE key='subjects_owner_only'").get()) {
    db.exec("DELETE FROM channel_subjects; INSERT INTO meta(key,value) VALUES('subjects_owner_only','1') ON CONFLICT(key) DO NOTHING")
  }
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
    agentTombstones: q('SELECT session_id FROM owner_unfiled WHERE agent=?'),
    file: q(`INSERT INTO membership(agent,session_id,channel_id,filed_at,filed_by) VALUES(?,?,?,?,?)
      ON CONFLICT(agent,session_id) DO UPDATE SET channel_id=excluded.channel_id, filed_at=excluded.filed_at, filed_by=excluded.filed_by`),
    fileNew: q('INSERT OR IGNORE INTO membership(agent,session_id,channel_id,filed_at,filed_by) VALUES(?,?,?,?,?)'),
    unfile: q('DELETE FROM membership WHERE agent=? AND session_id=?'),
    // Issue 520: a chat the owner took out of its channel stays out; agent and scheduler filing refuse it.
    tombstone: q('INSERT INTO owner_unfiled(agent,session_id,at) VALUES(?,?,?) ON CONFLICT(agent,session_id) DO UPDATE SET at=excluded.at'),
    untombstone: q('DELETE FROM owner_unfiled WHERE agent=? AND session_id=?'),
    tombstoned: q('SELECT 1 AS y FROM owner_unfiled WHERE agent=? AND session_id=?'),
    // Issue 520: subjects of chats the owner (or the Spaces migration) put in a channel: what belongs there.
    subjects: q('SELECT subject FROM channel_subjects WHERE channel_id=? ORDER BY at DESC, subject LIMIT ?'),
    hasSubject: q('SELECT 1 AS y FROM channel_subjects WHERE channel_id=? AND subject=?'),
    learn: q('INSERT INTO channel_subjects(channel_id,subject,at) VALUES(?,?,?) ON CONFLICT(channel_id,subject) DO UPDATE SET at=excluded.at'),
    subjectCount: q('SELECT COUNT(*) AS n FROM channel_subjects WHERE channel_id=?'),
    subjectPrune: q('DELETE FROM channel_subjects WHERE channel_id=? AND subject IN (SELECT subject FROM channel_subjects WHERE channel_id=? ORDER BY at ASC, subject LIMIT ?)'),
    removeSubjects: q('DELETE FROM channel_subjects WHERE channel_id=?'),
    reads: q('SELECT key, at FROM read_marks ORDER BY at DESC, key LIMIT ?'),
    readMark: q(`INSERT INTO read_marks(key,at,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET at=excluded.at, updated_at=excluded.updated_at WHERE excluded.at > read_marks.at`),
    readCount: q('SELECT COUNT(*) AS n FROM read_marks'),
    readPrune: q('DELETE FROM read_marks WHERE key IN (SELECT key FROM read_marks ORDER BY at ASC, key LIMIT ?)'),
    // Daily channel (issue 527).
    setKind: q('UPDATE channels SET kind=? WHERE id=?'),
    dailyOf: q("SELECT * FROM channels WHERE agent=? AND kind='daily' ORDER BY ord, created_at, id"),
    day: q('SELECT * FROM daily_days WHERE channel_id=? AND day=?'),
    addDay: q('INSERT OR IGNORE INTO daily_days(channel_id,day,agent,session_id,created_at) VALUES(?,?,?,?,?)'),
    daysBefore: q('SELECT day, session_id FROM daily_days WHERE channel_id=? AND day<? ORDER BY day DESC LIMIT ?'),
    dayOfSession: q('SELECT * FROM daily_days WHERE agent=? AND session_id=? ORDER BY day DESC LIMIT 1'),
    removeDays: q('DELETE FROM daily_days WHERE channel_id=?'),
    forgetDay: q('DELETE FROM daily_days WHERE agent=? AND session_id=?'),
    // Tags (issue 608): a chat can carry several of its agent's channels. `membership` keeps the primary tag (the first
    // one, then the oldest left), so everything that knows one channel per chat (Daily, filing, older shells) still works.
    tagsOf: q('SELECT channel_id, tagged_at, tagged_by FROM tags WHERE agent=? AND session_id=? ORDER BY tagged_at, rowid'),
    tag: q('SELECT 1 AS y FROM tags WHERE agent=? AND session_id=? AND channel_id=?'),
    addTag: q('INSERT OR IGNORE INTO tags(agent,session_id,channel_id,tagged_at,tagged_by) VALUES(?,?,?,?,?)'),
    dropTag: q('DELETE FROM tags WHERE agent=? AND session_id=? AND channel_id=?'),
    dropTags: q('DELETE FROM tags WHERE agent=? AND session_id=?'),
    tagMembers: q(`SELECT session_id FROM tags WHERE channel_id=? UNION SELECT session_id FROM membership WHERE channel_id=?`),
    channelTags: q('SELECT agent, session_id FROM tags WHERE channel_id=?'),
    removeChannelTags: q('DELETE FROM tags WHERE channel_id=?'),
    tagCount: q('SELECT COUNT(*) AS n FROM (SELECT session_id FROM tags WHERE channel_id=? UNION SELECT session_id FROM membership WHERE channel_id=?)'),
    markRemoved: q('INSERT INTO tag_removed(agent,session_id,channel_id,at) VALUES(?,?,?,?) ON CONFLICT(agent,session_id,channel_id) DO UPDATE SET at=excluded.at'),
    unmarkRemoved: q('DELETE FROM tag_removed WHERE agent=? AND session_id=? AND channel_id=?'),
    removed: q('SELECT 1 AS y FROM tag_removed WHERE agent=? AND session_id=? AND channel_id=?'),
    forgetRemoved: q('DELETE FROM tag_removed WHERE agent=? AND session_id=?'),
    removeChannelRemoved: q('DELETE FROM tag_removed WHERE channel_id=?'),
    copyTags: q("INSERT OR IGNORE INTO tags(agent,session_id,channel_id,tagged_at,tagged_by) SELECT agent, session_id, channel_id, filed_at, filed_by FROM membership"),
  }
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const v = fn(); db.exec('COMMIT'); return v } catch (e) { try { db.exec('ROLLBACK') } catch {} throw e } }
  // Tags (issue 608): every one-channel write keeps the tag table in step (called inside a transaction), so the two never
  // disagree whichever way the switch stood: filing adds the tag, a move replaces the primary tag, unfiling drops all.
  // Until Tags were first on (tags_migrated) the table is empty and nothing writes it: the migration copies membership
  // then, so a box that never turns Tags on pays nothing.
  let tagsLive = Boolean(st.meta.get('tags_migrated'))
  const tagFiled = (agent, sessionId, channelId, at, by) => { if (tagsLive) st.addTag.run(agent, sessionId, channelId, at, by) }
  const tagMoved = (agent, sessionId, from, to, at, by) => { if (!tagsLive) return; if (from && from !== to) st.dropTag.run(agent, sessionId, from); tagFiled(agent, sessionId, to, at, by) }
  const tagsGone = (agent, sessionId) => { if (tagsLive) { st.dropTags.run(agent, sessionId); st.forgetRemoved.run(agent, sessionId) } }
  // The chat's tags: the primary (membership) first, then the others oldest first.
  const tagIds = (agent, sessionId) => {
    const primary = st.member.get(agent, sessionId)?.channel_id || ''
    const rest = st.tagsOf.all(agent, sessionId).map(r => r.channel_id).filter(id => id !== primary)
    return primary ? [primary, ...rest] : rest
  }
  // After a tag left: the primary is the oldest tag still on the chat, or none (General).
  const promote = (agent, sessionId) => {
    const next = st.tagsOf.all(agent, sessionId).find(r => st.channel.get(r.channel_id))
    if (next) st.file.run(agent, sessionId, next.channel_id, next.tagged_at, next.tagged_by)
    else st.unfile.run(agent, sessionId)
    return next?.channel_id || ''
  }
  const view = r => ({ id: r.id, agent: r.agent, name: r.name, order: r.ord, createdAt: r.created_at, archived: !!r.archived,
    ...(r.archived ? { archivedAt: r.archived } : {}), pinned: r.pinned !== null && r.pinned !== undefined, ...(r.pinned !== null && r.pinned !== undefined ? { pinOrder: r.pinned } : {}),
    ...(r.kind ? { kind: r.kind } : {}), ...(r.kind === 'daily' ? { dayStartsAt: DAILY_DAY_STARTS_AT } : {}), ...(r.count !== undefined ? { count: Number(r.count) } : {}) })
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
    list({ agent, tags = false } = {}) {
      const rows = st.all.all().filter(r => !agent || r.agent === agent).map(r => view(tags ? { ...r, count: st.tagCount.get(r.id, r.id).n } : r))
      return { schema: CHANNELS_SCHEMA, sort: sort(), migratedAt: meta('spaces_migrated'), channels: rows, ...(tags ? { tags: true } : {}) }
    },
    get: id => view({ ...mustChannel(id), count: st.members.all(id).length }),
    // The channel without its member count: per-row checks on a list build must not read every member (issue 584).
    peek: id => view(mustChannel(id)),
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
        // Daily channel (issue 527): kind 'daily' makes this the agent's one daily channel (an earlier one becomes a
        // plain channel, its day threads kept); null turns it back. Alerts stays Alerts.
        if (Object.hasOwn(change, 'kind')) {
          if (change.kind !== 'daily' && change.kind !== null) fail(400, 'invalid_kind')
          if (r.kind === 'alerts') fail(409, 'alerts_channel')
          if (change.kind === 'daily' && r.kind !== 'daily') {
            for (const other of st.dailyOf.all(r.agent)) st.setKind.run(null, other.id)
            st.setKind.run('daily', id)
          }
          if (change.kind === null && r.kind === 'daily') st.setKind.run(null, id)
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
    remove(id) {
      return tx(() => {
        mustChannel(id)
        // A chat whose primary tag this was keeps its other tags: the oldest becomes its primary (issue 608).
        const tagged = st.channelTags.all(id)
        st.removeMembers.run(id); st.removeChannelTags.run(id); st.removeChannelRemoved.run(id)
        for (const r of tagged) if (!st.member.get(r.agent, r.session_id)) promote(r.agent, r.session_id)
        st.removeSubjects.run(id); st.removeDays.run(id); st.remove.run(id); return { deleted: id }
      })
    },
    // The membership row ({channel_id, filed_by}) or null.
    memberOf(agent, sessionId) { return validThreadId(sessionId) ? st.member.get(agentOf(agent), sessionId) || null : null },
    ownerUnfiled(agent, sessionId) { return validThreadId(sessionId) ? Boolean(st.tombstoned.get(agentOf(agent), sessionId)) : false },
    // Subject keys (lowercase) known to belong in a channel, newest first.
    channelSubjects(id, limit = CHANNEL_SUBJECTS_MAX) { return typeof id === 'string' && CHANNEL_ID.test(id) ? st.subjects.all(id, limit).map(r => r.subject) : [] },
    hasChannelSubject(id, subject) { return typeof id === 'string' && typeof subject === 'string' && Boolean(st.hasSubject.get(id, subject)) },
    learnSubject(id, subject) {
      if (typeof id !== 'string' || !CHANNEL_ID.test(id) || typeof subject !== 'string' || !subject || subject.length > 40) return false
      return tx(() => {
        if (!st.channel.get(id)) return false
        st.learn.run(id, subject, now())
        const over = st.subjectCount.get(id).n - CHANNEL_SUBJECTS_MAX
        if (over > 0) st.subjectPrune.run(id, id, over)
        return true
      })
    },
    channelOf(agent, sessionId) { return validThreadId(sessionId) ? st.member.get(agentOf(agent), sessionId)?.channel_id || '' : '' },
    members(id) { mustChannel(id); return st.members.all(id).map(r => ({ sessionId: r.session_id, filedAt: r.filed_at, filedBy: r.filed_by })) },
    // `tags` (issue 608): every chat carrying this channel as one of its tags, not only those filed in it.
    memberSet(id, { tags = false } = {}) {
      const r = typeof id === 'string' && CHANNEL_ID.test(id) ? st.channel.get(id) : null
      if (!r) return null
      return { agent: r.agent, ids: new Set((tags ? st.tagMembers.all(id, id) : st.members.all(id)).map(m => m.session_id)) }
    },
    // The atomic move: into channelId (dropping any other channel of the same agent), or out of every channel (null).
    move({ sessionId, channelId, agent, filedBy = 'owner' }) {
      if (!validThreadId(sessionId)) fail(400, 'invalid_session')
      if (!FILED_BY.has(filedBy)) fail(400, 'invalid_filed_by')
      return tx(() => {
        if (channelId === null) {
          const owner = agentOf(agent)
          // Only a chat that was in a channel leaves a tombstone: the owner took it out. Out of every channel is out of
          // every tag too (issue 608).
          if (st.unfile.run(owner, sessionId).changes) st.tombstone.run(owner, sessionId, now())
          if (tagsLive) st.dropTags.run(owner, sessionId)
          return { sessionId, agent: owner, channel: null }
        }
        const r = mustChannel(channelId)
        if (agent !== undefined && agent !== null && agent !== '' && agentOf(agent) !== r.agent) fail(409, 'agent_mismatch')
        st.untombstone.run(r.agent, sessionId)
        const had = st.member.get(r.agent, sessionId)
        if (had?.channel_id !== r.id) { const at = now(); st.file.run(r.agent, sessionId, r.id, at, filedBy); tagMoved(r.agent, sessionId, had?.channel_id, r.id, at, filedBy) }
        return { sessionId, agent: r.agent, channel: r.id }
      })
    },
    // Agent filing (status line `space`): only a thread in none of that agent's channels, never a move.
    fileIfUnfiled(agent, sessionId, channelId, filedBy = 'agent') {
      if (!validThreadId(sessionId) || typeof channelId !== 'string' || !CHANNEL_ID.test(channelId)) return false
      return tx(() => {
        const r = st.channel.get(channelId)
        if (!r || r.agent !== agentOf(agent) || r.archived) return false
        if (st.tombstoned.get(r.agent, sessionId)) return false
        const at = now()
        if (st.fileNew.run(r.agent, sessionId, r.id, at, filedBy).changes !== 1) return false
        tagFiled(r.agent, sessionId, r.id, at, filedBy)
        return true
      })
    },
    // Tags (issue 608). The chat's tag ids, primary first.
    tagsOf(agent, sessionId) { return validThreadId(sessionId) ? tagIds(agentOf(agent), sessionId) : [] },
    hasTag(agent, sessionId, channelId) {
      if (!validThreadId(sessionId) || typeof channelId !== 'string' || !CHANNEL_ID.test(channelId)) return false
      const who = agentOf(agent)
      return Boolean(st.tag.get(who, sessionId, channelId)) || st.member.get(who, sessionId)?.channel_id === channelId
    },
    // Once, the first time Tags are on: every chat's channel becomes its first tag.
    migrateTags() {
      if (meta('tags_migrated')) return { migrated: false, tags: 0 }
      return tx(() => {
        if (meta('tags_migrated')) return { migrated: false, tags: 0 }
        const n = st.copyTags.run().changes
        st.setMeta.run('tags_migrated', now())
        tagsLive = true
        return { migrated: true, tags: Number(n) }
      })
    },
    // Add one tag (the agent's own channel). A chat with no channel gets it as its primary. The owner's add clears his
    // own earlier removal of that tag. -> {sessionId, agent, channel (primary), tags}
    addTag({ sessionId, channelId, agent, by = 'owner' }) {
      if (!validThreadId(sessionId)) fail(400, 'invalid_session')
      if (!FILED_BY.has(by)) fail(400, 'invalid_filed_by')
      if (!tagsLive) store.migrateTags()
      return tx(() => {
        const r = mustChannel(channelId)
        if (agent !== undefined && agent !== null && agent !== '' && agentOf(agent) !== r.agent) fail(409, 'agent_mismatch')
        const at = now()
        if (by === 'owner') { st.unmarkRemoved.run(r.agent, sessionId, r.id); st.untombstone.run(r.agent, sessionId) }
        tagFiled(r.agent, sessionId, r.id, at, by)
        if (!st.member.get(r.agent, sessionId)) st.file.run(r.agent, sessionId, r.id, at, by)
        return { sessionId, agent: r.agent, channel: st.member.get(r.agent, sessionId)?.channel_id || null, tags: tagIds(r.agent, sessionId) }
      })
    },
    // Remove one tag. The owner's removal is remembered, so the agent never puts that tag back. Removing the primary
    // makes the oldest other tag primary; the last one leaves the chat in General (the owner took it out, as unfiling).
    removeTag({ sessionId, channelId, agent, by = 'owner' }) {
      if (!validThreadId(sessionId)) fail(400, 'invalid_session')
      if (!tagsLive) store.migrateTags()
      return tx(() => {
        const r = mustChannel(channelId)
        if (agent !== undefined && agent !== null && agent !== '' && agentOf(agent) !== r.agent) fail(409, 'agent_mismatch')
        st.dropTag.run(r.agent, sessionId, r.id)
        if (by === 'owner') st.markRemoved.run(r.agent, sessionId, r.id, now())
        if (st.member.get(r.agent, sessionId)?.channel_id === r.id && !promote(r.agent, sessionId) && by === 'owner') st.tombstone.run(r.agent, sessionId, now())
        return { sessionId, agent: r.agent, channel: st.member.get(r.agent, sessionId)?.channel_id || null, tags: tagIds(r.agent, sessionId) }
      })
    },
    // The agent's status-line `channel` with Tags on: one more tag, never one the owner removed from this chat, never on
    // a chat the owner took out of every channel, never an archived channel. -> true when added.
    tagIfAllowed(agent, sessionId, channelId, by = 'agent') {
      if (!validThreadId(sessionId) || typeof channelId !== 'string' || !CHANNEL_ID.test(channelId)) return false
      // Read first: a list rebuild asks for every row, and a refusal must not take the write lock each time.
      const who = agentOf(agent), refused = () => {
        const r = st.channel.get(channelId)
        if (!r || r.agent !== who || r.archived || st.removed.get(who, sessionId, r.id)) return true
        const member = st.member.get(who, sessionId)
        return (!member && Boolean(st.tombstoned.get(who, sessionId))) || member?.channel_id === r.id || Boolean(st.tag.get(who, sessionId, r.id))
      }
      if (refused()) return false
      if (!tagsLive) store.migrateTags()
      return tx(() => {
        const r = st.channel.get(channelId)
        if (!r || r.agent !== who || r.archived) return false
        if (st.removed.get(who, sessionId, r.id)) return false
        const member = st.member.get(who, sessionId)
        if (!member && st.tombstoned.get(who, sessionId)) return false
        if (member?.channel_id === r.id || st.tag.get(who, sessionId, r.id)) return false
        const at = now()
        tagFiled(who, sessionId, r.id, at, by)
        if (!member) st.file.run(who, sessionId, r.id, at, by)
        return true
      })
    },
    // A deleted thread leaves its channel.
    forget(agent, sessionId) { if (validThreadId(sessionId)) { st.unfile.run(agentOf(agent), sessionId); st.untombstone.run(agentOf(agent), sessionId); st.forgetDay.run(agentOf(agent), sessionId); tagsGone(agentOf(agent), sessionId) } },
    // exists(id) -> true | false | null (unknown: kept). Returns how many memberships were dropped.
    prune(agent, exists) {
      const owner = agentOf(agent), gone = st.agentMembers.all(owner).map(r => r.session_id).filter(id => exists(id) === false)
      if (gone.length) tx(() => { for (const id of gone) { st.unfile.run(owner, id); st.untombstone.run(owner, id); tagsGone(owner, id) } })
      const goneMarks = st.agentTombstones.all(owner).map(r => r.session_id).filter(id => exists(id) === false)
      if (goneMarks.length) tx(() => { for (const id of goneMarks) st.untombstone.run(owner, id) })
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
            if (st.fileNew.run(agent, thread, s.id, at, 'migration').changes === 1) { memberships++; tagFiled(agent, thread, s.id, at, 'migration') }
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
    // Daily channel (issue 527): seeded once for the main agent, pinned at rank 0 above Alerts. Like Alerts it is
    // renamable and archivable and never re-created once seeded, so an owner's archive or delete sticks.
    seedDaily() {
      if (meta('daily_seeded')) return null
      return tx(() => {
        if (meta('daily_seeded')) return null
        const existing = st.dailyOf.all('hermes')[0]
        if (existing) { st.setMeta.run('daily_seeded', existing.id); return null }
        const id = freeId(DAILY_ID)
        const minOrd = st.all.all().filter(r => r.agent === 'hermes').reduce((m, r) => Math.min(m, r.ord), 0)
        for (const r of st.all.all().filter(r => r.agent === 'hermes' && r.pinned !== null)) st.pin.run(r.pinned + 1, r.id)
        insertChannel({ id, agent: 'hermes', name: 'Daily', ord: minOrd - 1, createdAt: now(), pinned: 0, kind: 'daily' })
        st.setMeta.run('daily_seeded', id)
        return id
      })
    },
    // Issue 631 (switch wizard/private-routing): the private default agent's own Daily, seeded once per agent the way the
    // main agent's is (an owner's archive or delete of it sticks). An agent that already has a daily channel keeps it.
    seedDailyFor(agent) {
      const who = agentOf(agent)
      if (who === 'hermes') return this.seedDaily()
      const key = `daily_seeded:${who}`
      if (meta(key)) return null
      return tx(() => {
        if (meta(key)) return null
        const existing = st.dailyOf.all(who)[0]
        if (existing) { st.setMeta.run(key, existing.id); return null }
        const id = freeId(`${DAILY_ID}-${who}`.slice(0, 38))
        const minOrd = st.all.all().filter(r => r.agent === who).reduce((m, r) => Math.min(m, r.ord), 0)
        for (const r of st.all.all().filter(r => r.agent === who && r.pinned !== null)) st.pin.run(r.pinned + 1, r.id)
        insertChannel({ id, agent: who, name: 'Daily', ord: minOrd - 1, createdAt: now(), pinned: 0, kind: 'daily' })
        st.setMeta.run(key, id)
        return id
      })
    },
    // The agent's open daily channel (the raw row), or null.
    dailyChannel(agent) { try { return st.dailyOf.all(agentOf(agent)).find(r => !r.archived) || null } catch { return null } },
    // A daily channel by id (archived ones included, so their days stay readable), or null.
    dailyById(id) { const r = typeof id === 'string' && CHANNEL_ID.test(id) ? st.channel.get(id) : null; return r?.kind === 'daily' ? r : null },
    dayThread(channelId, day) { return DAY_KEY.test(day) ? st.day.get(channelId, day)?.session_id || null : null },
    // Today's thread, created once: concurrent first posts get the same id. The new thread is filed into the
    // channel by the agent (never over an owner's own filing or unfile). -> {sessionId, day, created}
    claimDay(channelId, day, mint) {
      if (!DAY_KEY.test(day)) fail(400, 'invalid_day')
      return tx(() => {
        const r = st.channel.get(channelId)
        if (r?.kind !== 'daily') fail(404, 'channel_not_found')
        const had = st.day.get(channelId, day)
        if (had) return { sessionId: had.session_id, day, created: false }
        const sessionId = mint()
        if (!validThreadId(sessionId)) fail(500, 'invalid_session')
        st.addDay.run(channelId, day, r.agent, sessionId, now())
        if (!st.tombstoned.get(r.agent, sessionId) && st.fileNew.run(r.agent, sessionId, channelId, now(), 'agent').changes === 1) tagFiled(r.agent, sessionId, channelId, now(), 'agent')
        return { sessionId, day, created: true }
      })
    },
    // Day threads newest first, `limit` of them before day `before` (exclusive; null: from the newest).
    days(channelId, { before = null, limit = 14 } = {}) {
      return st.daysBefore.all(channelId, before && DAY_KEY.test(before) ? before : '9999-99-99', limit).map(r => ({ day: r.day, sessionId: r.session_id }))
    },
    // {channelId, day} when this thread is a daily channel's day thread; plus the day before it, when there is one.
    dayOfSession(agent, sessionId) {
      if (!validThreadId(sessionId)) return null
      const r = st.dayOfSession.get(agentOf(agent), sessionId)
      // An archived Daily's old threads get no carry-over (issue 529): the channel no longer runs a day plan.
      const channel = r ? st.channel.get(r.channel_id) : null
      if (channel?.kind !== 'daily' || channel.archived) return null
      const prev = st.daysBefore.all(r.channel_id, r.day, 1)[0]
      return { channelId: r.channel_id, day: r.day, ...(prev ? { previous: { day: prev.day, sessionId: prev.session_id } } : {}) }
    },
    // What older shells read as `spaces` (read-only). Archived channels are left out; each keeps its
    // newest-filed 500 threads so the projection always passes the shell's Space validation.
    spacesProjection() {
      return st.all.all().filter(r => !r.archived).slice(0, PROJECTION_SPACES).map(r => {
        const threads = st.members.all(r.id).map(m => m.session_id)
        return { id: r.id, name: r.name, ...(r.agent === 'hermes' ? {} : { agent: r.agent }), threads: threads.slice(-PROJECTION_THREADS), createdAt: r.created_at }
      })
    },
    // Read watermarks (issue 471, WIZARD_CHANNEL_READ_SYNC=1): the newest activity time (ms) the owner has read a
    // channel feed to, per shell key, so every device of the owner shares it. Forward only: an older mark never wins.
    reads() { return { schema: CHANNEL_READS_SCHEMA, at: Object.fromEntries(st.reads.all(READ_MARKS_MAX).map(r => [r.key, Number(r.at)])) } },
    markRead(marks, { clock = Date.now } = {}) {
      if (!marks || typeof marks !== 'object' || Array.isArray(marks)) fail(400, 'invalid_marks')
      const entries = Object.entries(marks)
      if (!entries.length || entries.length > READ_MARKS_PER_WRITE) fail(400, 'invalid_marks')
      // A device clock ahead of the box must not mark tomorrow's posts read: a mark is never later than the box's now.
      const cap = clock() + READ_MARK_SKEW_MS
      for (const [key, at] of entries) if (!validReadKey(key) || !Number.isFinite(at) || at < 0) fail(400, 'invalid_marks')
      tx(() => {
        const at = now()
        for (const [key, t] of entries) st.readMark.run(key, Math.floor(Math.min(t, cap)), at)
        const over = st.readCount.get().n - READ_MARKS_MAX
        if (over > 0) st.readPrune.run(over)
      })
      return store.reads()
    },
    close() { try { db.close() } catch { /* already closed */ } },
  }
  return store
}

// Agent inbox (wizard-ux issue 1569): 'daily' or 'alerts' when this thread is a Daily day thread or is filed in a
// Daily or Alerts channel, else ''; 'unreadable' when the store exists but can't be read (callers fail closed). Read-only and independent of the Channels switch: those threads stay in Chats
// with Channels off too, and Send to inbox must never hide them (the sweep card is posted in today's Daily thread).
export function fixedChannelKind(path, agent, sessionId) {
  if (!path || !existsSync(path) || !validThreadId(sessionId)) return ''
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const who = agentOf(agent)
    const filed = db.prepare("SELECT c.kind FROM membership m JOIN channels c ON c.id=m.channel_id WHERE m.agent=? AND m.session_id=? AND c.kind IN ('daily','alerts')").get(who, sessionId)
    if (filed?.kind) return filed.kind
    const day = db.prepare("SELECT 1 AS y FROM daily_days d JOIN channels c ON c.id=d.channel_id WHERE d.agent=? AND d.session_id=? AND c.kind='daily' LIMIT 1").get(who, sessionId)
    return day ? 'daily' : ''
  } catch { return 'unreadable' } finally { try { db?.close() } catch {} }
}

// The same threads as a list (newest filed first, at most `limit`), so the shell can leave Send to inbox off them.
export function fixedChannelThreads(path, agent, limit = 500) {
  if (!path || !existsSync(path)) return []
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const who = agentOf(agent)
    const rows = db.prepare(`SELECT session_id, MAX(at) AS at FROM (
        SELECT m.session_id, m.filed_at AS at FROM membership m JOIN channels c ON c.id=m.channel_id WHERE m.agent=? AND c.kind IN ('daily','alerts')
        UNION ALL SELECT d.session_id, d.created_at AS at FROM daily_days d JOIN channels c ON c.id=d.channel_id WHERE d.agent=? AND c.kind='daily'
      ) GROUP BY session_id ORDER BY at DESC, session_id LIMIT ?`).all(who, who, limit)
    return rows.map(r => r.session_id)
  } catch { return [] } finally { try { db?.close() } catch {} }
}

// HTTP: /wizard/v1/channels (GET ?agent=, POST {name, agent?}, PATCH one of {id, name?, archived?, pinned?} |
// {order:[ids]} | {pinOrder:[ids]} | {sort:'az'|'za'}) and /wizard/v1/channels/membership (GET ?channel= |
// ?sessionId=&agent=, PUT {sessionId, channelId|null, agent?}) and, with the read sync on, /wizard/v1/channels/read
// (membership === 'read'). Unknown keys are a 400, like ui-preferences.
export function channelRequest(store, method, membership, params, body, options = {}) {
  const only = (...keys) => { if (Object.keys(body).some(k => !keys.includes(k))) fail(400, 'invalid_request') }
  // /wizard/v1/channels/read (issue 471): GET -> {schema, at}; PUT {at:{key: ms}} moves marks forward only.
  if (membership === 'read') {
    if (method === 'GET') return store.reads()
    only('at')
    return store.markRead(body.at)
  }
  // /wizard/v1/channels/tags (issue 608, Tags on): GET ?sessionId=&agent= -> {sessionId, agent, channel, tags} or
  // ?channel= -> {channel, members}; PUT {sessionId, agent?, add: id} | {sessionId, agent?, remove: id}.
  if (membership === 'tags') {
    if (method === 'GET') {
      if (params.has('channel')) { const set = store.memberSet(params.get('channel'), { tags: true }); if (!set) fail(404, 'channel_not_found'); return { channel: params.get('channel'), members: [...set.ids] } }
      const sessionId = params.get('sessionId')
      if (!validThreadId(sessionId)) fail(400, 'invalid_session')
      const agent = agentOf(params.get('agent'))
      return { sessionId, agent, channel: store.channelOf(agent, sessionId) || null, tags: store.tagsOf(agent, sessionId) }
    }
    only('sessionId', 'agent', 'add', 'remove')
    const add = Object.hasOwn(body, 'add'), remove = Object.hasOwn(body, 'remove')
    if (add === remove || typeof body[add ? 'add' : 'remove'] !== 'string') fail(400, 'invalid_request')
    return add ? store.addTag({ sessionId: body.sessionId, channelId: body.add, agent: body.agent, by: 'owner' })
      : store.removeTag({ sessionId: body.sessionId, channelId: body.remove, agent: body.agent, by: 'owner' })
  }
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
    return store.list({ ...(agent ? { agent } : {}), tags: options.tags === true })
  }
  if (method === 'POST') { only('name', 'agent'); return store.create({ name: body.name, agent: body.agent }) }
  const keys = Object.keys(body)
  if (keys.length === 1 && keys[0] === 'sort') { store.setSort(body.sort); return store.list() }
  if (keys.length === 1 && keys[0] === 'order') return store.reorder(body.order, 'order')
  if (keys.length === 1 && keys[0] === 'pinOrder') return store.reorder(body.pinOrder, 'pin')
  only('id', 'name', 'archived', 'pinned', ...(options.daily ? ['kind'] : []))
  if (keys.length < 2) fail(400, 'invalid_request')
  const { id, ...change } = body
  return store.update(id, change)
}
