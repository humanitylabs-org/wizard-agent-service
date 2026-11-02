// Shell-owned typed operations (wizard-os spec/browser-trust-shell-intents §6): the shell model picker's Claude
// accounts read goes through ONE fixed Service operation instead of the Claude app's own /api/accounts, which the
// listener gate refuses to every browser. WAM-generated goldens (ai-*.json); synthetic accounts only.
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
const AMBIENT = ['cookie', 'authorization', 'x-wizard-shell-token', 'x-wizard-owner-proof', 'tailscale-user-login', 'origin', 'referer', 'sec-fetch-site']

async function claudeEngine() {
  const state = { key: '', seen: [] as any[], status: 200, accounts: [
    { id: 'acct-1', name: 'Max', source: 'pool', email: 's***@e***', plan: 'Max 5x', status: 'ready', secret: 'NEVER-FORWARDED',
      usage: { fetchedAt: new Date().toISOString(), limits: [{ id: 'session:session', label: 'Session', usedPercent: 100, remainingPercent: 0, resetsAt: '2026-11-02T12:00:00Z' },
        { id: 'weekly_all:weekly', label: 'Weekly', usedPercent: 40, remainingPercent: 60 }, { id: 'opus:weekly', label: 'Opus', usedPercent: 5, remainingPercent: 95 }] },
      credentials: [{ id: 'cred-1', name: 'Sign-in A', managed: true, token: 'NEVER-FORWARDED' }], actions: { reconnect: true, remove: true, prefer: true } },
    { id: 'acct-2', name: 'Work', source: 'pool', email: 'w***@e***', plan: 'Pro', status: 'rate_limited', credentials: [{ id: 'cred-2', name: 'Sign-in B', managed: true }],
      error: { code: 'limit', message: 'See https://evil.example/x' } }] as any[] }
  const server = createServer((req, res) => {
    state.seen.push({ method: req.method, url: req.url, headers: { ...req.headers } })
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (AMBIENT.some(h => req.headers[h] !== undefined) || req.headers['x-wizard-app-credential'] !== state.key) return json(401, { error: 'adapter_credential_required' })
    if (req.method === 'GET' && req.url === '/api/accounts') return state.status === 200 ? json(200, { provider: 'claude', owner: 'hermes', accounts: state.accounts, actions: { add: true } }) : json(state.status, { error: 'down' })
    json(404, { error: 'not found' })
  })
  const address = await listen(server)
  resources.push(() => new Promise(r => server.close(r)))
  return { state, port: address.port }
}

async function box(scenario = 'ai-granted', mutate: (doc: any) => void = () => {}) {
  const up = await claudeEngine()
  const dir = mkdtempSync(join(tmpdir(), 'bt-shellops-'))
  resources.push(() => rmSync(dir, { recursive: true, force: true }))
  const appsJsonPath = join(dir, 'apps.json')
  const doc = JSON.parse(readFileSync(new URL(scenario + '.json', FIXTURES), 'utf8'))
  for (const a of doc.apps) if (a.browser?.upstream) a.browser.upstream = `http://127.0.0.1:${up.port}`
  mutate(doc)
  writeFileSync(appsJsonPath, JSON.stringify(doc))
  const b = doc.apps.find((a: any) => a.id === 'wizard-claude')?.browser
  mkdirSync(join(dir, 'browser-app-credentials'), { recursive: true })
  const key = randomBytes(32).toString('hex')   // WAM's file; generated at runtime, never a literal
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
  const call = async (body: unknown, headers: Record<string, string> = {}, path = '/wizard/v1/browser-shell/call') => {
    const r = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Wizard-Owner-Proof': PROOF, 'X-Wizard-Shell-Token': TOKEN, ...headers }, body: JSON.stringify(body) })
    return { status: r.status, body: await r.json() }
  }
  return { up, call, port: address.port, keyFile: b ? join(dir, 'browser-app-credentials', `${b.installation_id}.key`) : '' }
}
const READ = { operation: 'models.claude_accounts', args: {} }

