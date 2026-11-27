// Issue 631: private mode edges (on for everyone; switch wizard/private-routing removed). A private agent's pushes are
// content-free, a private default agent owns its Daily, and the private agent's read grant also reaches the standard
// agent's imported History. The routed paths (sweep, Open / Send, scheduled sweeps) are covered per runtime by the
// parity check `private-routing-edges`; this file covers the pieces.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'
import { PRIVATE_PUSH_BODY, PRIVATE_PUSH_TITLE, contentFreeNote, contentFreePing, privatePushLink, privatePushes } from '../server/private-edges.mjs'
import { searchImportedHistory, standardChatRpc } from '../server/standard-chats.mjs'
import { createChannelStore } from '../server/channel-store.mjs'

const servers: Server[] = []
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined))) })

const SHELL = 'https://box.example.invalid:8796/wizard-os-home/'

describe('content-free pushes (issue 631)', () => {
  it('takes the words out and opens the shell', () => {
    const note = contentFreeNote({ agent: 'private', key: 'agent-alert:x', title: 'Rent failed', message: 'Your card ending 1234 was declined', link: 'https://bank.example/item/9', about: 'chats', tags: 'chat-reply' }, { shellUrl: SHELL, view: 'alerts' })
    expect(note).toEqual({ agent: 'private', key: 'agent-alert:x', about: 'chats', tags: 'chat-reply', title: PRIVATE_PUSH_TITLE, message: PRIVATE_PUSH_BODY, link: `${SHELL}?inbox=alerts` })
    // A link already into the shell (a thread's deep link: ids, never words) is kept.
    const thread = `${SHELL}?session=wizard_1&agent=private`
    expect(contentFreeNote({ title: 't', message: 'm', link: thread }, { shellUrl: SHELL }).link).toBe(thread)
    // No https shell address known: no link at all rather than an app's own page.
    expect(contentFreeNote({ title: 't', message: 'm', link: 'https://bank.example/x' }, { shellUrl: '' })).toEqual({ title: PRIVATE_PUSH_TITLE, message: PRIVATE_PUSH_BODY })
    expect(privatePushLink('http://plain/x')).toBe('')
  })

  it('wraps a notifications slot: only private agents, only while on', async () => {
    const sent: any[] = []
    let on = true
    const slot = privatePushes({ available: (a: string) => a !== 'nobody', send: async (n: any) => { sent.push(n); return { app: 'notifications' } } },
      { on: () => on, isPrivate: (a: string) => a === 'private', shellUrl: () => SHELL, view: 'alerts' })
    expect(slot.available('private')).toBe(true)
    expect(slot.available('nobody')).toBe(false)
    await slot.send({ agent: 'private', title: 'Secret', message: 'codeword PURPLE-OTTER' })
    await slot.send({ agent: 'hermes', title: 'Build done', message: 'All green' })
    on = false
    await slot.send({ agent: 'private', title: 'Secret', message: 'codeword PURPLE-OTTER' })
    expect(sent.map(n => [n.title, n.message])).toEqual([[PRIVATE_PUSH_TITLE, PRIVATE_PUSH_BODY], ['Build done', 'All green'], ['Secret', 'codeword PURPLE-OTTER']])
    expect(JSON.stringify(sent[0])).not.toContain('PURPLE-OTTER')
    expect(privatePushes(null as any, {})).toBeNull()
  })

  it('a ping keeps its id and time, never its words', () => {
    expect(contentFreePing({ id: 'inbox_1', title: 'Rent failed', ask: 'card declined', severity: 'high', link: 'https://bank/x', at: 5 }, SHELL))
      .toEqual({ id: 'inbox_1', title: PRIVATE_PUSH_TITLE, ask: '', severity: 'high', link: `${SHELL}?inbox=alerts`, at: 5, content_free: true })
  })
})

