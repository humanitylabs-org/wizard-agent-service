import { afterEach, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWizardServer, listen } from '../server/service.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const proof = 'attachment-owner-proof-0123456789abcdef0123456789'
const owner = { 'X-Wizard-Owner-Proof': proof }
const servers: any[] = [], roots: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise(r => s.close(r))))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const json = (body: any, headers = owner) => ({ method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
async function scene(files = 'own', failPlacement = false) {
  const seen: any[] = [], placed: any[] = []
  const dir = mkdtempSync(join(tmpdir(), 'agent-attachments-')); roots.push(dir)
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : null
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/health') return res.end('{"status":"ok"}')
    if (req.url === '/api/model/options') return res.end(JSON.stringify({ providers: [{ slug: 'anthropic', authenticated: true, models: ['claude-opus-5-5'] }] }))
    if (req.method === 'GET' && req.url?.startsWith('/api/sessions/')) { res.statusCode = 404; return res.end('{}') }
    if (req.method === 'POST' && req.url?.startsWith('/v1/runs')) {
      seen.push(body); res.statusCode = 202; return res.end('{"run_id":"attachment-run","status":"running"}')
    }
    res.end('{}')
  }); servers.push(upstream)
  const port = (await listen(upstream)).port
  const wizard = createWizardServer({
    upstreamOrigin: `http://127.0.0.1:${port}`, hermesKey: 'fixture', ownerProof: proof,
    requireAccess: false, agentBridge: false, joinedDelegation: 'off', followThrough: false,
    wizardOsHome: dir, settingsPath: join(dir, 'settings.json'),
    mediaRoot: join(dir, 'files'), mediaAgentRoot: '/owner-files', mediaIndexPath: join(dir, 'media.json'),
    uploadStatePath: join(dir, 'uploads.sqlite3'), uploadReserveBytes: 0,
    agentRuntime: { apply: async () => ({}), start: async () => ({}), stop: async () => ({}),
      place: async (id: string, payload: any) => {
        placed.push({ id, payload }); if (failPlacement) throw new Error('secret-host-path')
        return { verified: true, path: '/opt/data/inbox/2026-10-22/fixture.png' }
      } },
  }); servers.push(wizard)
  const base = `http://127.0.0.1:${(await listen(wizard)).port}`
  const created = await fetch(`${base}/wizard/v1/agents`, json({ label: 'Attachment fixture', harness: 'hermes', model: { provider: 'anthropic', model: 'claude-opus-5-5' }, permissions: { preset: 'standard' } }))
  expect(created.status).toBe(201)
  const id = (await created.json()).agent.id
  const path = join(dir, 'agents', id, 'agent.json'), agent = JSON.parse(readFileSync(path, 'utf8'))
  agent.runtime.port = port; agent.permissions.files = files; writeFileSync(path, JSON.stringify(agent))
  const key = 'fixture-agent-gateway-0123456789abcdef0123456789'
  writeFileSync(join(dir, 'agents', id, 'gateway.key'), key)
  await fetch(`${base}/wizard/v1/agents/${id}/start`, json({}))
  const upload = await fetch(`${base}/wizard/files/upload`, { method: 'POST', headers: { ...owner, 'Content-Type': 'application/octet-stream', 'X-Wizard-Mime': 'image/png', 'X-Wizard-Filename': 'fixture.png' }, body: png })
  expect(upload.status).toBe(201)
  const file = (await upload.json()).file
  expect(file.id).toBeTruthy()
  const send = (path = '/v1/runs', headers: any = owner, ids: any = [file.id]) => fetch(`${base}/wizard/hermes${path}?agent=${id}`, json({ session_id: 'wizard_attachment_test', input: 'Describe this', wizard_file_ids: ids }, headers))
  return { send, seen, placed, id, key, file, base }
}
it('forwards native images and durable container paths, never owner host paths or raw ids', async () => {
  const s = await scene(); expect((await s.send()).status).toBe(202)
  const body = s.seen.at(-1)
  expect(body.wizard_file_ids).toBeUndefined()
  expect(body.input[0].content[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } })
  expect(body.input[0].content[0].text).toContain('/opt/data/inbox/2026-10-22/fixture.png')
  expect(JSON.stringify(body)).not.toContain('/owner-files')
  expect(JSON.stringify(body)).not.toContain('localPath')
  expect(s.placed).toHaveLength(1)
  expect(Buffer.from(s.placed[0].payload.data_base64, 'base64')).toEqual(png)
})
it('refuses files:none with 409 without resolving or forwarding', async () => {
  const s = await scene('none'); expect((await s.send()).status).toBe(409)
  expect(s.seen).toHaveLength(0); expect(s.placed).toHaveLength(0)
})
it('an agent principal cannot reference owner file ids', async () => {
  const s = await scene(); expect((await s.send('/v1/runs', { Authorization: `Bearer ${s.key}` })).status).toBe(403)
  expect(s.seen).toHaveLength(0); expect(s.placed).toHaveLength(0)
})
it('rewrites steer attachments as native images too', async () => {
  const s = await scene(); expect((await s.send()).status).toBe(202)
  expect((await s.send('/v1/runs/attachment-run/steer')).status).toBe(202)
  expect(s.seen.at(-1).input[0].content[1].type).toBe('image_url')
  expect(s.seen.at(-1).wizard_file_ids).toBeUndefined()
})
it('keeps native images when placement fails and explains missing durable copy without leaking paths', async () => {
  const s = await scene('own', true); expect((await s.send()).status).toBe(202)
  const body = s.seen.at(-1)
  expect(body.input[0].content[1].type).toBe('image_url')
  expect(body.input[0].content[0].text).toContain('placement_error')
  expect(JSON.stringify(body)).not.toContain('secret-host-path')
  expect(JSON.stringify(body)).not.toContain('trusted_path')
})
it('uses the main run validator for duplicate, malformed and missing ids', async () => {
  const s = await scene()
  for (const ids of [[s.file.id, s.file.id], ['../bad'], 'bad', ['drop_00000000000000000000000000000000']]) expect((await s.send('/v1/runs', owner, ids)).status).toBe(400)
  expect(s.seen).toHaveLength(0); expect(s.placed).toHaveLength(0)
})
it('gives non-image files a durable tool-readable path', async () => {
  const s = await scene()
  const upload = await fetch(`${s.base}/wizard/files/upload`, { method: 'POST', headers: { ...owner, 'Content-Type': 'application/octet-stream', 'X-Wizard-Mime': 'text/plain', 'X-Wizard-Filename': 'note.txt' }, body: 'Synthetic attachment note' })
  expect(upload.status).toBe(201)
  const { file } = await upload.json()
  expect((await s.send('/v1/runs', owner, [file.id])).status).toBe(202)
  expect(s.seen.at(-1).input).toContain('trusted_path')
  expect(s.seen.at(-1).input).toContain('text/plain')
})
