import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSkins, validateListing, addressOf } from '../server/skins.mjs'
import { publicKey, signEvent, verifyEvent, eventId, npub, decodeNip19, sha256, relayRequest, relayPublish, blossomRequest, blossomUpload } from '../server/nostr.mjs'
import { createMySkin, MY_SKIN_MAX_BYTES } from '../server/my-skin.mjs'
import { createWizardServer, listen } from '../server/service.mjs'
import { curatorSecret, runCurator } from '../scripts/skins-curator.mjs'

const KEY = '0'.repeat(63) + '1', OTHER = '0'.repeat(63) + '2', CURATOR = '0'.repeat(63) + '3'
const PUB = publicKey(KEY), OTHER_PUB = publicKey(OTHER)
const CSS = Buffer.from('body { color: coral; }')
const cleanups: (() => any)[] = []
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop() })
function scratch() { const root = mkdtempSync(join(tmpdir(), 'nostr-skins-')); cleanups.push(() => rmSync(root, { recursive: true, force: true })); return root }
const sign = (template: any, key = KEY) => signEvent(template, key, new Uint8Array(32))
function listing(server = 'https://example.com/blossom', overrides: any = {}, key = KEY) {
  return sign({ kind: 30117, created_at: 1700000000, tags: [
    ['d', 'golden'], ['t', 'wizard-skin'], ['name', 'Golden'], ['summary', 'Synthetic skin'],
    ['published_at', '1699999900'], ['version', '1'], ['base', 'nebula'], ['ux', '1'],
    ['file', 'skin.css', sha256(CSS), 'text/css', String(CSS.length)], ['server', server], ['alt', 'Wizard OS skin: Golden'],
  ], content: '{"schema":1}', ...overrides }, key)
}
function mutate(event: any, key: string, transform: (e: any) => void) { const draft = structuredClone(event); transform(draft); return sign(draft, key) }
function matches(event: any, filter: any) {
  return Object.entries(filter).every(([key, value]: any) => key === 'limit' || (key === 'kinds' ? value.includes(event.kind) : key === 'authors' ? value.includes(event.pubkey) : key === 'ids' ? value.includes(event.id) : key.startsWith('#') ? event.tags.some((t: any) => t[0] === key.slice(1) && value.includes(t[1])) : true))
}
async function network() {
  const events: any[] = [], published: any[] = [], blobs = new Map<string, { body: Buffer, mime: string }>()
  let requests = 0, rejectPublish = false, hang = false
  const http = createServer(async (req, res) => {
    requests++
    if (req.method === 'PUT' && req.url === '/blossom/upload') {
      const parts = []; for await (const chunk of req) parts.push(chunk)
      const body = Buffer.concat(parts)
      let auth
      try { auth = JSON.parse(Buffer.from(String(req.headers.authorization).slice(6), 'base64').toString()) } catch {}
      if (!auth || !verifyEvent(auth) || auth.kind !== 24242 || !auth.tags.some((t: any) => t[0] === 't' && t[1] === 'upload')
        || !auth.tags.some((t: any) => t[0] === 'x' && t[1] === sha256(body)) || req.headers['x-sha-256'] !== sha256(body)
        || !auth.tags.some((t: any) => t[0] === 'expiration' && Number(t[1]) > Date.now() / 1000 && Number(t[1]) <= Date.now() / 1000 + 600)) { res.writeHead(401).end(); return }
      blobs.set(sha256(body), { body, mime: String(req.headers['content-type']) })
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ sha256: sha256(body) })); return
    }
    const blob = blobs.get(String(req.url).split('/').pop() || '')
    if (!blob) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': blob.mime, 'Content-Length': blob.body.length })
    res.end(req.method === 'HEAD' ? undefined : blob.body)
  })
  const ws = new WebSocketServer({ server: http, path: '/relay' })
  ws.on('connection', socket => socket.on('message', (message: any) => {
    const frame = JSON.parse(message.toString())
    if (frame[0] === 'REQ' && !hang) {
      for (const event of events) if (frame.slice(2).some((f: any) => matches(event, f))) socket.send(JSON.stringify(['EVENT', frame[1], event]))
      socket.send(JSON.stringify(['EOSE', frame[1]]))
    } else if (frame[0] === 'EVENT') {
      published.push(frame[1])
      if (!rejectPublish) events.push(frame[1])
      socket.send(JSON.stringify(['OK', frame[1].id, !rejectPublish, rejectPublish ? 'blocked' : 'stored']))
    }
  }))
  const address = await listen(http), origin = `http://127.0.0.1:${address.port}`, relay = `ws://127.0.0.1:${address.port}/relay`, blossom = origin + '/blossom'
  cleanups.push(async () => { for (const socket of ws.clients || []) socket.terminate(); ws.close(); http.closeAllConnections(); await new Promise<void>(r => http.close(() => r())) })
  blobs.set(sha256(CSS), { body: CSS, mime: 'text/css' })
  return { origin, relay, blossom, events, published, blobs, requests: () => requests, reject: () => { rejectPublish = true }, hang: () => { hang = true } }
}
function local(net?: any, extra: any = {}) {
  const dir = scratch(), root = join(dir, 'files'), stateDir = join(dir, 'state')
  mkdirSync(root)
  const options = { root, stateDir, relays: net ? [net.relay] : [], blossom: net?.blossom, curator: publicKey(CURATOR), transport: { allowPrivate: true, timeoutMs: 300 }, now: () => 1700000100, ...extra }
  return { skins: createSkins(options)!, dir, root, stateDir, options }
}

