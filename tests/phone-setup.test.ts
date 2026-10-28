import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPhoneSetup } from '../server/phone-setup.mjs'
import { createTailnetIngress, createWizardServer, listen } from '../server/service.mjs'
import { createSettingsTailnetVerifier, createTailnetAccessVerifier } from '../server/tailnet-access.mjs'
import { normalizeSettings, readSettings, updateSettings } from '../server/wizard-os-settings.mjs'

const OWNER = 'owner@example.com'
const DNS = 'wizard.tail1234.ts.net'
const ORIGIN = `https://${DNS}`
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()) })))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir() { const d = mkdtempSync(join(tmpdir(), 'phone-setup-')); dirs.push(d); return d }

type HelperState = {
  installed: boolean, daemon: string, backend_state: string, auth_url: string | null, dns_name: string | null,
  https_enabled: boolean, https_enable_url: string | null, serve: { on: boolean, target: string | null },
  owner_login: string | null, peers: Array<Record<string, unknown>>, tailnet: string | null,
}

// A stand-in for ops/private-access/wizard-private-access on a real unix socket (same routes and shapes).
async function fakeHelper(dir: string, initial: Partial<HelperState> = {}) {
  const state: HelperState = {
    installed: true, daemon: 'running', backend_state: 'NeedsLogin', auth_url: null, dns_name: null, tailnet: null,
    https_enabled: false, https_enable_url: null, serve: { on: false, target: null }, owner_login: null, peers: [], ...initial,
  }
  const calls: string[] = []
  const socketPath = join(dir, 'helper.sock')
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      calls.push(`${req.method} ${req.url} ${body}`.trim())
      const reply = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
      const route = `${req.method} ${req.url}`
      if (route === 'GET /v1/status') return reply(200, state)
      if (route === 'POST /v1/start') {
        if (state.backend_state !== 'Running') { state.backend_state = 'NeedsLogin'; state.auth_url = 'https://login.tailscale.com/a/abc123' }
        return reply(200, state)
      }
      if (route === 'POST /v1/serve') {
        if (state.backend_state !== 'Running') return reply(409, { error: 'not_signed_in', detail: 'x' })
        if (!state.https_enabled) { state.https_enable_url = 'https://login.tailscale.com/f/serve?node=n1'; return reply(200, state) }
        state.serve = { on: true, target: 'http://127.0.0.1:8799' }; state.https_enable_url = null
        return reply(200, state)
      }
      if (route === 'POST /v1/reset') {
        if ((state as any).reset_fails) return reply(502, { error: 'reset_failed', detail: 'tailscale is still signed in' })
        Object.assign(state, { backend_state: 'NeedsLogin', auth_url: null, dns_name: null, owner_login: null, serve: { on: false, target: null }, peers: [] })
        return reply(200, state)
      }
      return reply(404, { error: 'not_found', detail: '' })
    })
  })
  await new Promise<void>((r) => server.listen(socketPath, r))
  servers.push(server)
  const signIn = (login = OWNER) => Object.assign(state, { backend_state: 'Running', auth_url: null, dns_name: DNS, tailnet: 'tail1234.ts.net', owner_login: login })
  return { state, calls, socketPath, signIn }
}

