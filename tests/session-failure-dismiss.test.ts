// 17 Oct 2026: Dismiss on a failed thread returned an error. Wizard UX posts '{}' and the server
// only accepted an empty body; and queue failures were dismissed under a key the list never checks.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'

const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'wizard-dismiss-'))
const dismissPath = join(root, 'dismissed-failures.json')
let upstream: ReturnType<typeof createServer>
let wizard: ReturnType<typeof createWizardServer>
let base = ''

beforeAll(async () => {
  upstream = createServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end('{}') })
  const address = await listen(upstream)
  wizard = createWizardServer({
    requireJoinedDelegationCapability: false, upstreamOrigin: `http://127.0.0.1:${address.port}`,
    hermesKey: 'fixture', requireAccess: false, dismissedFailureStatePath: dismissPath,
  })
  base = `http://127.0.0.1:${(await listen(wizard)).port}`
})
afterAll(() => { wizard?.close(); upstream?.close(); rmSync(root, { recursive: true, force: true }) })

describe('failed-thread Dismiss', () => {
  it('accepts the body Wizard UX actually sends', async () => {
    for (const body of ['{}', '']) {
      const r = await fetch(`${base}/wizard/session-failure/wizard_1_failed/dismiss`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      expect(r.status).toBe(200)
      expect((await r.json()).dismissed).toBe(true)
    }
    expect(readFileSync(dismissPath, 'utf8')).toContain('wizard_1_failed')
  })
  it('still rejects a real payload', async () => {
    const r = await fetch(`${base}/wizard/session-failure/wizard_1_failed/dismiss`, { method: 'POST', body: '{"x":1}' })
    expect(r.status).toBe(400)
  })
})