describe('the private default agent\u2019s own Daily (issue 631)', () => {
  it('is seeded once per agent and an archive sticks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'edges-daily-'))
    const store = createChannelStore(join(dir, 'channels.sqlite'))
    expect(store.dailyChannel('private')).toBeNull()
    const id = store.seedDailyFor('private')
    expect(id).toBe('daily-private')
    expect(store.dailyChannel('private')).toMatchObject({ id, agent: 'private', name: 'Daily', kind: 'daily' })
    expect(store.seedDailyFor('private')).toBeNull()
    expect(store.dailyChannel('hermes')).toBeNull() // the main agent's own Daily is its own seed
    store.close?.()
  })
})

function factStore(path: string) {
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE facts (fact_id INTEGER PRIMARY KEY, content TEXT UNIQUE, category TEXT, tags TEXT, trust_score REAL, created_at TEXT)')
  const add = db.prepare('INSERT INTO facts (content, category, tags, trust_score, created_at) VALUES (?, ?, ?, ?, ?)')
  add.run('Owner likes the lighthouse walk on Sundays', 'general', '', 0.5, '2026-11-20')
  add.run('[Earlier agent, 2025-03-02] The lighthouse keeper is called Ingrid', 'general', 'people,imported,earlier-agent', 0.3, '2026-11-21')
  add.run('[Earlier agent, 2025-04-02] The lighthouse door code is fixture-key', 'general', 'imported,earlier-agent', 0.3, '2026-11-21')
  db.close()
}

