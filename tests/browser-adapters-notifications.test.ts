// Card 2: the REAL Notifications screens' operations (notifications.inbox, notifications.mark) admitted only from
// WAM-written install/grant state (tests/fixtures/browser-trust/wam/card2-*.json, produced by
// wizard-app-manager tools/browser_admission_fixture.py from the app's own wizard.md). The upstream stub follows the
// Notifications backend contract: items carry `revision`, /api/mark compares-and-sets on `expect` (409, nothing written).
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { createWizardServer, listen } from '../server/service.mjs'

const TOKEN = 'd4'.repeat(32)
const PROOF = 'owner-proof-synthetic-'.repeat(3)
const FIXTURES = new URL('./fixtures/browser-trust/wam/', import.meta.url)
const resources: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close() })

const rev = (i: any) => 'r-' + createHash('sha256').update(JSON.stringify(['notification-mark-v1', i.id, !!i.read, !!i.flag, !!i.archived])).digest('hex').slice(0, 16)
type Item = { id: string, title: string, message: string, time: number, priority: number, link: string, source: string, read: boolean, flag: boolean, archived: boolean }

async function notificationsUpstream({ cas = true } = {}) {
  const mk = (n: number, extra: Partial<Item> = {}): Item => ({ id: 'n' + n, title: 'Synthetic ' + n, message: 'synthetic body ' + n, time: 1761955200 - n, priority: 3, link: '', source: 'agent', read: false, flag: false, archived: false, ...extra })
  const state = {
    items: [mk(1, { priority: 5, link: 'https://example.invalid/a', source: 'cron' }), mk(2, { link: 'javascript:alert(1)' }), mk(3, { archived: true, read: true }), mk(4, { flag: true })] as Item[],
    marks: 0, posts: [] as any[], requests: [] as string[], dropMarkReply: false, beforeMark: null as null | (() => void),
  }
  const view = (v: string) => v === 'flagged' ? state.items.filter(i => i.flag && !i.archived) : v === 'archive' ? state.items.filter(i => i.archived) : v === 'all' ? state.items : state.items.filter(i => !i.archived)
  const server = createServer((req, res) => {
    state.requests.push(`${req.method} ${req.url}`)
    for (const h of ['cookie', 'authorization', 'x-wizard-shell-token', 'x-wizard-owner-proof', 'tailscale-user-login']) if (req.headers[h]) { res.writeHead(400).end('credential forwarded'); return }
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    const url = new URL(req.url || '/', 'http://x')
    if (req.method === 'GET' && url.pathname === '/notifications/api/items') {
      const items = view(url.searchParams.get('view') || 'inbox').slice(0, Number(url.searchParams.get('limit') || 200))
      const counts = { unread: state.items.filter(i => !i.read && !i.archived).length, needs: state.items.filter(i => !i.read && !i.archived && i.priority >= 4).length, flagged: state.items.filter(i => i.flag && !i.archived).length }
      json(200, { view: url.searchParams.get('view'), counts, items: items.map(i => ({ ...i, tags: ['x'], ...(cas ? { revision: rev(i) } : {}) })) }); return
    }
    if (req.method === 'POST' && url.pathname === '/notifications/api/mark') {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        const d = JSON.parse(body)
        state.posts.push(d)
        state.beforeMark?.()
        const hit = state.items.filter(i => d.ids.includes(i.id))
        if (d.expect && hit.some(i => rev(i) !== d.expect[i.id])) { json(409, { error: 'conflict' }); return }
        state.marks++
        for (const i of hit) { for (const k of ['read', 'flag', 'archived'] as const) if (typeof d[k] === 'boolean') i[k] = d[k]; if (d.archived === true) i.read = true }
        if (state.dropMarkReply) { req.socket.destroy(); return }
        json(200, { ok: true, changed: hit.length })
      })
      return
    }
    json(404, { error: 'not found' })
  })
  const address = await listen(server)
  resources.push(() => new Promise(r => server.close(r)))
  return { state, port: address.port }
}

