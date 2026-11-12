import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { createBrowserBoundary, browserBoundaryFromEnv, passiveMediaPath } from '../server/browser-boundary.mjs'
import { createWizardServer, createTailnetIngress, listen } from '../server/service.mjs'

const TOKEN = 'a1'.repeat(32)
const PROOF = 'owner-proof-synthetic-'.repeat(3)
const resources: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close() })
const req = (headers = {}) => ({ headers })
const owner = { kind: 'owner', via: 'access_verifier' }

describe('browser owner boundary', () => {
  it('off is inert, including an unused/invalid secret path', () => {
    expect(browserBoundaryFromEnv({ WIZARD_BROWSER_BOUNDARY: '0', WIZARD_SHELL_TOKEN_FILE: '/missing' })).toEqual({ enabled: false })
    expect(createBrowserBoundary().allows(req({ origin: 'null' }), owner)).toBe(true)
  })
  it('enabled configuration fails closed and secrets never appear in diagnostics', () => {
    for (const token of ['', 'short', 'A1'.repeat(32), TOKEN + '\n', TOKEN + 'a']) expect(() => createBrowserBoundary({ enabled: true, token })).toThrow('Shell token must')
    expect(() => browserBoundaryFromEnv({ WIZARD_BROWSER_BOUNDARY: '1' })).toThrow('readable WIZARD_SHELL_TOKEN_FILE')
    const dir = mkdtempSync(join(tmpdir(), 'boundary-'))
    resources.push(() => rmSync(dir, { recursive: true, force: true }))
    writeFileSync(join(dir, 'token'), TOKEN + '\n')
    expect(browserBoundaryFromEnv({ WIZARD_BROWSER_BOUNDARY: '1', WIZARD_SHELL_TOKEN_FILE: join(dir, 'token') })).toEqual({ enabled: true, token: TOKEN })
  })
  it('network identity, origin, owner proof and forged/duplicate headers do not substitute for possession', () => {
    const gate = createBrowserBoundary({ enabled: true, token: TOKEN })
    for (const headers of [{}, { 'tailscale-user-login': 'owner@example.test' }, { 'x-wizard-owner-proof': PROOF }, { origin: 'https://box.example.test' }, { 'x-wizard-shell-token': 'b'.repeat(64) }, { 'x-wizard-shell-token': [TOKEN, TOKEN] }]) {
      expect(gate.allows(req(headers), owner)).toBe(false)
    }
    expect(gate.allows(req({ 'x-wizard-shell-token': TOKEN }), owner)).toBe(true)
    for (const headers of [{origin:' null '},{'sec-fetch-site':'same-site'},{'sec-fetch-site':'none'},{'sec-fetch-dest':'iframe'},{'sec-fetch-dest':'embed'}]) expect(gate.allows(req({ 'x-wizard-shell-token': TOKEN, ...headers }), owner)).toBe(false)
    expect(gate.allows(req({ 'x-wizard-shell-token': TOKEN, 'sec-fetch-site': 'cross-site' }), owner)).toBe(false)
    for (const kind of ['agent', 'service']) {
      expect(gate.allows(req(), { kind })).toBe(true)
      expect(gate.allows(req({ 'sec-fetch-mode': 'cors' }), { kind })).toBe(true)
      for (const headers of [{ origin: 'null' }, { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-dest': 'empty' }]) expect(gate.allows(req(headers), { kind })).toBe(false)
    }
  })

  it('passive owner media (img/video/audio, a top-level download) of a known id needs no token; nothing else does', () => {
    const gate = createBrowserBoundary({ enabled: true, token: TOKEN })
    const media = (headers: Record<string, string>, who: any = owner) => gate.allows(req(headers), who, { mediaRequest: true })
    const site = { 'sec-fetch-site': 'same-origin' }
    for (const dest of ['image', 'video', 'audio', 'track']) expect(media({ ...site, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': dest }), dest).toBe(true)
    for (const dest of ['document', 'empty']) expect(media({ ...site, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': dest }), dest).toBe(true)
    for (const headers of [
      {}, // no browser metadata: a script outside a browser or an old client still needs the token
      { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
      { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }, // a sandboxed app frame
      { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
      { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      { ...site, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }, // fetch() from a page
      { ...site, 'sec-fetch-mode': 'same-origin', 'sec-fetch-dest': 'empty' },
      { ...site, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }, // a frame load
      { ...site, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' },
      { ...site, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'embed' },
      { ...site, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image', origin: 'null' },
    ]) expect(media(headers as any), JSON.stringify(headers)).toBe(false)
    const img = { ...site, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }
    expect(gate.allows(req(img), owner)).toBe(false) // only for the media routes
    for (const who of [{ kind: 'anonymous' }, { kind: 'agent' }, { kind: 'service' }]) expect(media(img, who)).toBe(false)
    expect(createBrowserBoundary().allows(req(img), owner, { mediaRequest: true })).toBe(true) // off is inert
    const hex = 'ab'.repeat(16)
    expect(passiveMediaPath('GET', `/wizard/attachments/${hex}`)).toBe(true)
    expect(passiveMediaPath('HEAD', `/wizard/files/wf_${hex}/content`)).toBe(true)
    expect(passiveMediaPath('GET', `/wizard/files/drop_${hex}/content`)).toBe(true) // inbox-backed saved files
    for (const [method, path] of [['POST', `/wizard/attachments/${hex}`], ['GET', '/wizard/files'], ['GET', `/wizard/files/${hex}/content`],
      ['GET', `/wizard/attachments/${hex}/x`], ['GET', '/wizard/v1/settings'], ['GET', `/wizard/files/wf_${hex}`], ['GET', `/wizard/files/drop_${hex}x/content`], ['DELETE', `/wizard/files/wf_${hex}/content`]]) {
      expect(passiveMediaPath(method, path), `${method} ${path}`).toBe(false)
    }
  })

  async function service(enabled: boolean, requireAccess = false, extra = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'boundary-http-'))
    resources.push(() => rmSync(dir, { recursive: true, force: true }))
    const accessVerifier = Object.assign(async () => ({ sub: 'synthetic-owner' }), { fromRequest: true })
    const server = createWizardServer({
      requireAccess, accessVerifier, tailnetVerifier: accessVerifier,
      upstreamOrigin: 'http://127.0.0.1:1', hermesKey: 'fixture-key', ownerProof: PROOF,
      browserBoundary: { enabled, token: TOKEN },
      hermesHome: join(dir, 'synthetic-hermes'), wizardOsHome: dir, settingsPath: join(dir, 'settings.json'), appsJsonPath: join(dir, 'apps.json'),
      launcherPath: join(dir, 'launcher.json'), agentBridge: false, followThrough: false, joinedDelegation: 'off', ...extra,
    })
    const address = await listen(server)
    resources.push(() => new Promise(resolve => server.close(resolve)))
    const ingress = createTailnetIngress(server)
    const remote = await listen(ingress)
    resources.push(() => new Promise(resolve => ingress.close(resolve)))
    return { base: `http://127.0.0.1:${address.port}`, tailnet: `http://127.0.0.1:${remote.port}` }
  }
  it('HTTP: both ingress paths deny owner reads and mutations before dispatch; token does not replace proof', async () => {
    const { base, tailnet } = await service(true)
    const paths = [
      ['GET', '/wizard/v1/settings'], ['GET', '/wizard/v1/apps'], ['GET', '/wizard/hermes/api/sessions'],
      ['GET', '/wizard/files'], ['GET', '/wizard/v1/bootstrap'], ['GET', '/wizard/health'],
      ['POST', '/wizard/hermes/v1/runs'], ['PUT', '/wizard/v1/settings'],
      ['POST', '/wizard-os-home/api/voice'], ['POST', '/wizard/v1/setup/seen'],
      ['POST', '/wizard/v1/agents'], ['DELETE', '/wizard/v1/agents/synthetic'],
    ]
    for (const origin of [base, tailnet]) for (const [method, path] of paths) {
      const r = await fetch(origin + path, { method, headers: { 'X-Wizard-Owner-Proof': PROOF, 'Tailscale-User-Login': 'owner@example.test' } })
      expect(r.status, `${method} ${origin}${path}`).toBe(401)
      expect(await r.json()).toEqual({ error: 'shell_token_required', check: 'browser_boundary' })
    }
    const headers = { 'X-Wizard-Shell-Token': TOKEN, 'X-Wizard-Owner-Proof': PROOF }
    expect((await fetch(base + '/wizard/v1/settings', { headers })).status).toBe(200)
    expect((await fetch(base + '/wizard/v1/setup', { headers: { 'X-Wizard-Shell-Token': TOKEN } })).status).toBe(403)
    // Main's earlier Origin gate also rejects opaque requests, before the boundary.
    expect((await fetch(base + '/wizard/v1/settings', { headers: { ...headers, Origin: 'null' } })).status).toBe(403)
    expect((await fetch(base + '/wizard-os-home/api/voice')).status).toBe(401)
  })
  it('HTTP: an owner <img>/<video> load of an attachment or saved file passes the gate on both listeners; fetch() and frames do not', async () => {
    const { base, tailnet } = await service(true, true)
    // node:http, not fetch: Node's fetch overwrites Sec-Fetch-Mode with 'cors'.
    const get = (url: string, headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const request = httpRequest(url, { headers }, reply => { reply.resume(); reply.on('end', () => resolve(reply.statusCode ?? 0)) })
      request.on('error', reject); request.end()
    })
    const hex = 'cd'.repeat(16)
    const img = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' }
    for (const origin of [base, tailnet]) {
      const owned = origin === base ? { 'X-Wizard-Owner-Proof': PROOF } : { 'Tailscale-User-Login': 'owner@example.test' }
      for (const path of [`/wizard/attachments/${hex}`, `/wizard/files/wf_${hex}/content`, `/wizard/files/drop_${hex}/content`]) {
        const passed = await get(origin + path, { ...owned, ...img })
        expect(passed, `${origin}${path}`).not.toBe(401) // reaches the route (unknown id: not found / unavailable)
        for (const headers of [{ ...img, 'Sec-Fetch-Site': 'cross-site' }, { ...img, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' }, { ...img, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' }]) {
          const refused = await get(origin + path, { ...owned, ...headers })
          expect(refused, `${origin}${path} ${JSON.stringify(headers)}`).toBe(401)
        }
      }
      // A listing or another owner read is never passive media.
      expect(await get(origin + '/wizard/files', { ...owned, ...img })).toBe(401)
    }
    // Without the owner's proof the media exemption does not apply.
    expect(await get(base + `/wizard/attachments/${hex}`, img)).toBe(401)
  })
  it('tailnet static proxy preserves browser metadata and opener isolation, never owner credentials', async () => {
    const seen: any[] = []
    const shell = createServer((req, res) => {
      seen.push(req.headers)
      res.writeHead(req.headers['sec-fetch-dest'] === 'document' ? 200 : 403, {
        'Content-Type': 'text/html', 'Cache-Control': 'private, no-store',
        'Cross-Origin-Opener-Policy': 'noopener-allow-popups', 'Content-Security-Policy': "frame-ancestors 'none'",
      })
      res.end('<!doctype html><title>Synthetic shell only</title>')
    })
    const addr = await listen(shell)
    resources.push(() => new Promise(resolve => shell.close(resolve)))
    const { tailnet } = await service(true, true, { tailnetShellOrigin: `http://127.0.0.1:${addr.port}` })
    const headers = { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'X-Wizard-Owner-Proof': PROOF, 'X-Wizard-Shell-Token': TOKEN, Cookie: 'synthetic=not-forwarded' }
    const doc: any = await new Promise((resolve, reject) => {
      const request = httpRequest(tailnet + '/wizard-os-home/desktop.html', { headers }, reply => { reply.resume(); reply.on('end', () => resolve(reply)) })
      request.on('error', reject); request.end()
    })
    expect(doc.statusCode).toBe(200)
    expect(doc.headers['cross-origin-opener-policy']).toBe('noopener-allow-popups')
    expect(doc.headers['content-security-policy']).toBe("frame-ancestors 'none'")
    expect(seen[0]['sec-fetch-mode']).toBe('navigate')
    expect(seen[0]['sec-fetch-site']).toBe('none')
    for (const name of ['x-wizard-owner-proof', 'x-wizard-shell-token', 'cookie', 'tailscale-user-login']) expect(seen[0][name]).toBeUndefined()
    const script = await fetch(tailnet + '/wizard-os-home/desktop.html', { headers: { ...headers, 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors' } })
    expect(script.status).toBe(403)
  })
  it('flag off preserves the legacy body and HTTP status, not a token-shaped success substitute', async () => {
    const { base } = await service(false)
    const r = await fetch(base + '/wizard/v1/settings', { headers: { 'X-Wizard-Owner-Proof': PROOF } })
    expect(r.status).toBe(200)
    const data = await r.json()
    expect(data).not.toHaveProperty('browser_boundary')
    expect(data).not.toHaveProperty('shell_token')
  })
})
