// Issue 446: Chats Channels posts. view=list rows carry firstRequest (the first owner message, cleaned, at most
// 400 code units) and firstAttachments (its images as file refs), behind WIZARD_CHANNEL_FIRST_POSTS.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { batchedOwnerTurnRestore, firstPostOf, firstPostOfHistory, needsOwnerTurnRestore, readHermesFirstPosts } from '../server/first-post.mjs'
import { DurableRunQueue } from '../server/run-queue.mjs'
import { listPayload, listRow } from '../server/session-list-view.mjs'
import { restoreOwnerTurns } from '../server/service.mjs'

const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
const marker = (files: any[], tag = 'WIZARD_FILES_V1') => `\n\n[${tag}]\n${JSON.stringify(files)}\n[/${tag}]`
const photo = { id: 'file-photo-1', filename: 'garden.png', mime: 'image/png', bytes: 10, trusted_path: '/opt/data/inbox/garden.png' }
const pdf = { id: 'file-doc-1', filename: 'plan.pdf', mime: 'application/pdf', bytes: 10 }
const voice = { id: 'file-voice-1', filename: 'wizard-voice-1.webm', mime: 'audio/webm', bytes: 10, transcript: 'Plant the **roses** first.' }
const row = (id: string, extra: any = {}) => ({ id, title: 'Generated title', preview: 'Hermes 60-char head', updated_at: '2026-11-10T10:00:00Z', ...extra })

describe('firstPostOf', () => {
  it('cleans the owner words: workspace prefix, file and intent markers, the screen note, markdown', () => {
    const content = `[Workspace::v1: /opt/data]\n## Plan **the garden** with \`care\`${marker([photo])}\n\n[WIZARD_IMAGE_INTENT_V1]\nInspect images\n[/WIZARD_IMAGE_INTENT_V1]\n[WizardOS context] Window in front: Notes. Visible on screen: secret-looking screen text`
    expect(firstPostOf(content)).toEqual({ text: 'Plan the garden with care', attachments: [{ id: 'file-photo-1', name: 'garden.png', mime: 'image/png' }] })
  })
  it('cuts at 400 UTF-16 code units and never leaves half a surrogate pair', () => {
    expect(firstPostOf('a'.repeat(1000)).text).toBe('a'.repeat(400))
    const emoji = firstPostOf(`${'a'.repeat(399)}😀 more`).text
    expect(emoji).toBe('a'.repeat(399))
    expect(emoji.length).toBeLessThanOrEqual(400)
  })
  it('keeps images only, as { id, name, mime } refs, de-duplicated, from file and chip markers', () => {
    const post = firstPostOf(`Look${marker([photo, pdf, voice, { ...photo }])}${marker([{ id: 'file-photo-2', filename: 'b.JPG', mime: 'IMAGE/JPEG', bytes: 3 }], 'WIZARD_FILE_CHIPS_V1')}`)
    expect(post.attachments).toEqual([{ id: 'file-photo-1', name: 'garden.png', mime: 'image/png' }, { id: 'file-photo-2', name: 'b.JPG', mime: 'image/jpeg' }])
    expect(JSON.stringify(post)).not.toContain('trusted_path')
    expect(JSON.stringify(post)).not.toContain('/opt/data')
  })
  it('drops refs the files route cannot serve (Helm attachment envelopes, bad ids)', () => {
    const helm = `Here.\n\n<helm_attachments>${JSON.stringify({ items: [{ id: '1'.repeat(32), name: 'a.png', mime: 'image/png' }] })}</helm_attachments>`
    expect(firstPostOf(helm)).toEqual({ text: 'Here.', attachments: [] })
    expect(firstPostOf(`x${marker([{ ...photo, id: '../etc/passwd' }])}`).attachments).toEqual([])
  })
  it('a photo-only message has no words but its photos; a voice note says its transcript', () => {
    expect(firstPostOf(`Please use the attached photo.${marker([photo])}`)).toEqual({ text: '', attachments: [{ id: 'file-photo-1', name: 'garden.png', mime: 'image/png' }] })
    expect(firstPostOf(marker([voice]))).toEqual({ text: 'Plant the roses first.', attachments: [] })
  })
  it('drops Hermes\' [screenshot] image placeholder from the words', () => {
    expect(firstPostOf(`Who redesigned this? [screenshot]${marker([photo])}`).text).toBe('Who redesigned this?')
    expect(firstPostOf('[screenshot]\n[screenshot]').text).toBe('')
  })
  it('reads the text parts of a multi-part message', () => {
    expect(firstPostOf(JSON.stringify([{ type: 'text', text: `Screenshot please${marker([photo])}` }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }])).text).toBe('Screenshot please')
  })
})