describe('Nostr wire primitives', () => {
  it('has two fixed valid schema-1 vectors (including a fork), NIP-01 ids and deterministic BIP-340 signatures', () => {
    const first = listing()
    const fork = listing(undefined, { created_at: 1700000001, tags: [...first.tags.filter((t: any) => t[0] !== 'd'), ['d', 'fork'], ['a', addressOf(first), '', 'fork'], ['p', PUB]] }, OTHER)
    expect(first.id).toBe('de92164d4e9483e7c74d843d5d3956b7a7221b86057faef35720630866d0a843')
    expect(first.sig).toBe('d35ed1c9ec8c2eb0be1196e150bbc715ae33d335d4573e396173439f9b187c93e1e1f92202d2e6a1faa2079af2c43def6058b2f90cd7c39b8ca90bf04e7fd8cf')
    expect(fork.id).toBe('6970e40c7d65aa858f1119a889b897d06e6c72092af167f717e2d60cd956e76c')
    expect(fork.sig).toBe('91adb7b5f86924ad75d847ae7067d589a5345585f22b4c2bf1d8e132e4de00c8308f8b86ebba45683add761dea436b8ca3ec67ec2b28bed772a8ac09bbc0bc98')
    for (const e of [first, fork]) { expect(eventId(e)).toBe(e.id); expect(verifyEvent(e)).toBe(true); expect(validateListing(e).event_id).toBe(e.id) }
    expect(npub(PUB)).toBe('npub10xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqpkge6d')
    expect(decodeNip19(npub(PUB), 'npub')).toBe(PUB)
    expect(() => decodeNip19(npub(PUB).slice(0, -1) + 'q', 'npub')).toThrow()
    expect(verifyEvent({ ...first, content: '{}' })).toBe(false)
  })
  it('handles REQ/EOSE, publish OK/rejection and timeouts using a real loopback WebSocket', async () => {
    const net = await network(), event = listing(net.blossom)
    net.events.push(event)
    expect((await relayRequest(net.relay, [{ kinds: [30117] }])).events).toEqual([event])
    expect((await relayPublish(net.relay, event)).ok).toBe(true)
    net.reject()
    expect(await relayPublish(net.relay, event)).toMatchObject({ ok: false, message: 'blocked' })
    net.hang()
    expect((await relayRequest(net.relay, [{}], { timeoutMs: 20 })).ok).toBe(false)
  })
  it('uses valid BUD-02 auth, reads back uploaded bytes, refuses private URLs by default', async () => {
    const net = await network()
    expect(await blossomUpload(net.blossom, CSS, 'text/css', KEY, { allowPrivate: true })).toBe(sha256(CSS))
    await expect(blossomRequest(net.origin)).rejects.toThrow('unsafe_blossom_url')
    await expect(blossomRequest('https://127.0.0.1/x')).rejects.toThrow('unsafe_blossom_url')
    await expect(blossomRequest('https://[::ffff:127.0.0.1]/x')).rejects.toThrow('unsafe_blossom_url')
  })
})

