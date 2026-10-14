// Shares with an agents registry: per-agent routing and private-agent storage (AGENT_SERVICE_API.md "Shares").
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'

const servers: Server[] = []
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined))) })
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')

async function fakeHermes(name: string, sessions: string[] = []) {
  const seen: { method: string, path: string, body: any }[] = []
  const known = new Set(sessions)
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    let raw = ''
    for await (const c of req) raw += c
    const body = raw ? JSON.parse(raw) : undefined
    seen.push({ method: req.method ?? '', path: url.pathname, body })
    const json = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (url.pathname === '/health') return json(200, { status: 'ok' })
    if (url.pathname === '/v1/capabilities') return json(200, { features: {} })
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (req.method === 'GET' && sessionMatch) return known.has(sessionMatch[1]) ? json(200, { session: { id: sessionMatch[1] } }) : json(404, {})
    if (req.method === 'POST' && url.pathname === '/api/sessions') { if (known.has(body.id)) return json(409, {}); known.add(body.id); return json(201, { session: { id: body.id, title: body.title } }) }
    if (req.method === 'POST' && url.pathname === '/v1/runs') return json(202, { run_id: `${name}-run-${seen.filter((s) => s.path === '/v1/runs').length}`, status: 'started' })
    if (req.method === 'GET' && /^\/v1\/runs\//.test(url.pathname)) return json(200, { status: 'completed' })
    json(404, {})
  })
  servers.push(server)
  const address = await listen(server) as import('node:net').AddressInfo
  return { port: address.port, origin: `http://127.0.0.1:${address.port}`, seen, known, runs: () => seen.filter((s) => s.method === 'POST' && s.path === '/v1/runs') }
}

async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'share-agents-'))
  writeFileSync(join(dir, 'apps.json'), JSON.stringify({ schema: 1, apps: [] }))
  const main = await fakeHermes('main', ['main-thread'])
  const runtime = { apply: async () => ({ ok: true }), start: async () => ({ ok: true }), stop: async () => ({ ok: true }), deliver: async () => ({ verified: true }) }
  const svc = createWizardServer({
    requireJoinedDelegationCapability: false,
    upstreamOrigin: main.origin, hermesKey: 'fixture-key', requireAccess: false, agentBridge: false, followThrough: false,
    appsJsonPath: join(dir, 'apps.json'), settingsPath: join(dir, 'settings.json'), wizardOsHome: dir,
    agentRuntime: runtime, agentBasePort: 47750,
    mediaRoot: join(dir, 'media'), mediaAgentRoot: '/files', mediaIndexPath: join(dir, 'state', 'media-files.json'),
    uploadStatePath: join(dir, 'state', 'uploads.sqlite3'), uploadReserveBytes: 0,
    runQueueStatePath: join(dir, 'state', 'queue.sqlite3'), runQueuePollIntervalMs: 0, activeSessionReader: async () => [], dispatchHealthReader: () => true,
  })
  servers.push(svc)
  const address = await listen(svc) as import('node:net').AddressInfo
  const base = `http://127.0.0.1:${address.port}`
  return { dir, main, base }
}

const post = (base: string, path: string, value: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) })

async function addPrivate(dir: string, base: string) {
  const created = await post(base, '/wizard/v1/agents', { label: 'Private', harness: 'hermes', model: { provider: 'tinfoil', model: 'glm-5-3' }, permissions: { preset: 'private' } }, { 'Idempotency-Key': 'create-private' })
  const { agent } = await created.json()
  const agentHermes = await fakeHermes('private')
  const file = join(dir, 'agents', agent.id, 'agent.json')
  const value = JSON.parse(readFileSync(file, 'utf8'))
  value.runtime.port = agentHermes.port
  writeFileSync(file, JSON.stringify(value))
  return { agent, agentHermes }
}

