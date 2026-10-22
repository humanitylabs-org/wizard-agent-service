import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserBoundary, browserBoundaryFromEnv } from '../server/browser-boundary.mjs'
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
    expect(gate.allows(req({ 'x-wizard-shell-token': TOKEN, origin: 'null' }), owner)).toBe(false)
    expect(gate.allows(req({ 'x-wizard-shell-token': TOKEN, 'sec-fetch-site': 'cross-site' }), owner)).toBe(false)
    for (const kind of ['agent', 'service']) expect(gate.allows(req(), { kind })).toBe(true)
  })

  async function service(enabled: boolean, requireAccess = false) {
    const dir = mkdtempSync(join(tmpdir(), 'boundary-http-'))
    resources.push(() => rmSync(dir, { recursive: true, force: true }))
    const accessVerifier = Object.assign(async () => ({ sub: 'synthetic-owner' }), { fromRequest: true })
    const server = createWizardServer({
      requireAccess, accessVerifier, tailnetVerifier: accessVerifier,
      upstreamOrigin: 'http://127.0.0.1:1', hermesKey: 'fixture-key', ownerProof: PROOF,
      browserBoundary: { enabled, token: TOKEN },
      wizardOsHome: dir, settingsPath: join(dir, 'settings.json'), appsJsonPath: join(dir, 'apps.json'),
      launcherPath: join(dir, 'launcher.json'), agentBridge: false, followThrough: false, joinedDelegation: 'off',
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
    expect((await fetch(base + '/wizard/v1/settings', { headers: { ...headers, Origin: 'null' } })).status).toBe(401)
    expect((await fetch(base + '/wizard-os-home/api/voice')).status).toBe(401)
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