describe('My skins folders', () => {
  it('migrates existing My skin without changing CSS or scripts, switches and clears the active layer', () => {
    const { skins, root } = local(), path = join(root, 'Skins', 'My skin')
    mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'skin.css'), CSS); writeFileSync(join(path, 'skin.js'), 'export const x = 1')
    expect(skins.list().active).toBe('My skin')
    expect(readFileSync(join(root, 'Skins', 'active'), 'utf8')).toBe('My skin\n')
    const layer = createMySkin({ root })!
    expect(layer.css()).toBe(CSS.toString()); expect(layer.script().body!.toString()).toBe('export const x = 1')
    const { id } = skins.create({ name: 'Second', css: 'body { opacity: .9 }' })
    skins.setActive(id)
    expect(layer.relative).toBe('Skins/Second/skin.css'); expect(layer.css()).toContain('opacity: .9'); expect(layer.script().exists).toBe(false)
    skins.setActive(null)
    expect(layer.css()).toBe(''); expect(layer.script().exists).toBe(false); expect(() => layer.write('a{}')).toThrow('no_active_skin')
    expect(createSkins({ root, stateDir: join(root, 'state') })!.list().active).toBe(null)
    expect(readFileSync(join(path, 'skin.css'))).toEqual(CSS)
  })
  it('validates ids, deduplicates folders, caps CSS and refuses symlink escapes', async () => {
    const { skins, root } = local()
    expect(skins.list()).toEqual({ active: null, skins: [] })
    for (const name of ['', '.bad', '../x', 'a/b', 'a\\b', 'bad\n', 'x'.repeat(65)]) expect(() => skins.create({ name })).toThrow()
    expect(skins.create({ name: 'Local', css: 'a{}' }).id).toBe('Local')
    expect(skins.create({ name: 'Local', css: 'b{}' }).id).toBe('Local 2')
    expect(() => skins.create({ name: 'Big', css: 'x'.repeat(MY_SKIN_MAX_BYTES + 1) })).toThrow('skin_too_large')
    symlinkSync(scratch(), join(root, 'Skins', 'Escape'))
    expect(() => skins.setActive('Escape')).toThrow('skin_not_found')
    await expect(skins.pack('Escape')).rejects.toThrow('skin_not_found')
    expect(skins.list().skins.map((s: any) => s.id)).toEqual(['Local', 'Local 2'])
  })
})

