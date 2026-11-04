import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'

test('fallback shell CSP narrowly allows the independent public connection check', async t => {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'troubleshooter-csp-'))
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Synthetic shell</title>')
  const service = createWizardServer({ requireAccess: false, uxDir: root, uxPrefix: 'wizard-os-home', wizardOsHome: root, hermesHome: root, agentBridge: false, followThrough: false, joinedDelegation: 'off' })
  const address = await listen(service)
  t.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); rmSync(root, { recursive: true, force: true }) })
  for (const path of ['/wizard-os-home/', '/wizard-os-home/index.html']) {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`)
    assert.equal(response.status, 200)
    const csp = response.headers.get('content-security-policy')
    assert.deepEqual(csp.match(/connect-src ([^;]+)/)[1].split(' '), ["'self'", 'blob:', 'data:', 'https://derp1.tailscale.com/generate_204'])
    assert.match(csp, /object-src 'none'/)
    assert.match(csp, /frame-ancestors 'none'/)
  }
})
