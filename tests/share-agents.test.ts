// Shares with an agents registry: per-agent routing and private-agent storage (AGENT_SERVICE_API.md "Shares").
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
    if (req.method === 'GET' && /^\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) return json(200, { messages: seen.filter(x => x.method === 'POST' && x.path === '/v1/runs').map((x, i) => ({ id: i + 1, role: 'user', content: x.body.input })) })
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

async function start(extra: Record<string, any> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'share-agents-'))
  writeFileSync(join(dir, 'apps.json'), JSON.stringify({ schema: 1, apps: [] }))
  const main = await fakeHermes('main', ['main-thread'])
  const runtime = { apply: async () => ({ ok: true }), start: async () => ({ ok: true }), stop: async () => ({ ok: true }), deliver: async () => ({ verified: true }) }
  const options = {
    requireJoinedDelegationCapability: false,
    upstreamOrigin: main.origin, hermesKey: 'fixture-key', requireAccess: false, agentBridge: false, followThrough: false,
    appsJsonPath: join(dir, 'apps.json'), settingsPath: join(dir, 'settings.json'), wizardOsHome: dir,
    agentRuntime: runtime, agentBasePort: 47750,
    mediaRoot: join(dir, 'media'), mediaAgentRoot: '/files', mediaIndexPath: join(dir, 'state', 'media-files.json'),
    uploadStatePath: join(dir, 'state', 'uploads.sqlite3'), uploadReserveBytes: 0,
    runQueueStatePath: join(dir, 'state', 'queue.sqlite3'), runQueuePollIntervalMs: 0, activeSessionReader: async () => [], dispatchHealthReader: () => true,
    ...extra,
  }
  const svc = createWizardServer(options)
  servers.push(svc)
  const address = await listen(svc) as import('node:net').AddressInfo
  const base = `http://127.0.0.1:${address.port}`
  return { dir, main, base, svc, options }
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