describe('verified Store', () => {
  it('newest-wins per address, profiles, fork counts, featured ordering, authors and 5-minute caching', async () => {
    const net = await network(), { skins } = local(net)
    const parent = listing(net.blossom), child = listing(net.blossom, { created_at: parent.created_at + 2, tags: [...parent.tags.filter((t: any) => t[0] !== 'd'), ['d', 'fork'], ['a', addressOf(parent), net.relay, 'fork'], ['p', PUB]] }, OTHER)
    const update = mutate(parent, KEY, e => { e.created_at++; e.tags = e.tags.map((t: any) => t[0] === 'version' ? ['version', '2'] : t) })
    net.events.push(parent, update, child,
      sign({ kind: 0, created_at: 1700000000, tags: [], content: '{"name":"Synthetic author","picture":"https://example.com/author.webp"}' }),
      sign({ kind: 30004, created_at: 1700000000, tags: [['d', 'wizard-skins-featured'], ['a', addressOf(parent)]], content: '' }, CURATOR))
    const result = await skins.store()
    expect(result.items.map((i: any) => i.a)).toEqual([addressOf(parent), addressOf(child)])
    expect(result.items[0]).toMatchObject({ version: 2, forks: 1, featured: true, author: { name: 'Synthetic author' } })
    expect(result.items[0].servers).toBeUndefined()
    expect(result.relays).toEqual([{ url: net.relay, ok: true }])
    expect((await skins.store({ authors: OTHER_PUB })).items.map((i: any) => i.a)).toEqual([addressOf(child)])
    net.events.length = 0
    expect((await skins.store()).items).toHaveLength(2)
    expect((await skins.store({ refresh: true })).items).toHaveLength(0)
  })
  it.each(['a', 'p'])('removes blocked %s entries within one refresh and ignores other curators', async kind => {
    const net = await network(), { skins } = local(net), event = listing(net.blossom)
    net.events.push(event, sign({ kind: 30004, created_at: 1700000000, tags: [['d', 'wizard-skins-blocked'], [kind, kind === 'a' ? addressOf(event) : PUB]], content: '' }, OTHER))
    expect((await skins.store()).items).toHaveLength(1)
    net.events.push(sign({ kind: 30004, created_at: 1700000001, tags: [['d', 'wizard-skins-blocked'], [kind, kind === 'a' ? addressOf(event) : PUB]], content: '' }, CURATOR))
    expect((await skins.store({ refresh: true })).items).toHaveLength(0)
  })
  it('rejects malformed signatures, schema, required tags, base, UX, files, MIME, sizes, hashes and unsupported JS', async () => {
    const net = await network(), { skins } = local(net), good = listing(net.blossom)
    const mutations = [
      (e: any) => { e.content = '{"schema":2}' }, (e: any) => { e.content = 'null' },
      ...['d', 'name', 'published_at', 'version', 'base', 'ux', 'alt', 'server', 'file', 't'].map(tag => (e: any) => { e.tags = e.tags.filter((t: any) => t[0] !== tag) }),
      (e: any) => { e.tags.find((t: any) => t[0] === 'base')[1] = 'other' },
      (e: any) => { e.tags.find((t: any) => t[0] === 'ux')[1] = '2' },
      (e: any) => { e.tags.find((t: any) => t[0] === 'file')[4] = '65537' },
      (e: any) => { e.tags.find((t: any) => t[0] === 'file')[3] = 'text/html' },
      (e: any) => { e.tags.find((t: any) => t[0] === 'file')[2] = 'f'.repeat(64) },
      (e: any) => { e.tags.push(['file', 'skin.js', sha256(CSS), 'application/javascript', String(CSS.length)]) },
      (e: any) => { e.tags.push([...e.tags.find((t: any) => t[0] === 'file')]) },
    ]
    for (const change of mutations) {
      const bad = mutate(good, KEY, change)
      net.events.splice(0, net.events.length, bad)
      expect((await skins.store({ refresh: true })).items).toEqual([])
    }
    net.events.splice(0, net.events.length, { ...good, sig: '0'.repeat(128) })
    expect((await skins.store({ refresh: true })).items).toEqual([])
    net.blobs.set(sha256(CSS), { body: Buffer.from('tampered content!!!!!'), mime: 'text/css' })
    const isolated = local(net).skins
    net.events.splice(0, net.events.length, good)
    expect((await isolated.store()).items).toEqual([])
  })
  it('hash-verifies disk cache, exposes only listed blobs, and adds new fork folders without overwriting or JS', async () => {
    const net = await network(), { skins, root, stateDir } = local(net), event = listing(net.blossom)
    net.events.push(event)
    skins.create({ name: 'Golden', css: 'body{color:blue}' })
    await skins.store()
    expect((await skins.blob(sha256(CSS))).body).toEqual(CSS)
    const made = await skins.add(addressOf(event))
    expect(made).toEqual({ id: 'Golden 2' }); expect(skins.list().active).toBe('Golden 2')
    expect(readFileSync(join(root, 'Skins', 'Golden', 'skin.css'), 'utf8')).toBe('body{color:blue}')
    expect(JSON.parse(readFileSync(join(root, 'Skins', made.id, 'skin.json'), 'utf8')).forked_from).toEqual({ a: addressOf(event), event_id: event.id, author: PUB })
    expect(existsSync(join(root, 'Skins', made.id, 'skin.js'))).toBe(false)
    writeFileSync(join(stateDir, 'blobs', sha256(CSS)), 'tampered')
    await expect(skins.blob(sha256(CSS))).rejects.toThrow('blob_not_found')
    await expect(skins.blob('0'.repeat(64))).rejects.toThrow('blob_not_found')
  })
})