function call(port: number, path: string, { method = 'GET', headers = {}, body = '' }: { method?: string, headers?: Record<string, string>, body?: string } = {}) {
  return new Promise<{ status: number, body: any, raw: string }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => { let parsed: any = null; try { parsed = JSON.parse(data) } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, body: parsed, raw: data }) })
    })
    req.on('error', reject)
    req.end(body || undefined)
  })
}
const jsonPost = (headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' })

async function startLocal(options: Record<string, unknown>) {
  const server = createWizardServer({ requireAccess: false, agentBridge: false, followThrough: false, archivedSessionReader: () => [], ...options })
  servers.push(server)
  return { server, port: (await listen(server)).port }
}

describe('Wizard OS settings for phone setup', () => {
  it('normalises access.tailscale and setup progress', () => {
    const empty = normalizeSettings({})
    expect(empty.access).toEqual({ tailscale: { origin: '', owner_logins: [] } })
    expect(empty.setup).toEqual({ seen_at: '', phone_started_at: '', phone_seen_at: '' })
    const on = normalizeSettings({ access: { tailscale: { origin: ORIGIN, owner_logins: ['Owner@Example.com', 'owner@example.com', 'bad login', 7] } },
      setup: { seen_at: '2026-10-14T10:00:00Z', phone_seen_at: 'yesterday' } })
    expect(on.access.tailscale).toEqual({ origin: ORIGIN, owner_logins: [OWNER] })
    expect(on.setup).toEqual({ seen_at: '2026-10-14T10:00:00Z', phone_started_at: '', phone_seen_at: '' })
    // Origin must be an exact https *.ts.net origin, and an origin without owners authorizes nobody.
    for (const origin of ['http://wizard.tail1234.ts.net', 'https://example.com', `${ORIGIN}/x`, `https://u:p@${DNS}`]) {
      expect(normalizeSettings({ access: { tailscale: { origin, owner_logins: [OWNER] } } }).access.tailscale.origin).toBe('')
    }
    expect(normalizeSettings({ access: { tailscale: { origin: ORIGIN, owner_logins: [] } } }).access.tailscale).toEqual({ origin: '', owner_logins: [] })
    expect(normalizeSettings({ access: { tailscale: { origin: ORIGIN, owner_logins: ['a@b.c,d@e.f'] } } }).access.tailscale.owner_logins).toEqual([])
  })

  it('updateSettings keeps unknown keys, writes atomically and never clobbers an unreadable file', () => {
    const dir = tempDir()
    const path = join(dir, 'settings.json')
    writeFileSync(path, JSON.stringify({ schema: 1, owner: { name: 'Alex' }, custom: { keep: true } }))
    const result = updateSettings(path, (raw: any) => { raw.setup = { seen_at: '2026-10-14T10:00:00Z' } })
    expect(result.owner.name).toBe('Alex')
    expect(result.setup.seen_at).toBe('2026-10-14T10:00:00Z')
    expect(JSON.parse(readFileSync(path, 'utf8')).custom).toEqual({ keep: true })
    writeFileSync(path, '{ not json')
    expect(() => updateSettings(path, () => {})).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{ not json')
    const fresh = join(dir, 'nested', 'settings.json')
    updateSettings(fresh, (raw: any) => { raw.setup = { seen_at: '2026-10-14T10:00:00Z' } })
    expect(readSettings(fresh).settings.setup.seen_at).toBe('2026-10-14T10:00:00Z')
  })
})

describe('setup API (box-local listener)', () => {
  it('advertises quiet launch only for explicitly configured alongside installs', async () => {
    const dir = tempDir()
    for (const launchMode of ['alongside', 'vm', '', 'unknown']) {
      const setup = createPhoneSetup({ settingsPath: join(dir, 'settings.json'), launchMode })
      expect((await setup.overview()).launch_mode).toBe(launchMode === 'alongside' ? 'alongside' : undefined)
      expect(existsSync(join(dir, 'settings.json'))).toBe(false)
    }
  })

  it('a helper outage never marks a stale host phone address ready', async () => {
    const dir = tempDir()
    const socketPath = join(dir,'unresponsive.sock')
    writeFileSync(socketPath,'')
    let calls = 0
    const setup = createPhoneSetup({ settingsPath: join(dir, 'settings.json'), socketPath, hostShellUrl: () => `${ORIGIN}:8796/wizard-os-home/`,
      call: async () => { calls++; throw new Error('The summary must never call or wait for the helper') } })
    expect((await setup.overview()).items[0]).toEqual({ id: 'phone', title: 'Use Wizard on your phone', state: 'todo' })
    expect(calls).toBe(0)
  })

  it.each([false,true])('an unlinked helper socket never reclassifies a prior enrollment (pinned=%s)', async (accessPinned) => {
    const dir = tempDir(), settingsPath = join(dir, 'settings.json')
    updateSettings(settingsPath, (raw: any) => {
      raw.network = {base_url: ORIGIN}
      raw.access = {tailscale:{origin:ORIGIN,owner_logins:[OWNER]}}
      raw.setup = {phone_started_at:new Date().toISOString()}
    })
    const setup = createPhoneSetup({settingsPath, accessPinned, socketPath:join(dir,'missing.sock'), hostShellUrl:()=>`${ORIGIN}:8796/wizard-os-home/`})
    expect(await setup.phone()).toMatchObject({step:'unavailable'})
    expect((await setup.overview()).items[0]).toEqual({id:'phone',title:'Use Wizard on your phone',state:'in_progress'})
  })

  it('is unavailable without the helper socket, never crashes, and tracks first run', async () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'settings.json')
    const { port } = await startLocal({ settingsPath, privateAccessSocket: join(dir, 'missing.sock') })
    const overview = await call(port, '/wizard/v1/setup')
    expect(overview.status).toBe(200)
    expect(overview.body).toEqual({ first_run: true, items: [{ id: 'phone', title: 'Use Wizard on your phone', state: 'todo' }] })
    const phone = await call(port, '/wizard/v1/setup/phone')
    expect(phone.body).toEqual({ step: 'unavailable', auth_url: null, https_enable_url: null, wizard_url: null, device_name: null,
      phones: [], install_url: 'https://tailscale.com/download', error: null })
    expect((await call(port, '/wizard/v1/setup/phone/start', jsonPost())).body.step).toBe('unavailable')
    expect((await call(port, '/wizard/v1/setup/seen', jsonPost())).body).toEqual({ ok: true })
    expect((await call(port, '/wizard/v1/setup')).body.first_run).toBe(false)
    expect(readSettings(settingsPath).settings.setup.seen_at).toMatch(/^\d{4}-\d\d-\d\dT/)
  })

  it('reports a box without Tailscale', async () => {
    const dir = tempDir()
    const helper = await fakeHelper(dir, { installed: false, daemon: 'missing', backend_state: 'NoState' })
    const { port } = await startLocal({ settingsPath: join(dir, 'settings.json'), privateAccessSocket: helper.socketPath })
    expect((await call(port, '/wizard/v1/setup/phone')).body).toMatchObject({ step: 'unavailable', error: 'tailscale_not_installed' })
  })

  it('walks off -> signin -> https -> serving -> phone_seen and records settings', async () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ owner: { name: 'Alex' }, network: { base_url: 'https://old.example.com', aliases: ['older.example.com'] } }))
    const helper = await fakeHelper(dir)
    const { port } = await startLocal({ settingsPath, privateAccessSocket: helper.socketPath })

    expect((await call(port, '/wizard/v1/setup/phone')).body.step).toBe('off')
    const started = await call(port, '/wizard/v1/setup/phone/start', jsonPost())
    expect(started.status).toBe(200)
    expect(started.body).toMatchObject({ step: 'signin', auth_url: 'https://login.tailscale.com/a/abc123', wizard_url: null })
    expect(helper.calls).toContain('POST /v1/start {"hostname":"wizard"}')
    expect((await call(port, '/wizard/v1/setup')).body.items[0].state).toBe('in_progress')

    helper.signIn()  // the owner finished signing in on the computer
    const https = await call(port, '/wizard/v1/setup/phone')
    expect(https.body).toMatchObject({ step: 'https', https_enable_url: 'https://login.tailscale.com/f/serve?node=n1', device_name: DNS, wizard_url: null })
    expect(readSettings(settingsPath).settings.access.tailscale.origin).toBe('')  // nothing authorized before Serve is on

    helper.state.https_enabled = true  // the owner enabled HTTPS on the tailnet
    const again = await call(port, '/wizard/v1/setup/phone/start', jsonPost())
    expect(again.body).toMatchObject({ step: 'serving', wizard_url: `${ORIGIN}/`, device_name: DNS, auth_url: null })
    const saved = readSettings(settingsPath).settings
    expect(saved.network.base_url).toBe(ORIGIN)
    expect(saved.network.aliases).toEqual(['old.example.com', 'older.example.com'])
    expect(saved.access.tailscale).toEqual({ origin: ORIGIN, owner_logins: [OWNER] })
    expect(saved.owner.name).toBe('Alex')

    helper.state.peers = [
      { id: 'a', name: 'laptop', os: 'macOS', online: true, last_seen: null },
      { id: 'b', name: 'pixel', os: 'android', online: false, last_seen: '2026-10-01T10:00:00Z' },
    ]
    const notYet = await call(port, '/wizard/v1/setup/phone')
    expect(notYet.body.step).toBe('serving')
    expect(notYet.body.phones).toEqual([{ name: 'pixel', os: 'android', online: false }])
    helper.state.peers.push({ id: 'c', name: 'iphone', os: 'iOS', online: true, last_seen: null })
    // A phone that is online on the tailnet has not opened Wizard yet: still serving, listed as a hint.
    const online = await call(port, '/wizard/v1/setup/phone')
    expect(online.body.step).toBe('serving')
    expect(online.body.phones).toContainEqual({ name: 'iphone', os: 'iOS', online: true })
    expect(readSettings(settingsPath).settings.setup.phone_seen_at).toBe('')
    // The phone opens Wizard through Serve (recorded by noteOwnerRequest, covered below).
    updateSettings(settingsPath, (raw: any) => { raw.setup = { ...raw.setup, phone_seen_at: new Date().toISOString() } })
    const seen = await call(port, '/wizard/v1/setup/phone')
    expect(seen.body.step).toBe('phone_seen')
    expect(readSettings(settingsPath).settings.setup.phone_seen_at).toMatch(/Z$/)
    expect((await call(port, '/wizard/v1/setup')).body.items[0].state).toBe('done')

    const reset = await call(port, '/wizard/v1/setup/phone/reset', jsonPost())
    expect(reset.body).toMatchObject({ step: 'off', wizard_url: null })
    expect(helper.calls).toContain('POST /v1/reset {}')
    const cleared = readSettings(settingsPath).settings
    expect(cleared.access.tailscale).toEqual({ origin: '', owner_logins: [] })
    expect(cleared.network.base_url).toBe('')
    expect(cleared.network.aliases).toContain(DNS)
    expect(cleared.setup.phone_seen_at).toBe('')
    expect(cleared.setup.seen_at).toBe('')
    expect((await call(port, '/wizard/v1/setup')).body.items[0].state).toBe('todo')
  })

  it('stops saying connected once the last phone leaves the tailnet, until a phone opens Wizard again', async () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'settings.json')
    const helper = await fakeHelper(dir)
    const { port } = await startLocal({ settingsPath, privateAccessSocket: helper.socketPath })
    await call(port, '/wizard/v1/setup/phone/start', jsonPost())
    helper.signIn()
    helper.state.https_enabled = true
    expect((await call(port, '/wizard/v1/setup/phone/start', jsonPost())).body.step).toBe('serving')
    helper.state.peers = [{ id: 'c', name: 'iphone', os: 'iOS', online: true, last_seen: null }]
    updateSettings(settingsPath, (raw: any) => { raw.setup = { ...raw.setup, phone_seen_at: new Date().toISOString() } })
    expect((await call(port, '/wizard/v1/setup/phone')).body.step).toBe('phone_seen')

    // An offline phone is still on the tailnet: still connected.
    helper.state.peers = [{ id: 'c', name: 'iphone', os: 'iOS', online: false, last_seen: '2026-10-01T10:00:00Z' }]
    expect((await call(port, '/wizard/v1/setup/phone')).body.step).toBe('phone_seen')

    // The owner removes the phone in Tailscale's admin (a laptop stays): it can't reach Wizard any more.
    helper.state.peers = [{ id: 'a', name: 'laptop', os: 'macOS', online: true, last_seen: null }]
    const removed = await call(port, '/wizard/v1/setup/phone')
    expect(removed.body).toMatchObject({ step: 'serving', phones: [] })
    expect(readSettings(settingsPath).settings.setup.phone_seen_at).toBe('')
    expect((await call(port, '/wizard/v1/setup')).body.items[0].state).toBe('in_progress')

    // The phone rejoins the tailnet: only a hint, as the first time, until it opens Wizard.
    helper.state.peers.push({ id: 'd', name: 'iphone', os: 'iOS', online: true, last_seen: null })
    expect((await call(port, '/wizard/v1/setup/phone')).body.step).toBe('serving')
  })

  it('keeps a visit recorded through environment-pinned access, whatever the helper lists', async () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'settings.json')
    const helper = await fakeHelper(dir)
    const { port } = await startLocal({ settingsPath, privateAccessSocket: helper.socketPath, tailnetAccessPinned: true })
    helper.signIn()
    helper.state.https_enabled = true
    const seen = new Date().toISOString()
    updateSettings(settingsPath, (raw: any) => { raw.setup = { ...raw.setup, phone_seen_at: seen } })
    helper.state.peers = [{ id: 'a', name: 'laptop', os: 'macOS', online: true, last_seen: null }]
    await call(port, '/wizard/v1/setup/phone')
    expect(readSettings(settingsPath).settings.setup.phone_seen_at).toBe(seen)
  })

  it('keeps connected when the helper peer list is full, since an offline phone may be past its 32-peer cap', async () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'settings.json')
    const helper = await fakeHelper(dir)
    const { port } = await startLocal({ settingsPath, privateAccessSocket: helper.socketPath })
    await call(port, '/wizard/v1/setup/phone/start', jsonPost())
    helper.signIn()
    helper.state.https_enabled = true
    expect((await call(port, '/wizard/v1/setup/phone/start', jsonPost())).body.step).toBe('serving')
    const seen = new Date().toISOString()
    updateSettings(settingsPath, (raw: any) => { raw.setup = { ...raw.setup, phone_seen_at: seen } })
    // 32 online laptops fill the helper's list; the owner's offline iPhone sorts after them and is cut off.
    helper.state.peers = Array.from({ length: 32 }, (_, i) => ({ id: `l${i}`, name: `laptop-${String(i).padStart(2, '0')}`, os: 'macOS', online: true, last_seen: null }))
    await call(port, '/wizard/v1/setup/phone')
    expect(readSettings(settingsPath).settings.setup.phone_seen_at).toBe(seen)
  })

  it('never turns Serve on or records anything from a poll before the owner pressed start', async () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'settings.json')
    const helper = await fakeHelper(dir, { https_enabled: true })
    helper.signIn()  // e.g. a Linux box that was already on Tailscale
    const { port } = await startLocal({ settingsPath, privateAccessSocket: helper.socketPath })
    expect((await call(port, '/wizard/v1/setup/phone')).body).toMatchObject({ step: 'https', wizard_url: null })
    helper.state.serve = { on: true, target: 'http://127.0.0.1:8799' }  // serving for some other reason
    expect((await call(port, '/wizard/v1/setup/phone')).body).toMatchObject({ step: 'https', wizard_url: null })
    expect(helper.calls.filter((c) => !c.startsWith('GET /v1/status'))).toEqual([])
    expect(readSettings(settingsPath).settings.access.tailscale.origin).toBe('')
  })

  it('a reset that Tailscale refuses still revokes access, and later polls do not restore it', async () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'settings.json')
    const helper = await fakeHelper(dir, { https_enabled: true })
    const { port } = await startLocal({ settingsPath, privateAccessSocket: helper.socketPath })
    await call(port, '/wizard/v1/setup/phone/start', jsonPost())
    helper.signIn()
    expect((await call(port, '/wizard/v1/setup/phone/start', jsonPost())).body.step).toBe('serving')
    expect(readSettings(settingsPath).settings.access.tailscale.owner_logins).toEqual([OWNER]);
    (helper.state as any).reset_fails = true
    const reset = await call(port, '/wizard/v1/setup/phone/reset', jsonPost())
    expect(reset.status).toBe(200)
    expect(reset.body).toMatchObject({ error: 'reset_failed', wizard_url: null })
    expect(readSettings(settingsPath).settings.access.tailscale).toEqual({ origin: '', owner_logins: [] })
    for (let i = 0; i < 3; i++) expect((await call(port, '/wizard/v1/setup/phone')).body.wizard_url).toBeNull()
    expect(readSettings(settingsPath).settings.access.tailscale).toEqual({ origin: '', owner_logins: [] })
  })

  it('says so when the environment pins tailnet access and reset cannot revoke it', async () => {
    const dir = tempDir()
    const helper = await fakeHelper(dir)
    const { port } = await startLocal({ settingsPath: join(dir, 'settings.json'), privateAccessSocket: helper.socketPath, tailnetAccessPinned: true })
    expect((await call(port, '/wizard/v1/setup/phone/reset', jsonPost())).body.error).toBe('access_pinned_by_environment')
  })

  it('reports a helper socket it may not use instead of calling the box a dev box', async () => {
    const setup = createPhoneSetup({ settingsPath: join(tempDir(), 'settings.json'), socketPath: '/x',
      call: async () => { throw Object.assign(new Error('x'), { code: 'helper_forbidden' }) } })
    expect(await setup.phone()).toMatchObject({ step: 'unavailable', error: 'helper_forbidden' })
  })

  it('shows the address for a host-managed box (no helper, network.base_url on the tailnet)', async () => {
    const settingsPath = join(tempDir(), 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ network: { base_url: 'https://wizard.tail0000.ts.net' } }))
    // The real helperCall with no socket on disk: the helper is genuinely absent.
    const setup = createPhoneSetup({ settingsPath, socketPath: join(tempDir(), 'no-such.sock') })
    expect(await setup.phone()).toMatchObject({ step: 'serving', wizard_url: 'https://wizard.tail0000.ts.net/', device_name: 'wizard.tail0000.ts.net', managed: 'host' })
    // A helper whose socket exists but refuses (an outage) is reported, never shown as host-managed with a stale QR.
    const refused = async () => { throw Object.assign(new Error('x'), { code: 'unavailable', absent: false }) }
    const down = await createPhoneSetup({ settingsPath, socketPath: '/x', call: refused }).phone()
    expect(down).toMatchObject({ step: 'unavailable', wizard_url: null, error: 'helper_unreachable' })
    expect(down.managed).toBeUndefined()
    // A public or empty base_url is not a private connection.
    writeFileSync(settingsPath, JSON.stringify({ network: { base_url: 'https://example.com' } }))
    expect(await createPhoneSetup({ settingsPath, socketPath: join(tempDir(), 'no-such.sock') }).phone()).toMatchObject({ step: 'unavailable', wizard_url: null })
  })

  it('treats a stale helper socket that refuses connections as an outage', async () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ network: { base_url: 'https://wizard.tail0000.ts.net' } }))
    const sock = join(dir, 'stale.sock')
    // A socket file left by a helper that has stopped: connect() gets ECONNREFUSED.
    const { execFileSync } = await import('node:child_process')
    execFileSync('python3', ['-c', 'import socket,sys;s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1])', sock])
    expect(existsSync(sock)).toBe(true)
    const out = await createPhoneSetup({ settingsPath, socketPath: sock }).phone()
    expect(out).toMatchObject({ step: 'unavailable', wizard_url: null, error: 'helper_unreachable' })
    expect(out.managed).toBeUndefined()
  })

  it('does not report serving until the owner is recorded', async () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'settings.json')
    const helper = await fakeHelper(dir, { https_enabled: true })
    const { port } = await startLocal({ settingsPath, privateAccessSocket: helper.socketPath })
    await call(port, '/wizard/v1/setup/phone/start', jsonPost())
    helper.signIn()
    helper.state.owner_login = null  // e.g. a tagged node: Serve sends no user identity
    const result = await call(port, '/wizard/v1/setup/phone/start', jsonPost())
    expect(result.body).toMatchObject({ step: 'https', wizard_url: null, error: 'owner_not_recorded' })
    expect(readSettings(settingsPath).settings.access.tailscale.origin).toBe('')
  })

  it('applies the same-origin write rules of neighbouring routes', async () => {
    const dir = tempDir()
    const helper = await fakeHelper(dir)
    const { port } = await startLocal({ settingsPath: join(dir, 'settings.json'), privateAccessSocket: helper.socketPath })
    const host = `127.0.0.1:${port}`
    for (const path of ['/wizard/v1/setup/seen', '/wizard/v1/setup/phone/start', '/wizard/v1/setup/phone/reset']) {
      expect((await call(port, path, { method: 'POST', body: '{}' })).status).toBe(415)
      expect((await call(port, path, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415)
      expect((await call(port, path, jsonPost({ origin: 'https://evil.example' }))).status).toBe(403)
      expect((await call(port, path, jsonPost({ origin: 'null' }))).status).toBe(403)
      expect((await call(port, path, jsonPost({ 'sec-fetch-site': 'cross-site' }))).status).toBe(403)
      expect((await call(port, path, jsonPost({ 'sec-fetch-site': 'same-site' }))).status).toBe(403)
      expect((await call(port, path)).status).toBe(404)
      expect((await call(port, `${path}?x=1`, jsonPost())).status).toBe(400)
    }
    expect((await call(port, '/wizard/v1/setup/phone/start', jsonPost({ origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }))).status).toBe(200)
    expect(helper.calls.filter((c) => c.startsWith('POST /v1/start'))).toHaveLength(1)
    expect(helper.calls.some((c) => c.startsWith('POST /v1/reset'))).toBe(false)
    expect((await call(port, '/wizard/v1/setup/phone/nope')).status).toBe(404)
    for (const site of ['cross-site', 'same-site']) {
      expect((await call(port, '/wizard/v1/setup/phone', { headers: { 'sec-fetch-site': site } })).status).toBe(403)
      expect((await call(port, '/wizard/v1/setup', { headers: { 'sec-fetch-site': site } })).status).toBe(403)
    }
    expect((await call(port, '/wizard/v1/setup/phone', { headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200)
  })

  it('refuses a DNS-rebound Host on the box-local listener', async () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ network: { base_url: 'https://box.example.com', aliases: ['alias.example.com'] } }))
    const helper = await fakeHelper(dir)
    const { port } = await startLocal({ settingsPath, privateAccessSocket: helper.socketPath })
    for (const host of ['attacker.example', `attacker.example:${port}`, '127.0.0.1.attacker.example', 'wizard.local.attacker.example', 'evil.local']) {
      expect((await call(port, '/wizard/v1/setup/phone', { headers: { host } })).status).toBe(403)
      expect((await call(port, '/wizard/v1/setup/phone/start', jsonPost({ host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }))).status).toBe(403)
    }
    expect((await call(port, '/wizard/v1/setup', { headers: { host: '127.0.0.1', 'x-forwarded-host': 'attacker.example' } })).status).toBe(403)
    expect(helper.calls.filter((c) => c.startsWith('POST /v1/start'))).toHaveLength(0)
    for (const host of [`127.0.0.1:${port}`, 'localhost:48023', '[::1]:8796', 'box.example.com', 'alias.example.com:443', '192.168.1.20:8796', 'wizard.localhost:48023', 'wizardbox']) {
      expect((await call(port, '/wizard/v1/setup', { headers: { host } })).status).toBe(200)
    }
  })

  it('allows the shell host apps.json records on a fresh box with no settings.json (first-run Setup)', async () => {
    const dir = tempDir()
    const appsJsonPath = join(dir, 'apps.json')
    writeFileSync(appsJsonPath, JSON.stringify({ apps: [
      { id: 'wizard-ux', provides: ['shell'], view: { url: `https://${DNS}:8796/wizard-os-home/`, local: 'http://127.0.0.1:8796/wizard-os-home/' } },
      { id: 'hermes-agent', provides: ['agent'], view: { url: 'https://other.tail1234.ts.net:9119/' } },
      { id: 'evil', provides: ['shell'], view: { url: 'http://plain.example/' } },
    ] }))
    const helper = await fakeHelper(dir)
    const { port } = await startLocal({ settingsPath: join(dir, 'settings.json'), appsJsonPath, privateAccessSocket: helper.socketPath })
    // Tailscale Serve keeps the browser's Host (the shell's own address, with its port).
    const ok = await call(port, '/wizard/v1/setup', { headers: { host: `${DNS}:8796` } })
    expect(ok.status).toBe(200)
    expect(ok.body.first_run).toBe(true)
    expect((await call(port, '/wizard/v1/setup/seen', jsonPost({ host: `${DNS}:8796`, origin: `https://${DNS}:8796`, 'sec-fetch-site': 'same-origin' }))).status).toBe(200)
    // Only the app that provides `shell`, only https: other apps' hosts and plain-http views stay refused.
    for (const host of ['other.tail1234.ts.net:9119', 'plain.example', 'attacker.example']) {
      expect((await call(port, '/wizard/v1/setup', { headers: { host } })).status).toBe(403)
    }
    expect((await call(port, '/wizard/v1/setup', { headers: { host: '127.0.0.1', 'x-forwarded-host': 'attacker.example' } })).status).toBe(403)
  })

  it('refuses the Serve host on a fresh box when apps.json does not name it', async () => {
    const dir = tempDir()
    const helper = await fakeHelper(dir)
    const { port } = await startLocal({ settingsPath: join(dir, 'settings.json'), appsJsonPath: join(dir, 'missing.json'), privateAccessSocket: helper.socketPath })
    expect((await call(port, '/wizard/v1/setup', { headers: { host: `${DNS}:8796` } })).status).toBe(403)
  })

  it('alongside box with host Tailscale and no helper: phone setup shows the shell link from apps.json', async () => {
    const dir = tempDir()
    const appsJsonPath = join(dir, 'apps.json')
    const shell = `https://${DNS}:8796/wizard-os-home/`
    writeFileSync(appsJsonPath, JSON.stringify({ apps: [{ id: 'wizard-ux', provides: ['shell'], view: { url: shell } }] }))
    const { port } = await startLocal({ settingsPath: join(dir, 'settings.json'), appsJsonPath, privateAccessSocket: join(dir, 'missing.sock') })
    const phone = await call(port, '/wizard/v1/setup/phone')
    expect(phone.body.step).toBe('serving')
    expect(phone.body.wizard_url).toBe(shell)
    expect(phone.body.device_name).toBe(DNS)
    expect(phone.body.managed).toBe('host')
    const overview = (await call(port, '/wizard/v1/setup')).body
    expect(overview.items[0]).toMatchObject({ state: 'done', phone_ready: true })
    expect(readSettings(join(dir, 'settings.json')).settings.setup.phone_seen_at).toBe('')
    updateSettings(join(dir, 'settings.json'), (raw: any) => { raw.setup = { phone_seen_at: new Date().toISOString() } })
    expect((await call(port, '/wizard/v1/setup/phone')).body.step).toBe('phone_seen')
    // phone_ready is only a hint for ready-before-first-visit copy, not an availability capability.
    expect((await call(port, '/wizard/v1/setup')).body.items[0]).toEqual({ id: 'phone', title: 'Use Wizard on your phone', state: 'done' })
  })

  it('never offers a non-tailnet or plain-http shell link as the phone address', async () => {
    const dir = tempDir()
    for (const url of ['http://127.0.0.1:8796/wizard-os-home/', 'https://example.com/wizard-os-home/', 'https://u:p@box.tail1234.ts.net/']) {
      const appsJsonPath = join(dir, 'apps.json')
      writeFileSync(appsJsonPath, JSON.stringify({ apps: [{ id: 'wizard-ux', provides: ['shell'], view: { url } }] }))
      const { port } = await startLocal({ settingsPath: join(dir, 'settings.json'), appsJsonPath, privateAccessSocket: join(dir, 'missing.sock') })
      expect((await call(port, '/wizard/v1/setup/phone')).body.step).toBe('unavailable')
      expect((await call(port, '/wizard/v1/setup')).body.items[0].state).toBe('todo')
    }
  })

  it('is owner-only when the listener requires access', async () => {
    const dir = tempDir()
    const helper = await fakeHelper(dir)
    const accessVerifier = createTailnetAccessVerifier({ origin: ORIGIN, logins: OWNER })
    const { port } = await startLocal({ requireAccess: true, accessVerifier, settingsPath: join(dir, 'settings.json'), privateAccessSocket: helper.socketPath })
    expect((await call(port, '/wizard/v1/setup', { headers: { host: DNS, 'tailscale-user-login': 'someone@example.com' } })).status).toBe(403)
    expect((await call(port, '/wizard/v1/setup/phone/start', jsonPost({ host: DNS, 'tailscale-user-login': 'someone@example.com', origin: ORIGIN }))).status).toBe(403)
    expect((await call(port, '/wizard/v1/setup', { headers: { host: DNS, 'tailscale-user-login': OWNER } })).status).toBe(200)
    expect((await call(port, '/wizard/v1/setup/phone/start', jsonPost({ host: DNS, 'tailscale-user-login': OWNER, origin: ORIGIN }))).status).toBe(200)
    expect(helper.calls.filter((c) => c.startsWith('POST /v1/start'))).toHaveLength(1)
  })

  it('serializes concurrent starts into helper calls one at a time', async () => {
    const dir = tempDir()
    const settingsPath = join(dir, 'settings.json')
    let active = 0, peak = 0
    const call = async (_s: string, method: string, path: string) => {
      active++; peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 20))
      active--
      return { status: 200, body: { installed: true, daemon: 'running', backend_state: 'NeedsLogin', auth_url: 'https://login.tailscale.com/a/x', serve: { on: false }, peers: [], method, path } }
    }
    const setup = createPhoneSetup({ settingsPath, socketPath: '/unused', call })
    await Promise.all([setup.start(), setup.start(), setup.phone(), setup.reset()])
    expect(peak).toBe(1)
  })
})

