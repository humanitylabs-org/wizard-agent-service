import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'
import { agentReadablePaths, projectPrivateFilePaths } from '../server/private-file-projection.mjs'

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

describe('routed agent notes and inbox paths', () => {
  const home = '/srv/agents/scribe/home'
  const agent = { id: 'scribe', label: 'Scribe', notes_dir: 'wiki' }
  const project = (text: string, who: Record<string, unknown> = agent) => {
    const roots = [root, home, '/opt/data']
    const out = projectPrivateFilePaths(Buffer.from(JSON.stringify({ data: [{ content: text }] })), roots, { readable: agentReadablePaths(who, home) })
    return JSON.parse(out.toString()).data[0].content as string
  }
  it('shows a declared notes path as the agent notebook, container and host side', () => {
    expect(project('The handoff is at /opt/data/wiki/for-review/2026-01-02-synthetic.md.'))
      .toBe('The handoff is at Scribe notes › for-review/2026-01-02-synthetic.md.')
    expect(project(`Saved (${home}/wiki/index.md) and /opt/data/wiki`)).toBe('Saved (Scribe notes › index.md) and Scribe notes')
  })
  it('names a placed inbox file but never its location', () => {
    expect(project('Read /opt/data/inbox/2026-01-02/report.pdf now')).toBe('Read [private attachment: report.pdf] now')
    expect(project(`Read ${home}/inbox/2026-01-02/report.pdf and /opt/data/inbox/odd/../x`)).toBe('Read [private attachment: report.pdf] and [private attachment]')
    expect(project(`Blob ${root}/0c/abc123`)).toBe('Blob [private attachment]')
  })
  it('keeps every other home path redacted', () => {
    expect(project('See /opt/data/.env, /opt/data/wikipedia/x and /opt/data/wiki/../config.yaml'))
      .toBe('See [private attachment], [private attachment] and [private attachment]')
    expect(project('See /opt/data/wiki/.hidden/key and /opt/data/memories/MEMORY.md')).toBe('See [private attachment] and [private attachment]')
    expect(project('Notes at /opt/data/wiki/a.md', { id: 'scribe', label: 'Scribe' })).toBe('Notes at [private attachment]')
  })
  it('never lets a notes label carry a protected location', () => {
    const out = project('Odd /opt/data/wiki/x/opt/data/y and /opt/data/wiki/a.md', { ...agent, label: '/opt/data' })
    expect(out).not.toContain('/opt/data')
    expect(out).toBe('Odd [private attachment] and [private attachment]')
  })
  it('keeps the inbox an attachment location even if notes were declared over it', () => {
    expect(project('File /opt/data/inbox/2026-01-02/a.txt', { ...agent, notes_dir: 'inbox' })).toBe('File [private attachment: a.txt]')
  })
})
