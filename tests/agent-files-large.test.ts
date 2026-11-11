import { afterEach, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { placeAgentFiles, placementReason, AGENT_FILE_PLACE_LIMIT } from '../server/agent-files.mjs'
import { listen } from '../server/service.mjs'
import { createRuntimeClient } from '../server/agents.mjs'

// Issue 464: long recordings never reached container agents (25 MB inline cap) and the refusal said only
// "Durable copy unavailable".
const roots: string[] = [], servers: any[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise(r => s.close(r))))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const container = { id: 'philosopher', runtime: { kind: 'container' } }
function fileOf(bytes: Buffer, filename = 'Day 2 retreat.mp3') {
  const dir = mkdtempSync(join(tmpdir(), 'agent-files-large-')); roots.push(dir)
  const localPath = join(dir, 'blob'); writeFileSync(localPath, bytes)
  return { id: 'f1', filename, mime: 'audio/mpeg', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), localPath }
}
async function drain(stream: any) { const parts: Buffer[] = []; for await (const c of stream) parts.push(c); return Buffer.concat(parts) }

it('streams a file over the inline limit to the runtime instead of base64', async () => {
  const bytes = Buffer.alloc(3000, 7), streamed: any[] = [], inline: any[] = []
  const runtime = {
    place: async (id: string, p: any) => { inline.push(p); return { verified: true, path: '/opt/data/inbox/2026-11-11/x' } },
    placeStream: async (id: string, p: any) => { streamed.push({ id, ...p, data: await drain(p.open()) }); return { verified: true, path: '/opt/data/inbox/2026-11-11/abc-Day_2_retreat.mp3' } },
  }
  const [out]: any[] = await placeAgentFiles(container, [fileOf(bytes)], runtime, { inlineLimit: 1000 })
  expect(out.placement_error).toBeUndefined()
  expect(out.trusted_path).toBe('/opt/data/inbox/2026-11-11/abc-Day_2_retreat.mp3')
  expect(inline).toHaveLength(0)
  expect(streamed[0]).toMatchObject({ id: 'philosopher', filename: 'Day 2 retreat.mp3', bytes: 3000 })
  expect(streamed[0].data.equals(bytes)).toBe(true)
  // small files keep the old inline path (an older runtime helper still understands it)
  const [small]: any[] = await placeAgentFiles(container, [fileOf(Buffer.from('short clip'))], runtime, { inlineLimit: 1000 })
  expect(small.trusted_path).toBe('/opt/data/inbox/2026-11-11/x'); expect(inline).toHaveLength(1)
})

it('the default cap fits multi-hour recordings', () => {
  expect(AGENT_FILE_PLACE_LIMIT).toBeGreaterThanOrEqual(2 * 1024 * 1024 * 1024)
})

it('refusals name the size and the limit instead of "Durable copy unavailable"', async () => {
  const bytes = Buffer.alloc(3 * 1024 * 1024, 1)
  const [out]: any[] = await placeAgentFiles(container, [fileOf(bytes, 'talk.mp3')], { placeStream: async () => { throw new Error('never called') } }, { inlineLimit: 1000, limit: 2 * 1024 * 1024 })
  expect(out.trusted_path).toBeUndefined()
  expect(out.placement_error).toContain('talk.mp3 is 3 MB; the limit for files sent to an agent is 2 MB.')
  expect(out.placement_error).toContain('Tell the owner')
  expect(out.placement_error).not.toContain('Durable copy unavailable')
})

it('helper refusals become plain reasons and never leak helper text', async () => {
  const file = fileOf(Buffer.alloc(3000, 2))
  const fail = (code: string) => ({ placeStream: async () => { throw Object.assign(new Error('/srv/secret/host/path'), code ? { code } : {}) } })
  const [space]: any[] = await placeAgentFiles(container, [file], fail('insufficient_space'), { inlineLimit: 1000 })
  expect(space.placement_error).toContain('not enough free disk space')
  const [old]: any[] = await placeAgentFiles(container, [file], { place: async () => ({}) }, { inlineLimit: 1000 })
  expect(old.placement_error).toContain('not reachable or is out of date')
  const [other]: any[] = await placeAgentFiles(container, [file], fail(''), { inlineLimit: 1000 })
  expect(other.placement_error).toContain('could not be copied to this agent')
  for (const p of [space, old, other]) expect(p.placement_error).not.toContain('/srv/secret')
  expect(placementReason('changed', file)).toContain('changed after it was attached')
})

it('a host-profile agent gets large files without any copy or cap', async () => {
  const file = { ...fileOf(Buffer.alloc(3000, 3)), trusted_path: '/owner-files/talk.mp3' }
  const [out]: any[] = await placeAgentFiles({ id: 'p', runtime: { kind: 'profile' } }, [file], null, { inlineLimit: 10, limit: 100 })
  expect(out).toMatchObject({ trusted_path: '/owner-files/talk.mp3' }); expect(out.placement_error).toBeUndefined()
})

it('the runtime client streams raw bytes with name, hash and length headers', async () => {
  const seen: any[] = []
  const helper = createServer(async (req, res) => {
    const body = await drain(req); seen.push({ url: req.url, headers: req.headers, body })
    res.setHeader('Content-Type', 'application/json')
    if (seen.length > 1) { res.statusCode = 507; return res.end('{"error":"insufficient_space"}') }
    res.end('{"verified":true,"path":"/opt/data/inbox/2026-11-11/abc-retreat.mp3"}')
  }); servers.push(helper)
  const client = createRuntimeClient({ url: `http://127.0.0.1:${(await listen(helper)).port}`, token: 'tok' })
  const file = fileOf(Buffer.alloc(5000, 9), 'retreat é.mp3')
  const { createReadStream } = await import('node:fs')
  const reply = await client.placeStream('philosopher', { filename: file.filename, sha256: file.sha256, bytes: file.bytes, open: () => createReadStream(file.localPath) })
  expect(reply.verified).toBe(true)
  expect(seen[0].url).toBe('/agents/philosopher/place-stream')
  expect(seen[0].headers['content-length']).toBe('5000')
  expect(seen[0].headers['authorization']).toBe('Bearer tok')
  expect(decodeURIComponent(seen[0].headers['x-wizard-filename'])).toBe('retreat é.mp3')
  expect(seen[0].headers['x-wizard-sha256']).toBe(file.sha256)
  expect(seen[0].body.equals(Buffer.alloc(5000, 9))).toBe(true)
  await expect(client.placeStream('philosopher', { ...file, open: () => createReadStream(file.localPath) })).rejects.toMatchObject({ code: 'insufficient_space' })
})
