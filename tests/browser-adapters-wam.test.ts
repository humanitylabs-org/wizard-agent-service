// Real WAM-written install/grant state (tests/fixtures/browser-trust/wam/*.json, produced by
// wizard-app-manager tools/browser_admission_fixture.py) admitting Notifications list/mark-read through
// the production resolver, fixed operations and durable outcome receipts. No injected resolver.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createWizardServer, listen } from '../server/service.mjs'

const TOKEN = 'c3'.repeat(32)
const PROOF = 'owner-proof-synthetic-'.repeat(3)
const FIXTURES = new URL('./fixtures/browser-trust/wam/', import.meta.url)
const resources: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close() })

type Item = { id: string, title: string, message: string, time: number, read: boolean, flag: boolean, archived: boolean }
async function notificationsUpstream() {
  const state = { items: [
    { id: 'n1', title: 'Synthetic build finished', message: 'synthetic', time: 1761955200, read: false, flag: false, archived: false },
    { id: 'n2', title: 'Synthetic reminder', message: 'synthetic', time: 1761955100, read: false, flag: false, archived: false },
  ] as Item[], marks: 0, lists: 0, requests: [] as string[], failItems: 0, dropMarkReply: false, onMark: null as null | (() => void) }
  const server = createServer((req, res) => {
    state.requests.push(`${req.method} ${req.url}`)
    for (const h of ['cookie', 'authorization', 'x-wizard-shell-token', 'x-wizard-owner-proof', 'tailscale-user-login']) if (req.headers[h]) { res.writeHead(400).end('credential forwarded'); return }
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.method === 'GET' && req.url?.startsWith('/notifications/api/items?')) {
      state.lists++
      if (state.failItems > 0) { state.failItems--; json(500, { error: 'synthetic' }); return }
      json(200, { view: 'inbox', counts: {}, items: state.items.filter(i => !i.archived) }); return
    }
    if (req.method === 'POST' && req.url === '/notifications/api/mark') {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        if (!String(req.headers['content-type']).startsWith('application/json')) { json(415, {}); return }
        const d = JSON.parse(body)
        state.marks++
        for (const i of state.items) if (d.ids.includes(i.id) && d.read === true) i.read = true
        state.onMark?.()
        if (state.dropMarkReply) { req.socket.destroy(); return }   // effect applied, reply lost
        json(200, { ok: true, changed: d.ids.length })
      })
      return
    }
    json(404, { error: 'not found' })
  })
  const address = await listen(server)
  resources.push(() => new Promise(r => server.close(r)))
  return { state, port: address.port }
}

async function box({ scenario = 'granted', receiptLimits = {}, receiptsPath = '', boundary = true } = {}) {
  const up = await notificationsUpstream()
  const dir = mkdtempSync(join(tmpdir(), 'bt-wam-'))
  resources.push(() => rmSync(dir, { recursive: true, force: true }))
  const appsJsonPath = join(dir, 'apps.json')
  // Only the upstream port of the WAM-written file is replaced, so the fixture listener is reachable.
  const use = (name: string, mutate?: (doc: any) => void) => {
    const doc = JSON.parse(readFileSync(new URL(name + '.json', FIXTURES), 'utf8'))
    for (const a of doc.apps) if (a.browser?.upstream) a.browser.upstream = `http://127.0.0.1:${up.port}`
    mutate?.(doc)
    writeFileSync(appsJsonPath, JSON.stringify(doc))
  }
  use(scenario)
  const receipts = receiptsPath || join(dir, 'state', 'browser-operation-receipts.json')
  const server = createWizardServer({
    requireAccess: false, upstreamOrigin: 'http://127.0.0.1:1', hermesKey: 'fixture-key', ownerProof: PROOF,
    browserBoundary: { enabled: boundary, token: TOKEN },
    browserAdapterWam: { receiptsPath: receipts, receiptLimits },
    hermesHome: join(dir, 'synthetic-hermes'), wizardOsHome: dir, settingsPath: join(dir, 'settings.json'), appsJsonPath,
    launcherPath: join(dir, 'launcher.json'), agentBridge: false, followThrough: false, joinedDelegation: 'off',
  })
  const address = await listen(server)
  resources.push(() => new Promise(r => server.close(r)))
  const base = `http://127.0.0.1:${address.port}/wizard/v1/browser-adapters/`
  const post = async (path: string, body: unknown, headers: Record<string, string | undefined> = {}) => {
    const r = await fetch(base + path, { method: 'POST', headers: Object.fromEntries(Object.entries({ 'content-type': 'application/json', 'X-Wizard-Shell-Token': TOKEN, 'X-Wizard-Owner-Proof': PROOF, ...headers }).filter(([, v]) => v !== undefined)) as Record<string, string>, body: JSON.stringify(body) })
    return { status: r.status, body: await r.json() }
  }
  let n = 0
  const bind = async (appId = 'notifications') => {
    const generation = randomUUID()
    const r = await post('bindings', { appId, generation })
    const call = (operation: string, args: unknown, extra: Record<string, unknown> = {}) =>
      post('call', { handle: r.body.handle, generation, requestId: 'wbs-' + (++n), operation, args, ...extra })
    return { ...r, generation, call }
  }
  return { up, use, post, bind, receipts, appsJsonPath }
}
const listArgs = { limit: 20, cursor: null }

