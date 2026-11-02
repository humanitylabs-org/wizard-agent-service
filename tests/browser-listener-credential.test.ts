// Listener credential on the adapter's OWN upstream call (wizard-os #386). The Notifications listener, with the
// browser boundary on, answers only the installation's app credential (minted by WAM, read here server-side from
// the WAM file on every call). The Service sends that credential and nothing ambient: never the shell token,
// owner proof, cookies, Authorization, Origin or Tailscale identity. Real WAM-written apps.json (listener-auth.json).
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { createWizardServer, listen } from '../server/service.mjs'

const TOKEN = randomBytes(32).toString('hex')
const PROOF = 'owner-proof-synthetic-'.repeat(3)
const FIXTURES = new URL('./fixtures/browser-trust/wam/', import.meta.url)
const resources: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close() })
const AMBIENT = ['cookie', 'authorization', 'x-wizard-shell-token', 'x-wizard-owner-proof', 'tailscale-user-login', 'origin', 'referer', 'x-forwarded-for', 'sec-fetch-site', 'sec-fetch-dest']

async function gatedUpstream() {
  // Mirrors the Notifications front's gate: no credential (or any ambient/browser header) -> refused.
  const state = { key: '', items: [{ id: 'n1', title: 'Synthetic', message: 'synthetic', time: 1761955200, read: false }], seen: [] as Record<string, string | string[] | undefined>[], refused: 0 }
  const server = createServer((req, res) => {
    state.seen.push({ ...req.headers })
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (AMBIENT.some(h => req.headers[h] !== undefined) || req.headers['x-wizard-app-credential'] !== state.key) { state.refused++; json(401, { error: 'adapter_credential_required' }); return }
    if (req.method === 'GET' && req.url?.startsWith('/notifications/api/items?')) { json(200, { items: state.items }); return }
    if (req.method === 'POST' && req.url === '/notifications/api/mark') {
      let body = ''; req.on('data', c => { body += c }); req.on('end', () => { for (const i of state.items) if (JSON.parse(body).ids.includes(i.id)) i.read = true; json(200, { ok: true }) }); return
    }
    json(404, {})
  })
  const address = await listen(server)
  resources.push(() => new Promise(r => server.close(r)))
  return { state, port: address.port }
}

async function box(scenario = 'listener-auth') {
  const up = await gatedUpstream()
  const dir = mkdtempSync(join(tmpdir(), 'bt-cred-'))
  resources.push(() => rmSync(dir, { recursive: true, force: true }))
  const appsJsonPath = join(dir, 'apps.json')
  const doc = JSON.parse(readFileSync(new URL(scenario + '.json', FIXTURES), 'utf8'))
  for (const a of doc.apps) if (a.browser?.upstream) a.browser.upstream = `http://127.0.0.1:${up.port}`
  writeFileSync(appsJsonPath, JSON.stringify(doc))
  const notif = doc.apps.find((a: any) => a.id === 'notifications').browser
  const keyFile = join(dir, 'browser-app-credentials', `${notif.installation_id}.key`)
  const setKey = (key: string | null) => {   // WAM's file; generated at runtime, never a literal
    mkdirSync(join(dir, 'browser-app-credentials'), { recursive: true })
    if (key === null) rmSync(keyFile, { force: true }); else writeFileSync(keyFile, key + '\n', { mode: 0o600 })
    up.state.key = key ?? ''
  }
  const server = createWizardServer({
    requireAccess: false, upstreamOrigin: 'http://127.0.0.1:1', hermesKey: 'fixture-key', ownerProof: PROOF,
    browserBoundary: { enabled: true, token: TOKEN }, browserAdapterWam: { receiptsPath: join(dir, 'receipts.json') },
    hermesHome: join(dir, 'synthetic-hermes'), wizardOsHome: dir, settingsPath: join(dir, 'settings.json'), appsJsonPath,
    launcherPath: join(dir, 'launcher.json'), agentBridge: false, followThrough: false, joinedDelegation: 'off',
  })
  const address = await listen(server)
  resources.push(() => new Promise(r => server.close(r)))
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${address.port}/wizard/v1/browser-adapters/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Wizard-Shell-Token': TOKEN, 'X-Wizard-Owner-Proof': PROOF, cookie: 'wos=ambient' }, body: JSON.stringify(body) })
    return { status: r.status, body: await r.json() }
  }
  let n = 0
  const bind = async () => {
    const generation = randomUUID()
    const r = await post('bindings', { appId: 'notifications', generation })
    expect(r.status).toBe(200)
    return (operation: string, args: unknown, extra: Record<string, unknown> = {}) => post('call', { handle: r.body.handle, generation, requestId: 'wbs-' + (++n), operation, args, ...extra })
  }
  return { up, setKey, bind, notif }
}

describe('adapter upstream uses the app-scoped listener credential, never ambient authority', () => {
  it('WAM recorded a credential reference, not the value', async () => {
    const t = await box()
    expect(t.notif.listener_credential).toEqual({ header: 'X-Wizard-App-Credential', ref: `browser-app-credentials/${t.notif.installation_id}.key`, env: 'WIZARD_APP_CREDENTIAL', state: 'written' })
  })

  it('list and mark-read pass the gated listener with the credential and no shell token or owner identity', async () => {
    const t = await box()
    const key = randomBytes(32).toString('hex'); t.setKey(key)
    const call = await t.bind()
    const list = await call('notifications.list', { limit: 5, cursor: null })
    expect(list.status).toBe(200)
    const mark = await call('notifications.mark_read', { id: 'n1', expectedRevision: list.body.items[0].revision }, { operationKey: randomUUID() })
    expect(mark.status).toBe(200)
    expect(t.up.state.items[0].read).toBe(true)
    expect(t.up.state.refused).toBe(0)
    expect(t.up.state.seen.length).toBeGreaterThan(2)
    for (const h of t.up.state.seen) {
      expect(h['x-wizard-app-credential']).toBe(key)
      for (const a of AMBIENT) expect(h[a]).toBeUndefined()
      expect(Object.values(h).join('\n')).not.toContain(TOKEN)
    }
  })

  it('missing or malformed key fails closed before any upstream request', async () => {
    const t = await box()
    t.setKey(null)
    const call = await t.bind()
    const r = await call('notifications.list', { limit: 5, cursor: null })
    expect(r).toEqual({ status: 503, body: { error: 'backend_unavailable', retryable: true } })
    t.setKey('not-a-key')
    expect((await call('notifications.list', { limit: 5, cursor: null })).status).toBe(503)
    expect(t.up.state.seen).toHaveLength(0)
  })

  it('a rotated key (reinstall) is read on the next call; the old one stops working', async () => {
    const t = await box()
    t.setKey(randomBytes(32).toString('hex'))
    const call = await t.bind()
    expect((await call('notifications.list', { limit: 5, cursor: null })).status).toBe(200)
    const rotated = randomBytes(32).toString('hex'); t.setKey(rotated)
    expect((await call('notifications.list', { limit: 5, cursor: null })).status).toBe(200)
    expect(t.up.state.seen.at(-1)?.['x-wizard-app-credential']).toBe(rotated)
    expect(t.up.state.refused).toBe(0)
  })

  it('an installation without a recorded credential sends none (ungated listener, unchanged behaviour)', async () => {
    const t = await box('granted')
    const call = await t.bind()
    t.up.state.key = undefined as unknown as string   // accept the absent header
    const r = await call('notifications.list', { limit: 5, cursor: null })
    expect(r.status).toBe(200)
    expect(t.up.state.seen.every(h => h['x-wizard-app-credential'] === undefined)).toBe(true)
  })
})