describe('imported History over the read grant (issue 631)', () => {
  it('finds imported facts first and History files, never a credential', () => {
    const dir = mkdtempSync(join(tmpdir(), 'edges-history-'))
    const home = join(dir, 'main-home'), files = join(dir, 'files')
    mkdirSync(home, { recursive: true })
    factStore(join(home, 'memory_store.db'))
    mkdirSync(join(files, 'Imported', 'Hermes', 'Chats', '2025'), { recursive: true })
    writeFileSync(join(files, 'Imported', 'Hermes', 'Chats', '2025', 'Boat trip.md'), '# Boat trip\n\nWe took the ferry past the Lighthouse at dawn and Ingrid waved.\n')
    writeFileSync(join(files, 'Imported', 'Hermes', 'Chats', '2025', 'Keys.md'), 'lighthouse fixture-key\n')
    writeFileSync(join(files, 'Imported', 'Hermes', 'image.png'), 'lighthouse')
    const found = searchImportedHistory(join(home, 'state.db'), files, 'Lighthouse Ingrid', { secrets: ['fixture-key'] })
    expect(found.facts).toEqual([{ kind: 'fact', imported: true, text: '[Earlier agent, 2025-03-02] The lighthouse keeper is called Ingrid', category: 'general', created: '2026-11-21' }])
    expect(found.files).toEqual([{ kind: 'file', path: 'Imported/Hermes/Chats/2025/Boat trip.md', excerpt: expect.stringContaining('Lighthouse at dawn and Ingrid waved') }])
    const all = searchImportedHistory(join(home, 'state.db'), files, 'lighthouse', { secrets: ['fixture-key'] })
    expect(all.facts.map(f => f.imported)).toEqual([true, false]) // imported History first; the keyed fact never
    expect(JSON.stringify(all)).not.toContain('fixture-key')
    expect(() => searchImportedHistory('', '', '  ')).toThrow()
    expect(searchImportedHistory('', '', 'lighthouse')).toEqual({ facts: [], files: [] })
  })

  it('the tool is listed only when the Service hands the History root', () => {
    const agent = { id: 'private', privacy: 'private', permissions: { read_standard_chats: true } }
    const principal = { kind: 'agent', agentId: 'private' }
    const list = (opts?: any) => (standardChatRpc(agent, principal, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, '', [], opts) as any).result.tools.map((t: any) => t.name)
    expect(list()).toEqual(['standard_chats_search', 'standard_chat_read', 'standard_memory_read'])
    expect(list({ history: { filesRoot: '' } })).toEqual(['standard_chats_search', 'standard_chat_read', 'standard_memory_read', 'standard_history_search'])
    const off = standardChatRpc(agent, principal, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'standard_history_search', arguments: { query: 'lighthouse' } } }, '', []) as any
    expect(off.result).toEqual({ content: [{ type: 'text', text: 'unknown_tool' }], isError: true })
  })

  async function box(lookOff = false) {
    const main = createServer((req, res) => { req.resume(); req.on('end', () => {
      const p = new URL(req.url ?? '/', 'http://x').pathname
      res.writeHead(p === '/health' ? 200 : 404, { 'Content-Type': 'application/json' }); res.end(p === '/health' ? '{"status":"ok"}' : '{}')
    }) })
    servers.push(main)
    const mainAddress = await listen(main) as import('node:net').AddressInfo
    const dir = mkdtempSync(join(tmpdir(), 'edges-box-'))
    const home = join(dir, 'main-home'), files = join(dir, 'files')
    mkdirSync(home, { recursive: true }); mkdirSync(join(dir, 'Pages', 'wizard-look'), { recursive: true })
    factStore(join(home, 'memory_store.db'))
    writeFileSync(join(dir, 'apps.json'), JSON.stringify({ schema: 1, apps: [] }))
    writeFileSync(join(dir, 'Pages', 'wizard-look', 'look.json'), JSON.stringify({ version: 1, skin: null, tweaks: lookOff ? { 'wizard/private-routing': { on: false, at: 1 } } : {} }))
    const svc = createWizardServer({
      upstreamOrigin: `http://127.0.0.1:${mainAddress.port}`, hermesKey: 'fixture-key', requireAccess: false, agentBridge: false,
      appsJsonPath: join(dir, 'apps.json'), settingsPath: join(dir, 'settings.json'), wizardOsHome: dir, hermesStatePath: join(home, 'state.db'),
      userFilesRoot: files, agentGatewayUrl: 'http://gateway:8923/wizard/mcp', followThrough: false, agentBasePort: 47930, runQueue: false,
      agentRuntime: { apply: async () => ({ ok: true }), start: async () => ({ ok: true }), stop: async () => ({ ok: true }) },
      pagesRoot: join(dir, 'Pages'), pagesGitDir: join(dir, 'pages-history.git'), pagesWatch: false,
    })
    servers.push(svc)
    const base = `http://127.0.0.1:${(await listen(svc) as import('node:net').AddressInfo).port}`
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
    const made = await (await post('/wizard/v1/agents', { label: 'Private', harness: 'hermes', model: { provider: 'tinfoil', model: 'glm-5-3' }, permissions: { preset: 'private', read_standard_chats: true } })).json()
    const key = readFileSync(join(dir, 'agents', made.agent.id, 'gateway.key'), 'utf8').trim()
    const rpc = (body: unknown) => post('/wizard/standard-chats/mcp', body, { Authorization: ['Bearer', key].join(' ') })
    return { rpc, base, post, made }
  }

  it('the private agent finds an imported fact through its own gateway key; an old Look file saying off changes nothing', async () => {
    const on = await box()
    expect(on.made.agent.permissions.read_standard_chats).toBe(true)
    const listed = await (await on.rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()
    expect(listed.result.tools.map((t: any) => t.name)).toContain('standard_history_search')
    const call = await (await on.rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'standard_history_search', arguments: { query: 'lighthouse keeper' } } })).json()
    expect(call.result.isError).toBe(false)
    expect(JSON.parse(call.result.content[0].text).facts[0].text).toContain('called Ingrid')
    // The standard (main) agent's own credential never reaches it: no agent principal, no grant.
    expect((await on.post('/wizard/standard-chats/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/list' })).status).toBe(403)
    const old = await box(true)
    const oldList = await (await old.rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()
    expect(oldList.result.tools.map((t: any) => t.name)).toEqual(['standard_chats_search', 'standard_chat_read', 'standard_memory_read', 'standard_history_search'])
  })
})