describe('first post readers', () => {
  it('state.db: the first visible owner message; an agent-started thread is null; an unknown thread is absent', () => {
    const d = mkdtempSync(join(tmpdir(), 'first-post-')); dirs.push(d)
    const path = join(d, 'state.db'), db = new DatabaseSync(path)
    db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY); CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, display_kind TEXT, timestamp REAL)')
    const put = db.prepare('INSERT INTO messages(session_id, role, content, display_kind, timestamp) VALUES(?,?,?,?,?)')
    db.prepare('INSERT INTO sessions(id) VALUES(?)').run('owner'); db.prepare('INSERT INTO sessions(id) VALUES(?)').run('agent')
    put.run('owner', 'user', '[ASYNC DELEGATION BATCH COMPLETE — d1]\nworker transcript', 'async_delegation_complete', 1)
    put.run('owner', 'user', `${'Long owner words '.repeat(40)}${marker([photo, pdf])}`, null, 2)
    put.run('owner', 'user', 'A later message', null, 3)
    put.run('agent', 'assistant', 'I started this', 'final', 1)
    db.prepare('INSERT INTO sessions(id) VALUES(?)').run('huge')
    put.run('huge', 'user', `${'x'.repeat(200_000)}${marker([photo])}`, null, 1)
    db.close()
    const posts = readHermesFirstPosts(path, ['owner', 'agent', 'missing', 'huge'])
    expect(posts.get('owner')?.text.startsWith('Long owner words Long')).toBe(true)
    expect(posts.get('owner')?.text.length).toBe(400)
    expect(posts.get('owner')?.attachments).toEqual([{ id: 'file-photo-1', name: 'garden.png', mime: 'image/png' }])
    expect(posts.get('agent')).toBeNull()
    expect(posts.has('missing')).toBe(false)
    // A very long first message keeps its photos: the file marker sits after the words.
    expect(posts.get('huge')?.attachments).toEqual([{ id: 'file-photo-1', name: 'garden.png', mime: 'image/png' }])
    expect(posts.get('huge')?.text).toBe('x'.repeat(400))
    expect(readHermesFirstPosts(join(d, 'unreadable.db'), ['owner']).size).toBe(0)
  })
  it('history page (a restricted agent, read through its runtime)', () => {
    expect(firstPostOfHistory([{ role: 'user', content: '[Your active task list was preserved across context compression]\n- x' }, { role: 'user', content: `Hi${marker([photo])}` }], false))
      .toEqual({ text: 'Hi', attachments: [{ id: 'file-photo-1', name: 'garden.png', mime: 'image/png' }] })
    expect(firstPostOfHistory([{ role: 'assistant', content: 'Agent note', display_kind: 'final' }], false)).toBeNull()
    expect(firstPostOfHistory([], false)).toBeUndefined()
    // A voice note still being transcribed: not decided yet, so it is read again later.
    expect(firstPostOfHistory([{ role: 'user', content: '' }], false)).toBeUndefined()
  })
})

