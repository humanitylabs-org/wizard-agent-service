import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { STATUS_INSTRUCTIONS, parseStatus } from '../server/thread-status.mjs'
import { ANCHOR_SECONDS, TITLE_INSTRUCTIONS, ThreadTitleStore, appTopicName, clashCandidates, looksLikeOpener, looksLikeSentence, normalizeTitle, provisionalTitleFrom, titleContextLine, titleKey, titleToApply, topicFor } from '../server/thread-titles.mjs'
import { kinds, scene } from '../qa/agent-parity/fixture.mjs'
import { serverChecks } from '../qa/agent-parity/server-checks.mjs'
import { WIZARD_RUN_INSTRUCTIONS, createWizardServer, listen } from '../server/service.mjs'

const directories: string[] = []
const servers: Array<ReturnType<typeof createServer>> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
const tempDir = async () => { const d = await mkdtemp(join(tmpdir(), 'wizard-titles-')); directories.push(d); return d }
const tag = (value: object) => `Reply.\n\n[WIZARD_STATUS_V1]${JSON.stringify(value)}[/WIZARD_STATUS_V1]`

describe('title format', () => {
  it('compacts proposals into a short project label', () => {
    expect(normalizeTitle('WizardOS - Desktop')).toBe('WizardOS · Desktop')
    expect(normalizeTitle('WizardOS: Phone app.')).toBe('WizardOS · Phone app')
    expect(normalizeTitle('"WizardOS — Voice"')).toBe('WizardOS · Voice')
    expect(normalizeTitle('  ')).toBe('')
    const long = normalizeTitle('WizardOS · An extremely long project name that keeps going and going')
    expect(long.length).toBeLessThanOrEqual(32)
    expect(long.endsWith(' ')).toBe(false)
  })

  it('knows a sentence title from a label', () => {
    expect(looksLikeSentence('Review 0xMovez post on X')).toBe(true)
    expect(looksLikeSentence('Send voice note with text and images together')).toBe(true)
    expect(looksLikeSentence('WizardOS · Desktop')).toBe(false)
    expect(looksLikeSentence('Wizard Topics')).toBe(false)
  })

  it('asks the agent for a title in the status line and to keep it unless the project changed', () => {
    expect(STATUS_INSTRUCTIONS).toContain('"title":"WizardOS · Desktop"')
    expect(STATUS_INSTRUCTIONS).toContain('Return the thread\'s current title exactly')
    expect(WIZARD_RUN_INSTRUCTIONS).toContain('project-level label')
    expect(WIZARD_RUN_INSTRUCTIONS).toContain("hand that tab over with the Browser app's handoff tool")
    expect(parseStatus(tag({ state: 'done', ask: 'Shipped', subject: 'DeFleur', title: 'WizardOS - Desktop' }))).toEqual({ state: 'done', ask: 'Shipped', subject: 'DeFleur', title: 'WizardOS · Desktop' })
    expect(parseStatus(tag({ state: 'done', ask: 'Shipped' }))).toEqual({ state: 'done', ask: 'Shipped' })
  })

  it('names the project home, broadens legacy features once and never narrows a project for a sub-ask', () => {
    expect(TITLE_INSTRUCTIONS).toContain('project-level label')
    expect(TITLE_INSTRUCTIONS).toContain('one to four words and at most 32 characters')
    expect(TITLE_INSTRUCTIONS).toContain('only when the project itself changes')
    expect(TITLE_INSTRUCTIONS).toContain('one-time broadening')
    expect(TITLE_INSTRUCTIONS).not.toContain('or to a different feature')
    expect(TITLE_INSTRUCTIONS).not.toContain('the project, then the feature')
    expect(TITLE_INSTRUCTIONS).not.toContain('Messenger · Chats features')
    const decide = (currentTitle: string, proposed: string, locked = false) => titleToApply({ currentTitle, proposed, record: { locked, appliedFor: null }, assistantAt: 1 })
    expect(decide('Messenger', 'Messenger · Settings buttons')).toBe('')
    expect(decide('Messenger #2', 'Messenger · Composer paste')).toBe('')
    expect(decide('Messenger · Composer paste', 'Messenger')).toBe('Messenger')
    expect(decide('Messenger · Composer paste', 'Messenger', true)).toBe('')
    expect(decide('Messenger', 'Video Editor')).toBe('Video Editor')
    expect(decide('WizardOS · Desktop', 'WizardOS · Phone app')).toBe('WizardOS · Phone app')
  })
})

