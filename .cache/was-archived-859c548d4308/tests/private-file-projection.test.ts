import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'
import { projectPrivateFilePaths } from '../server/private-file-projection.mjs'

const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))) })
const root = '/srv/wizard-inbox/blobs'
const recovery = `Recovered voice. Original audio: ${root}/0c/abc123 (drop_voice). Continue the request.`
async function fixture(text = recovery) {
  const upstream = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(req.url?.includes('/messages')
      ? { data: [{ id: 1, role: 'user', content: text }, { id: 2, role: 'assistant', content: 'Recovered reply is ready.' }] }
      : { data: [{ id: 'wizard_recovered', source: 'api_server', title: 'Recovered voice', latest_message: { role: 'user', content: text }, last_user_message: { role: 'user', content: text } }] }))
  })
  servers.push(upstream)
  const a = await listen(upstream)
  const wizard = createWizardServer({ upstreamOrigin: `http://127.0.0.1:${a.port}`, hermesKey: 'credential-secret', inboxToken: 'inbox-secret', inboxTrustedRoots: [root], requireAccess: false, archivedSessionReader: () => [] })
  servers.push(wizard)
  const b = await listen(wizard)
  return `http://127.0.0.1:${b.port}/wizard/hermes`
}

describe('private attachment locations in recovery history', () => {
  it('preserves the stored payload and projects only private locations, including nested content', () => {
    const source = Buffer.from(JSON.stringify({ data: [{ content: recovery, parts: [{ text: `See ${root}/0c/abc123` }] }], total: 1 }))
    const original = source.toString()
    const projected = projectPrivateFilePaths(source, [root])
    expect(source.toString()).toBe(original)
    expect(projected.toString()).not.toContain(root)
    expect(JSON.parse(projected.toString())).toEqual({ data: [{ content: 'Recovered voice. Original audio: [private attachment] (drop_voice). Continue the request.', parts: [{ text: 'See [private attachment]' }] }], total: 1 })
  })
  it.each(['/api/sessions?limit=100', '/api/sessions/wizard_recovered/messages?view=wizard'])('serves the actual HTTP read without a 502: %s', async (path) => {
    const base = await fixture()
    const response = await fetch(base + path)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('Continue the request.')
    expect(text).not.toContain(root)
    expect(text).toContain('[private attachment]')
  })
  it.each(['credential-secret', 'inbox-secret'])('still blocks exposed credentials: %s', async (secret) => {
    const base = await fixture(`${recovery} ${secret}`)
    const response = await fetch(base + '/api/sessions/wizard_recovered/messages?view=wizard')
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'unsafe_upstream_response' })
  })
  it('leaves malformed responses for the fail-closed boundary', () => {
    const source = Buffer.from(`not-json ${root}/secret`)
    expect(projectPrivateFilePaths(source, [root])).toBe(source)
  })
})