async function box({ scenario = 'card2-granted', cas = true, receiptsPath = '', receiptLimits = {} } = {}) {
  const up = await notificationsUpstream({ cas })
  const dir = mkdtempSync(join(tmpdir(), 'bt2-'))
  resources.push(() => rmSync(dir, { recursive: true, force: true }))
  const appsJsonPath = join(dir, 'apps.json')
  const use = (name: string) => {
    const doc = JSON.parse(readFileSync(new URL(name + '.json', FIXTURES), 'utf8'))
    for (const a of doc.apps) if (a.browser?.upstream) a.browser.upstream = `http://127.0.0.1:${up.port}`
    writeFileSync(appsJsonPath, JSON.stringify(doc))
  }
  use(scenario)
  const receipts = receiptsPath || join(dir, 'state', 'receipts.json')
  const server = createWizardServer({
    requireAccess: false, upstreamOrigin: 'http://127.0.0.1:1', hermesKey: 'fixture-key', ownerProof: PROOF,
    browserBoundary: { enabled: true, token: TOKEN }, browserAdapterWam: { receiptsPath: receipts, receiptLimits },
    hermesHome: join(dir, 'synthetic-hermes'), wizardOsHome: dir, settingsPath: join(dir, 'settings.json'), appsJsonPath,
    launcherPath: join(dir, 'launcher.json'), agentBridge: false, followThrough: false, joinedDelegation: 'off',
  })
  const address = await listen(server)
  resources.push(() => new Promise(r => server.close(r)))
  const base = `http://127.0.0.1:${address.port}/wizard/v1/browser-adapters/`
  const post = async (path: string, body: unknown) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Wizard-Shell-Token': TOKEN, 'X-Wizard-Owner-Proof': PROOF }, body: JSON.stringify(body) })
    return { status: r.status, body: await r.json() }
  }
  let n = 0
  const bind = async () => {
    const generation = randomUUID()
    const r = await post('bindings', { appId: 'notifications', generation })
    const call = (operation: string, args: unknown, extra: Record<string, unknown> = {}) => post('call', { handle: r.body.handle, generation, requestId: 'wbs-' + (++n), operation, args, ...extra })
    return { ...r, call }
  }
  return { up, use, bind, receipts }
}
const ITEM_KEYS = 'archived,flag,id,link,message,priority,read,revision,source,time,title'
const marked = (items: any[], ids: string[]) => ids.map(id => ({ id, expectedRevision: items.find(i => i.id === id).revision }))