describe('list rows', () => {
  const post = { text: 'Plan the garden', attachments: [{ id: 'file-photo-1', name: 'garden.png', mime: 'image/png' }] }
  it('switch on: rows carry both fields; an agent-started or unread row carries neither', () => {
    expect(listRow(row('a', { wizard_first_post: post }), '', null, { firstPosts: true })).toMatchObject({ firstRequest: 'Plan the garden', firstAttachments: post.attachments })
    for (const extra of [{ wizard_first_post: null }, {}]) {
      const listed = listRow(row('b', extra), '', null, { firstPosts: true })
      expect(listed).not.toHaveProperty('firstRequest'); expect(listed).not.toHaveProperty('firstAttachments')
    }
    // With the channel store also on, Hermes' short preview never stands in for the post.
    const channels = { channelOf: () => 'chan-1' }
    const both = listRow(row('c'), '', channels, { firstPosts: true })
    expect(both).toMatchObject({ channel: 'chan-1' }); expect(both).not.toHaveProperty('firstRequest')
    const page = listPayload({ data: [row('a', { wizard_first_post: post })] }, '', null, { firstPosts: true })
    expect(page.data[0]).toMatchObject({ firstRequest: 'Plan the garden' })
    expect(JSON.stringify(page)).not.toContain('wizard_first_post')
  })
  it('switch off: rows are unchanged', () => {
    const listed = listRow(row('a', { wizard_first_post: post }))
    expect(listed).not.toHaveProperty('firstRequest'); expect(listed).not.toHaveProperty('firstAttachments')
    expect(listRow(row('a', { wizard_first_post: post }), '', null, null)).toEqual(listRow(row('a')))
  })
})