describe('when a title changes', () => {
  it('renames only on a different project, once per reply, never over a lock', () => {
    expect((titleToApply as any)({ currentTitle: 'WizardOS · Desktop', proposed: 'WizardOS · Desktop', record: null, assistantAt: 1 })).toBe('')
    expect((titleToApply as any)({ currentTitle: 'WizardOS · Desktop', proposed: 'WizardOS · desktop', record: null, assistantAt: 1 })).toBe('')
    expect((titleToApply as any)({ currentTitle: 'WizardOS · Desktop #2', proposed: 'WizardOS · Desktop', record: null, assistantAt: 1 })).toBe('')
    expect((titleToApply as any)({ currentTitle: 'Review 0xMovez post on X', proposed: 'DeFleur', record: null, assistantAt: 1 })).toBe('DeFleur')
    expect((titleToApply as any)({ currentTitle: 'A', proposed: 'B project', record: { locked: true }, assistantAt: 1 })).toBe('')
    expect((titleToApply as any)({ currentTitle: 'A', proposed: 'B project', record: { appliedFor: 7 }, assistantAt: 7 })).toBe('')
  })

  it('marks renames in the thread, quietly for a barely-seen opener title', async () => {
    let now = 1_000_000
    const path = join(await tempDir(), 'titles.json')
    const store: any = new ThreadTitleStore(path, { now: () => now })
    // The opener's sentence title, replaced minutes after the thread started: nothing to mark.
    store.recordRename('s1', { from: 'Send voice note with text', to: 'WizardOS · Voice notes', by: 'agent', assistantAt: 1, since: now - 120 })
    expect(store.visibleHistory('s1')).toEqual([])
    // Days later the work moves: the thread marks where.
    now += 2 * 86400
    store.recordRename('s1', { from: 'WizardOS · Voice notes', to: 'WizardOS · Desktop', by: 'agent', assistantAt: 2 })
    expect(store.visibleHistory('s1').map((r: any) => r.from)).toEqual(['WizardOS · Voice notes'])
    expect(new ThreadTitleStore(path).get('s1')?.title).toBe('WizardOS · Desktop')
    // James renames: locked.
    store.recordRename('s1', { from: 'WizardOS · Desktop', to: 'Captions', by: 'you' })
    expect(store.get('s1')?.locked).toBe(true)
    expect(ANCHOR_SECONDS).toBe(1800)
  })

  it('tells each run what the thread is called', () => {
    expect(titleContextLine('WizardOS · Desktop', {})).toContain('“WizardOS · Desktop”')
    const locked = titleContextLine('Captions', { locked: true })
    expect(locked).toContain('“Captions”, and that title is fixed')
    expect(locked).not.toMatch(/James|himself|herself/u)
  })
})

