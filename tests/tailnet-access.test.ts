import { mkdtempSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer } from '../server/service.mjs'
import { containerGateway, createTailnetAccessVerifier } from '../server/tailnet-access.mjs'

const ORIGIN = 'https://box.tail1234.ts.net:8445'
const HOST = 'box.tail1234.ts.net:8445'
const OWNER = 'owner@example.com'

function req(over: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return {
    method: 'GET', url: '/wizard/v1/bootstrap', socket: { remoteAddress: '127.0.0.1' },
    headers: { host: HOST, 'tailscale-user-login': OWNER, ...headers }, ...over,
  }
}

describe('Tailscale Serve access verifier', () => {
  const verify = createTailnetAccessVerifier({ origin: ORIGIN, logins: OWNER })

  it('accepts the owner through the loopback Serve proxy', async () => {
    expect(await verify(req())).toEqual({ sub: `tailscale:${OWNER}`, email: OWNER, iss: 'tailscale-serve' })
    expect(await verify(req({ socket: { remoteAddress: '::ffff:127.0.0.1' } }))).toBeTruthy()
    expect(await verify(req({}, { 'tailscale-user-login': 'Owner@Example.com' }))).toBeTruthy()
  })

  it.each([
    ['another tailnet user', req({}, { 'tailscale-user-login': 'someone@example.com' })],
    ['no identity', { ...req(), headers: { host: HOST } }],
    ['a peer that is not the proxy', req({ socket: { remoteAddress: '172.25.0.9' } })],
    ['a different host', req({}, { host: 'evil.ts.net' })],
    ['a cross-origin request', req({}, { origin: 'https://evil.example' })],
    ['a write without Origin', req({ method: 'POST' })],
    ['a cross-site API fetch', req({}, { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })],
  ])('refuses %s', async (_name, request) => {
    await expect(verify(request)).rejects.toThrow()
  })

  it('allows same-origin writes and opening the app from a link', async () => {
    expect(await verify(req({ method: 'POST' }, { origin: ORIGIN }))).toBeTruthy()
    expect(await verify(req({ url: '/wizard/' }, { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }))).toBeTruthy()
  })

  it('trusts the container gateway only when configured', async () => {
    const boxed = createTailnetAccessVerifier({ origin: ORIGIN, logins: `${OWNER}, second@example.com`, proxyPeers: ['127.0.0.1', '172.25.0.1'] })
    expect(await boxed(req({ socket: { remoteAddress: '172.25.0.1' } }))).toBeTruthy()
    expect(await boxed(req({}, { 'tailscale-user-login': 'second@example.com' }))).toBeTruthy()
    await expect(verify(req({ socket: { remoteAddress: '172.25.0.1' } }))).rejects.toThrow()
  })

  it.each([
    [{ origin: 'http://box.tail1234.ts.net', logins: OWNER }],
    [{ origin: 'https://example.com', logins: OWNER }],
    [{ origin: `${ORIGIN}/path`, logins: OWNER }],
    [{ origin: ORIGIN, logins: '' }],
    [{ origin: ORIGIN, logins: OWNER, proxyPeers: [] }],
  ])('refuses bad configuration %#', (options) => {
    expect(() => createTailnetAccessVerifier(options)).toThrow()
  })

  it('reads the container gateway from the route table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-'))
    const table = join(dir, 'route')
    writeFileSync(table, 'Iface\tDestination\tGateway\n eth0\t00000000\t010019AC\t0003\neth0\t000019AC\t00000000\t0001\n')
    expect(containerGateway(table)).toBe('172.25.0.1')
    expect(containerGateway(join(dir, 'missing'))).toBe('')
  })
})

describe('service with Tailscale access', () => {
  const servers: ReturnType<typeof createWizardServer>[] = []
  afterEach(async () => { await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))); servers.length = 0 })

  it('lets the owner in and refuses everyone else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tailnet-svc-'))
    writeFileSync(join(dir, 'index.html'), '<html>wizard-account-local</html>')
    const accessVerifier = createTailnetAccessVerifier({ origin: 'https://box.tail1234.ts.net', logins: OWNER })
    const server = createWizardServer({ requireAccess: true, accessVerifier, distDir: dir, archivedSessionReader: () => [] })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    // node:http, not fetch: fetch never lets the caller set Host.
    const get = (headers: Record<string, string>) => new Promise<{ status: number, body: string }>((resolve, reject) => {
      const r = httpRequest({ host: '127.0.0.1', port: address.port, path: '/wizard/', headers }, (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      r.on('error', reject)
      r.end()
    })
    const host = 'box.tail1234.ts.net'
    const ok = await get({ host, 'tailscale-user-login': OWNER })
    expect(ok.status).toBe(200)
    expect(ok.body).toContain('wizard-account-')
    expect(ok.body).not.toContain('wizard-account-local')
    expect((await get({ host, 'tailscale-user-login': 'someone@example.com' })).status).toBe(403)
    expect((await get({ host })).status).toBe(403)
    expect((await get({ host: 'other.ts.net', 'tailscale-user-login': OWNER })).status).toBe(403)
  })
})
