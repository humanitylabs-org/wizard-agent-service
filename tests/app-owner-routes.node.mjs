import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, createAgentIngress } from '../server/service.mjs'
import { sharedVaultRegistration } from '../server/shared-vault-bootstrap.mjs'
import { createAppOwnerRoutes } from '../server/app-owner-routes.mjs'

const proof = 'synthetic-proof-only-0123456789abcdefghij'
const token = 'synthetic-broker-only-0123456789abcdefghij'
const site = 'https://owner.fixture.test'
const base = '/wizard/apps/shared-vault/api/'
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)))
const close = s => new Promise(r => s.close(r))
function send(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { host: 'owner.fixture.test', ...headers } }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', c => data += c)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }))
    })
    req.on('error', reject); req.end(body)
  })
}

test('real Service registered installed route, strict owner access, raw paths, headers, uninstall and restart', { skip: process.getuid?.() === 0 ? 'Owner-route activation intentionally refuses a root Service' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-vault-platform-'))
  const privateDir = join(dir, 'private'); mkdirSync(privateDir, { mode: 0o700 })
  const appsPath = join(dir, 'apps.json')
  const install = () => writeFileSync(appsPath, JSON.stringify({ apps: [{ id: 'shared-vault', view: { url: '/shared-vault/' }, status: 'running' }] }))
  install()
  const viewRoot = join(dir, 'views', 'shared-vault')
  mkdirSync(join(viewRoot, 'builds', 'a'.repeat(40)), { recursive: true })
  writeFileSync(join(viewRoot, 'builds', 'a'.repeat(40), '.ok'), '')
  writeFileSync(join(viewRoot, 'view.json'), JSON.stringify({ active: true, mode: 'own', serving: 'a'.repeat(40) }))
  const received = []; let redirect = false
  const broker = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403); return res.end('{}') }
    let data = ''; for await (const c of req) data += c
    received.push({ url: req.url, headers: req.headers, data })
    if (redirect) { res.writeHead(307, { location: '/capture', 'set-cookie': 'authority=bad' }); return res.end('secret-redirect') }
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'authority=bad', 'x-broker-secret': 'bad' }); res.end('{"state":"ready_to_connect"}')
  })
  const brokerPort = await listen(broker)
  writeFileSync(join(privateDir, 'owner-token'), token, { mode: 0o600 })
  writeFileSync(join(privateDir, 'owner.json'), JSON.stringify({ publicOrigin: site, brokerOrigin: `http://127.0.0.1:${brokerPort}`, ownerTokenFile: join(privateDir, 'owner-token') }), { mode: 0o600 })
  let service, ingress
  const start = async (extra = {}) => {
    service = createWizardServer({ upstreamOrigin: 'http://127.0.0.1:1', hermesKey: 'synthetic-upstream-key',
      requireAccess: false, ownerProof: proof, agentBridge: false, agents: false, followThrough: false, joinedDelegation: 'off',
      wizardOsHome: dir, settingsPath: join(dir, 'settings.json'), appsJsonPath: appsPath,
      launcherPath: join(dir, 'launcher.json'), threadSeenStatePath: join(dir, 'seen.json'),
      threadDispositionStatePath: join(dir, 'dispositions.json'),
      appOwnerRoutes: await sharedVaultRegistration(join(privateDir, 'owner.json')), ...extra })
    return await listen(service)
  }
  const owner = { 'x-wizard-owner-proof': proof }
  try {
    let port = await start()
    const alias = await send(port, '/wizard/views/shared-vault/api/status', { headers: owner })
    assert.equal(alias.status, 307); assert.equal(alias.headers.location, base + 'status'); assert.equal(received.length, 0)
    assert.equal((await send(port, '/wizard/views/shared-vault/api/%73tatus', { headers: owner })).status, 403)
    for (const headers of [{}, { 'x-wizard-principal': 'owner', 'x-forwarded-user': 'owner', authorization: `Bearer ${token}` }, { 'x-wizard-owner-proof': 'wrong' }]) {
      assert.equal((await send(port, base + 'status', { headers })).status, 403)
    }
    assert.equal(received.length, 0)
    for (const path of ['status?owner=true', '%73tatus', 'status/', '../api/status', 'status/../status', 'status#fragment']) {
      assert.equal((await send(port, base + path, { headers: owner })).status, 403)
    }
    for (const headers of [{ host: 'evil.test' }, { origin: 'https://evil.test' }, { 'sec-fetch-site': 'cross-site' }]) {
      assert.equal((await send(port, base + 'status', { headers: { ...owner, ...headers } })).status, 403)
    }
    const write = { method: 'POST', body: '{}', headers: { ...owner, 'content-type': 'application/json', 'content-length': '2' } }
    assert.equal((await send(port, base + 'disconnect', write)).status, 403)
    assert.equal((await send(port, base + 'disconnect', { ...write, headers: { ...write.headers, origin: 'https://evil.test' } })).status, 403)
    assert.equal(received.length, 0)
    const ok = await send(port, base + 'status', { headers: { ...owner, cookie: 'caller=not-forwarded', authorization: 'Bearer caller', 'x-forwarded-host': 'evil.test' } })
    assert.equal(ok.status, 200); assert.equal(ok.headers['set-cookie'], undefined); assert.equal(ok.headers['x-broker-secret'], undefined)
    assert.equal(ok.headers['cache-control'], 'no-store'); assert(!ok.data.includes(token))
    assert.equal(received[0].url, '/api/status'); assert.equal(received[0].headers.authorization, `Bearer ${token}`)
    for (const name of ['cookie', 'x-wizard-owner-proof', 'x-forwarded-user', 'x-forwarded-host']) assert.equal(received[0].headers[name], undefined)
    assert.equal((await send(port, base + 'disconnect', { ...write, headers: { ...write.headers, origin: site } })).status, 200)
    assert.equal((await send(brokerPort, '/api/status')).status, 403)
    redirect = true
    const r = await send(port, base + 'status', { headers: owner })
    assert.equal(r.status, 503); assert.equal(r.headers.location, undefined); assert(!r.data.includes('secret-redirect'))
    redirect = false
    writeFileSync(appsPath, '{"apps":[]}')
    assert.equal((await send(port, base + 'status', { headers: owner })).status, 404)
    install()
    await close(service); port = await start()
    assert.equal((await send(port, base + 'status', { headers: owner })).status, 200)
    await close(service); port = await start({ ownerProof: '' })
    assert.equal((await send(port, base + 'status')).status, 403) // box-only never becomes owner here
    await close(service); port = await start({ requireAccess: true, accessVerifier: async () => false })
    assert.equal((await send(port, base + 'status', { headers: owner })).status, 403)
    ingress = createAgentIngress(service, 'agent-a')
    const agentPort = await listen(ingress)
    assert([401, 403].includes((await send(agentPort, base + 'status', { headers: owner })).status))
  } finally {
    if (ingress) await close(ingress)
    if (service?.listening) await close(service)
    await close(broker); rmSync(dir, { recursive: true, force: true })
  }
})

test('registration validation has no duplicate/prefix catch-all or metadata loader', async () => {
  assert.throws(() => createAppOwnerRoutes([{ appId: '../app', handle() {}, routes: ['GET status'] }]))
  const row = { appId: 'shared-vault', handle() {}, routes: ['GET status'] }
  assert.throws(() => createAppOwnerRoutes([row, row]))
  assert.throws(() => createAppOwnerRoutes([{ ...row, routes: ['GET *'] }]))
  assert.deepEqual(await sharedVaultRegistration(''), [])
})