describe('topic titles: the app or area, never the opener words', () => {
  const catalog = [{ id: 'messenger', name: 'Messenger' }, { id: 'notes', name: 'Notes' }, { id: 'wisdom', name: 'Wisdom' }, { id: 'money', name: 'Money' }, { id: 'meditate-next', name: 'Meditate (test)' }]

  it('names the topic from the status line app, then an app the text names, then the subject', () => {
    expect(appTopicName('messenger', catalog)).toBe('Messenger')
    expect(appTopicName('meditate-next', catalog)).toBe('Meditate')
    expect(appTopicName('wizard-music', catalog)).toBe('Music') // not in the catalogue: its id without the wizard- prefix
    expect(topicFor({ appId: 'wizard-music', catalog, texts: ['Notes app'], subject: 'Infrastructure' })).toBe('Music')
    expect(topicFor({ catalog, texts: ['Notes app having dumb popups'] })).toBe('Notes')
    expect(topicFor({ catalog, texts: ['Build ai lookup from wisdom'] })).toBe('Wisdom')
    expect(topicFor({ catalog, texts: ['WizardOS general thread'] })).toBe('WizardOS')
    expect(topicFor({ catalog, texts: ['I spent money on lunch'] })).toBe('') // a generic app word needs "app" after it
    expect(topicFor({ catalog, texts: ['Open the Money app'] })).toBe('Money')
    expect(topicFor({ catalog, texts: ['With Novaire right now, could'], subject: 'Infrastructure' })).toBe('Infrastructure')
    expect(topicFor({ catalog, texts: ['x'], subject: 'Wizard Apps' })).toBe('')
  })

  it('knows opener fragments from labels', () => {
    for (const opener of ['Bro on music, I am', 'My messenger isn\'t loading', 'With Novaire right now, could', 'Actually just realized I don\'t', 'Troubleshoot chat that won\'t', 'Mythological terms for lesser false gods']) expect(looksLikeOpener(opener), opener).toBe(true)
    for (const label of ['Music', 'Messenger', 'Notes', 'WizardOS · Voice', 'WizardOS · Phone app', 'TSR podcast', 'Tokyo trip', 'Rabbit R1 setup', 'VPS performance', 'GitHub sync']) expect(looksLikeOpener(label), label).toBe(false)
  })

  it('replaces an echoed placeholder or an opener-word proposal with the topic, and only then', () => {
    const placeholder = { provisional: true, locked: false, appliedFor: null, title: 'Bro on music, I am', history: [] }
    const decide = (currentTitle: string, proposed: string, record: any, topic?: string) => (titleToApply as any)({ currentTitle, proposed, record, assistantAt: 3, topic })
    // The agent repeats the placeholder (the live failure): topic wins; without a topic the placeholder stays untouched.
    expect(decide('Bro on music, I am', 'Bro on music, I am', placeholder, 'Music')).toBe('Music')
    expect(decide('Bro on music, I am', 'Bro on music, I am', placeholder, '')).toBe('')
    // The agent proposes opener words that differ from the placeholder.
    expect(decide('Bro on music, I am', 'Bro on music, I am going to', placeholder, 'Music')).toBe('Music')
    // A real label from the agent still wins over the Service's guess.
    expect(decide('Bro on music, I am', 'Wizard Music', placeholder, 'Music')).toBe('Wizard Music')
    // A sentence-titled agent thread gets the topic once the agent echoes it.
    expect(decide('Troubleshoot chat that won\'t', 'Troubleshoot chat that won\'t', { locked: false, appliedFor: null, history: [{ by: 'agent' }] }, 'Chats')).toBe('Chats')
    // Owner locks and per-reply once-only stay absolute.
    expect(decide('Mine', 'Mine too', { ...placeholder, locked: true }, 'Music')).toBe('')
    expect((titleToApply as any)({ currentTitle: 'Bro on music, I am', proposed: 'Bro on music, I am', record: { ...placeholder, appliedFor: 3 }, assistantAt: 3, topic: 'Music' })).toBe('')
    // Without a topic option (routed agents such as Philosopher) behaviour is exactly as before.
    expect(decide('Review 0xMovez post on X', 'Bro on music, I am', null)).toBe('Bro on music, I am')
    expect(decide('WizardOS · Chats', 'Messenger', null, 'Notes')).toBe('Messenger')
  })

  it('puts a clash-free spelling on a title another thread holds: dated, never numbered', () => {
    const at = new Date(Date.UTC(2026, 10, 8, 13, 5))
    expect(clashCandidates('Messenger', at)).toEqual(['Messenger', 'Messenger (8 Nov)', 'Messenger (8 Nov 13:05)'])
    for (const c of clashCandidates('WizardOS · Phone app experience', at)) expect(c.length).toBeLessThanOrEqual(32)
    expect(clashCandidates('Messenger', at, 'wizard_ab12')).toEqual(['Messenger', 'Messenger (8 Nov)', 'Messenger (8 Nov 13:05)', 'Messenger (8 Nov 13:05 ab12)'])
    expect(titleKey('Messenger (8 Nov 13:05 ab12)')).toBe('messenger')
    expect(titleContextLine('Music, I am', { provisional: true })).toMatch(/only a placeholder/)
    expect(titleKey('Messenger (8 Nov)')).toBe('messenger')
    expect(titleKey('Messenger (8 Nov 13:05)')).toBe('messenger')
    expect(titleToApply({ currentTitle: 'Messenger (8 Nov)', proposed: 'Messenger', record: null, assistantAt: 1 })).toBe('')
  })

  it('cuts the first-message placeholder at the app the opener names', () => {
    expect(provisionalTitleFrom('The Notes app keeps showing dumb popups', catalog)).toBe('Notes')
    expect(provisionalTitleFrom('Fix the calendar sync bug on the phone app please', catalog)).toBe('Fix the calendar sync bug')
    expect(provisionalTitleFrom('Fix the calendar sync bug on the phone app please')).toBe('Fix the calendar sync bug')
  })

  it('tells the agent a placeholder is not a label and apps are named plainly', () => {
    const line = titleContextLine('Bro on music, I am', { provisional: true })
    expect(line).toContain('never repeat it')
    expect(line).toContain('app or area')
    expect(TITLE_INSTRUCTIONS).toContain('plain name')
    expect(TITLE_INSTRUCTIONS).toContain('no number')
    expect(TITLE_INSTRUCTIONS).toContain('opening words')
  })
})