describe('tailnet listener with settings-driven Tailscale access', () => {
  async function stack({ proxyPeers = ['127.0.0.1', '::1'], env = {}, shellOrigin = '', ownerProof = '' }: { proxyPeers?: string[], env?: { origin?: string, logins?: string }, shellOrigin?: string, ownerProof?: string } = {}) {
    const dir = tempDir()
    const settingsPath = join(dir, 'settings.json')
    const appsJsonPath = join(dir, 'apps.json')
    writeFileSync(appsJsonPath, '{"apps":[]}')
    let server: ReturnType<typeof createWizardServer> | undefined
    const tailnetVerifier = createSettingsTailnetVerifier({
      ...env, proxyPeers,
      settings: () => readSettings(settingsPath).settings.access.tailscale,
      onVerified: (request: IncomingMessage) => (server as any)?.phoneSetup?.noteOwnerRequest(request),
    })
    server = createWizardServer({
      requireAccess: false, ownerProof, tailnetVerifier, tailnetAccessPinned: Boolean(tailnetVerifier.pinned), settingsPath, appsJsonPath, privateAccessSocket: join(dir, 'missing.sock'),
      mcpToken: 'fixture-mcp', wizardOsHome: dir, bridgeWriteSkills: false, bridgeWatchMs: 0,
      followThrough: false, archivedSessionReader: () => [], ...(shellOrigin ? { tailnetShellOrigin: shellOrigin } : {}),
    })
    servers.push(server)
    const local = (await listen(server)).port
    const ingress = createTailnetIngress(server)
    servers.push(ingress)
    const tailnet = (await listen(ingress)).port
    const enroll = (logins = [OWNER]) => updateSettings(settingsPath, (raw: any) => { raw.access = { tailscale: { origin: ORIGIN, owner_logins: logins } } })
    return { settingsPath, local, tailnet, enroll }
  }
  const owner = { host: DNS, 'tailscale-user-login': OWNER }

  it('refuses everything through Serve until enrollment, then admits the owner without a restart', async () => {
    const s = await stack()
    expect((await call(s.tailnet, '/wizard/v1/apps', { headers: owner })).status).toBe(403)
    expect((await call(s.tailnet, '/wizard/v1/setup', { headers: owner })).status).toBe(403)
    // The box-local path is unchanged: no identity needed, a spoofed header changes nothing.
    expect((await call(s.local, '/wizard/v1/apps')).status).toBe(200)
    expect((await call(s.local, '/wizard/v1/apps', { headers: { 'tailscale-user-login': 'someone@example.com' } })).status).toBe(200)
    s.enroll()
    expect((await call(s.tailnet, '/wizard/v1/apps', { headers: owner })).status).toBe(200)
    expect((await call(s.tailnet, '/wizard/v1/setup', { headers: { ...owner, 'tailscale-user-login': 'Owner@Example.com' } })).status).toBe(200)
    expect((await call(s.local, '/wizard/v1/apps')).status).toBe(200)
  })

  it.each([
    ['another tailnet user', { ...owner, 'tailscale-user-login': 'someone@example.com' }],
    ['no identity', { host: DNS }],
    ['a wrong Host', { ...owner, host: 'evil.tail1234.ts.net' }],
    ['the loopback Host', { ...owner, host: '127.0.0.1' }],
    ['a cross-origin read', { ...owner, origin: 'https://evil.example' }],
    ['a cross-site fetch', { ...owner, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }],
  ])('refuses %s after enrollment', async (_name, headers) => {
    const s = await stack()
    s.enroll()
    expect((await call(s.tailnet, '/wizard/v1/apps', { headers })).status).toBe(403)
    expect((await call(s.tailnet, '/wizard/v1/setup', { headers })).status).toBe(403)
  })

  it('refuses writes that are cross-origin or carry no Origin', async () => {
    const s = await stack()
    s.enroll()
    for (const path of ['/wizard/v1/setup/seen', '/wizard/v1/setup/phone/reset', '/wizard/v1/setup/phone/start']) {
      expect((await call(s.tailnet, path, jsonPost(owner))).status).toBe(403)
      expect((await call(s.tailnet, path, jsonPost({ ...owner, origin: 'https://evil.example' }))).status).toBe(403)
      expect((await call(s.tailnet, path, jsonPost({ ...owner, origin: 'http://127.0.0.1' }))).status).toBe(403)
    }
    expect(readSettings(s.settingsPath).settings.access.tailscale.origin).toBe(ORIGIN)  // the reset never ran
    expect((await call(s.tailnet, '/wizard/v1/setup/seen', jsonPost({ ...owner, origin: ORIGIN, 'sec-fetch-site': 'same-origin' }))).status).toBe(200)
  })

  it('refuses a spoofed identity from a peer that is not the Serve proxy', async () => {
    // Positive control: the same request from the trusted peer (loopback here) is accepted.
    const trusted = await stack()
    trusted.enroll()
    expect((await call(trusted.tailnet, '/wizard/v1/apps', { headers: owner })).status).toBe(200)
    // Only the trusted peer differs: loopback is not the Serve proxy any more.
    const s = await stack({ proxyPeers: ['192.0.2.44'] })
    s.enroll()
    expect((await call(s.tailnet, '/wizard/v1/apps', { headers: owner })).status).toBe(403)
    const forged = { ...owner, origin: ORIGIN, 'x-forwarded-for': '192.0.2.44', forwarded: 'for=192.0.2.44', 'x-real-ip': '192.0.2.44' }
    expect((await call(s.tailnet, '/wizard/v1/apps', { headers: forged })).status).toBe(403)
    expect((await call(s.tailnet, '/wizard/v1/setup/phone/reset', jsonPost(forged))).status).toBe(403)
    const verify = createSettingsTailnetVerifier({ settings: () => ({ origin: ORIGIN, owner_logins: [OWNER] }) })
    await expect(verify({ method: 'GET', url: '/wizard/v1/apps', socket: { remoteAddress: '172.25.0.9' }, headers: owner })).rejects.toThrow()
    expect(await verify({ method: 'GET', url: '/wizard/v1/apps', socket: { remoteAddress: '127.0.0.1' }, headers: owner })).toMatchObject({ email: OWNER })
  })

  it('never exposes the box-only tool gateway or agent context through Serve', async () => {
    const s = await stack()
    s.enroll()
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'f', version: '1' } } })
    const headers = { ...owner, origin: ORIGIN, authorization: 'Bearer fixture-mcp', 'content-type': 'application/json' }
    expect((await call(s.tailnet, '/wizard/mcp', { method: 'POST', headers, body })).status).toBe(403)
    expect((await call(s.tailnet, '/wizard/v1/agent-context', { headers: owner })).status).toBe(403)
    expect((await call(s.local, '/wizard/mcp', { method: 'POST', headers: { authorization: 'Bearer fixture-mcp', 'content-type': 'application/json' }, body })).status).toBe(200)
  })

  it('environment origin and login override settings', async () => {
    const s = await stack({ env: { origin: 'https://other.tail9999.ts.net', logins: 'second@example.com' } })
    s.enroll()
    expect((await call(s.tailnet, '/wizard/v1/apps', { headers: owner })).status).toBe(403)
    expect((await call(s.tailnet, '/wizard/v1/apps', { headers: { host: 'other.tail9999.ts.net', 'tailscale-user-login': 'second@example.com' } })).status).toBe(200)
    expect(() => createSettingsTailnetVerifier({ origin: ORIGIN })).toThrow()
    expect(() => createSettingsTailnetVerifier({ logins: OWNER })).toThrow()
    expect(() => createSettingsTailnetVerifier({ origin: 'http://x.ts.net', logins: OWNER })).toThrow()
    expect(() => createSettingsTailnetVerifier({ proxyPeers: [] })).toThrow()
    expect(createSettingsTailnetVerifier({ origin: ORIGIN, logins: OWNER }).pinned).toBe(true)
    expect(createSettingsTailnetVerifier({ origin: ' ', logins: ' ' }).pinned).toBe(false)
    expect(createSettingsTailnetVerifier({}).pinned).toBe(false)
  })

  it('ignores invalid settings (fails closed)', async () => {
    const s = await stack()
    writeFileSync(s.settingsPath, JSON.stringify({ access: { tailscale: { origin: 'https://evil.example', owner_logins: [OWNER] } } }))
    expect((await call(s.tailnet, '/wizard/v1/apps', { headers: { ...owner, host: 'evil.example' } })).status).toBe(403)
    writeFileSync(s.settingsPath, JSON.stringify({ access: { tailscale: { origin: ORIGIN, owner_logins: [] } } }))
    expect((await call(s.tailnet, '/wizard/v1/apps', { headers: owner })).status).toBe(403)
  })

  it('the phone shares the computer\'s account scope when the box-local listener implies the owner', async () => {
    const s = await stack()
    s.enroll()
    const put = await call(s.tailnet, '/wizard/thread-dispositions', { method: 'PUT', headers: { ...owner, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: 'direct', sessionId: 'wizard_t1', deferred: true }) })
    expect(put.status).toBe(200)
    const local = await call(s.local, '/wizard/thread-dispositions')
    expect(JSON.stringify(local.body)).toContain('wizard_t1')
  })

  it('keeps owner-proof local ingress separate from the enrolled Serve owner', async () => {
    const s = await stack({ ownerProof: 'synthetic-owner-proof-for-phone-regression' })
    s.enroll()
    expect((await call(s.local, '/wizard/v1/setup')).status).toBe(403)
    expect((await call(s.local, '/wizard/v1/setup', { headers: owner })).status).toBe(403)
    expect((await call(s.local, '/wizard/v1/setup', { headers: { 'x-wizard-owner-proof': 'synthetic-owner-proof-for-phone-regression' } })).status).toBe(200)
    expect((await call(s.tailnet, '/wizard/v1/setup', { headers: owner })).status).toBe(200)
    expect((await call(s.tailnet, '/wizard/v1/agents', { headers: owner })).status).toBe(200)
  })

  it.each([false,true])('records phone_seen on verified settings or pinned access (pinned=%s)', async (pinned) => {
    const s = await stack(pinned ? {env:{origin:ORIGIN,logins:OWNER}} : {})
    if (!pinned) s.enroll()
    await call(s.tailnet, '/wizard/v1/apps', { headers: { ...owner, 'user-agent': DESKTOP_UA } })
    await call(s.local, '/wizard/v1/apps', { headers: { 'user-agent': IPHONE_UA } })  // box-local phones do not count
    await call(s.tailnet, '/wizard/v1/apps', { headers: { ...owner, 'tailscale-user-login': 'someone@example.com', 'user-agent': IPHONE_UA } })
    await new Promise((r) => setTimeout(r, 50))
    expect(readSettings(s.settingsPath).settings.setup.phone_seen_at).toBe('')
    await call(s.tailnet, '/wizard/v1/apps', { headers: { ...owner, 'user-agent': IPHONE_UA } })
    await expect.poll(() => readSettings(s.settingsPath).settings.setup.phone_seen_at).toMatch(/Z$/)
    expect(readSettings(s.settingsPath).settings.access.tailscale.origin).toBe(pinned ? '' : ORIGIN)
    expect((await call(s.tailnet, '/wizard/v1/setup', {headers:owner})).body.items[0]).toEqual({id:'phone',title:'Use Wizard on your phone',state:'done'})
  })

  it('serves the shell to a verified phone without forwarding identity or credentials', async () => {
    const seen: Array<{ url: string, headers: Record<string, unknown> }> = []
    const shell = createServer((req, res) => {
      seen.push({ url: req.url ?? '', headers: req.headers })
      if (req.url === '/') { res.writeHead(302, { Location: '/wizard-os-home/' }); res.end(); return }
      if (req.url === '/wizard-os-home/dir') { res.writeHead(301, { Location: '//evil.example/' }); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'x=1', 'X-Secret': 'no' }); res.end('<html>shell</html>')
    })
    servers.push(shell)
    const shellPort = (await listen(shell)).port
    const s = await stack({ shellOrigin: `http://127.0.0.1:${shellPort}` })
    expect((await call(s.tailnet, '/wizard-os-home/', { headers: owner })).status).toBe(403)
    expect(seen).toHaveLength(0)
    s.enroll()
    const page = await call(s.tailnet, '/wizard-os-home/index.html', { headers: { ...owner, cookie: 'c=1', authorization: 'Bearer x', 'user-agent': DESKTOP_UA } })
    expect(page.status).toBe(200)
    expect(page.raw).toBe('<html>shell</html>')
    expect(seen[0].url).toBe('/wizard-os-home/index.html')
    for (const name of ['tailscale-user-login', 'cookie', 'authorization', 'x-forwarded-for', 'origin']) expect(seen[0].headers[name]).toBeUndefined()
    const root = await call(s.tailnet, '/', { headers: owner })
    expect(root.status).toBe(302)
    const offsite = await call(s.tailnet, '/wizard-os-home/dir', { headers: owner })
    expect(offsite.status).toBe(502)  // a protocol-relative redirect would leave the owner's origin
    seen.pop()
    // API paths under the shell prefix stay the service's own routes; writes never go to the shell.
    expect((await call(s.tailnet, '/wizard-os-home/api/route', jsonPost({ ...owner, origin: ORIGIN }))).status).not.toBe(200)
    expect((await call(s.tailnet, '/wizard-os-home/index.html', jsonPost({ ...owner, origin: ORIGIN }))).status).not.toBe(200)
    expect(seen.map((r) => r.url)).toEqual(['/wizard-os-home/index.html', '/'])
    expect((await call(s.tailnet, '/wizard-os-home/.env', { headers: owner })).status).not.toBe(200)
    expect((await call(s.tailnet, '/wizard-ux//evil.example', { headers: owner })).status).not.toBe(200)
    expect((await call(s.tailnet, '/wizard-os-home//evil.example/x', { headers: owner })).status).not.toBe(200)
    expect(seen.map((r) => r.url)).toEqual(['/wizard-os-home/index.html', '/'])
  })
})

describe('no private configuration ships in this service', () => {
  it('has no hardcoded owner name in model- or user-visible strings', async () => {
    const { titleContextLine } = await import('../server/thread-titles.mjs')
    expect(titleContextLine('X', { locked: true })).not.toMatch(/James/u)
    expect(existsSync(join(__dirname, '..', 'server', 'phone-setup.mjs'))).toBe(true)
    const source = ['service.mjs', 'phone-setup.mjs', 'tailnet-access.mjs', 'wizard-os-settings.mjs', 'thread-titles.mjs']
      .map((f) => readFileSync(join(__dirname, '..', 'server', f), 'utf8')).join('\n')
    // The private names are assembled so this file itself never contains them (repo-wide scans stay clean).
    for (const name of [['wizard', '001.com'], ['tailc0', 'f369']].map((parts) => parts.join(''))) expect(source).not.toContain(name)
  })
})