async function sendShare(base: string, body: any, data: Buffer[]) {
  const created = await post(base, '/wizard/v1/shares', body)
  const share = await created.json()
  if (created.status !== 201) return { status: created.status, share }
  for (const [i, upload] of share.uploads.entries()) {
    const r = await fetch(`${base}/wizard/v1/uploads/${upload.upload_id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' }, body: data[i] })
    expect(r.status).toBe(204)
  }
  await Promise.all(share.uploads.map((u: any) => post(base, `/wizard/v1/uploads/${u.upload_id}/complete`, {})))
  return { status: created.status, share }
}
const delivered = async (base: string, id: string) => {
  for (let i = 0; i < 200; i += 1) {
    const s = await (await fetch(`${base}/wizard/v1/shares/${id}`)).json()
    if (s.status === 'delivered' || s.status === 'failed') return s
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`not delivered: ${JSON.stringify(await (await fetch(`${base}/wizard/v1/shares/${id}`)).json())}`)
}

describe('shares with an agents registry', () => {
  it('a share to the Private agent lands only in its home inbox and its own Hermes; main history and media/ untouched', async () => {
    const { dir, main, base } = await start()
    const { agent, agentHermes } = await addPrivate(dir, base)
    const a = randomBytes(4096), b = randomBytes(100)
    const { status, share } = await sendShare(base, { client_share_id: 'p-1', agent: agent.id, note: 'For you only', files: [{ filename: 'diary.pdf', mime: 'application/pdf', bytes: a.length, sha256: sha(a) }, { filename: 'photo.jpg', mime: 'image/jpeg', bytes: b.length }] }, [a, b])
    expect(status).toBe(201)
    expect(share).toMatchObject({ agent: agent.id, agent_label: 'Private' })
    expect((await delivered(base, share.share_id)).status).toBe('delivered')
    const day = new Date().toISOString().slice(0, 10)
    const inbox = join(dir, 'agents', agent.id, 'home', 'inbox', day)
    expect(sha(readFileSync(join(inbox, 'diary.pdf')))).toBe(sha(a))
    expect(readFileSync(join(inbox, 'photo.jpg')).equals(b)).toBe(true)
    // never media/ or the main Wizard Files index, never the main Hermes
    expect(existsSync(join(dir, 'media', 'Inbox'))).toBe(false)
    expect(existsSync(join(dir, 'state', 'media-files.json'))).toBe(false)
    expect(main.seen.filter((s) => s.method === 'POST')).toEqual([])
    // the agent's own Hermes got one thread and one run naming the files by path in its home
    expect(agentHermes.seen.filter((s) => s.method === 'POST' && s.path === '/api/sessions')).toHaveLength(1)
    const runs = agentHermes.runs()
    expect(runs).toHaveLength(1)
    expect(runs[0].body.session_id).toBe(share.thread_id)
    expect(runs[0].body.wizard_file_ids).toBeUndefined()
    expect(runs[0].body.input.startsWith('For you only')).toBe(true)
    expect(runs[0].body.input).toContain(`/opt/data/inbox/${day}/diary.pdf`)
    expect(runs[0].body.input).not.toContain(dir)
    // the thread is pinned to the private agent
    const pins = JSON.parse(readFileSync(join(dir, 'agents', '.threads.json'), 'utf8'))
    expect(pins.threads[share.thread_id]).toBe(agent.id)
    // staging is outside the agent's home and empty
    expect(readdirSync(join(dir, 'agents', agent.id, 'upload-staging')).filter((n) => n.endsWith('.part'))).toEqual([])
    // the upload's file never names a host path
    const upload = await (await fetch(`${base}/wizard/v1/uploads/${share.uploads[0].upload_id}`)).json()
    expect(JSON.stringify(upload)).not.toContain(dir)
  })

  it('omitted agent → the default (main) agent and Wizard Files', async () => {
    const { dir, main, base } = await start()
    await addPrivate(dir, base)
    const a = randomBytes(10)
    const { share } = await sendShare(base, { client_share_id: 'm-1', files: [{ filename: 'n.txt', bytes: 10 }] }, [a])
    expect(share.agent).toBe('hermes')
    expect((await delivered(base, share.share_id)).status).toBe('delivered')
    expect(main.runs()).toHaveLength(1)
    expect(main.runs()[0].body.input).toContain('/files/Inbox/')
    expect(existsSync(join(dir, 'media', 'Inbox'))).toBe(true)
  })

  it('a stopped or unknown agent → 409, never another agent; a thread of another agent → 409', async () => {
    const { dir, main, base } = await start()
    const { agent, agentHermes } = await addPrivate(dir, base)
    expect((await post(base, '/wizard/v1/shares', { client_share_id: 'u-1', agent: 'nobody', files: [{ filename: 'a', bytes: 1 }] })).status).toBe(409)
    expect((await post(base, '/wizard/v1/shares', { client_share_id: 'u-2', agent: agent.id, thread: 'main-thread', files: [{ filename: 'a', bytes: 1 }] })).status).toBe(404)
    // the container goes down, then the owner stops the agent
    const agentServer = servers.find((s) => (s.address() as any)?.port === agentHermes.port)!
    await new Promise((r) => { agentServer.close(r); agentServer.closeAllConnections() })
    expect((await post(base, `/wizard/v1/agents/${agent.id}/stop`, {})).status).toBeLessThan(300)
    const stopped = await post(base, '/wizard/v1/shares', { client_share_id: 'u-3', agent: agent.id, files: [{ filename: 'a', bytes: 1 }] })
    expect(stopped.status).toBe(409)
    expect(await stopped.json()).toMatchObject({ error: 'agent_unavailable', agent: agent.id })
    expect(main.seen.filter((s) => s.method === 'POST')).toEqual([])
  })
})