describe('pack, publish, report and curator', () => {
  it('uploads only bounded schema-1 blobs, preserves fork / first-publish tags and increments version', async () => {
    const net = await network(), { skins, root, stateDir, options } = local(net), parent = listing(net.blossom)
    net.events.push(parent)
    const { id } = await skins.add(addressOf(parent)), folder = join(root, 'Skins', id)
    writeFileSync(join(folder, 'skin.js'), 'DO NOT SHARE')
    writeFileSync(join(folder, 'composition.json'), '{"tokens":{}}')
    const packed = await skins.pack(id)
    expect(packed.slug).toBe('golden')
    expect(packed.unsigned.tags.filter((t: any) => t[0] === 'file').map((t: any) => t[1])).toEqual(['skin.css', 'composition.json'])
    expect(packed.unsigned.tags).toContainEqual(['a', addressOf(parent), net.relay, 'fork'])
    const event = sign(packed.unsigned, OTHER), published = await skins.publish(id, event)
    expect(published).toMatchObject({ event_id: event.id, a: addressOf(event), relays: [{ url: net.relay, ok: true }] })
    expect(JSON.parse(readFileSync(join(folder, 'skin.json'), 'utf8')).published.event_id).toBe(event.id)
    expect((statSync(join(stateDir, 'upload-key.hex')).mode & 0o777)).toBe(0o600)
    expect(JSON.stringify(skins.list())).not.toContain(readFileSync(join(stateDir, 'upload-key.hex'), 'utf8').trim())
    // Simulate a service restart; publishing metadata lives outside the HTTP process.
    const restarted = createSkins(options)!
    const next = await restarted.pack(id)
    expect(next.unsigned.tags).toContainEqual(['version', '2'])
    expect(next.unsigned.tags).toContainEqual(packed.unsigned.tags.find((t: any) => t[0] === 'published_at'))
    expect((await restarted.publish(id, sign(next.unsigned, OTHER))).event_id).toBeTruthy()
    await expect(restarted.publish(id, sign(next.unsigned, OTHER))).rejects.toThrow('pack_mismatch')
  })
  it('refuses bad signatures, tampered remote/local blobs and tag mismatches before ANY broadcast', async () => {
    const net = await network(), { skins, root } = local(net), { id } = skins.create({ name: 'Test', css: CSS.toString() })
    const packed = await skins.pack(id), event = sign(packed.unsigned)
    await expect(skins.publish(id, { ...event, sig: '0'.repeat(128) })).rejects.toThrow('invalid_skin_event')
    await expect(skins.publish(id, mutate(event, KEY, e => { e.tags.find((t: any) => t[0] === 'version')[1] = '2' }))).rejects.toThrow('pack_mismatch')
    net.blobs.set(sha256(CSS), { body: Buffer.from('tampered'), mime: 'text/css' })
    await expect(skins.publish(id, event)).rejects.toThrow('skin_blob_unavailable')
    net.blobs.set(sha256(CSS), { body: CSS, mime: 'text/css' })
    writeFileSync(join(root, 'Skins', id, 'skin.css'), 'body { color: red }')
    await expect(skins.publish(id, event)).rejects.toThrow('pack_mismatch')
    expect(net.published).toEqual([])
  })
  it('signs reports with the private box upload key and surfaces relay refusal', async () => {
    const net = await network(), { skins, stateDir } = local(net), a = addressOf(listing(net.blossom))
    expect(await skins.report({ a, reason: 'Synthetic test report' })).toEqual({ ok: true })
    const event = net.published[0]
    expect(verifyEvent(event)).toBe(true); expect(event.kind).toBe(1984); expect(event.tags).toContainEqual(['report', 'other'])
    expect(event.pubkey).toBe(publicKey(readFileSync(join(stateDir, 'upload-key.hex'), 'utf8').trim()))
    net.reject()
    await expect(skins.report({ a, reason: 'Synthetic test report' })).rejects.toThrow('report_failed')
  })
  it('curator CLI adds/removes/lists and seeds a folder with file-based key config without exposing secrets', async () => {
    const net = await network(), dir = scratch(), keyFile = join(dir, 'curator.json'), output: any[] = []
    writeFileSync(keyFile, JSON.stringify({ secret_hex: CURATOR }), { mode: 0o600 })
    const env = { WIZARD_SKINS_CURATOR_KEY_FILE: keyFile, WIZARD_SKINS_RELAYS: net.relay, WIZARD_SKINS_BLOSSOM: net.blossom }
    const options = { env, output: (value: any) => { output.push(value) }, transport: { allowPrivate: true, timeoutMs: 300 } }
    expect(curatorSecret(env)).toBe(CURATOR)
    const a = addressOf(listing(net.blossom))
    await runCurator(['featured', 'add', a], options)
    await runCurator(['featured', 'list'], options)
    expect(output.at(-1).entries).toEqual([['a', a]])
    await runCurator(['featured', 'remove', a], options)
    expect(output.at(-1).entries).toEqual([])
    await runCurator(['blocked', 'add', npub(PUB)], options)
    expect(output.at(-1).entries).toEqual([['p', PUB]])
    const folder = join(dir, 'Seed'); mkdirSync(folder); writeFileSync(join(folder, 'skin.css'), CSS)
    await runCurator(['publish-skin', folder, '--slug', 'seed', '--name', 'Seed', '--summary', 'A seed skin'], options)
    expect(net.published.at(-1).pubkey).toBe(publicKey(CURATOR))
    expect(JSON.parse(readFileSync(join(folder, 'skin.json'), 'utf8')).published.slug).toBe('seed')
    expect(JSON.stringify(output)).not.toContain(CURATOR)
  })
})

