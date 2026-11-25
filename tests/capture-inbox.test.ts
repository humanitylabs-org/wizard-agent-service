// wizard-os issue 696: capture inboxes. The owner drops things in Inbox/ of his Files; after a quiet period the box
// hands the batch to the main agent as one agent-inbox record and one hidden worker turn, and the agent files every
// item with wizard_capture only (logged), so "undo that" puts the whole batch back exactly. Switch off: nothing.
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { CAPTURE_TOOL, DEFAULT_RULES, RULES_FILE, batchTurnText, captureTool, cleanFolder, createCaptureInbox } from '../server/capture-inbox.mjs'
import { AgentInboxStore } from '../server/agent-inbox.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

const dirs: string[] = [], servers: any[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections?.(); s.close(() => r()) })))
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }))
})
const home = () => { const d = mkdtempSync(join(tmpdir(), 'capture-inbox-')); dirs.push(d); return d }
const walk = (root: string, dir = root): string[] => readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(root, p) : [relative(root, p)] }).sort()
// The issue's done-when batch: 2 receipts, 1 PDF article, 1 photo of a book page, 1 voice note.
const FIVE: Record<string, string> = {
  'IMG_2041.jpg': 'jpeg: cafe receipt 4.20', 'taxi-receipt.pdf': '%PDF-1.4 taxi receipt 31.00', 'why-we-sleep.pdf': '%PDF-1.4 article',
  'IMG_2042.jpg': 'jpeg: book page with highlights', 'voice-note.m4a': 'm4a: these are the Tokyo receipts',
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
// A clock the test moves by hand; file change times are real, so the baseline is taken in real time first.
const clock = () => { const c = { at: Date.now(), now: () => c.at }; return c }

function box(extra: any = {}) {
  const d = home(), root = join(d, 'media')
  mkdirSync(join(root, 'Inbox'), { recursive: true })
  const c = clock()
  const inbox: any = createCaptureInbox({ root, statePath: join(d, 'capture.json'), now: c.now, quietMs: 60_000, ...extra })
  return { d, root, c, inbox }
}
async function arrived(root: string, files: Record<string, string>, day = '2026-11-25') {
  await sleep(5)
  mkdirSync(join(root, 'Inbox', day), { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, 'Inbox', day, name), text)
}

describe('the watcher (module)', () => {
  it('turning it on takes a baseline: what is already in Inbox is never batched', async () => {
    const { root, c, inbox } = box()
    await arrived(root, { 'old-scan.pdf': 'from last year' }, '2025-01-02')
    expect(inbox.scan()).toBeNull() // baseline
    c.at += 10 * 60_000
    expect(inbox.scan()).toBeNull()
    expect(inbox.pending()).toBe(0)
  })

  it('a batch waits for the quiet period, a growing file keeps it waiting, then all 5 come as one batch', async () => {
    const { root, c, inbox } = box()
    inbox.scan()
    await arrived(root, FIVE)
    expect(inbox.scan()).toBeNull()
    expect(inbox.pending()).toBe(5)
    c.at += 50_000
    writeFileSync(join(root, 'Inbox', '2026-11-25', 'voice-note.m4a'), 'm4a: these are the Tokyo receipts, and more bytes')
    expect(inbox.scan()).toBeNull() // still growing
    c.at += 50_000
    expect(inbox.scan()).toBeNull() // 50 s after the last change
    c.at += 20_000
    const batch = inbox.scan()
    expect(batch?.items.map((i: any) => [i.name, i.kind]).sort()).toEqual([['IMG_2041.jpg', 'image'], ['IMG_2042.jpg', 'image'], ['taxi-receipt.pdf', 'pdf'], ['voice-note.m4a', 'audio'], ['why-we-sleep.pdf', 'pdf']])
    c.at += 10 * 60_000
    expect(inbox.scan()).toBeNull() // never batched twice
  })

  it('chat attachments, hidden files and symlinks are never batched', async () => {
    const d = home(), root = join(d, 'media')
    mkdirSync(join(root, 'Inbox'), { recursive: true })
    const c = clock()
    const inbox: any = createCaptureInbox({ root, now: c.now, quietMs: 1000, chatFiles: () => new Set(['Inbox/2026-11-25/chat-photo.jpg']) })
    inbox.scan()
    await arrived(root, { 'chat-photo.jpg': 'sent in a chat', '.syncthing.tmp': 'partial', 'drop.pdf': '%PDF' })
    writeFileSync(join(d, 'outside.txt'), 'outside')
    symlinkSync(join(d, 'outside.txt'), join(root, 'Inbox', '2026-11-25', 'link.txt'))
    inbox.scan(); c.at += 2000
    expect(inbox.scan()?.items.map((i: any) => i.name)).toEqual(['drop.pdf'])
  })

  it('the switch going off and on again takes a new baseline', async () => {
    const { root, c, inbox } = box({ quietMs: 1000 })
    inbox.scan()
    expect(inbox.pause()).toBe(true)
    await arrived(root, { 'while-off.pdf': '%PDF' })
    expect(inbox.scan()).toBeNull() // baseline again
    c.at += 5000
    expect(inbox.scan()).toBeNull()
  })
})

describe('filing, notes and undo (module)', () => {
  async function batchOfFive() {
    const b = box({ quietMs: 1000 })
    b.inbox.scan()
    await arrived(b.root, FIVE)
    b.inbox.scan(); b.c.at += 2000
    const batch = b.inbox.scan()
    const before = Object.fromEntries(walk(b.root).map(p => [p, readFileSync(join(b.root, p), 'utf8')]))
    return { ...b, batch, before }
  }
  const item = (batch: any, name: string) => batch.items.find((i: any) => i.name === name).item

  it('files all 5 by rule, then "undo that" restores every file exactly and takes the notes out', async () => {
    const { root, inbox, batch, before } = await batchOfFive()
    writeFileSync(join(root, 'Reading-existing.md'), 'keep me\n')
    mkdirSync(join(root, 'Reading'), { recursive: true })
    writeFileSync(join(root, 'Reading', 'Why We Sleep.md'), '# Why We Sleep\n\nEarlier highlight.\n')
    const beforeAll = Object.fromEntries(walk(root).map(p => [p, readFileSync(join(root, p), 'utf8')]))
    const b = batch.id
    expect(inbox.file(b, item(batch, 'IMG_2041.jpg'), { folder: 'Documents/Receipts/2026', judged_as: 'receipt', rule: 'Receipts and invoices' })).toMatchObject({ folder: 'Documents/Receipts/2026' })
    inbox.file(b, item(batch, 'taxi-receipt.pdf'), { folder: 'Documents/Receipts/2026', judged_as: 'receipt', rule: 'Receipts and invoices' })
    inbox.file(b, item(batch, 'why-we-sleep.pdf'), { folder: 'Reading/Articles', judged_as: 'article', rule: 'Articles' })
    inbox.note(b, item(batch, 'IMG_2042.jpg'), { path: 'Reading/Why We Sleep.md', text: '> Sleep is the single most effective thing we can do.', judged_as: 'book page', rule: 'Photos of book pages' })
    inbox.note(b, item(batch, 'IMG_2042.jpg'), { path: 'Reading/Thinking, Fast and Slow.md', text: '# Thinking, Fast and Slow\n\n> A new note.' })
    inbox.file(b, item(batch, 'IMG_2042.jpg'), { folder: 'Reading/Why We Sleep', judged_as: 'book page', rule: 'Photos of book pages' })
    inbox.file(b, item(batch, 'voice-note.m4a'), { folder: 'Voice notes', judged_as: 'voice note', rule: 'A voice note in a batch' })
    expect(inbox.finish(b, '5 filed from Inbox: 2 receipts to Documents/Receipts/2026, 1 article, 1 book page, 1 voice note')).toMatchObject({ waiting: [] })
    expect(walk(join(root, 'Inbox'))).toEqual([])
    expect(readFileSync(join(root, 'Reading', 'Why We Sleep.md'), 'utf8')).toContain('Sleep is the single most effective')
    const view = inbox.view(inbox.batch(b))
    expect(view.items.every((i: any) => i.state === 'filed')).toBe(true)
    expect(view.log.filter((e: any) => e.action === 'file')).toHaveLength(5)

    const undone = inbox.undo()
    expect(undone).toMatchObject({ batch: b, restored: 7, problems: [], items_back_in_inbox: 5, of: 5 })
    const after = Object.fromEntries(walk(root).map(p => [p, readFileSync(join(root, p), 'utf8')]))
    expect(after).toEqual(beforeAll)
    // The folders filing made are gone again; the owner's own Reading folder stays.
    expect(readdirSync(root).sort()).toEqual(['Capture rules.md', 'Inbox', 'Reading', 'Reading-existing.md'].filter(n => existsSync(join(root, n))).sort())
    expect(existsSync(join(root, 'Documents'))).toBe(false)
    expect(existsSync(join(root, 'Voice notes'))).toBe(false)
    expect(readdirSync(join(root, 'Reading'))).toEqual(['Why We Sleep.md'])
    expect(Object.keys(before).filter(p => p.startsWith('Inbox/'))).toHaveLength(5)
    // Put back means left alone: the watcher does not batch them again.
    expect(inbox.scan()).toBeNull()
  })

  it('never overwrites, never files into Inbox or outside the root, and refuses unknown items', async () => {
    const { root, inbox, batch } = await batchOfFive()
    mkdirSync(join(root, 'Documents', 'Receipts'), { recursive: true })
    writeFileSync(join(root, 'Documents', 'Receipts', 'IMG_2041.jpg'), 'an older receipt')
    const r = inbox.file(batch.id, 'IMG_2041.jpg', { folder: 'Documents/Receipts' })
    expect(r.filed.endsWith('Documents/Receipts/IMG_2041 (2).jpg')).toBe(true)
    expect(readFileSync(join(root, 'Documents', 'Receipts', 'IMG_2041.jpg'), 'utf8')).toBe('an older receipt')
    for (const folder of ['Inbox/2026', '../outside', '.hidden', '', 'a/../../b']) expect(() => inbox.file(batch.id, 'taxi-receipt.pdf', { folder })).toThrow()
    expect(() => inbox.file(batch.id, 'not-in-batch.pdf', { folder: 'Documents' })).toThrow(/no item/)
    expect(() => cleanFolder('/media/Documents/X', { agentRoot: '/media' })).not.toThrow()
    expect(cleanFolder('/media/Documents/X', { agentRoot: '/media' })).toBe('Documents/X')
  })

  it('undo leaves a file alone when something else took its place, and says so', async () => {
    const { root, inbox, batch } = await batchOfFive()
    inbox.file(batch.id, 'taxi-receipt.pdf', { folder: 'Documents' })
    writeFileSync(join(root, 'Inbox', '2026-11-25', 'taxi-receipt.pdf'), 'a new drop with the same name')
    const r = inbox.undo(batch.id)
    expect(r.problems).toEqual(['taxi-receipt.pdf: another file is now at Inbox/2026-11-25/taxi-receipt.pdf'])
    expect(existsSync(join(root, 'Documents', 'taxi-receipt.pdf'))).toBe(true)
  })

  it('a mark on a file that left Inbox goes, so a new drop reusing the inode is still new', async () => {
    const { root, c, inbox, batch } = await batchOfFive()
    inbox.file(batch.id, 'taxi-receipt.pdf', { folder: 'Documents' })
    const id = batch.items.find((i: any) => i.name === 'taxi-receipt.pdf').file_id
    inbox.scan()
    const state = JSON.parse(readFileSync(join(root, '..', 'capture.json'), 'utf8'))
    expect(state.handled[id]).toBeUndefined()
    expect(Object.keys(state.handled)).toHaveLength(4) // the four still in Inbox
    void c
  })

  it('writes the default rules into Files once and keeps the owner\'s own text', async () => {
    const { root, inbox } = await batchOfFive()
    expect(inbox.rules().text).toBe(DEFAULT_RULES)
    expect(readFileSync(join(root, RULES_FILE), 'utf8')).toBe(DEFAULT_RULES)
    inbox.setRules('# Capture rules\n\n- Receipts: Money only.\n')
    expect(inbox.rules().text).toContain('Money only')
  })
})

describe('the wizard_capture tool', () => {
  it('is listed for the main agent only while the switch is on, and answers plainly', async () => {
    const { root, c, inbox } = box({ quietMs: 1000 })
    inbox.scan(); await arrived(root, FIVE); inbox.scan(); c.at += 2000
    const batch = inbox.scan()
    let on = false
    const tool: any = captureTool({ inbox: () => inbox, on: () => on })
    expect(tool.list('hermes')).toEqual([])
    on = true
    expect(tool.list('hermes').map((t: any) => t.name)).toEqual([CAPTURE_TOOL])
    expect(tool.list('philosopher')).toEqual([])
    expect((await tool.call(CAPTURE_TOOL, { action: 'file', batch: batch.id, item: 'i1', folder: 'Docs' }, 'philosopher'))?.isError).toBe(true)
    const filed = await tool.call(CAPTURE_TOOL, { action: 'file', batch: batch.id, item: 'taxi-receipt.pdf', folder: 'Documents/Receipts/2026', judged_as: 'receipt', rule: 'Receipts' }, 'hermes')
    expect(JSON.parse(filed.content[0].text).folder).toBe('Documents/Receipts/2026')
    const refused = await tool.call(CAPTURE_TOOL, { action: 'file', batch: batch.id, item: 'i2', folder: 'Inbox/x' }, 'hermes')
    expect(refused.isError).toBe(true)
    const listed = JSON.parse((await tool.call(CAPTURE_TOOL, { action: 'list', batch: batch.id }, 'hermes')).content[0].text)
    expect(listed.items.find((i: any) => i.name === 'taxi-receipt.pdf').state).toBe('filed')
    const undone = JSON.parse((await tool.call(CAPTURE_TOOL, { action: 'undo' }, 'hermes')).content[0].text)
    expect(undone).toMatchObject({ batch: batch.id, items_back_in_inbox: 5 })
    await expect(tool.call('wizard_other', {}, 'hermes')).resolves.toBeNull()
  })

  it('the batch turn names every item where the agent sees it, and the owner\'s rules', () => {
    const text = batchTurnText({ id: 'cap_0123456789abcdef', items: [{ item: 'i1', name: 'a.pdf', kind: 'pdf', size: 2048, path: 'Inbox/2026-11-25/a.pdf' }] } as any, { agentRoot: '/media', rules: { path: '/media/Capture rules.md', text: DEFAULT_RULES } })
    expect(text).toContain('cap_0123456789abcdef')
    expect(text).toContain('/media/Inbox/2026-11-25/a.pdf')
    expect(text).toContain('Photos of book pages')
    expect(text).toContain('wizard_capture action done')
  })
})

describe('capture inbox on the Agent Service', () => {
  const TOKEN = 'fixture-main-gateway-token'
  const start = (extra: any = {}) => startIn(home(), extra)
  async function startIn(d: string, extra: any = {}) {
    const media = join(d, 'media')
    mkdirSync(join(media, 'Inbox'), { recursive: true })
    writeFileSync(join(d, 'apps.json'), JSON.stringify({ schema: 1, apps: [] }))
    const calls: any[] = []
    const upstream = createServer((req, res) => {
      let raw = ''
      req.on('data', ch => { raw += ch })
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : null
        const path = new URL(req.url || '/', 'http://x').pathname
        if (path !== '/health' && path !== '/v1/capabilities') calls.push({ method: req.method, url: path, body })
        const send = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
        if (path === '/health') return send(200, { status: 'ok' })
        if (path === '/v1/capabilities') return send(200, { features: {} })
        if (req.method === 'POST' && path === '/api/sessions') return send(201, { session: { id: body.id } })
        if (/^\/api\/sessions\/[^/]+$/u.test(path)) return send(200, { session: { id: path.split('/').at(-1) } })
        if (req.method === 'POST' && path === '/v1/runs') return send(202, { run_id: `run_up_${calls.length}`, status: 'started' })
        if (/^\/v1\/runs\/[^/]+$/u.test(path)) return send(200, { run_id: path.split('/').at(-1), status: 'running' })
        send(404, { error: 'nope' })
      })
    })
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()))
    servers.push(upstream)
    const s = createWizardServer({ wizardOsHome: d, requireAccess: false, hermesKey: 'test', followThrough: false, joinedDelegation: 'off',
      agentBridge: true, bridgeWriteSkills: false, mcpToken: TOKEN, appsJsonPath: join(d, 'apps.json'), bridgeLog: () => {},
      upstreamOrigin: `http://127.0.0.1:${(upstream.address() as any).port}`, runQueueStatePath: join(d, 'q.db'), runQueuePollIntervalMs: 0,
      operatorWorkerStatePath: join(d, 'workers.json'), dispatchHealthReader: () => true, activeSessionReader: () => [], canonicalSessionReader: () => [],
      settingsPath: join(d, 'settings.json'), threadTitleStatePath: join(d, 'titles.json'), agentInboxStatePath: join(d, 'agent-inbox.json'),
      mediaRoot: media, mediaAgentRoot: '/media', mediaIndexPath: join(d, 'media.json'), captureQuietMs: 300, captureScanMs: 100, ...extra })
    servers.push(s)
    const a: any = await listen(s)
    const base = `http://127.0.0.1:${a.port}`
    let rpc = 0
    const mcp = async (method: string, params: any = {}) => {
      const r = await fetch(`${base}/wizard/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: ['Bearer', TOKEN].join(' ') }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method, params }) })
      return (await r.json()).result
    }
    const tool = async (args: any) => {
      const result = await mcp('tools/call', { name: CAPTURE_TOOL, arguments: args })
      return { error: result.isError === true, value: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) }
    }
    const batched = async () => {
      for (let n = 0; n < 50 && !calls.some(c => c.url === '/v1/runs'); n += 1) await sleep(100)
      return new AgentInboxStore(join(d, 'agent-inbox.json'), { log: () => undefined }).list().filter(r => r.source === 'capture:files')
    }
    return { d, media, calls, base, mcp, tool, batched, store: () => new AgentInboxStore(join(d, 'agent-inbox.json'), { log: () => undefined }) }
  }

  it('a batch left without its record (a restart right after the scan) still gets its record and worker', async () => {
    const d = home(), media = join(d, 'media')
    mkdirSync(join(media, 'Inbox'), { recursive: true })
    const c = clock()
    const pre: any = createCaptureInbox({ root: media, statePath: join(d, 'capture-inbox.json'), now: c.now, quietMs: 1 })
    pre.scan(); await arrived(media, { 'a.pdf': '%PDF' }); pre.scan(); c.at += 10
    const made = pre.scan()
    expect(made.record_id).toBeNull()
    const s = await startIn(d, { captureInbox: true, filesRoot: '/owner-files' })
    const records = await s.batched()
    expect(records).toHaveLength(1)
    expect(records[0].capture.batch).toBe(made.id)
    expect(JSON.stringify(s.calls.find(c => c.url === '/v1/runs').body)).toContain('/owner-files/Inbox/2026-11-25/a.pdf')
  })

  it('a partial undo never reads as undone: the record says what is still out and waits on the owner', async () => {
    const { media, batched, tool, base, store } = await start({ captureInbox: true })
    await sleep(250)
    await arrived(media, { 'a.pdf': '%PDF a', 'b.pdf': '%PDF b' })
    const [record] = await batched()
    const batch = record.capture.batch
    await tool({ action: 'file', batch, item: 'a.pdf', folder: 'Docs' })
    await tool({ action: 'file', batch, item: 'b.pdf', folder: 'Docs' })
    await tool({ action: 'done', batch, outcome: '2 filed from Inbox: 2 documents' })
    writeFileSync(join(media, 'Inbox', '2026-11-25', 'b.pdf'), 'a new drop with the same name')
    const undo = await (await fetch(`${base}/wizard/v1/capture/${batch}/undo`, { method: 'POST' })).json()
    expect(undo).toMatchObject({ items_back_in_inbox: 1, of: 2, problems: [expect.stringContaining('b.pdf')] })
    expect(store().get(record.id)).toMatchObject({ kind: 'needs_you', state: 'new', last_update: expect.stringContaining('Undo not finished: 1 of 2 back in Inbox') })
  })

  it('switch off: nothing is watched, moved or written, no tool, and the routes answer 404', async () => {
    const { d, media, calls, base, mcp } = await start()
    await sleep(250)
    await arrived(media, FIVE)
    await sleep(900)
    expect(calls).toEqual([])
    expect(walk(media).filter(p => !p.startsWith('Skins/'))).toEqual(Object.keys(FIVE).map(n => `Inbox/2026-11-25/${n}`).sort())
    expect(existsSync(join(d, 'capture-inbox.json'))).toBe(false)
    expect((await mcp('tools/list')).tools.map((t: any) => t.name)).not.toContain(CAPTURE_TOOL)
    expect((await fetch(`${base}/wizard/v1/capture`)).status).toBe(404)
    expect((await fetch(`${base}/wizard/v1/capture/cap_0123456789abcdef/undo`, { method: 'POST' })).status).toBe(404)
  })

  it('switch on: 5 dropped files are one private record and one hidden worker turn; the agent files them; the owner undoes it', async () => {
    const { media, calls, base, mcp, tool, batched, store } = await start({ captureInbox: true })
    await sleep(250) // the baseline
    await arrived(media, FIVE)
    const records = await batched()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ privacy_class: 'private', worker: true, state: 'running', title: '5 new in Inbox', capture: { source: 'files', count: 5 } })
    expect(calls.some(c => c.method === 'PATCH' && c.url === `/api/sessions/${records[0].thread_id}` && c.body?.hidden === true)).toBe(true)
    const run = calls.find(c => c.url === '/v1/runs')
    expect(run.body.session_id).toBe(records[0].thread_id)
    const input = JSON.stringify(run.body)
    expect(input).toContain(records[0].capture.batch)
    expect(input).toContain('/media/Inbox/2026-11-25/taxi-receipt.pdf')
    expect(input).toContain('Photos of book pages')
    expect(input).toContain('Background capture')
    expect(readFileSync(join(media, RULES_FILE), 'utf8')).toBe(DEFAULT_RULES)
    const listed = await (await fetch(`${base}/wizard/v1/capture`)).json()
    expect(listed).toMatchObject({ on: true, active: true, pending: 0 })
    expect(listed.batches[0]).toMatchObject({ batch: records[0].capture.batch, record_id: records[0].id, state: 'open' })

    // The agent, through its wizard gateway, files every item by rule.
    expect((await mcp('tools/list')).tools.map((t: any) => t.name)).toContain(CAPTURE_TOOL)
    const before = Object.fromEntries(walk(media).map(p => [p, readFileSync(join(media, p), 'utf8')]))
    const batch = records[0].capture.batch
    for (const [item, folder, judged] of [['IMG_2041.jpg', 'Documents/Receipts/2026', 'receipt'], ['taxi-receipt.pdf', '/media/Documents/Receipts/2026', 'receipt'],
      ['why-we-sleep.pdf', 'Reading/Articles', 'article'], ['IMG_2042.jpg', 'Reading/Why We Sleep', 'book page'], ['voice-note.m4a', 'Voice notes', 'voice note']]) {
      const r = await tool({ action: 'file', batch, item, folder, judged_as: judged, rule: 'default rules' })
      expect(r.error).toBe(false)
    }
    expect((await tool({ action: 'note', batch, item: 'IMG_2042.jpg', path: 'Reading/Why We Sleep.md', text: '> Sleep is the single most effective thing.' })).value.created).toBe(true)
    await tool({ action: 'done', batch, outcome: '5 filed from Inbox: 2 receipts to Documents/Receipts/2026, 1 article, 1 book page, 1 voice note' })
    expect(walk(join(media, 'Inbox'))).toEqual([])
    // One sweep line says what happened (the record's title is what the card shows for Done items).
    expect(store().get(records[0].id)).toMatchObject({ title: '5 filed from Inbox: 2 receipts to Documents/Receipts/2026, 1 article, 1 book page, 1 voice note', last_update: expect.stringContaining('1 voice note') })

    // "Undo that": the owner's own route puts all 5 back exactly and takes the highlight note out.
    const undo = await fetch(`${base}/wizard/v1/capture/${batch}/undo`, { method: 'POST' })
    expect([undo.status, await undo.json()]).toEqual([200, expect.objectContaining({ batch, problems: [], items_back_in_inbox: 5, of: 5 })])
    expect(Object.fromEntries(walk(media).map(p => [p, readFileSync(join(media, p), 'utf8')]))).toEqual(before)
    expect(store().get(records[0].id)?.last_update).toBe('Undone: 5 items back in Inbox.')
    // Nothing is batched again.
    await sleep(600)
    expect(store().list().filter(r => r.source === 'capture:files')).toHaveLength(1)
    expect(calls.filter(c => c.url === '/v1/runs')).toHaveLength(1)
  })
})
