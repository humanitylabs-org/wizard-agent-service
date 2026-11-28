import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHermesSessionTruthReader, readHermesSessionTruth } from '../server/session-truth.mjs'
import { readFirstPostPages } from '../server/first-post.mjs'
import { createListEvidenceReader } from '../server/list-evidence.mjs'

// Issue 584: a Chats list rebuild read every listed thread's message bodies again, about 0.4 MB a thread for the
// truth walk and 50 first user rows a thread for the first-post key: 170-300 MB a rebuild on a large state.db, which
// kept the disk busy and stalled every other read. Unchanged threads must now cost index pages, not bodies.
const cleanup: Array<() => unknown> = []
afterEach(() => { while (cleanup.length) cleanup.pop()?.() })
const threadIo = existsSync('/proc/thread-self/io')
const rchar = () => Number(readFileSync('/proc/thread-self/io', 'utf8').match(/rchar: (\d+)/)?.[1])
const readBytes = (run: () => unknown) => { const before = rchar(); run(); return rchar() - before }

const BIG = 'x'.repeat(120_000)
function stateDb({ revisions = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'list-memo-')), path = join(root, 'state.db')
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const db = new DatabaseSync(path)
  cleanup.push(() => db.close())
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT, started_at REAL, model TEXT, model_config TEXT, parent_session_id TEXT,
      end_reason TEXT, title TEXT, last_activity_at REAL, message_count INTEGER DEFAULT 0${revisions ? ', transcript_revision INTEGER NOT NULL DEFAULT 0' : ''});
    CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_call_id TEXT,
      timestamp REAL, finish_reason TEXT, reasoning TEXT, active INTEGER DEFAULT 1, compacted INTEGER DEFAULT 0, display_kind TEXT, display_metadata TEXT);
    CREATE INDEX idx_messages_session_active ON messages(session_id, active, timestamp);
    CREATE INDEX idx_messages_session_id ON messages(session_id, id);
    CREATE TABLE session_turn_leases(conversation_id TEXT, expires_at REAL);
    ${revisions ? `CREATE TRIGGER messages_transcript_revision_update AFTER UPDATE OF role, content, tool_calls ON messages
      BEGIN UPDATE sessions SET transcript_revision = transcript_revision + 1 WHERE id = new.session_id; END;` : ''}`)
  const old = Date.now() / 1000 - 3600
  // Display kinds are set as Hermes sets them: a NULL last column is read from the record header alone, a set one is
  // read past the bodies before it.
  const insert = db.prepare('INSERT INTO messages(session_id, role, content, tool_calls, timestamp, finish_reason, reasoning, display_kind) VALUES(?,?,?,?,?,?,?,?)')
  const add = { run: (id: string, role: string, content: string, calls: string | null, at: number, finish: string | null, reasoning: string | null, kind: string | null = role === 'user' ? 'message' : 'final') =>
    insert.run(id, role, content, calls, at, finish, reasoning, kind) }
  const thread = (id: string, at = old) => {
    db.prepare('INSERT INTO sessions(id, source, started_at, model) VALUES(?,?,?,?)').run(id, 'wizard-mobile', at, 'synthetic-model')
    add.run(id, 'user', `Plan the garden beds for ${id}`, null, at, null, null)
    // A long agentic turn: every step's words, tool calls and reasoning sit between the request and the answer.
    for (let step = 0; step < 12; step++) add.run(id, 'assistant', `Checking step ${step}`, `[{"id":"c${step}","function":{"name":"read"}}]`, at + 1 + step, 'tool_calls', BIG, 'step')
    add.run(id, 'assistant', 'Done: three beds, tomatoes in the sunniest.\n[WIZARD_STATUS_V1]{"state":"done","ask":"The beds are planned.","subject":"Garden"}[/WIZARD_STATUS_V1]', null, at + 20, 'stop', BIG)
  }
  return { path, db, add, thread, old }
}

describe.skipIf(!threadIo)('a Chats list rebuild reads only what changed (issue 584)', () => {
  it('an unchanged thread\'s truth comes from the remembered walk, equal to a fresh read', () => {
    const f = stateDb()
    const ids: any[] = ['wizard_a', 'wizard_b', 'wizard_c']
    for (const id of ids) f.thread(id)
    const reader = createHermesSessionTruthReader(f.path)
    cleanup.push(() => reader.close())
    const now = Date.now() / 1000
    let first: any, second: any
    const cold = readBytes(() => { first = reader.read(ids, now) })
    const warm = readBytes(() => { second = reader.read(ids, now) })
    expect(cold).toBeGreaterThan(3 * 12 * 100_000)
    expect(warm).toBeLessThan(cold / 10)
    expect(second).toEqual(first)
    expect(second).toEqual(readHermesSessionTruth(f.path, ids, now))
    expect(second.get('wizard_a')).toMatchObject({ requestPreview: 'Plan the garden beds for wizard_a', status: { state: 'done' } })
    expect(reader.stats()).toMatchObject({ hits: 3, walks: 3 })
  })

  it('a new message, an in-place rewrite or a compression end reads the thread again', () => {
    const f = stateDb()
    const ids: any[] = ['wizard_a', 'wizard_b']
    for (const id of ids) f.thread(id)
    const reader = createHermesSessionTruthReader(f.path)
    cleanup.push(() => reader.close())
    const now = Date.now() / 1000
    reader.read(ids, now)
    f.add.run('wizard_a', 'user', 'Add a herb bed too', null, f.old + 30, null, null)
    f.db.prepare("UPDATE messages SET content = 'Plan the vegetable beds' WHERE session_id = 'wizard_b' AND role = 'user'").run()
    const after = reader.read(ids, now)
    expect(after).toEqual(readHermesSessionTruth(f.path, ids, now))
    expect(after.get('wizard_a')?.requestPreview).toBe('Add a herb bed too')
    expect(after.get('wizard_b')?.requestPreview).toBe('Plan the vegetable beds')
    f.db.prepare("UPDATE sessions SET end_reason = 'compression' WHERE id = 'wizard_a'").run()
    expect(reader.read(ids, now)).toEqual(readHermesSessionTruth(f.path, ids, now))
    expect(reader.stats().hits).toBe(1) // only wizard_b, unchanged since its rewrite was read
  })

  it('a thread that just changed, or a state.db without transcript revisions, is read fresh every time', () => {
    const recent = stateDb()
    recent.thread('wizard_new', Date.now() / 1000 - 30)
    const a = createHermesSessionTruthReader(recent.path)
    cleanup.push(() => a.close())
    a.read(['wizard_new']); a.read(['wizard_new'])
    expect(a.stats()).toMatchObject({ hits: 0, walks: 2, size: 0 })
    const legacy = stateDb({ revisions: false })
    legacy.thread('wizard_old')
    const b = createHermesSessionTruthReader(legacy.path)
    cleanup.push(() => b.close())
    b.read(['wizard_old']); b.read(['wizard_old'])
    expect(b.stats()).toMatchObject({ hits: 0, walks: 2, size: 0 })
  })

  it('a remembered walk is read again after ten minutes, whatever the revision says', async () => {
    const { createTranscriptWalkMemo } = await import('../server/session-truth.mjs')
    let clock = 1_000_000
    const memo = createTranscriptWalkMemo({ now: () => clock })
    const db = {}
    memo.key(db, 'wizard_a', 0, '')
    memo.set('wizard_a', 'k1', { lastUserAt: 5, replies: [] })
    expect(memo.get('wizard_a', 'k1')).toEqual({ lastUserAt: 5, replies: [] })
    clock += 10 * 60_000
    expect(memo.get('wizard_a', 'k1')).toBeNull()
  })

  it('a replaced state.db never answers from the old file\'s walks', () => {
    const f = stateDb(); f.thread('wizard_a')
    const reader = createHermesSessionTruthReader(f.path)
    cleanup.push(() => reader.close())
    const now = Date.now() / 1000
    expect(reader.read(['wizard_a'], now).get('wizard_a')?.requestPreview).toBe('Plan the garden beds for wizard_a')
    const g = stateDb(); g.thread('wizard_a')
    g.db.prepare("UPDATE messages SET content = 'Restored request' WHERE role = 'user'").run()
    g.db.exec('UPDATE sessions SET transcript_revision = 0; PRAGMA wal_checkpoint(TRUNCATE)')
    renameSync(g.path, f.path)
    expect(reader.read(['wizard_a'], now).get('wizard_a')?.requestPreview).toBe('Restored request')
  })

  it('first posts whose thread is unchanged are memo hits without reading the first user rows again', () => {
    const f = stateDb()
    const ids: any[] = ['wizard_a', 'wizard_b']
    for (const id of ids) {
      f.thread(id)
      for (let n = 0; n < 8; n++) f.add.run(id, 'user', `${BIG} follow-up ${n}`, null, f.old + 40 + n, null, null)
    }
    let first: any, second: any
    const cold = readBytes(() => { first = readFirstPostPages(f.path, { ids, reach: true }) })
    expect(first.pages.map((page: any) => page.id)).toEqual(ids)
    const known = first.pages.map((page: any) => [page.id, page.key])
    // The list's memo still holds both keys: the second rebuild skips both bodies and keys.
    const warm = readBytes(() => { second = readFirstPostPages(f.path, { ids, known, reach: true }) })
    expect(cold).toBeGreaterThan(2 * 8 * 100_000)
    expect(warm).toBeLessThan(cold / 10)
    expect(second).toEqual({ hits: known, pages: [] })
    // A new owner message moves the thread's revision and its key: that thread's page is read again.
    f.add.run('wizard_a', 'user', 'One more', null, f.old + 60, null, null)
    const changed: any = readFirstPostPages(f.path, { ids, known, reach: true })
    expect(changed.pages.map((page: any) => page.id)).toEqual(['wizard_a'])
    expect(changed.hits).toEqual([known[1]])
    // A key the list no longer holds reads the page as before.
    const forgotten: any = readFirstPostPages(f.path, { ids: ['wizard_b'], known: [], reach: true })
    expect(forgotten.pages.map((page: any) => page.id)).toEqual(['wizard_b'])
  })

  it('a routed agent\'s list evidence remembers walks per agent state.db', () => {
    const main = stateDb(), agent = stateDb()
    agent.thread('wizard_agent_1'); agent.thread('wizard_agent_2')
    const reader = createListEvidenceReader(main.path)
    cleanup.push(() => reader.close())
    const ask = () => (reader.read as any)({ kind: 'agent-evidence', path: agent.path, ids: ['wizard_agent_1', 'wizard_agent_2'], now: Date.now() })
    let first: any, second: any
    const cold = readBytes(() => { first = ask() })
    const warm = readBytes(() => { second = ask() })
    expect(second).toEqual(first)
    expect(second.value.get('wizard_agent_1').truth.requestPreview).toBe('Plan the garden beds for wizard_agent_1')
    expect(warm).toBeLessThan(cold / 10)
    expect(reader.stats().agents[0]).toMatchObject({ hits: 2 })
  })
})