describe('shell model picker: models.claude_accounts', () => {
  it('reads the Claude slot installation through its listener credential and returns only the picker fields', async () => {
    const t = await box()
    const r = await t.call(READ)
    expect(r.status).toBe(200)
    expect(r.body.state).toBe('ok')
    expect(r.body.accounts).toHaveLength(2)
    expect(r.body.accounts[0]).toEqual({ id: 'account', source: 'pool', status: 'ready', usage: { fetchedAt: expect.any(String),
      limits: [{ id: 'session:session', usedPercent: 100, remainingPercent: 0 }, { id: 'weekly_all:weekly', usedPercent: 40, remainingPercent: 60 }] } })
    expect(r.body.accounts[1]).toEqual({ id: 'account', source: 'pool', status: 'rate_limited', usage: null })
    const text = JSON.stringify(r.body)
    for (const leak of ['NEVER-FORWARDED', 'cred-1', 's***@e***', 'Max 5x', 'evil.example', 'Sign-in', 'opus:weekly']) expect(text).not.toContain(leak)
    expect(t.up.state.seen).toHaveLength(1)
    const h = t.up.state.seen[0].headers
    expect(h['x-wizard-app-credential']).toBe(t.up.state.key)
    for (const a of AMBIENT) expect(h[a]).toBeUndefined()
  })

  it('is shell-only: no token, a frame, another site or Origin:null never reach the app', async () => {
    const t = await box()
    expect([401, 403]).toContain((await t.call(READ, { 'X-Wizard-Shell-Token': '' })).status)
    expect([401, 403]).toContain((await t.call(READ, { Origin: 'null' })).status)
    expect([401, 403]).toContain((await t.call(READ, { 'Sec-Fetch-Site': 'cross-site' })).status)
    expect([401, 403]).toContain((await t.call(READ, { 'Sec-Fetch-Dest': 'iframe' })).status)
    const noOwner = await fetch(`http://127.0.0.1:${t.port}/wizard/v1/browser-shell/call`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Wizard-Shell-Token': TOKEN }, body: JSON.stringify(READ) })
    expect(noOwner.status).toBe(403)
    expect(t.up.state.seen).toHaveLength(0)
  })

  it('is a closed list with exact arguments, and not reachable through the app-frame adapter', async () => {
    const t = await box()
    expect((await t.call({ operation: 'models.claude_accounts', args: { app: 'wizard-chatgpt' } })).body.error).toBe('bad_request')
    expect((await t.call({ operation: 'ai_accounts.inventory', args: {} })).body.error).toBe('bad_request')
    expect((await t.call({ operation: 'models.claude_accounts' })).body.error).toBe('bad_request')
    const bind = await t.call({ appId: 'wizard-claude', generation: randomUUID() }, {}, '/wizard/v1/browser-adapters/bindings')
    expect(bind.status).toBe(200)
    const viaFrame = await t.call({ handle: bind.body.handle, generation: 'x', requestId: 'wbs-1', operation: 'models.claude_accounts', args: {} }, {}, '/wizard/v1/browser-adapters/call')
    expect(viaFrame.status).toBe(403)
    expect(t.up.state.seen).toHaveLength(0)
  })

  it('absent and unavailable stay distinct (the picker says "not answering" only for the second)', async () => {
    const down = await box()
    down.up.state.status = 503
    expect((await down.call(READ)).body).toEqual({ state: 'unavailable' })
    // Another app holds the Claude subscription slot: never read the non-provider installation.
    const other = await box('ai-granted', doc => { doc.slots['claude-subscription'].default = 'wizard-chatgpt' })
    expect((await other.call(READ)).body).toEqual({ state: 'absent' })
    expect(other.up.state.seen).toHaveLength(0)
    const gone = await box('ai-granted', doc => { doc.apps = doc.apps.filter((a: any) => a.id !== 'wizard-claude') })
    expect((await gone.call(READ)).body).toEqual({ state: 'absent' })
  })

  it('a recorded but missing listener credential fails closed without calling the app', async () => {
    const t = await box()
    rmSync(t.keyFile)
    expect((await t.call(READ)).body).toEqual({ state: 'unavailable' })
    expect(t.up.state.seen).toHaveLength(0)
  })
})

describe('health probes under the boundary', () => {
  it('a program (no browser headers) reads /wizard/health without the shell token; a browser request still needs it', async () => {
    const t = await box()
    const get = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${t.port}/wizard/health`, { headers: { 'X-Wizard-Owner-Proof': PROOF, ...headers } })
    const prog = await get({})
    expect(prog.status).toBe(200)
    expect((await prog.json()).status).toBe('ok')
    expect([401, 403]).toContain((await get({ 'Sec-Fetch-Site': 'same-origin' })).status)
    expect([401, 403]).toContain((await get({ Origin: 'null' })).status)
    expect([401, 403]).toContain((await get({ 'Tailscale-User-Login': 'owner@example.test' })).status)   // network identity: not box-local
  })
})