describe('card 2: the real Notifications screens over typed operations', () => {
  it('inbox: every view, counts and marks in a fixed DTO; unsafe links and upstream extras are dropped', async () => {
    const t = await box()
    const b = await t.bind()
    expect(b.status).toBe(200)
    const inbox = await b.call('notifications.inbox', { view: 'inbox', limit: 500 })
    expect(inbox.status).toBe(200)
    expect(Object.keys(inbox.body).sort()).toEqual(['counts', 'items', 'view'])
    expect(inbox.body.counts).toEqual({ unread: 3, needs: 1, flagged: 1 })
    expect(inbox.body.items.map((i: any) => i.id)).toEqual(['n1', 'n2', 'n4'])
    expect(inbox.body.items.every((i: any) => Object.keys(i).sort().join() === ITEM_KEYS)).toBe(true)   // no tags, no cas
    expect(inbox.body.items[0]).toMatchObject({ priority: 5, source: 'cron', link: 'https://example.invalid/a', revision: rev(t.up.state.items[0]) })
    expect(inbox.body.items[1].link).toBe('')                                                           // javascript: dropped
    expect((await b.call('notifications.inbox', { view: 'archive', limit: 50 })).body.items.map((i: any) => i.id)).toEqual(['n3'])
    expect((await b.call('notifications.inbox', { view: 'flagged', limit: 50 })).body.items.map((i: any) => i.id)).toEqual(['n4'])
    expect((await b.call('notifications.inbox', { view: 'all', limit: 2 })).body.items).toHaveLength(2)
    for (const args of [{ view: 'spam', limit: 5 }, { view: 'inbox', limit: 0 }, { view: 'inbox', limit: 501 }, { view: 'inbox' }, { view: 'inbox', limit: 5, cursor: null }, { view: 'inbox', limit: 5, url: '/x' }])
      expect((await b.call('notifications.inbox', args)).status, JSON.stringify(args)).toBe(400)
    expect(t.up.state.requests.every(r => r.startsWith('GET /notifications/api/items?view='))).toBe(true)   // fixed upstream path only
  })

  it('mark: read, unread, flag, archive and mark-all-read are one compare-and-set write each, read back and receipted', async () => {
    const t = await box()
    const b = await t.bind()
    let items = (await b.call('notifications.inbox', { view: 'all', limit: 500 })).body.items
    const step = async (ids: string[], marks: Record<string, boolean>) => {
      const key = randomUUID()
      const r = await b.call('notifications.mark', { items: marked(items, ids), marks }, { operationKey: key })
      expect(r.status, JSON.stringify(marks)).toBe(200)
      expect(r.body).toEqual({ items: ids.map(id => ({ id, revision: expect.stringMatching(/^r-/) })), marks, operationKey: key })
      items = (await b.call('notifications.inbox', { view: 'all', limit: 500 })).body.items
      for (const x of r.body.items) expect(items.find((i: any) => i.id === x.id).revision).toBe(x.revision)   // readback agrees
      expect((await b.call('data.status', { operation: 'notifications.mark', operationKey: key })).body).toEqual({ status: 'succeeded', operationKey: key, result: r.body })
      return t.up.state.posts.at(-1)
    }
    expect(await step(['n1'], { read: true })).toEqual({ ids: ['n1'], read: true, expect: { n1: rev({ id: 'n1' }) } })
    await step(['n1'], { read: false })                                   // unread: not monotonic, so CAS-only
    await step(['n2'], { flag: true })
    await step(['n2'], { archived: true })
    expect(t.up.state.items.find(i => i.id === 'n2')).toMatchObject({ archived: true, read: true, flag: true })
    await step(['n3'], { archived: false })                               // Move to inbox
    await step(['n1', 'n4'], { read: true })                              // Mark all read
    expect(t.up.state.marks).toBe(6)
  })

  it('stale view: a revision changed elsewhere conflicts with no upstream effect; a race lost at the upstream also writes nothing', async () => {
    const t = await box()
    const b = await t.bind()
    const items = (await b.call('notifications.inbox', { view: 'all', limit: 500 })).body.items
    t.up.state.items[0].flag = true                                       // the agent flagged n1 meanwhile
    const r = await b.call('notifications.mark', { items: marked(items, ['n1', 'n2']), marks: { read: true } }, { operationKey: randomUUID() })
    expect(r).toMatchObject({ status: 409, body: { error: 'conflict' } })
    expect(t.up.state.posts).toEqual([])
    const fresh = (await b.call('notifications.inbox', { view: 'all', limit: 500 })).body.items
    t.up.state.beforeMark = () => { t.up.state.items[1].read = true }   // changes between pre-read and the write
    const raced = await b.call('notifications.mark', { items: marked(fresh, ['n2']), marks: { flag: true } }, { operationKey: randomUUID() })
    expect(raced).toMatchObject({ status: 409, body: { error: 'conflict' } })
    expect(t.up.state.items[1].flag).toBe(false)
    expect(t.up.state.marks).toBe(0)
  })

  it('an upstream without compare-and-set (older Notifications build) is refused before any receipt or effect', async () => {
    const t = await box({ cas: false })
    const b = await t.bind()
    const items = (await b.call('notifications.inbox', { view: 'all', limit: 500 })).body.items
    const r = await b.call('notifications.mark', { items: marked(items, ['n1']), marks: { read: true } }, { operationKey: randomUUID() })
    expect(r).toMatchObject({ status: 501, body: { error: 'unsupported_capability' } })
    expect(t.up.state.posts).toEqual([])
  })

  it('lost reply: the same key reconciles by readback with exactly one effect; key reuse with other arguments conflicts', async () => {
    const t = await box()
    const b = await t.bind()
    const items = (await b.call('notifications.inbox', { view: 'all', limit: 500 })).body.items
    const key = randomUUID(), args = { items: marked(items, ['n1', 'n2']), marks: { archived: true } }
    t.up.state.dropMarkReply = true
    const first = await b.call('notifications.mark', args, { operationKey: key })
    expect(first.status).toBe(200)                                        // proven by readback, not by the lost reply
    t.up.state.dropMarkReply = false
    expect(await b.call('notifications.mark', args, { operationKey: key })).toEqual(first)
    expect(t.up.state.marks).toBe(1)
    expect((await b.call('notifications.mark', { ...args, marks: { archived: false } }, { operationKey: key })).body.error).toBe('conflict')
    expect(t.up.state.marks).toBe(1)
  })

  it('bad arguments never reach the upstream', async () => {
    const t = await box()
    const b = await t.bind()
    const ok = { id: 'n1', expectedRevision: rev({ id: 'n1' }) }
    const bad: unknown[] = [
      { items: [], marks: { read: true } }, { items: [ok, ok], marks: { read: true } }, { items: [ok], marks: {} },
      { items: [ok], marks: { read: 'yes' } }, { items: [ok], marks: { deleted: true } }, { items: [{ ...ok, url: '/x' }], marks: { read: true } },
      { items: [{ id: '../x', expectedRevision: ok.expectedRevision }], marks: { read: true } }, { items: [ok], marks: { read: true }, ids: ['n1'] },
      { items: Array.from({ length: 501 }, (_, i) => ({ id: 'x' + i, expectedRevision: ok.expectedRevision })), marks: { read: true } },
    ]
    for (const args of bad) expect((await b.call('notifications.mark', args, { operationKey: randomUUID() })).status, JSON.stringify(args).slice(0, 80)).toBe(400)
    expect((await b.call('notifications.mark', { items: [ok], marks: { read: true } })).status).toBe(400)               // no key
    expect((await b.call('notifications.mark', { items: [ok], marks: { read: true } }, { operationKey: 'k' })).status).toBe(400)
    expect(t.up.state.requests).toEqual([])
  })

  it('grants come from WAM: declaration alone, inbox-only, revoked mark and the card-1 contract are refused at the server', async () => {
    const t = await box({ scenario: 'card2-declared' })
    let b = await t.bind()
    expect((await b.call('notifications.inbox', { view: 'inbox', limit: 5 })).body.error).toBe('not_allowed')
    t.use('card2-inbox-only'); b = await t.bind()
    const items = (await b.call('notifications.inbox', { view: 'all', limit: 500 })).body.items
    expect(items).toHaveLength(4)
    expect((await b.call('notifications.mark', { items: marked(items, ['n1']), marks: { read: true } }, { operationKey: randomUUID() })).body.error).toBe('not_allowed')
    t.use('card2-granted'); b = await t.bind()
    expect((await b.call('notifications.mark', { items: marked(items, ['n1']), marks: { read: true } }, { operationKey: randomUUID() })).status).toBe(200)
    t.use('card2-revoked-mark')                                           // open binding: permission revision moved
    expect((await b.call('notifications.mark', { items: marked(items, ['n2']), marks: { read: true } }, { operationKey: randomUUID() })).body.error).toBe('revoked')
    t.use('granted'); b = await t.bind()                                  // card-1 contract: list/mark_read only
    expect((await b.call('notifications.inbox', { view: 'inbox', limit: 5 })).body.error).toBe('not_allowed')
    expect((await b.call('notifications.mark', { items: marked(items, ['n2']), marks: { read: true } }, { operationKey: randomUUID() })).body.error).toBe('not_allowed')
    expect(t.up.state.marks).toBe(1)
  })

  it('a 500-item mark-all-read fits the receipt store; its receipt size is measured', async () => {
    const t = await box()
    for (let i = 5; i <= 500; i++) t.up.state.items.push({ id: 'n' + i, title: 't', message: 'm', time: 1, priority: 3, link: '', source: 'agent', read: false, flag: false, archived: false })
    const b = await t.bind()
    const items = (await b.call('notifications.inbox', { view: 'all', limit: 500 })).body.items
    expect(items).toHaveLength(500)
    const r = await b.call('notifications.mark', { items: marked(items, items.map((i: any) => i.id)), marks: { read: true } }, { operationKey: randomUUID() })
    expect(r.status).toBe(200)
    const bytes = readFileSync(t.receipts).byteLength
    console.log(`receipt store after one 500-item mark: ${bytes} bytes`)
    expect(bytes).toBeLessThan(64 * 1024)
  })
})
