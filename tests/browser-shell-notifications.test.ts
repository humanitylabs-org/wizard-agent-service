// Rehearsal finding (wizard-os 389): the shell's Chats bell (wizard-ux web/core/notif-bell.js) read
// /notifications/api/count and /api/items and posted /api/mark straight from the shell document. Under the listener
// gate the Notifications listener answers only the Service adapter, so the bell went blank. The shell now asks
// the Service through shell-owned typed operations (like models.claude_accounts): notifications.count / .items /
// .mark, on the Notifications slot's WAM-recorded installation and its listener credential, reusing the frame's
// typed notifications operations (projection, compare-and-set, durable receipts). WAM golden listener-auth.json.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createWizardServer, listen } from '../server/service.mjs'

const TOKEN = randomBytes(32).toString('hex')
const PROOF = 'owner-proof-synthetic-'.repeat(3)
const FIXTURES = new URL('./fixtures/browser-trust/wam/', import.meta.url)
const resources: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close() })
const rev = (i: any) => 'r-' + createHash('sha256').update(JSON.stringify(['notification-mark-v1', i.id, !!i.read, !!i.flag, !!i.archived])).digest('hex').slice(0, 16)
const AMBIENT = ['cookie', 'authorization', 'x-wizard-shell-token', 'x-wizard-owner-proof', 'tailscale-user-login', 'origin', 'referer']

async function upstream() {
  const mk = (n: number, extra = {}) => ({ id: 'n' + n, title: 'Synthetic ' + n, message: 'synthetic ' + n, time: 1761955200 - n, priority: 3, link: '', source: 'agent', read: false, flag: false, archived: false, ...extra })
  const state = { key: '', items: [mk(1, { priority: 5 }), mk(2), mk(3, { archived: true, read: true })] as any[], requests: [] as string[] }
  const server = createServer((req, res) => {
    state.requests.push(`${req.method} ${req.url}`)
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (AMBIENT.some(h => req.headers[h] !== undefined) || req.headers['x-wizard-app-credential'] !== state.key) return json(401, { error: 'adapter_credential_required' })
    const url = new URL(req.url || '/', 'http://x')
    const counts = () => ({ unread: state.items.filter(i => !i.read && !i.archived).length, needs: state.items.filter(i => !i.read && !i.archived && i.priority >= 4).length, flagged: 0 })
    if (req.method === 'GET' && url.pathname === '/notifications/api/items') {
      const v = url.searchParams.get('view'), items = v === 'all' ? state.items : state.items.filter(i => !i.archived)
      return json(200, { view: v, counts: counts(), items: items.slice(0, Number(url.searchParams.get('limit'))).map(i => ({ ...i, revision: rev(i), secret: 'NEVER' })) })
    }
    if (req.method === 'POST' && url.pathname === '/notifications/api/mark') {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        const d = JSON.parse(body)
        const hit = state.items.filter(i => d.ids.includes(i.id))
        if (d.expect && hit.some(i => rev(i) !== d.expect[i.id])) return json(409, { error: 'conflict' })
        for (const i of hit) for (const k of ['read', 'flag', 'archived']) if (typeof d[k] === 'boolean') i[k] = d[k]
        json(200, { ok: true })
      })
      return
    }
    json(404, { error: 'not found' })
  })
  const address = await listen(server)
  resources.push(() => new Promise(r => server.close(r)))
  return { state, port: address.port }
}

