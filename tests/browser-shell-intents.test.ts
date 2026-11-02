// Shell intents (wizard-os spec/browser-trust-shell-intents): the ChatGPT/Claude connection pages' typed operations,
// the trusted-shell owner confirmation and the narrow sign-in navigation intent, admitted only from WAM-written
// install/grant state (fixtures ai-*.json, generated from the apps' own wizard.md). The upstream stub follows the
// shared accounts engine (wizard-app-store images/wizard-chatgpt pool_server.py) and the original Claude Code page.
// Synthetic accounts only; no provider and no real sign-in.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { createWizardServer, listen } from '../server/service.mjs'
import { createBrowserAdapters } from '../server/browser-adapters.mjs'
import { createAiAccountsOperations, navigationTarget } from '../server/browser-ai-accounts.mjs'

const TOKEN = randomBytes(32).toString('hex')
const PROOF = 'owner-proof-synthetic-'.repeat(3)
const FIXTURES = new URL('./fixtures/browser-trust/wam/', import.meta.url)
const resources: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close() })
const AMBIENT = ['cookie', 'authorization', 'x-wizard-shell-token', 'x-wizard-owner-proof', 'tailscale-user-login', 'origin', 'referer', 'sec-fetch-site']
const JOB = () => randomBytes(18).toString('base64url')
const CLAUDE_URL = 'https://claude.ai/oauth/authorize?code=true&client_id=synthetic-client&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=synthetic&code_challenge_method=S256&state=synthetic-state'

async function accountsEngine(provider: 'chatgpt' | 'claude') {
  const state = {
    key: '', seen: [] as any[], posts: [] as any[], jobs: new Map<string, any>(), signinUrl: provider === 'chatgpt' ? 'https://auth.openai.com/codex/device' : CLAUDE_URL,
    legacy: { status: 'not_connected', posts: [] as any[] },
    accounts: [{ id: 'acct-1', name: 'openai-codex-oauth-1', source: 'pool', email: 's***@e***', plan: 'Plus', status: 'ready', secret: 'NEVER-FORWARDED',
      usage: { limits: [{ id: 'session:5h', label: 'Session', usedPercent: 12, resetsAt: '2026-11-02T12:00:00Z', raw: 'x' }], fetchedAt: '2026-11-02T06:00:00Z' },
      credentials: [{ id: 'cred-1', name: 'Sign-in A', managed: true, token: 'NEVER-FORWARDED' }], priority: 0, preferred: true,
      actions: { reconnect: true, remove: true, prefer: true } },
    { id: 'acct-2', name: 'Work', email: 'w***@e***', plan: 'Pro', status: 'expired', credentials: [{ id: 'cred-2', name: 'Sign-in B', managed: true }],
      priority: 1, preferred: false, actions: { reconnect: true, remove: true, prefer: true }, error: { code: 'expired', message: 'Sign in again at https://evil.example/x' } }] as any[],
  }
  const json = (res: any, code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  const server = createServer((req, res) => {
    state.seen.push({ method: req.method, url: req.url, headers: { ...req.headers } })
    if (AMBIENT.some(h => req.headers[h] !== undefined) || req.headers['x-wizard-app-credential'] !== state.key) { json(res, 401, { error: 'adapter_credential_required' }); return }
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://x')
      const d = body ? JSON.parse(body) : null
      if (req.method === 'GET' && url.pathname === '/api/accounts') {
        json(res, 200, { provider, name: provider === 'claude' ? 'Claude' : 'ChatGPT', owner: 'hermes', accounts: state.accounts, inventoryStatus: 'available',
          actions: { add: true }, management: { contract: 'wizard.account-management/1', status: 'available' }, agent: 'hermes-agent:9119', legacySignin: false, cookie: 'x' }); return
      }
      if (url.pathname === '/api/operations' && req.method === 'POST') {
        state.posts.push({ body: d, headers: { ...req.headers } })
        if (req.headers['x-wizard-account-action'] !== '1') { json(res, 403, { error: 'Cross-site action rejected' }); return }
        if (d.action === 'submit' || d.action === 'cancel') {
          const job = state.jobs.get(d.operation); if (!job) { json(res, 409, { error: 'refused' }); return }
          if (d.action === 'cancel') job.status = 'cancelled'; else { job.inputRequired = false; job.status = 'succeeded' }
          json(res, 200, job); return
        }
        if (d.confirmed !== true) { json(res, 403, { error: 'confirmation required' }); return }
        const job = { id: JOB(), provider, action: d.action, target: d.target ?? null, status: d.action === 'remove' || d.action === 'prefer' ? 'succeeded' : 'running', expiresAt: 1793600000,
          url: ['add', 'reconnect'].includes(d.action) ? state.signinUrl : null, userCode: provider === 'chatgpt' && d.action === 'add' ? 'SYN-1234' : null,
          inputRequired: provider === 'claude' && d.action === 'add', credentialIds: [], stdout: 'token=abc' }
        if (d.action === 'remove') state.accounts = state.accounts.filter(a => !a.credentials.some((c: any) => c.id === d.target))
        state.jobs.set(job.id, job)
        json(res, 200, job); return
      }
      const m = /^\/api\/operations\/([A-Za-z0-9_-]{20,64})$/.exec(url.pathname)
      if (m && req.method === 'GET') { const job = state.jobs.get(m[1]); job ? json(res, 200, job) : json(res, 404, { error: 'gone' }); return }
      if (url.pathname === '/claude-code/api/accounts') { json(res, 200, { accounts: [{ id: 'claude-code', name: 'Claude subscription', detail: 'Pro or Max', status: state.legacy.status, plan: 'Max 5x', account: 's***@e***' }] }); return }
      const l = /^\/claude-code\/api\/claude\/(connect|code|cancel|logout|test)$/.exec(url.pathname)
      if (l && req.method === 'POST') {
        state.legacy.posts.push({ path: l[1], body: d })
        if (l[1] === 'connect') { json(res, 200, { ok: true, login_id: 'login-synthetic-1', url: state.signinUrl }); return }
        if (l[1] === 'code') { state.legacy.status = 'connected'; json(res, 200, { ok: true, message: 'Connected.' }); return }
        if (l[1] === 'logout') { state.legacy.status = 'not_connected'; json(res, 200, { ok: true, message: 'Disconnected.' }); return }
        if (l[1] === 'test') { json(res, 200, { ok: true, message: 'Claude answered.', seconds: 1.4, model: 'synthetic-model' }); return }
        json(res, 200, { ok: true }); return
      }
      json(res, 404, { error: 'not found' })
    })
  })
  const address = await listen(server)
  resources.push(() => new Promise(r => server.close(r)))
  return { state, port: address.port }
}