describe('the Agent Service applies titles through Hermes', () => {
  async function fixture({ titleSource = 'llm', startedAgo = 5 * 86400, title = 'Review 0xMovez post on X' as string | null, queued = false, apps = null as null | Array<{ id: string, name: string }>, extra = {} as Record<string, unknown> } = {}) {
    const directory = await tempDir()
    const now = Date.now() / 1000
    const statePath = join(directory, 'state.db')
    const state = new DatabaseSync(statePath)
    state.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at REAL, title TEXT, title_source TEXT);
      CREATE TABLE messages (session_id TEXT, role TEXT, finish_reason TEXT, content TEXT, display_kind TEXT, timestamp REAL, active INTEGER DEFAULT 1);
      CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL);
    `)
    state.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run('wizard_t1', now - startedAgo, title, title === null ? null : titleSource)
    state.close()
    if (apps) await writeFile(join(directory, 'apps.json'), JSON.stringify({ schema: 1, apps }))
    const reply: Record<string, string> = { title: 'DeFleur' }
    const clock = { bump: 0 }
    const patches: Array<{ id: string, body: any }> = []
    const runs: any[] = []
    const upstream = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const raw = Buffer.concat(chunks).toString('utf8')
      res.setHeader('Content-Type', 'application/json')
      if (url.pathname === '/v1/capabilities') { res.end(JSON.stringify({ features: {} })); return }
      if (req.method === 'POST' && url.pathname === '/v1/runs') { runs.push(JSON.parse(raw)); res.end(JSON.stringify({ run_id: 'run_1', status: 'running' })); return }
      const patch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
      if (patch && req.method === 'PATCH') {
        const body = JSON.parse(raw)
        patches.push({ id: patch[1], body })
        const db = new DatabaseSync(statePath)
        // Hermes keeps session titles unique.
        if (db.prepare('SELECT 1 FROM sessions WHERE title = ? AND id != ?').get(body.title, patch[1])) { db.close(); res.statusCode = 400; res.end(JSON.stringify({ error: 'Title already in use' })); return }
        db.prepare("UPDATE sessions SET title = ?, title_source = 'user' WHERE id = ?").run(body.title, patch[1])
        db.close()
        res.end(JSON.stringify({ session: { id: patch[1], title: body.title } }))
        return
      }
      if (url.pathname === '/api/sessions') {
        const db = new DatabaseSync(statePath, { readOnly: true })
        const title = (db.prepare('SELECT title FROM sessions WHERE id = ?').get('wizard_t1') as any).title
        db.close()
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'wizard_t1', source: 'api_server', title, message_count: 2, last_active: now }] }))
        return
      }
      if (/^\/api\/sessions\/wizard_t1\/messages$/.test(url.pathname)) {
        res.end(JSON.stringify({ data: [
          { role: 'user', timestamp: now - 60, content: 'Go' },
          { role: 'assistant', display_kind: 'final', timestamp: now - 10 + clock.bump, content: tag({ state: 'done', ask: 'Shipped captions', subject: 'DeFleur', ...reply }) },
        ] }))
        return
      }
      res.statusCode = 404; res.end('{}')
    })
    servers.push(upstream)
    const upstreamAddress = await listen(upstream) as any
    const app = createWizardServer({
      requireJoinedDelegationCapability: false,
      upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      hermesKey: 'fixture-key',
      requireAccess: false,
      hermesStatePath: statePath,
      archivedSessionReader: () => [],
      threadTitleStatePath: join(directory, 'titles.json'),
      ...(apps ? { appsJsonPath: join(directory, 'apps.json') } : {}),
      ...(queued ? { runQueueStatePath: join(directory, 'queue.sqlite3'), dispatchHealthReader: () => true, activeSessionReader: () => [] } : {}),
      ...extra,
    })
    servers.push(app)
    const origin = `http://127.0.0.1:${(await listen(app) as any).port}`
    const list = async () => (await (await fetch(`${origin}/wizard/hermes/api/sessions?limit=20`)).json()).data[0]
    return { origin, list, patches, runs, reply, statePath, clock, directory }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

  // WizardOS is one word (James, 8 Nov 2026): stored titles are respelled once, keeping who owns them.
  const TWO = `Wizard${' '}OS`
  const receipt = async (directory: string) => {
    for (let i = 0; i < 40; i += 1) {
      try { return JSON.parse(await (await import('node:fs/promises')).readFile(join(directory, 'titles.json.wizardos-respell.json'), 'utf8')) } catch { await settle() }
    }
    throw new Error('no respell receipt')
  }
  it('respells a stored agent title once and the agent may still rename it', async () => {
    const { list, patches, reply, directory } = await fixture({ title: `${TWO} · Desktop`, extra: { respellDelayMs: 5 } })
    reply.title = 'WizardOS · Desktop'
    const done = await receipt(directory)
    expect(done.renamed).toEqual([expect.objectContaining({ id: 'wizard_t1', from: `${TWO} · Desktop`, to: 'WizardOS · Desktop', locked: false })])
    expect(done.titles_before).toEqual([expect.objectContaining({ id: 'wizard_t1', title: `${TWO} · Desktop` })])
    expect(patches).toEqual([{ id: 'wizard_t1', body: { title: 'WizardOS · Desktop' } }])
    expect((await list()).title).toBe('WizardOS · Desktop'); await settle()
    const stored = JSON.parse(await (await import('node:fs/promises')).readFile(join(directory, 'titles.json'), 'utf8')).threads.wizard_t1
    expect(stored).toMatchObject({ title: 'WizardOS · Desktop', locked: false })
    expect(stored.history.at(-1)).toMatchObject({ by: 'agent', quiet: true, to: 'WizardOS · Desktop' })
    expect(patches).toHaveLength(1)
  })
  it("respells the owner's own title and keeps it locked", async () => {
    const { list, patches, directory } = await fixture({ title: `My ${TWO} notes`, titleSource: 'user', extra: { respellDelayMs: 5 } })
    const done = await receipt(directory)
    expect(done.renamed).toEqual([expect.objectContaining({ to: 'My WizardOS notes', locked: true })])
    expect((await list()).title).toBe('My WizardOS notes'); await settle()
    expect(patches).toEqual([{ id: 'wizard_t1', body: { title: 'My WizardOS notes' } }])
  })
  it('a title the one-time respell could not fix is tried again on the next start', async () => {
    const { directory: dir } = await fixture({ title: `${TWO} · Desktop`, extra: { respellStoredTitles: false } })
    const fs = await import('node:fs/promises')
    await fs.writeFile(join(dir, 'titles.json.wizardos-respell.json'), JSON.stringify({ schema: 1, renamed: [], failed: ['wizard_t1'], passes: 1 }))
    const { patches } = await fixture({ title: `${TWO} · Desktop`, extra: { respellDelayMs: 5, threadTitleStatePath: join(dir, 'titles.json') } })
    let done: any = null
    for (let i = 0; i < 40 && !(done?.passes >= 2); i += 1) { await settle(); done = JSON.parse(await fs.readFile(join(dir, 'titles.json.wizardos-respell.json'), 'utf8')) }
    expect(done).toMatchObject({ passes: 2, failed: [] })
    expect(done.renamed).toEqual([expect.objectContaining({ id: 'wizard_t1', to: 'WizardOS · Desktop' })])
    expect(patches).toEqual([{ id: 'wizard_t1', body: { title: 'WizardOS · Desktop' } }])
  })
  it('shows WizardOS before the stored title is fixed, and spells an owner rename in one word', async () => {
    const { origin, list, patches } = await fixture({ title: `${TWO} plans`, titleSource: 'user', extra: { respellStoredTitles: false } })
    expect((await list()).title).toBe('WizardOS plans'); await settle()
    expect(patches).toEqual([{ id: 'wizard_t1', body: { title: 'WizardOS plans' } }])
    const renamed = await fetch(`${origin}/wizard/hermes/api/sessions/wizard_t1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: `${TWO.toLowerCase()} roadmap` }) })
    expect(renamed.ok).toBe(true)
    expect(patches.at(-1)).toEqual({ id: 'wizard_t1', body: { title: 'WizardOS roadmap' } })
  })

  it('renames a sentence-titled thread from the status line once, then marks it in the thread only', async () => {
    const { list, patches } = await fixture()
    await list(); await settle()
    expect(patches).toEqual([{ id: 'wizard_t1', body: { title: 'DeFleur' } }])
    const row = await list(); await settle()
    expect(row.title).toBe('DeFleur')
    expect(row.wizard_title_was).toBeUndefined()
    expect(row.wizard_title_renames).toEqual([expect.objectContaining({ from: 'Review 0xMovez post on X', to: 'DeFleur', by: 'agent' })])
    expect(patches).toHaveLength(1)
  })

  it('leaves a title James set alone and remembers his own renames', async () => {
    const { origin, list, patches } = await fixture({ titleSource: 'user' })
    await list(); await settle()
    expect(patches).toEqual([])
    const renamed = await fetch(`${origin}/wizard/hermes/api/sessions/wizard_t1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Movez thread' }) })
    expect(renamed.ok).toBe(true)
    const row = await list(); await settle()
    expect(row.title).toBe('Movez thread')
    expect(row.wizard_title_was).toBeUndefined()
    expect(patches).toHaveLength(1)
  })

  it('names a new thread from its first message within the send, then lets the agent title replace it', async () => {
    const { origin, list, patches, reply } = await fixture({ title: null, startedAgo: 5, queued: true })
    reply.title = 'Calendar'
    const sent = await fetch(`${origin}/wizard/hermes/v1/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'first-send-1' }, body: JSON.stringify({ session_id: 'wizard_t1', input: [{ role: 'user', content: [{ type: 'text', text: 'Hey, can you fix the calendar sync bug please' }] }] }) })
    expect(sent.ok).toBe(true)
    await settle()
    expect(patches).toEqual([{ id: 'wizard_t1', body: { title: 'Fix the calendar sync bug' } }])
    const row = await list(); await settle()
    expect(row.title).toBe('Fix the calendar sync bug') // the list shows the placeholder before the first reply ends
    // The first final reply carries the agent's own title: it replaces the placeholder, never the reverse.
    expect(patches.map((patch) => patch.body.title)).toEqual(['Fix the calendar sync bug', 'Calendar'])
    const after = await list()
    expect(after.title).toBe('Calendar')
    expect(after.wizard_title_provisional).toBeUndefined()
    expect(patches).toHaveLength(2)
  })

  const firstSend = (origin: string, key: string, text: string) => fetch(`${origin}/wizard/hermes/v1/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ session_id: 'wizard_t1', input: [{ role: 'user', content: [{ type: 'text', text }] }] }) })

  it('replaces an opener placeholder the agent repeats with the app name', async () => {
    const { origin, list, patches, reply } = await fixture({ title: null, startedAgo: 5, queued: true, apps: [{ id: 'messenger', name: 'Messenger' }] })
    reply.title = 'Fix my chat window thing' // the agent repeats the placeholder the Service cut from the opener
    reply.app_id = 'messenger'
    await firstSend(origin, 'first-send-3', 'Fix my chat window thing now please')
    await settle()
    expect(patches.map((patch) => patch.body.title)).toEqual(['Fix my chat window thing'])
    await list(); await settle()
    expect(patches.map((patch) => patch.body.title)).toEqual(['Fix my chat window thing', 'Messenger'])
    const after = await list()
    expect(after.title).toBe('Messenger')
  })

  it('dates a second thread on the same app instead of numbering it', async () => {
    const { origin, list, patches, reply, statePath } = await fixture({ title: null, startedAgo: 5, queued: true, apps: [{ id: 'messenger', name: 'Messenger' }] })
    const db = new DatabaseSync(statePath)
    db.prepare("INSERT INTO sessions VALUES ('wizard_other', 1, 'Messenger', 'llm')").run(); db.close()
    reply.title = 'Fix my chat window thing'
    reply.app_id = 'messenger'
    await firstSend(origin, 'first-send-4', 'Fix my chat window thing now please')
    await settle(); await list(); await settle()
    const titles = patches.map((patch) => patch.body.title)
    expect(titles[0]).toBe('Fix my chat window thing')
    expect(titles.slice(1)).toEqual(clashCandidates('Messenger').slice(0, 2))
    expect(titles.join('|')).not.toMatch(/#\d/u)
    expect((await list()).title).toBe(clashCandidates('Messenger')[1])
  })

  it('never puts a placeholder over a title that exists or one James set', async () => {
    const { origin, patches } = await fixture({ titleSource: 'user', queued: true })
    await fetch(`${origin}/wizard/hermes/v1/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'first-send-2' }, body: JSON.stringify({ session_id: 'wizard_t1', input: [{ role: 'user', content: [{ type: 'text', text: 'Fix the calendar sync bug' }] }] }) })
    await settle()
    expect(patches).toEqual([])
  })

  it('tells the next run the current title', async () => {
    const { origin, runs } = await fixture()
    const sent = await fetch(`${origin}/wizard/hermes/v1/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: 'wizard_t1', input: 'hi' }) })
    expect(sent.ok).toBe(true)
    expect(String(runs[0].instructions)).toContain('This thread is currently titled “Review 0xMovez post on X”.')
  })
})

// Real Service HTTP routes; disposable synthetic runtimes, never existing owner agents.
describe('project-title runtime parity', () => {
  for (const kind of kinds) {
    it(`delivers and applies the same project rule on ${kind}`, async () => {
      const s = await scene(kind)
      try {
        const created = await s.request('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'wizard_parity', source: 'wizard-mobile' }) })
        expect(created.status).toBe(201)
        await serverChecks['automatic-titles'](s)
      } finally { await s.close() }
    })
  }
})