async function box(mutate: (doc: any) => void = () => {}) {
  const up = await upstream()
  const dir = mkdtempSync(join(tmpdir(), 'bt-bell-'))
  resources.push(() => rmSync(dir, { recursive: true, force: true }))
  const appsJsonPath = join(dir, 'apps.json')
  const doc = JSON.parse(readFileSync(new URL('listener-auth.json', FIXTURES), 'utf8'))
  for (const a of doc.apps) if (a.browser?.upstream) a.browser.upstream = `http://127.0.0.1:${up.port}`
  mutate(doc)
  writeFileSync(appsJsonPath, JSON.stringify(doc))
  const b = doc.apps.find((a: any) => a.id === 'notifications')?.browser
  mkdirSync(join(dir, 'browser-app-credentials'), { recursive: true })
  const key = randomBytes(32).toString('hex')
  if (b) writeFileSync(join(dir, 'browser-app-credentials', `${b.installation_id}.key`), key + '\n', { mode: 0o600 })
  up.state.key = key
  const server = createWizardServer({
    requireAccess: false, upstreamOrigin: 'http://127.0.0.1:1', hermesKey: 'fixture-key', ownerProof: PROOF,
    browserBoundary: { enabled: true, token: TOKEN }, browserAdapterWam: { receiptsPath: join(dir, 'receipts.json') },
    hermesHome: join(dir, 'synthetic-hermes'), wizardOsHome: dir, settingsPath: join(dir, 'settings.json'), appsJsonPath,
    launcherPath: join(dir, 'launcher.json'), agentBridge: false, followThrough: false, joinedDelegation: 'off',
  })
  const address = await listen(server)
  resources.push(() => new Promise(r => server.close(r)))
  const call = async (body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`http://127.0.0.1:${address.port}/wizard/v1/browser-shell/call`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Wizard-Owner-Proof': PROOF, 'X-Wizard-Shell-Token': TOKEN, ...headers }, body: JSON.stringify(body) })
    return { status: r.status, body: await r.json() }
  }
  return { up, call }
}

describe('shell Chats bell: notifications.count / .items / .mark', () => {
  it('count and items come from the Notifications installation through its listener credential, projected', async () => {
    const t = await box()
    const c = await t.call({ operation: 'notifications.count', args: {} })
    expect(c).toEqual({ status: 200, body: { state: 'ok', counts: { unread: 2, needs: 1, flagged: 0 } } })
    const i = await t.call({ operation: 'notifications.items', args: {} })
    expect(i.status).toBe(200)
    expect(i.body.state).toBe('ok')
    expect(i.body.items.map((x: any) => x.id)).toEqual(['n1', 'n2', 'n3'])
    expect(JSON.stringify(i.body)).not.toContain('NEVER')
    expect(t.up.state.requests).toEqual(['GET /notifications/api/items?view=inbox&limit=1', 'GET /notifications/api/items?view=all&limit=200'])
  })

  it('mark is the typed compare-and-set write: lands with the right revision, refuses a stale one', async () => {
    const t = await box()
    const items = (await t.call({ operation: 'notifications.items', args: {} })).body.items
    const n2 = items.find((x: any) => x.id === 'n2')
    const ok = await t.call({ operation: 'notifications.mark', args: { items: [{ id: 'n2', expectedRevision: n2.revision }], marks: { read: true }, operationKey: randomUUID() } })
    expect(ok.status).toBe(200)
    expect(ok.body.state).toBe('ok')
    expect(t.up.state.items.find(x => x.id === 'n2').read).toBe(true)
    const stale = await t.call({ operation: 'notifications.mark', args: { items: [{ id: 'n2', expectedRevision: n2.revision }], marks: { archived: true }, operationKey: randomUUID() } })
    expect(stale.body).toEqual({ state: 'failed', error: 'conflict' })
    expect(t.up.state.items.find(x => x.id === 'n2').archived).toBe(false)
    for (const bad of [{ items: [], marks: { read: true }, operationKey: randomUUID() }, { items: [{ id: 'n1', expectedRevision: 'r-0' }], marks: { evil: true }, operationKey: randomUUID() },
      { items: [{ id: 'n1', expectedRevision: n2.revision }], marks: { read: true } }, { items: [{ id: 'n1', expectedRevision: n2.revision }], marks: { read: true }, operationKey: 'x', extra: 1 }]) {
      expect((await t.call({ operation: 'notifications.mark', args: bad })).status).toBe(400)
    }
  })

  it('no Notifications installation (or not the slot provider): absent, nothing fetched', async () => {
    const t = await box(doc => { doc.slots.notifications.default = 'other-app' })
    expect((await t.call({ operation: 'notifications.count', args: {} })).body).toEqual({ state: 'absent' })
    expect(t.up.state.requests).toEqual([])
  })

  it('never from a frame, another site or Origin:null; never with extra args', async () => {
    const t = await box()
    for (const h of [{ origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-dest': 'iframe' }]) {
      expect((await t.call({ operation: 'notifications.count', args: {} }, h)).status).toBeGreaterThanOrEqual(400)
    }
    expect((await t.call({ operation: 'notifications.items', args: { view: 'all' } })).status).toBe(400)
    expect(t.up.state.requests).toEqual([])
  })
})
