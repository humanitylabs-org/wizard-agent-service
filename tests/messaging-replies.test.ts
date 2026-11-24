// Replies from WizardOS into chats a messaging app owns (wizard-agent-service issue 427): the outbox the wizard-os
// Hermes plugin takes from, and the state.db reads that decide "messaging chat?", "still current?" and "answered?".
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import {
  ANSWER_TIMEOUT_MS, CLAIM_TTL_MS, MOVED_ON_ERROR, MessagingReplies, NOT_TAKEN_ERROR, TAKE_TIMEOUT_MS,
  isMessagingRunId, readInjectedAnswer, readMessagingSession,
} from '../server/messaging-replies.mjs'

function stateDb() {
  const dir = mkdtempSync(join(tmpdir(), 'messaging-replies-'))
  const path = join(dir, 'state.db')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, session_key TEXT, chat_id TEXT, chat_type TEXT, thread_id TEXT, ended_at REAL, end_reason TEXT);
    CREATE TABLE gateway_routing (scope TEXT, session_key TEXT, data TEXT, updated_at REAL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, finish_reason TEXT, display_kind TEXT, timestamp REAL);`)
  const key = 'agent:main:telegram:dm:42'
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)').run('tg-now', 'telegram', key, '42', 'dm', null, null, null)
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)').run('tg-old', 'telegram', key, '42', 'dm', null, 100, 'new')
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)').run('slack-thread', 'slack', 'agent:main:slack:group:C1:17.1', 'C1', 'group', '17.1', null, null)
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)').run('mine', 'api_server', '', null, null, null, null, null)
  db.prepare('INSERT INTO gateway_routing VALUES (?,?,?,?)').run('/h/sessions', key, JSON.stringify({ session_id: 'tg-now' }), 1)
  return { path, db }
}

describe('which chats a messaging app owns', () => {
  it('names the app, its chat and whether the chat is still the conversation the app writes to', () => {
    const { path } = stateDb()
    expect(readMessagingSession(path, 'tg-now')).toEqual({ source: 'telegram', sessionKey: 'agent:main:telegram:dm:42', chatId: '42', chatType: 'dm', threadId: '', current: true })
    expect(readMessagingSession(path, 'tg-old')?.current).toBe(false)
    expect(readMessagingSession(path, 'slack-thread')).toMatchObject({ source: 'slack', chatId: 'C1', threadId: '17.1', current: null })
    expect(readMessagingSession(path, 'mine')).toBeNull()
    expect(readMessagingSession(path, 'missing')).toBeNull()
    expect(readMessagingSession('', 'tg-now')).toBeNull()
  })
})

describe('the outbox', () => {
  const chat = { source: 'telegram', sessionKey: 'agent:main:telegram:dm:42', chatId: '42', chatType: 'dm', threadId: '' }

  it('keeps one item per reply, offers it until acknowledged, and reads the answer once injected', () => {
    const { path, db } = stateDb()
    let now = 1_000_000
    const file = join(mkdtempSync(join(tmpdir(), 'mr-store-')), 'messaging-replies.json')
    const store = new MessagingReplies(file, { now: () => now })
    const item = store.add({ runId: 'wizardq_1', sessionId: 'tg-now', chat, text: 'hello from WizardOS' })
    expect(isMessagingRunId(item.id)).toBe(true)
    expect(store.add({ runId: 'wizardq_1', sessionId: 'tg-now', chat, text: 'hello from WizardOS' }).id).toBe(item.id)
    const [taken] = store.take()
    expect(taken).toMatchObject({ id: item.id, kind: 'inject', session_key: chat.sessionKey, platform: 'telegram', chat_id: '42', text: 'hello from WizardOS' })
    expect(store.take()).toEqual([]) // taken: not offered again at once
    now += CLAIM_TTL_MS
    expect(store.take().map(x => x.id)).toEqual([item.id]) // never acknowledged: the same id again
    expect(store.status(item.id, path).status).toBe('running')
    store.done(item.id, { status: 'injected', at: now / 1000 })
    expect(store.done(item.id, { status: 'failed' }).state).toBe('injected') // a repeated report changes nothing
    expect(store.status(item.id, path).status).toBe('running')
    db.prepare('INSERT INTO messages (session_id, role, content, display_kind, timestamp) VALUES (?,?,?,?,?)').run('tg-now', 'user', 'hello from WizardOS', 'internal_notification', now / 1000)
    db.prepare('INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES (?,?,?,?,?)').run('tg-now', 'assistant', '', '[{"id":"t"}]', now / 1000 + 1)
    db.prepare('INSERT INTO messages (session_id, role, content, finish_reason, timestamp) VALUES (?,?,?,?,?)').run('tg-now', 'assistant', 'Hi! (answered in Telegram too)', 'stop', now / 1000 + 2)
    expect(store.status(item.id, path)).toEqual({ status: 'completed', output: 'Hi! (answered in Telegram too)' })
    // Survives a restart of the Service.
    expect(new MessagingReplies(file, { now: () => now }).get(item.id).state).toBe('answered')
  })

  it('fails visibly when nothing takes it, when the app moved on, or when no answer comes', () => {
    const { path } = stateDb()
    let now = 5_000_000
    const store = new MessagingReplies('', { now: () => now })
    const lonely = store.add({ runId: 'a', sessionId: 'tg-now', chat, text: 'x' })
    now += TAKE_TIMEOUT_MS
    expect(store.status(lonely.id, path)).toEqual({ status: 'failed', error: NOT_TAKEN_ERROR })
    const moved = store.add({ runId: 'b', sessionId: 'tg-now', chat, text: 'y' })
    store.take(); store.done(moved.id, { status: 'older' })
    expect(store.status(moved.id, path)).toEqual({ status: 'failed', error: MOVED_ON_ERROR })
    const silent = store.add({ runId: 'c', sessionId: 'tg-now', chat, text: 'z' })
    store.take(); store.done(silent.id, { status: 'injected', at: now / 1000 })
    now += ANSWER_TIMEOUT_MS
    expect(store.status(silent.id, path).status).toBe('failed')
  })

  it('a worker that stopped after taking a reply: injected words become that turn, no words fail visibly', () => {
    const { path, db } = stateDb()
    let now = 9_000_000_000
    const store = new MessagingReplies('', { now: () => now })
    const lost = store.add({ runId: 'lost', sessionId: 'tg-now', chat, text: 'did it go?' })
    const gone = store.add({ runId: 'gone', sessionId: 'tg-now', chat, text: 'never sent' })
    store.take() // both taken; the worker dies before /done
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)').run('tg-now', 'user', 'did it go?', now / 1000 + 1)
    now += TAKE_TIMEOUT_MS
    expect(store.status(lost.id, path).status).toBe('running') // its words are in the chat: wait for its answer
    expect(store.get(lost.id).state).toBe('injected')
    expect(store.status(gone.id, path)).toEqual({ status: 'failed', error: NOT_TAKEN_ERROR })
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)').run('tg-now', 'assistant', 'yes it went', now / 1000)
    expect(store.status(lost.id, path)).toEqual({ status: 'completed', output: 'yes it went' })
  })

  it('the same words twice: the second reply waits for its own answer', () => {
    const { path, db } = stateDb()
    let now = 9_100_000_000
    const store = new MessagingReplies('', { now: () => now })
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)').run('tg-now', 'user', 'yes', now / 1000 - 3)
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)').run('tg-now', 'assistant', 'first answer', now / 1000 - 2)
    const item = store.add({ runId: 'again', sessionId: 'tg-now', chat, text: 'yes' })
    store.take(); store.done(item.id, { status: 'injected', at: now / 1000 })
    expect(store.status(item.id, path).status).toBe('running')
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)').run('tg-now', 'user', 'yes', now / 1000 + 0.2)
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)').run('tg-now', 'assistant', 'second answer', now / 1000 + 1)
    expect(store.status(item.id, path)).toEqual({ status: 'completed', output: 'second answer' })
  })

  it('posts the "continued in WizardOS" note once per older chat', () => {
    const store = new MessagingReplies('')
    const note = store.add({ kind: 'note', sessionId: 'tg-old', chat })
    expect(store.add({ kind: 'note', sessionId: 'tg-old', chat })).toBeNull()
    store.take(); store.done(note.id, { status: 'noted' })
    expect(store.add({ kind: 'note', sessionId: 'tg-old', chat })).toBeNull()
  })

  it('reads only the answer that follows the injected words', () => {
    const { path, db } = stateDb()
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)').run('tg-now', 'assistant', 'an older answer', 10)
    expect(readInjectedAnswer(path, 'tg-now', 'next', 0)).toBeNull()
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)').run('tg-now', 'user', 'next', 20)
    expect(readInjectedAnswer(path, 'tg-now', 'next', 0)).toBeNull()
    db.prepare('INSERT INTO messages (session_id, role, content, display_kind, timestamp) VALUES (?,?,?,?,?)').run('tg-now', 'assistant', 'thinking aloud', 'commentary', 21)
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)').run('tg-now', 'assistant', 'the answer', 22)
    expect(readInjectedAnswer(path, 'tg-now', 'next', 0)?.text).toBe('the answer')
  })
})