async function box(appId: 'wizard-chatgpt' | 'wizard-claude', scenario = 'ai-granted') {
  const up = await accountsEngine(appId === 'wizard-claude' ? 'claude' : 'chatgpt')
  const dir = mkdtempSync(join(tmpdir(), 'bt-intents-'))
  resources.push(() => rmSync(dir, { recursive: true, force: true }))
  const appsJsonPath = join(dir, 'apps.json')
  const load = (name: string) => {
    const doc = JSON.parse(readFileSync(new URL(name + '.json', FIXTURES), 'utf8'))
    for (const a of doc.apps) if (a.browser?.upstream) a.browser.upstream = `http://127.0.0.1:${up.port}`
    writeFileSync(appsJsonPath, JSON.stringify(doc))
    return doc.apps.find((a: any) => a.id === appId).browser
  }
  const b = load(scenario)
  mkdirSync(join(dir, 'browser-app-credentials'), { recursive: true })
  const key = randomBytes(32).toString('hex')   // WAM's file; generated at runtime, never a literal
  writeFileSync(join(dir, 'browser-app-credentials', `${b.installation_id}.key`), key + '\n', { mode: 0o600 })
  up.state.key = key
  const receiptsPath = join(dir, 'receipts.json')
  const server = createWizardServer({
    requireAccess: false, upstreamOrigin: 'http://127.0.0.1:1', hermesKey: 'fixture-key', ownerProof: PROOF,
    browserBoundary: { enabled: true, token: TOKEN }, browserAdapterWam: { receiptsPath },
    hermesHome: join(dir, 'synthetic-hermes'), wizardOsHome: dir, settingsPath: join(dir, 'settings.json'), appsJsonPath,
    launcherPath: join(dir, 'launcher.json'), agentBridge: false, followThrough: false, joinedDelegation: 'off',
  })
  const address = await listen(server)
  resources.push(() => new Promise(r => server.close(r)))
  const post = async (path: string, body: unknown, headers: Record<string, string> = { 'X-Wizard-Shell-Token': TOKEN }) => {
    const r = await fetch(`http://127.0.0.1:${address.port}/wizard/v1/browser-adapters/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Wizard-Owner-Proof': PROOF, ...headers }, body: JSON.stringify(body) })
    return { status: r.status, body: await r.json() }
  }
  let n = 0
  const bind = async () => {
    const generation = randomUUID()
    const r = await post('bindings', { appId, generation })
    expect(r.status).toBe(200)
    const handle = r.body.handle
    return {
      handle, generation,
      call: (operation: string, args: unknown, extra: Record<string, unknown> = {}) => post('call', { handle, generation, requestId: 'wbs-' + (++n), operation, args, ...extra }),
      confirmIntent: (operation: string, args: unknown, operationKey = randomUUID()) => post('intents', { handle, generation, requestId: 'wbs-' + (++n), kind: 'confirm', operation, args, operationKey }),
      navigateIntent: (target: string, ref: string) => post('intents', { handle, generation, requestId: 'wbs-' + (++n), kind: 'navigate', target, ref }),
      confirm: (intent: string, extra: Record<string, unknown> = {}) => post('intents/confirm', { handle, generation, intent, ...extra }),
      cancel: (intent: string) => post('intents/cancel', { handle, intent }),
    }
  }
  return { up, bind, load, receiptsPath, key, post }
}

describe('ChatGPT/Claude typed account operations', () => {
  it('inventory is a fixed DTO over the gated listener: no credential bodies, no URLs, nothing ambient', async () => {
    const t = await box('wizard-chatgpt')
    const s = await t.bind()
    const r = await s.call('ai_accounts.inventory', {})
    expect(r.status).toBe(200)
    expect(r.body.accounts.map((a: any) => a.id)).toEqual(['acct-1', 'acct-2'])
    const text = JSON.stringify(r.body)
    for (const leak of ['NEVER-FORWARDED', 'cookie', 'evil.example', 'raw']) expect(text).not.toContain(leak)
    expect(r.body.accounts[1].error.message).toBe('Sign in again at [link]')
    expect(r.body.accounts[0].credentials).toEqual([{ id: 'cred-1', name: 'Sign-in A', managed: true }])
    for (const h of t.up.state.seen.map((x: any) => x.headers)) { expect(h['x-wizard-app-credential']).toBe(t.key); for (const a of AMBIENT) expect(h[a]).toBeUndefined() }
    expect((await s.call('ai_accounts.inventory', { extra: 1 })).body.error).toBe('bad_request')
  })

  it('an owner-consent change is never a plain data.call, and `confirmed` is never an app argument', async () => {
    const t = await box('wizard-chatgpt')
    const s = await t.bind()
    expect(await s.call('ai_accounts.change', { action: 'remove', target: 'cred-1' }, { operationKey: randomUUID() })).toEqual({ status: 403, body: { error: 'confirmation_required', retryable: false } })
    expect((await s.call('ai_accounts.change', { action: 'remove', target: 'cred-1', confirmed: true }, { operationKey: randomUUID() })).body.error).toBe('confirmation_required')
    expect((await s.confirmIntent('ai_accounts.change', { action: 'remove', target: 'cred-1', confirmed: true })).body.error).toBe('bad_request')
    expect((await s.confirmIntent('ai_accounts.inventory', {})).body.error).toBe('not_allowed')   // not a consent op
    expect(t.up.state.posts).toHaveLength(0)
  })

  it('a confirmed intent runs once, with exactly the reviewed arguments', async () => {
    const t = await box('wizard-chatgpt')
    const s = await t.bind()
    const key = randomUUID()
    const q = await s.confirmIntent('ai_accounts.change', { action: 'remove', target: 'cred-1' }, key)
    expect(q.status).toBe(200)
    expect(q.body.summary).toMatchObject({ title: 'Remove this sign-in?', danger: true, action: 'Remove' })
    expect(q.body.summary.detail).toContain('Sign-in A')
    expect(t.up.state.posts).toHaveLength(0)                                  // queuing reviews nothing upstream
    expect((await s.confirm(q.body.intent, { args: { target: 'cred-2' } })).body.error).toBe('bad_request')   // args are fixed
    const done = await s.confirm(q.body.intent)
    expect(done.status).toBe(200)
    expect(done.body).toMatchObject({ kind: 'confirm', value: { action: 'remove', status: 'succeeded', signin: null } })
    expect(t.up.state.posts.map((p: any) => p.body)).toEqual([{ action: 'remove', target: 'cred-1', label: '', confirmed: true }])
    expect((await s.confirm(q.body.intent)).body.error).toBe('not_found')     // consumed
    expect(t.up.state.posts).toHaveLength(1)
    const status = await s.call('data.status', { operation: 'ai_accounts.change', operationKey: key })
    expect(status.body).toMatchObject({ status: 'succeeded', operationKey: key })
  })

  it('an intent belongs to its binding and document; another view or a newer load cannot use it', async () => {
    const t = await box('wizard-chatgpt')
    const a = await t.bind(), b = await t.bind()
    const q = await a.confirmIntent('ai_accounts.change', { action: 'prefer', target: 'cred-2' })
    expect((await b.confirm(q.body.intent)).body.error).toBe('not_found')
    expect((await a.confirm(q.body.intent, {})).status).toBe(200)
    expect((await a.confirmIntent('ai_accounts.change', { action: 'prefer', target: 'missing' })).body.error).toBe('not_found')
  })

  it('an update between review and confirm refuses the confirmation (source/commit/permission revision bound)', async () => {
    const t = await box('wizard-chatgpt')
    const s = await t.bind()
    const q = await s.confirmIntent('ai_accounts.change', { action: 'add', target: null })
    t.load('ai-chatgpt-updated')
    expect(await s.confirm(q.body.intent)).toMatchObject({ status: 403, body: { error: 'revoked' } })
    expect(t.up.state.posts).toHaveLength(0)
  })

  it('a revoked grant cannot even queue a review', async () => {
    const t = await box('wizard-chatgpt', 'ai-chatgpt-no-change')
    const s = await t.bind()
    expect((await s.confirmIntent('ai_accounts.change', { action: 'add', target: null })).body.error).toBe('not_allowed')
    expect((await s.call('ai_accounts.inventory', {})).status).toBe(200)   // reads keep working
  })

  it('review requests: one open per binding, at most three a minute per installation', async () => {
    const t = await box('wizard-chatgpt')
    const s = await t.bind()
    const one = await s.confirmIntent('ai_accounts.change', { action: 'add', target: null })
    expect((await s.confirmIntent('ai_accounts.change', { action: 'add', target: null })).body.error).toBe('busy')
    await s.cancel(one.body.intent)
    const two = await s.confirmIntent('ai_accounts.change', { action: 'add', target: null }); await s.cancel(two.body.intent)
    const three = await s.confirmIntent('ai_accounts.change', { action: 'add', target: null }); await s.cancel(three.body.intent)
    const four = await s.confirmIntent('ai_accounts.change', { action: 'add', target: null })
    expect(four.status).toBe(429)
    expect(four.body.error).toBe('rate_limited')
    expect(four.body.retryAfterMs).toBeGreaterThan(0)
    const other = await t.bind()   // the limit is per installation, not per view
    expect((await other.confirmIntent('ai_accounts.change', { action: 'add', target: null })).status).toBe(429)
    expect(t.up.state.posts).toHaveLength(0)
  })

  it('frames and non-shell callers cannot reach the intent routes (server-side refusal)', async () => {
    const t = await box('wizard-chatgpt')
    const s = await t.bind()
    const q = await s.confirmIntent('ai_accounts.change', { action: 'add', target: null })
    const body = { handle: s.handle, generation: s.generation, intent: q.body.intent }
    for (const headers of [{}, { 'X-Wizard-Shell-Token': '0'.repeat(64) }, { 'X-Wizard-Shell-Token': TOKEN, Origin: 'null' },
      { 'X-Wizard-Shell-Token': TOKEN, 'Sec-Fetch-Site': 'cross-site' }, { 'X-Wizard-Shell-Token': TOKEN, 'Sec-Fetch-Dest': 'iframe' }]) {
      const r = await t.post('intents/confirm', body, headers as Record<string, string>)
      // Origin null is refused by the earlier origin check (403 opaque_origin); everything else by the shell-token gate.
      expect([401, 403]).toContain(r.status)
      expect(['shell_token_required', 'opaque_origin']).toContain(r.body.error)
    }
    expect(t.up.state.posts).toHaveLength(0)
    expect((await s.confirm(q.body.intent)).status).toBe(200)   // the shell itself still can, once
  })
})

describe('narrow sign-in navigation intent', () => {
  it('ChatGPT: the device page reaches the frame only as a target id; the shell gets the URL after confirming', async () => {
    const t = await box('wizard-chatgpt')
    const s = await t.bind()
    const q = await s.confirmIntent('ai_accounts.change', { action: 'add', target: null })
    const started = (await s.confirm(q.body.intent)).body.value
    expect(started).toMatchObject({ action: 'add', status: 'running', userCode: 'SYN-1234', signin: 'signin' })
    expect(JSON.stringify(started)).not.toContain('https://')
    const progress = await s.call('ai_accounts.progress', { operation: started.id })
    expect(progress.body).toMatchObject({ signin: 'signin', userCode: 'SYN-1234' })
    expect(JSON.stringify(progress.body)).not.toContain('token=abc')
    const nav = await s.navigateIntent('signin', 'ai:' + started.id)
    expect(nav.body.summary).toMatchObject({ host: 'auth.openai.com', path: '/codex/device', action: 'Open' })
    expect(JSON.stringify(nav.body)).not.toContain('https://')
    expect((await s.confirm(nav.body.intent)).body).toEqual({ kind: 'navigate', url: 'https://auth.openai.com/codex/device' })
    expect((await s.confirm(nav.body.intent)).body.error).toBe('not_found')   // once
  })

  it('a sign-in page outside the installed contract is dropped and cannot be opened', async () => {
    const t = await box('wizard-chatgpt')
    t.up.state.signinUrl = 'https://auth.openai.com.evil.example/codex/device'
    const s = await t.bind()
    const started = (await s.confirm((await s.confirmIntent('ai_accounts.change', { action: 'add', target: null })).body.intent)).body.value
    expect(started.signin).toBeNull()
    expect((await s.navigateIntent('signin', 'ai:' + started.id)).body.error).toBe('not_found')
    expect((await s.navigateIntent('signin', 'ai:' + 'x'.repeat(24))).body.error).toBe('not_found')   // never produced
    expect((await s.navigateIntent('signin', 'https://evil.example/')).body.error).toBe('bad_request')   // no URLs from the app
  })

  it('Claude: the PKCE authorize page passes only with its listed query names; a token-shaped parameter is refused', async () => {
    const contract = { navigation: [{ id: 'signin', url: 'https://claude.ai/oauth/authorize', query: ['client_id', 'code', 'code_challenge', 'code_challenge_method', 'redirect_uri', 'response_type', 'scope', 'state'] }] }
    expect(navigationTarget(contract, CLAUDE_URL)).toBe('signin')
    for (const bad of [CLAUDE_URL + '&access_token=x', CLAUDE_URL + '#frag', CLAUDE_URL.replace('claude.ai', 'claude.ai:444'), CLAUDE_URL.replace('https://', 'https://u:p@'),
      CLAUDE_URL.replace('/oauth/authorize', '/oauth/authorize2'), CLAUDE_URL.replace('https:', 'http:'), CLAUDE_URL + '&state=dup']) expect(navigationTarget(contract, bad)).toBeNull()
    const t = await box('wizard-claude')
    const s = await t.bind()
    const started = (await s.confirm((await s.confirmIntent('ai_accounts.change', { action: 'add', target: null })).body.intent)).body.value
    expect(started).toMatchObject({ signin: 'signin', inputRequired: true, userCode: null })
    const code = 'synthetic' + randomBytes(8).toString('hex') + '#' + randomBytes(6).toString('hex')
    const step = await s.call('ai_accounts.step', { action: 'submit', operation: started.id, code }, { operationKey: randomUUID() })
    expect(step.body).toMatchObject({ status: 'succeeded' })
    expect(t.up.state.posts.at(-1).body).toEqual({ action: 'submit', operation: started.id, code })
    expect(readFileSync(t.receiptsPath, 'utf8')).not.toContain(code)    // the pasted code is never kept
    expect((await s.call('ai_accounts.step', { action: 'submit', operation: started.id, code: 'not a code' }, { operationKey: randomUUID() })).body.error).toBe('bad_request')
  })

  it('Claude Code page: connect and sign out need the owner; code, cancel and test do not; the login page opens only through the shell', async () => {
    const t = await box('wizard-claude')
    const s = await t.bind()
    expect((await s.call('claude_code.status', {})).body.accounts[0]).toMatchObject({ status: 'not_connected', plan: 'Max 5x' })
    expect((await s.call('claude_code.connect', {}, { operationKey: randomUUID() })).body.error).toBe('confirmation_required')
    const c = await s.confirmIntent('claude_code.connect', {})
    expect(c.body.summary.title).toBe('Connect Claude')
    const connected = (await s.confirm(c.body.intent)).body.value
    expect(connected).toEqual({ ok: true, loginId: 'login-synthetic-1', signin: 'signin', message: '' })
    const nav = await s.navigateIntent('signin', 'cc:login-synthetic-1')
    expect((await s.confirm(nav.body.intent)).body.url).toBe(CLAUDE_URL)
    expect((await s.call('claude_code.code', { loginId: 'login-synthetic-1', code: 'synthetic-code#state' }, { operationKey: randomUUID() })).body).toEqual({ ok: true, message: 'Connected.' })
    expect((await s.call('claude_code.test', {}, { operationKey: randomUUID() })).body).toEqual({ ok: true, message: 'Claude answered.', seconds: 1.4, model: 'synthetic-model' })
    expect((await s.call('claude_code.logout', {}, { operationKey: randomUUID() })).body.error).toBe('confirmation_required')
    const out = await s.confirmIntent('claude_code.logout', {})
    expect(out.body.summary).toMatchObject({ danger: true, action: 'Disconnect' })
    expect((await s.confirm(out.body.intent)).body.value).toEqual({ ok: true, message: 'Disconnected.' })
    expect(t.up.state.legacy.posts.map((p: any) => p.path)).toEqual(['connect', 'code', 'test', 'logout'])
  })
})

describe('intent lifetime', () => {
  it('expires two minutes after it was queued and is then refused', async () => {
    let t = 1_000_000
    const principal = { status: 'running', installationId: 'inst-' + 'a'.repeat(32), sourceId: 'standard:o/r', installedCommit: 'c'.repeat(40), permissionRevision: 'p-1', upstream: 'http://127.0.0.1:9',
      browser_contract: { operations: ['ai_accounts.change'], navigation: [] }, providers: {} }
    const fetchImpl = async () => new Response(JSON.stringify({ provider: 'chatgpt', accounts: [] }), { headers: { 'content-type': 'application/json' } })
    const ai = createAiAccountsOperations({ fetchImpl: fetchImpl as any, receipts: null } as any)
    const adapters: any = createBrowserAdapters({ resolveInstallation: () => principal, resolveGrants: () => ({ operations: ['ai_accounts.change'] }), ai, now: () => t } as any)
    const generation = randomUUID()
    const { handle } = adapters.create({ appId: 'wizard-chatgpt', generation })
    const q = await adapters.intentCreate({ handle, generation, requestId: 'wbs-1', kind: 'confirm', operation: 'ai_accounts.change', args: { action: 'add', target: null }, operationKey: randomUUID() })
    t += 120_001
    await expect(adapters.intentConfirm({ handle, generation, intent: q.intent })).rejects.toMatchObject({ code: 'expired' })
  })
})