// AI review kick-back (11 Nov 2026): the post is the first message the thread's view=wizard history shows as the
// owner's. Hermes 0.22.5+ stamps the owner's own API turns internal_notification and the Service restores them from
// its run queue; injected steers and nudges are never the post. Synthetic shapes, no real conversation content.
describe('first post follows the owner turns of the view=wizard history', () => {
  const SID = 'wizard_synthetic_first'
  const owner = 'So we are using the synthetic development pipeline now, as agreed on the call'
  const listBody = (text: string) => JSON.stringify({ session_id: SID, input: [{ role: 'user', content: [{ type: 'text', text }] }] })
  const queue = { admittedForSession: (runtime: string, sid: string) => runtime === 'direct' && sid === SID
    ? [{ publicRunId: 'wizardq_owner', upstreamRunId: 'run_owner', status: 'completed', createdAt: 1000, body: listBody(owner), payload: { created_at: 1000 } }] : [] }
  const restore = (raw: Buffer, sid: string) => restoreOwnerTurns(raw, queue, sid, null)
  // A thread the owner never wrote in: nothing of his in the queue either.
  const none = (raw: Buffer, sid: string) => restoreOwnerTurns(raw, { admittedForSession: () => [] }, sid, null)
  const stateDb = (rows: [string, string | null, number][], replies: number[] = []) => {
    const d = mkdtempSync(join(tmpdir(), 'first-post-turns-')); dirs.push(d)
    const path = join(d, 'state.db'), db = new DatabaseSync(path)
    db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY); CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, display_kind TEXT, timestamp REAL)')
    db.prepare('INSERT INTO sessions(id) VALUES(?)').run(SID)
    const put = db.prepare('INSERT INTO messages(session_id, role, content, display_kind, timestamp) VALUES(?,?,?,?,?)')
    for (const [content, kind, at] of rows) put.run(SID, 'user', content, kind, at)
    for (const at of replies) put.run(SID, 'assistant', 'Synthetic reply', 'final', at)
    db.close()
    return path
  }
  const steer = '[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position; not tool output] Music [/OUT-OF-BAND USER MESSAGE]'
  const nudges = [steer, '[Morning reconciliation · Coordinator] This thread stopped after a finished helper batch.',
    '[reporter] Your last report does not meet the report format: synthetic.', '[Picked up from 2026-11-06] Synthetic carry-over.',
    '[Relayed by Synthetic Manager] Synthetic relay.', '[Wizard follow-through] Cross-thread note from the "Synthetic" thread: hi']
  it('an owner message stamped internal_notification, then an out-of-band steer: the owner message is the post', () => {
    const path = stateDb([[owner, 'internal_notification', 1001], [steer, null, 1002]])
    expect(readHermesFirstPosts(path, [SID], { restore }).get(SID)).toEqual({ text: owner, attachments: [] })
  })
  it('each injected nudge is skipped on its own and after the owner message', () => {
    for (const nudge of nudges) {
      expect(readHermesFirstPosts(stateDb([[nudge, null, 1001]]), [SID], { restore: none }).get(SID)).toBeNull()
      expect(readHermesFirstPosts(stateDb([[nudge, null, 999], [owner, 'internal_notification', 1001]]), [SID], { restore }).get(SID)).toEqual({ text: owner, attachments: [] })
      expect(firstPostOfHistory([{ role: 'user', content: `[Workspace::v1: /opt/data]\n${nudge}` }], false)).toBeNull()
    }
  })
  it('a reporter nudge in a thread with no owner message: agent-started (no fields)', () => {
    const path = stateDb([['[reporter] Your last report does not meet the report format: synthetic.', 'internal_notification', 1001], ['[reporter] Again.', null, 1003]])
    expect(readHermesFirstPosts(path, [SID], { restore: none }).get(SID)).toBeNull()
  })
  it('an internal_notification row the queue does not claim stays hidden, as in the history', () => {
    const path = stateDb([['Synthetic gateway notice', 'internal_notification', 1001]])
    expect(readHermesFirstPosts(path, [SID], { restore: none }).get(SID)).toBeNull()
    expect(readHermesFirstPosts(path, [SID]).get(SID)).toBeNull()
  })
  it('an owner turn Hermes no longer holds comes back from the queue, as in the history', () => {
    expect(readHermesFirstPosts(stateDb([[steer, null, 1002]]), [SID], { restore }).get(SID)).toEqual({ text: owner, attachments: [] })
    // Codex review: Hermes kept only the reply. The history page still reaches past the queued turn, so it is the post.
    expect(readHermesFirstPosts(stateDb([], [1005]), [SID], { restore }).get(SID)).toEqual({ text: owner, attachments: [] })
    expect(readHermesFirstPosts(stateDb([], [1005]), [SID], { restore: none }).get(SID)).toBeNull()
    expect(readHermesFirstPosts(stateDb([], [1005]), [SID]).get(SID)).toBeNull()
  })
  it('equals the first owner turn of the same rows restored as a view=wizard history page', () => {
    const rows: [string, string | null, number][] = [[nudges[1], null, 999], [`${owner} [screenshot]`, 'internal_notification', 1001], [steer, null, 1002], ['A later owner message', null, 1003]]
    const page = { object: 'list', session_id: SID, pagination: { limit: 100, offset: 0, order: 'oldest', returned: rows.length },
      data: rows.map(([content, kind, at], i) => ({ id: i + 1, session_id: SID, role: 'user', content, timestamp: at, ...(kind ? { display_kind: kind } : {}) })) }
    const history = JSON.parse(restoreOwnerTurns(Buffer.from(JSON.stringify(page)), queue, SID, null).toString()).data
    expect(firstPostOfHistory(history, false)).toEqual({ text: owner, attachments: [] })
    expect(readHermesFirstPosts(stateDb(rows), [SID], { restore }).get(SID)).toEqual(firstPostOfHistory(history, false))
  })
})