describe('ordinary chat attachment custody (paperclip/resume/outbox, not shares)', () => {
  it('binds before bytes, survives Service restart, sends only to the selected private agent', async () => {
    const { dir, main, base, svc, options } = await start()
    const { agent, agentHermes } = await addPrivate(dir, base)
    const data = Buffer.from('private ordinary paperclip fixture')
    const body = { client_upload_id: 'paperclip-fixed-id', filename: 'private.txt', mime: 'text/plain', bytes: data.length, agent: agent.id }
    const created = await post(base, '/wizard/v1/uploads', body)
    expect(created.status).toBe(201)
    const up = await created.json(), path = `/wizard/v1/uploads/${up.upload_id}`, q = `?agent=${agent.id}`
    expect((await post(base, '/wizard/v1/uploads', { ...body, agent: 'hermes' })).status).toBe(409)
    expect((await fetch(base + path, { method: 'PATCH', headers: { 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body: data })).status).toBe(409)
    expect((await fetch(base + path + q, { method: 'PATCH', headers: { 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body: data.subarray(0, 8) })).status).toBe(204)
    const stage = join(dir, 'agents', agent.id, 'home', '.wizard-upload-staging', up.upload_id + '.part')
    expect(readFileSync(stage).equals(data.subarray(0, 8))).toBe(true)
    await new Promise<void>(resolve => svc.close(() => resolve()))
    servers.splice(servers.indexOf(svc), 1)
    const restarted = createWizardServer(options); servers.push(restarted)
    const address = await listen(restarted) as import('node:net').AddressInfo
    const next = `http://127.0.0.1:${address.port}`
    expect((await (await fetch(next + path + q)).json()).offset).toBe(8)
    expect((await fetch(next + path + q, { method: 'PATCH', headers: { 'Upload-Offset': '8', 'Content-Type': 'application/offset+octet-stream' }, body: data.subarray(8) })).status).toBe(204)
    const complete = await post(next, path + '/complete' + q, {})
    expect(complete.status).toBe(200)
    const file = (await complete.json()).file
    const download = await fetch(next + `/wizard/files/${file.id}/content` + q)
    expect(download.status).toBe(200)
    expect(Buffer.from(await download.arrayBuffer()).equals(data)).toBe(true)
    expect((await fetch(next + `/wizard/files/${file.id}/content?agent=hermes`)).status).toBe(404)
    const wrongMain = await post(next, '/wizard/hermes/v1/runs', { session_id: 'main-thread', input: 'wrong main target', wizard_file_ids: [file.id] }, { 'Idempotency-Key': 'must-not-leak' })
    expect(wrongMain.status).toBeGreaterThanOrEqual(400)
    const session = await post(next, '/wizard/hermes/api/sessions' + q, { id: 'private-paperclip-thread' })
    expect(session.status).toBe(201)
    const sent = await post(next, '/wizard/hermes/v1/runs' + q, { session_id: 'private-paperclip-thread', input: 'read this', wizard_file_ids: [file.id] })
    expect(sent.status).toBe(202)
    expect(agentHermes.runs()[0].body.input).toContain('/opt/data/inbox/')
    expect(agentHermes.runs()[0].body.wizard_file_ids).toBeUndefined()
    const history = await fetch(next + '/wizard/hermes/api/sessions/private-paperclip-thread/messages' + q + '&view=wizard')
    expect(history.status).toBe(200)
    const content = (await history.json()).messages[0].content
    expect(content).toContain('WIZARD_FILE_CHIPS_V1')
    expect(content).toContain(`"agent":"${agent.id}"`)
    expect(content).not.toContain('/opt/data/')
    expect((await post(next, '/wizard/hermes/v1/runs' + q, { session_id: 'private-paperclip-thread', input: 'wrong', wizard_file_ids: ['af_' + 'a'.repeat(32)] })).status).toBe(409)
    expect(existsSync(join(dir, 'media', 'Inbox'))).toBe(false)
    expect(existsSync(join(dir, 'state', 'media-files.json'))).toBe(false)
    expect(main.seen.filter(s => s.method === 'POST')).toEqual([])
  })
  it('one-shot outbox audio is stored only in selected agent home', async () => {
    const { dir, main, base } = await start()
    const { agent } = await addPrivate(dir, base)
    const data = Buffer.from('private audio fixture')
    const response = await fetch(`${base}/wizard/files/upload?agent=${agent.id}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Wizard-Filename': 'voice.webm', 'X-Wizard-Mime': 'audio/webm' }, body: data })
    expect(response.status).toBe(201)
    expect((await response.json()).file.id).toMatch(/^af_/)
    expect(readFileSync(join(dir, 'agents', agent.id, 'home', 'inbox', new Date().toISOString().slice(0,10), 'voice.webm')).equals(data)).toBe(true)
    expect(existsSync(join(dir, 'state', 'media-files.json'))).toBe(false)
    expect(main.seen.filter(s => s.method === 'POST')).toEqual([])
  })
})

describe('global ordinary control request boundary', () => {
  it('denies hostile authority/origin/fetch metadata on reads and writes before routing', async () => {
    const { base, main } = await start()
    const raw = (path: string, headers: Record<string,string>, method = 'GET') => new Promise<number>((resolve, reject) => {
      const req = httpRequest(base + path, { method, headers: { 'Content-Type':'application/json', ...headers } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)) })
      req.on('error', reject); req.end(method === 'POST' ? JSON.stringify({ id: 'must-not-create' }) : undefined)
    })
    for (const headers of [ { Host: 'attacker.test' }, { Origin: 'http://attacker.test' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Host: '127.0.0.1:1' } ]) {
      for (const path of ['/wizard/files', '/wizard/v1/agents', '/wizard/bootstrap']) expect(await raw(path, headers as Record<string,string>), JSON.stringify(headers)).toBe(403)
      expect(await raw('/wizard/hermes/api/sessions', headers as Record<string,string>, 'POST')).toBe(403)
    }
    expect((await post(base, '/wizard/hermes/api/sessions', { id: 'valid' }, { Origin: base, 'Sec-Fetch-Site': 'same-origin' })).status).toBe(201)
    expect((await fetch(base + '/wizard/v1/agents')).status).toBe(200)
    expect(main.seen.filter(s => s.method === 'POST')).toHaveLength(1)
    // Token routes are not owner-authorized by the exception: forged token still fails.
    expect((await post(base, '/wizard/v1/agents/hermes/deliveries', {}, { Host: 'machine.test', Authorization: 'Bearer forged' })).status).toBe(403)
  })
})

describe('maintenance HTTP admission (runtime barrier fixture, real activity DBs)', () => {
  it('does not let a loopback proxy bypass a configured access verifier', async () => {
    let entered = false
    const { base } = await start({ requireAccess: true, accessVerifier: async () => { throw new Error('denied') },
      maintenanceBarrier: { acquire: async () => { entered = true }, release: async () => {} } })
    const token = '11111111-1111-4111-8111-111111111111'
    expect((await post(base, '/wizard/v1/maintenance', { token })).status).toBe(403)
    expect((await fetch(base + '/wizard/v1/maintenance', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })).status).toBe(403)
    expect(entered).toBe(false)
  })
  it('checks secondary activity and rejects a new run racing the acquisition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maintenance-http-'))
    const mainPath = join(root, 'state.db')
    const makeState = (path: string, busy = false) => {
      const db = new DatabaseSync(path)
      db.exec("CREATE TABLE session_turn_leases(conversation_id TEXT, expires_at REAL); CREATE TABLE sessions(last_activity_description TEXT, last_activity_at REAL)")
      if (busy) db.prepare('INSERT INTO session_turn_leases VALUES (?,?)').run('hidden-worker', Date.now()/1000+300)
      db.close()
    }
    makeState(mainPath)
    let finish: () => void, entered: () => void
    const ready = new Promise<void>(r => entered = r)
    let waiting = true
    const barrier = { acquire: async () => { if (waiting) { entered!(); await new Promise<void>(r => finish = r) } return async () => {} }, release: async () => {} }
    const { dir, base } = await start({ hermesStatePath: mainPath, maintenanceBarrier: barrier })
    const { agent, agentHermes } = await addPrivate(dir, base)
    const privatePath = join(dir, 'agents', agent.id, 'home', 'state.db')
    makeState(privatePath, true)
    const token = '12345678-1234-1234-1234-123456789abc'
    const acquiring = post(base, '/wizard/v1/maintenance', {token})
    await ready
    expect((await post(base, `/wizard/hermes/v1/runs?agent=${agent.id}`, {session_id:'race',input:'must wait'})).status).toBe(409)
    expect(agentHermes.runs()).toHaveLength(0)
    finish!();expect((await acquiring).status).toBe(409)
    waiting = false
    const db = new DatabaseSync(privatePath);db.exec('DELETE FROM session_turn_leases');db.close()
    const held = await post(base, '/wizard/v1/maintenance', {token})
    expect(held.status).toBe(201);expect((await held.json()).agents).toEqual(['hermes',agent.id])
    expect((await post(base, `/wizard/hermes/v1/runs?agent=${agent.id}`, {session_id:'race',input:'must wait'})).status).toBe(409)
    expect((await fetch(base+'/wizard/v1/maintenance', {method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'wrong'})})).status).toBe(409)
    expect((await fetch(base+'/wizard/v1/maintenance', {method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})})).status).toBe(200)
    expect((await post(base, `/wizard/hermes/v1/runs?agent=${agent.id}`, {session_id:'after-release',input:'now allowed'})).status).toBe(202)
    expect(agentHermes.runs()).toHaveLength(1)
  })
})

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
    expect(readdirSync(join(dir, 'agents', agent.id, 'home', '.wizard-upload-staging')).filter((n) => n.endsWith('.part'))).toEqual([])
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

  it('replays exactly once, binds the recipient and note, and seals the private thread and file from main routes', async () => {
    const { dir, main, base } = await start()
    const { agent, agentHermes } = await addPrivate(dir, base)
    const bytes = Buffer.from('synthetic private fixture')
    const input = { client_share_id: 'replay', agent: agent.id, note: 'Private only', files: [{ filename: 'secret.txt', bytes: bytes.length, sha256: sha(bytes) }] }
    const { share } = await sendShare(base, input, [bytes])
    const original = await delivered(base, share.share_id)
    const replay = await post(base, '/wizard/v1/shares', input)
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true')
    expect(await replay.json()).toMatchObject({ share_id: share.share_id, thread_id: share.thread_id, agent: agent.id, run_id: original.run_id })
    expect((await post(base, `/wizard/v1/uploads/${share.uploads[0].upload_id}/complete`, {})).status).toBe(200)
    for (const changed of [{ agent: 'hermes' }, { agent: undefined }, { note: 'Changed' }, { thread: share.thread_id }, { files: [{ ...input.files[0], filename: 'other.txt' }] }]) {
      const result = await post(base, '/wizard/v1/shares', { ...input, ...changed })
      expect(result.status).toBe(409)
      expect(await result.json()).toMatchObject({ error: 'client_share_id_conflict' })
    }
    const path = `/wizard/hermes/api/sessions/${share.thread_id}`
    expect((await fetch(`${base}${path}?agent=${agent.id}`)).status).toBe(200)
    expect((await fetch(`${base}${path}`)).status).toBe(409)
    expect((await fetch(`${base}${path}?agent=hermes`)).status).toBe(409)
    expect((await fetch(`${base}${path}?agent=${agent.id}&view=operator`)).status).toBeGreaterThanOrEqual(400)
    const upload = await (await fetch(`${base}/wizard/v1/uploads/${share.uploads[0].upload_id}`)).json()
    expect((await fetch(`${base}/wizard/files/${upload.file.id}/content`)).status).toBe(404)
    expect(agentHermes.runs()).toHaveLength(1)
    expect(main.seen.filter((s) => s.method === 'POST')).toEqual([])
  })

  it('cannot replay a main upload handle as a private share', async () => {
    const { dir, base } = await start()
    const { agent } = await addPrivate(dir, base)
    const input = { client_share_id: 'main-to-private', files: [{ filename: 'same.txt', bytes: 5 }] }
    expect((await post(base, '/wizard/v1/shares', input)).status).toBe(201)
    const switched = await post(base, '/wizard/v1/shares', { ...input, agent: agent.id })
    expect(switched.status).toBe(409)
    expect(await switched.json()).toEqual({ error: 'client_share_id_conflict' })
  })

  it('refuses shares when agent file permission is none', async () => {
    const { dir, main, base } = await start()
    const { agent, agentHermes } = await addPrivate(dir, base)
    const file = join(dir, 'agents', agent.id, 'agent.json')
    const value = JSON.parse(readFileSync(file, 'utf8'))
    value.permissions.files = 'none'
    writeFileSync(file, JSON.stringify(value))
    const result = await post(base, '/wizard/v1/shares', { client_share_id: 'no-files', agent: agent.id, files: [{ filename: 'x', bytes: 5 }] })
    expect(result.status).toBe(409)
    expect(await result.json()).toMatchObject({ error: 'agent_files_not_allowed' })
    expect(agentHermes.runs()).toEqual([])
    expect(main.runs()).toEqual([])
  })

  it('denies unauthenticated share, upload status and bytes before accessing private data', async () => {
    const { main, base } = await start({ requireAccess: true, accessVerifier: async () => false })
    const upload = 'up_' + 'a'.repeat(32), share = 'sh_' + 'a'.repeat(32)
    const requests = [
      post(base, '/wizard/v1/shares', { client_share_id: 'unauth', agent: 'private', files: [{ filename: 'x', bytes: 5 }] }),
      fetch(`${base}/wizard/v1/shares/${share}`),
      fetch(`${base}/wizard/v1/uploads/${upload}`),
      fetch(`${base}/wizard/v1/uploads/${upload}`, { method: 'PATCH', headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': '0' }, body: 'secret' }),
      post(base, `/wizard/v1/uploads/${upload}/complete`, {}),
    ]
    for (const result of await Promise.all(requests)) expect(result.status).toBe(403)
    expect(main.seen.filter((s) => s.method === 'POST')).toEqual([])
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