describe('browser data admission from real WAM install/grant state', () => {
  it('granted Notifications: typed list, mark-read with durable receipt and readback, status', async () => {
    const t = await box()
    const b = await t.bind()
    expect(b.status).toBe(200)
    expect(b.body.principal).toEqual({ installationId: expect.stringMatching(/^inst-/), sourceId: 'standard:oscarhenrycollins/notifications', installedCommit: 'c'.repeat(40), permissionRevision: expect.stringMatching(/^p-/) })
    const list = await b.call('notifications.list', listArgs)
    expect(list.status).toBe(200)
    expect(list.body.nextCursor).toBeNull()
    expect(list.body.items.map((i: any) => Object.keys(i).sort().join())).toEqual(Array(2).fill('id,message,read,revision,time,title'))
    const n1 = list.body.items.find((i: any) => i.id === 'n1')
    const key = randomUUID()
    const mark = await b.call('notifications.mark_read', { id: 'n1', expectedRevision: n1.revision }, { operationKey: key })
    expect(mark.status).toBe(200)
    expect(mark.body).toEqual({ id: 'n1', read: true, revision: expect.stringMatching(/^r-/), operationKey: key })
    expect(mark.body.revision).not.toBe(n1.revision)
    expect(t.up.state.items[0].read).toBe(true)                       // upstream effect
    const again = await b.call('notifications.list', listArgs)        // actual result readback
    expect(again.body.items.find((i: any) => i.id === 'n1')).toMatchObject({ read: true, revision: mark.body.revision })
    const disk = JSON.parse(readFileSync(t.receipts, 'utf8'))          // durable outcome on disk
    expect(Object.values(disk.receipts)).toEqual([expect.objectContaining({ operation: 'notifications.mark_read', operationKey: key, status: 'succeeded', result: mark.body })])
    expect((await b.call('data.status', { operation: 'notifications.mark_read', operationKey: key })).body).toEqual({ status: 'succeeded', operationKey: key, result: mark.body })
  })

  it('outcome survives a Service restart: a new process reads the durable receipt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bt-restart-'))
    resources.push(() => rmSync(dir, { recursive: true, force: true }))
    const receiptsPath = join(dir, 'receipts.json')
    const first = await box({ receiptsPath })
    const b = await first.bind()
    const n1 = (await b.call('notifications.list', listArgs)).body.items[0]
    const key = randomUUID()
    const mark = await b.call('notifications.mark_read', { id: n1.id, expectedRevision: n1.revision }, { operationKey: key })
    const second = await box({ receiptsPath })          // fresh Service instance, same durable store
    const again = await second.bind()
    expect((await again.call('data.status', { operation: 'notifications.mark_read', operationKey: key })).body).toEqual({ status: 'succeeded', operationKey: key, result: mark.body })
    expect(second.up.state.marks).toBe(0)
  })

  it('lost reply: the same operationKey returns the original outcome without a second effect', async () => {
    const t = await box()
    const b = await t.bind()
    const n1 = (await b.call('notifications.list', listArgs)).body.items[0]
    const key = randomUUID()
    t.up.state.dropMarkReply = true                                  // upstream applies, connection dies
    const first = await b.call('notifications.mark_read', { id: n1.id, expectedRevision: n1.revision }, { operationKey: key })
    expect(first.status).toBe(200)                                   // reconciled by readback, not by trusting the reply
    t.up.state.dropMarkReply = false
    const retry = await b.call('notifications.mark_read', { id: n1.id, expectedRevision: n1.revision }, { operationKey: key })
    expect(retry.body).toEqual(first.body)
    expect(t.up.state.marks).toBe(1)
  })

  it('identical replay returns the recorded outcome even after the item changed elsewhere', async () => {
    const t = await box()
    const b = await t.bind()
    const n1 = (await b.call('notifications.list', listArgs)).body.items[0]
    const key = randomUUID()
    const first = await b.call('notifications.mark_read', { id: n1.id, expectedRevision: n1.revision }, { operationKey: key })
    t.up.state.items[0].read = false; t.up.state.items[0].flag = true   // an agent changed it afterwards
    const replay = await b.call('notifications.mark_read', { id: n1.id, expectedRevision: n1.revision }, { operationKey: key })
    expect(replay).toEqual(first)
    expect(t.up.state.marks).toBe(1)
  })

  it('production resolver: grants are bound to installation AND source; unreadable registry admits nothing', async () => {
    const { createWamInstallationResolver } = await import('../server/browser-installations.mjs')
    const dir = mkdtempSync(join(tmpdir(), 'bt-res-'))
    resources.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'apps.json')
    writeFileSync(path, readFileSync(new URL('granted.json', FIXTURES)))
    const r = createWamInstallationResolver({ appsJsonPath: path })
    const p = r.resolveInstallation('notifications')!
    expect(r.resolveGrants(p.installationId, p.sourceId).operations).toEqual(['notifications.list', 'notifications.mark_read'])
    expect(r.resolveGrants(p.installationId, 'standard:humanitylabs-org/notifications').operations).toEqual([])
    expect(r.resolveGrants('inst-' + '0'.repeat(32), p.sourceId).operations).toEqual([])
    writeFileSync(path, '{broken')
    expect(r.resolveInstallation('notifications')).toBeNull()
    expect(r.resolveGrants(p.installationId, p.sourceId).operations).toEqual([])
  })

  it('unknown outcome is reported, never claimed; status and retry reconcile without a second effect', async () => {
    const t = await box()
    const b = await t.bind()
    const n1 = (await b.call('notifications.list', listArgs)).body.items[0]
    const key = randomUUID()
    t.up.state.dropMarkReply = true
    t.up.state.onMark = () => { t.up.state.failItems = 1 }           // readback after the effect fails too
    const first = await b.call('notifications.mark_read', { id: n1.id, expectedRevision: n1.revision }, { operationKey: key })
    expect(first.status).toBe(409)
    expect(first.body).toMatchObject({ error: 'outcome_unknown', operationKey: key, retryable: false })
    expect((await b.call('data.status', { operation: 'notifications.mark_read', operationKey: key })).body).toMatchObject({ status: 'unknown' })
    t.up.state.dropMarkReply = false; t.up.state.onMark = null
    const retry = await b.call('notifications.mark_read', { id: n1.id, expectedRevision: n1.revision }, { operationKey: key })
    expect(retry.status).toBe(200)
    expect(retry.body).toMatchObject({ id: n1.id, read: true })
    expect(t.up.state.marks).toBe(1)
    expect((await b.call('data.status', { operation: 'notifications.mark_read', operationKey: key })).body.status).toBe('succeeded')
  })

  it('stale revision conflicts; key reuse with other arguments conflicts; no write either time', async () => {
    const t = await box()
    const b = await t.bind()
    const [n1, n2] = (await b.call('notifications.list', listArgs)).body.items
    const stale = await b.call('notifications.mark_read', { id: n1.id, expectedRevision: 'r-' + '0'.repeat(16) }, { operationKey: randomUUID() })
    expect(stale).toMatchObject({ status: 409, body: { error: 'conflict' } })
    const key = randomUUID()
    expect((await b.call('notifications.mark_read', { id: n1.id, expectedRevision: n1.revision }, { operationKey: key })).status).toBe(200)
    const reuse = await b.call('notifications.mark_read', { id: n2.id, expectedRevision: n2.revision }, { operationKey: key })
    expect(reuse).toMatchObject({ status: 409, body: { error: 'conflict' } })
    expect(t.up.state.marks).toBe(1)
    expect(t.up.state.items[1].read).toBe(false)
  })

  it('receipt quota refuses before any effect; an evicted receipt cannot re-apply a stale write', async () => {
    const quota = await box({ receiptLimits: { perInstallation: 1 } })
    const qb = await quota.bind()
    const [n1, n2] = (await qb.call('notifications.list', listArgs)).body.items
    expect((await qb.call('notifications.mark_read', { id: n1.id, expectedRevision: n1.revision }, { operationKey: randomUUID() })).status).toBe(200)
    const full = await qb.call('notifications.mark_read', { id: n2.id, expectedRevision: n2.revision }, { operationKey: randomUUID() })
    expect(full).toMatchObject({ status: 507, body: { error: 'quota_exceeded' } })
    expect(quota.up.state.marks).toBe(1)
    expect(quota.up.state.items[1].read).toBe(false)

    const evict = await box({ receiptLimits: { retentionMs: -1 } })   // every completed receipt is already past retention
    const eb = await evict.bind()
    const e1 = (await eb.call('notifications.list', listArgs)).body.items[0]
    const key = randomUUID()
    expect((await eb.call('notifications.mark_read', { id: e1.id, expectedRevision: e1.revision }, { operationKey: key })).status).toBe(200)
    const late = await eb.call('notifications.mark_read', { id: e1.id, expectedRevision: e1.revision }, { operationKey: key })
    expect(late).toMatchObject({ status: 409, body: { error: 'conflict' } })   // reread required, no blind re-apply
    expect(evict.up.state.marks).toBe(1)
  })

  it('unavailable receipt storage refuses before the effect', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bt-ro-'))
    resources.push(() => rmSync(dir, { recursive: true, force: true }))
    writeFileSync(join(dir, 'not-a-dir'), 'x')
    const t = await box({ receiptsPath: join(dir, 'not-a-dir', 'receipts.json') })
    const b = await t.bind()
    const n1 = (await b.call('notifications.list', listArgs)).body.items[0]
    const r = await b.call('notifications.mark_read', { id: n1.id, expectedRevision: n1.revision }, { operationKey: randomUUID() })
    expect(r).toMatchObject({ status: 503, body: { error: 'storage_unavailable', retryable: true } })
    expect(t.up.state.marks).toBe(0)
    expect(t.up.state.items[0].read).toBe(false)
  })

  it('declaration-only installation is refused at the server and never reaches the app', async () => {
    const t = await box({ scenario: 'declared' })
    const b = await t.bind()
    expect(b.status).toBe(200)    // a binding names the installation; it grants nothing
    expect(await b.call('notifications.list', listArgs)).toMatchObject({ status: 403, body: { error: 'not_allowed' } })
    expect(await b.call('notifications.mark_read', { id: 'n1', expectedRevision: 'r-' + '0'.repeat(16) }, { operationKey: randomUUID() })).toMatchObject({ status: 403, body: { error: 'not_allowed' } })
    expect(t.up.state.requests).toEqual([])
  })

  it('revoked grant, update, source change, provider change, uninstall and reinstall are refused at the server', async () => {
    const t = await box()
    const b = await t.bind()
    const n1 = (await b.call('notifications.list', listArgs)).body.items[0]
    const key = randomUUID()
    expect((await b.call('notifications.mark_read', { id: n1.id, expectedRevision: n1.revision }, { operationKey: key })).status).toBe(200)
    const before = t.up.state.requests.length
    const refused = async (scenario: string, oldCode: string, freshList: number, freshMark: number) => {
      t.use(scenario)
      expect((await b.call('notifications.list', listArgs)).body.error, scenario).toBe(oldCode)
      const fresh = await t.bind()
      if (fresh.status !== 200) { expect([freshList, freshMark], scenario).toEqual([403, 403]); return }
      expect((await fresh.call('notifications.list', listArgs)).status, scenario).toBe(freshList)
      expect((await fresh.call('notifications.mark_read', { id: 'n2', expectedRevision: 'r-' + '0'.repeat(16) }, { operationKey: randomUUID() })).status, scenario).toBe(freshMark === 200 ? 409 : freshMark)
    }
    await refused('revoked-mark', 'revoked', 200, 403)          // permission revision moved; mark no longer granted
    await refused('updated', 'revoked', 200, 200)               // commit moved: old binding dead, same-source grant carries
    await refused('source-changed', 'revoked', 403, 403)        // other publisher, same app id: no inherited grant
    await refused('provider-changed', 'revoked', 403, 403)      // no longer the notifications slot provider
    await refused('uninstalled', 'not_allowed', 403, 403)
    await refused('reinstalled', 'revoked', 403, 403)           // new installation id, no grant
    expect(t.up.state.marks).toBe(1)
    expect(t.up.state.requests.slice(before).filter(r => r.startsWith('POST'))).toEqual([])
    // A new installation cannot read the old installation's outcome receipts.
    t.use('reinstalled', doc => { doc.apps[0].browser.granted = ['notifications.list', 'notifications.mark_read']; doc.apps[0].browser.admissible = true })
    const other = await t.bind()
    expect((await other.call('data.status', { operation: 'notifications.mark_read', operationKey: key })).body.error).toBe('not_found')
  })

  it('result delivery is rechecked: a grant revoked during the effect withholds the result', async () => {
    const t = await box()
    const b = await t.bind()
    const n1 = (await b.call('notifications.list', listArgs)).body.items[0]
    const key = randomUUID()
    t.up.state.onMark = () => t.use('revoked-mark')
    const r = await b.call('notifications.mark_read', { id: n1.id, expectedRevision: n1.revision }, { operationKey: key })
    expect(r.status).toBe(403)
    expect(r.body.id).toBeUndefined()
    t.up.state.onMark = null
    const disk = Object.values(JSON.parse(readFileSync(t.receipts, 'utf8')).receipts) as any[]
    expect(disk[0]).toMatchObject({ status: 'succeeded', operationKey: key })   // the truth is kept, not delivered
  })

  it('duplicate Profiles publishers: ambiguous id refused; a source switch does not inherit state.local', async () => {
    const t = await box({ scenario: 'profiles-oscar' })
    const legacy = await t.bind('profiles')
    expect(legacy.body.principal.sourceId).toBe('standard:oscarhenrycollins/profiles')
    const state = await legacy.call('state.local', {})
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body.namespace)).toEqual(['local-owner-profile', legacy.body.principal.installationId, 'standard:oscarhenrycollins/profiles'])
    t.use('profiles-org')
    expect((await legacy.call('state.local', {})).body.error).toBe('revoked')
    const org = await t.bind('profiles')
    expect(org.body.principal.sourceId).toBe('standard:humanitylabs-org/profiles')
    expect((await org.call('state.local', {})).body.error).toBe('not_allowed')
    const dup = JSON.parse(readFileSync(new URL('profiles-org.json', FIXTURES), 'utf8')).apps.find((a: any) => a.id === 'profiles')
    t.use('profiles-oscar', doc => doc.apps.push(dup))
    expect((await t.bind('profiles')).body.error).toBe('not_allowed')
  })

  it('forged principal fields, unknown operations and non-shell callers are refused', async () => {
    const t = await box()
    expect((await t.post('bindings', { appId: 'notifications', generation: randomUUID(), sourceId: 'standard:oscarhenrycollins/notifications' })).status).toBe(400)
    const b = await t.bind()
    for (const extra of [{ appId: 'profiles' }, { installationId: b.body.principal.installationId }, { sourceId: 'x' }, { url: '/wizard/v1/settings' }]) {
      expect((await b.call('notifications.list', listArgs, extra)).status).toBe(400)
    }
    expect((await b.call('notifications.list', { ...listArgs, view: 'archive' })).status).toBe(400)
    expect((await b.call('notifications.list', { limit: 20, cursor: 'abc' })).body.error).toBe('unsupported_capability')
    expect((await b.call('owner.fetch', { url: '/wizard/v1/settings' })).body.error).toBe('not_allowed')
    expect((await b.call('notifications.mark_read', { id: 'n1', expectedRevision: 'r-' + '0'.repeat(16) })).status).toBe(400)   // no operationKey
    for (const headers of [{ 'X-Wizard-Shell-Token': '' }, { Origin: 'null' }, { 'Sec-Fetch-Dest': 'iframe' }, { 'Sec-Fetch-Site': 'same-site' }]) {
      const r = await t.post('bindings', { appId: 'notifications', generation: randomUUID() }, headers)
      // Refused before adapter dispatch, by the boundary gate (401) or the existing cross-origin write gate (403).
      expect([401, 403], JSON.stringify(headers)).toContain(r.status)
      expect(r.body.handle, JSON.stringify(headers)).toBeUndefined()
    }
    expect(t.up.state.marks).toBe(0)
  })

  it('default-off: without the boundary the adapter routes do not exist', async () => {
    const t = await box({ boundary: false })
    const r = await t.post('bindings', { appId: 'notifications', generation: randomUUID() })
    expect(r.status).toBe(404)
    expect(existsSync(t.receipts)).toBe(false)
  })
})