// AI review round 2 (11 Nov 2026): the list is polled, so the owner-turn restore must not run a queue scan per row on
// every poll. Posts the restore cannot change skip it, decided posts are kept, and the rest share one queue read.
describe('first posts stay cheap per poll', () => {
  const owner = 'Plan the synthetic garden with care'
  const listBody = (sid: string, text: string) => JSON.stringify({ session_id: sid, input: [{ role: 'user', content: [{ type: 'text', text }] }] })
  const stateDb = (threads: Record<string, [string, string, string | null, number][]>) => {
    const d = mkdtempSync(join(tmpdir(), 'first-post-poll-')); dirs.push(d)
    const path = join(d, 'state.db'), db = new DatabaseSync(path)
    db.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY); CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, display_kind TEXT, timestamp REAL)')
    const put = db.prepare('INSERT INTO messages(session_id, role, content, display_kind, timestamp) VALUES(?,?,?,?,?)')
    for (const [sid, rows] of Object.entries(threads)) {
      db.prepare('INSERT INTO sessions(id) VALUES(?)').run(sid)
      for (const [role, content, kind, at] of rows) put.run(sid, role, content, kind, at)
    }
    db.close()
    return path
  }
  const records = (sid: string) => sid === 'stamped' || sid === 'lost'
    ? [{ publicRunId: `wizardq_${sid}`, upstreamRunId: `run_${sid}`, status: 'completed', createdAt: 1000, body: listBody(sid, owner), payload: { created_at: 1000 } }] : []
  const counting = () => {
    const calls = { single: [] as string[], batches: [] as string[][] }
    const queue = {
      admittedForSession: (runtime: string, sid: string) => { calls.single.push(sid); return runtime === 'direct' ? records(sid) : [] },
      admittedForSessions: (runtime: string, ids: string[]) => { calls.batches.push(ids); return new Map(ids.map(id => [id, runtime === 'direct' ? records(id) : []])) },
    }
    return { calls, restore: batchedOwnerTurnRestore(queue, (raw: Buffer, view: any, sid: string) => restoreOwnerTurns(raw, view, sid, null)) as any }
  }
  const threads = {
    plain: [['user', owner, null, 1001], ['assistant', 'Synthetic reply', 'final', 1002]],
    stamped: [['user', owner, 'internal_notification', 1001], ['assistant', 'Synthetic reply', 'final', 1002]],
    lost: [['assistant', 'Synthetic reply', 'final', 1005]],
    agent: [['user', '[reporter] Synthetic nudge.', null, 1001]],
  } as Record<string, [string, string, string | null, number][]>
  it('needsOwnerTurnRestore: only pages whose first owner message the restore can change', () => {
    expect(needsOwnerTurnRestore([{ role: 'user', content: owner }])).toBe(false)
    expect(needsOwnerTurnRestore([{ role: 'user', content: '[reporter] x' }, { role: 'user', content: owner }])).toBe(false)
    expect(needsOwnerTurnRestore([{ role: 'user', content: owner, display_kind: 'internal_notification' }])).toBe(true)
    expect(needsOwnerTurnRestore([{ role: 'user', content: '[reporter] x' }])).toBe(true)
    expect(needsOwnerTurnRestore([])).toBe(true)
  })
  it('one batched queue read per page, only for threads that need the restore; same posts as per-thread restores', () => {
    const path = stateDb(threads), ids = Object.keys(threads), { calls, restore } = counting()
    const posts = readHermesFirstPosts(path, ids, { restore })
    expect(calls.batches).toEqual([['stamped', 'lost', 'agent']])
    expect(calls.single).toEqual([])
    const perThread = (raw: Buffer, sid: string) => restoreOwnerTurns(raw, { admittedForSession: (_r: string, id: string) => records(id) }, sid, null)
    expect(Object.fromEntries(posts)).toEqual(Object.fromEntries(readHermesFirstPosts(path, ids, { restore: perThread })))
    expect(posts.get('plain')).toEqual({ text: owner, attachments: [] })
    expect(posts.get('stamped')).toEqual({ text: owner, attachments: [] })
    expect(posts.get('lost')).toEqual({ text: owner, attachments: [] })
    expect(posts.get('agent')).toBeNull()
  })
  it('a decided post is kept until the thread\'s first rows or newest reply change, or the memo ages out', () => {
    const path = stateDb(threads), ids = Object.keys(threads), memo = new Map(), { calls, restore } = counting()
    const first = readHermesFirstPosts(path, ids, { restore, memo, now: 1_000_000 })
    expect(calls.batches.length).toBe(1)
    expect(Object.fromEntries(readHermesFirstPosts(path, ids, { restore, memo, now: 1_060_000 }))).toEqual(Object.fromEntries(first))
    expect(calls.batches.length).toBe(1)
    // A new reply in one thread: only that thread is read again.
    const db = new DatabaseSync(path)
    db.prepare('INSERT INTO messages(session_id, role, content, display_kind, timestamp) VALUES(?,?,?,?,?)').run('agent', 'assistant', 'Later', 'final', 1010)
    db.close()
    readHermesFirstPosts(path, ids, { restore, memo, now: 1_070_000 })
    expect(calls.batches.at(-1)).toEqual(['agent'])
    // An owner message arriving in an agent-started thread changes its first rows, so it becomes the post.
    const db2 = new DatabaseSync(path)
    db2.prepare('INSERT INTO messages(session_id, role, content, display_kind, timestamp) VALUES(?,?,?,?,?)').run('agent', 'user', 'Synthetic owner answer', null, 1020)
    db2.close()
    expect(readHermesFirstPosts(path, ids, { restore, memo, now: 1_080_000 }).get('agent')).toEqual({ text: 'Synthetic owner answer', attachments: [] })
    // After ten minutes everything is decided again.
    readHermesFirstPosts(path, ids, { restore, memo, now: 1_080_000 + 10 * 60_000 })
    expect(calls.batches.at(-1)).toEqual(['stamped', 'lost'])
  })
  it('DurableRunQueue.admittedForSessions equals admittedForSession per thread, with and without the owner-turn ledger', () => {
    for (const keepOwnerTurns of [false, true]) {
      const d = mkdtempSync(join(tmpdir(), 'first-post-queue-')); dirs.push(d)
      const queue = new DurableRunQueue({ statePath: join(d, 'q.sqlite3'), launch: async () => ({}), lookup: async () => ({}),
        activeSessionIds: async () => [], canDispatch: async () => false, keepOwnerTurns } as any) as any
      const insert = queue.database.prepare(`INSERT INTO wizard_run_queue (public_run_id, runtime, session_id, idempotency_key, request_hash, body,
        trusted_paths_json, status, upstream_run_id, payload_json, created_at, updated_at, terminal_at, continuation_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      const old = Date.now() / 1000 - 30 * 86400
      let n = 0
      for (const sid of ['s1', 's2', 's3']) for (let i = 0; i < 3; i++) {
        n++
        insert.run(`wizardq_${sid}_${i}`, i === 2 ? 'operator' : 'direct', sid, `k${n}`, 'h', listBody(sid, `${owner} ${i}`), '[]', 'completed', i === 1 && sid === 's2' ? '' : `run_${n}`,
          JSON.stringify({ created_at: old + 10 - n }), old + 10 - n, old + 10 - n, old + 10 - n, 'null')
      }
      for (let i = 0; i < 130; i++) insert.run(`wizardq_fill${i}`, 'direct', `other${i}`, `f${i}`, 'h', '{}', '[]', 'completed', `run_f${i}`, '{}', old + 100 + i, old + 100 + i, old + 100 + i, 'null')
      if (keepOwnerTurns) queue._pruneTerminal(true)
      const ids = ['s1', 's2', 's3', 'missing']
      const batch = queue.admittedForSessions('direct', ids)
      for (const id of ids) expect(batch.get(id)).toEqual(queue.admittedForSession('direct', id))
      expect(batch.get('s1').length).toBe(2)
      expect(queue.admittedForSessions('heavy', ids).size).toBe(0)
      queue.close()
    }
  })
})