async function api(net: any, extra: any = {}) {
  const localBox = local(net)
  const server = createWizardServer({ requireAccess: false, requireJoinedDelegationCapability: false, followThrough: false, agents: false, agentBridge: false,
    upstreamOrigin: 'http://127.0.0.1:9', hermesKey: 'synthetic', userFilesRoot: localBox.root, skinsStateDir: localBox.stateDir,
    settingsPath: join(localBox.dir, 'settings.json'), wizardOsHome: join(localBox.dir, 'os'), skins: { ...localBox.options }, ...extra })
  const address = await listen(server), origin = `http://127.0.0.1:${address.port}`
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) })
  const call = (path: string, method = 'GET', body?: any, headers = {}) => fetch(origin + '/wizard/v1/skins' + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { ...localBox, origin, call }
}
describe('HTTP routes', () => {
  it('exercises every API route, script activation and verified blob response', async () => {
    const net = await network(), { call, origin, root } = await api(net), event = listing(net.blossom)
    expect((await call('')).status).toBe(200)
    const made = await (await call('', 'POST', { name: 'Custom', css: 'a{}' })).json()
    expect(await (await call('/active', 'PUT', { id: made.id })).json()).toMatchObject({ active: 'Custom' })
    writeFileSync(join(root, 'Skins', made.id, 'skin.js'), 'export const test = 1')
    expect(await (await fetch(origin + '/wizard/v1/my-skin/script')).text()).toBe('export const test = 1')
    expect(await (await fetch(origin + '/wizard/v1/my-skin')).text()).toBe('a{}')
    net.events.push(event)
    expect((await (await call('/store?refresh=1')).json()).items).toHaveLength(1)
    const blob = await call('/store/blob/' + sha256(CSS))
    expect(blob.headers.get('content-type')).toBe('text/css'); expect(blob.headers.get('cache-control')).toContain('immutable'); expect(await blob.text()).toBe(CSS.toString())
    expect((await (await call('/store/add', 'POST', { a: addressOf(event) })).json()).id).toBe('Golden')
    expect(await (await call('/store/report', 'POST', { a: addressOf(event), reason: 'Synthetic report' })).json()).toEqual({ ok: true })
    const pack = await (await call('/Golden/pack', 'POST', {})).json()
    const published = await call('/Golden/publish', 'POST', { event: sign(pack.unsigned, OTHER) })
    expect(published.status).toBe(200); expect((await published.json()).event_id).toBeTruthy()
    expect(await (await call('/active', 'PUT', { id: null })).json()).toMatchObject({ active: null })
    expect(await (await fetch(origin + '/wizard/v1/my-skin')).text()).toBe('')
    expect((await fetch(origin + '/wizard/v1/my-skin/script')).status).toBe(404)
  })
  it('owner-only, same-origin, JSON/body/method checks are enforced before side effects', async () => {
    const net = await network(), proof = 'synthetic-owner-proof-for-skins-tests', { call } = await api(net, { ownerProof: proof })
    expect((await call('')).status).toBe(403)
    expect((await call('', 'GET', undefined, { 'X-Wizard-Owner-Proof': proof })).status).toBe(200)
    for (const headers of [{ Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
      expect((await call('', 'POST', { name: 'Never' }, { ...headers, 'X-Wizard-Owner-Proof': proof })).status).toBe(403)
    }
    expect((await call('', 'POST', { name: 'Nope' }, { 'X-Wizard-Owner-Proof': proof, 'Content-Type': 'text/plain' })).status).toBe(415)
    expect((await call('', 'DELETE', undefined, { 'X-Wizard-Owner-Proof': proof })).status).toBe(405)
    expect((await call('', 'POST', [], { 'X-Wizard-Owner-Proof': proof })).status).toBe(400)
    expect(net.published).toEqual([])
  })
})
