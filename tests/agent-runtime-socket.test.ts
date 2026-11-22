// Issue 582: the Service reaches the host runtime helper over a Unix socket (WIZARD_AGENT_RUNTIME_URL=unix:<path>),
// because a standard install's Service runs in Runtipi's network and can't reach the host's loopback.
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntimeClient } from '../server/agents.mjs'

const dirs: string[] = []
const closers: Array<() => void> = []
afterEach(() => { for (const c of closers.splice(0)) c(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'rt-sock-')); dirs.push(d); return d }

describe('runtime client over a Unix socket (issue 582)', () => {
  it('sends the token, JSON and streamed bodies over the socket and maps refusals to codes', async () => {
    const dir = scratch()
    const sock = join(dir, 'runtime.sock')
    const seen: any[] = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() })
        if (req.url === '/agents/bad/start') { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end('{"error":"agent_not_prepared"}'); return }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, url: req.url }))
      })
    })
    await new Promise<void>((r) => server.listen(sock, r))
    closers.push(() => server.close())
    const client = createRuntimeClient({ url: `unix:${sock}`, token: 't'.repeat(32) })
    expect(await client.apply('private')).toEqual({ ok: true, url: '/agents/private/apply' })
    expect(seen[0]).toMatchObject({ method: 'POST', auth: `Bearer ${'t'.repeat(32)}`, body: '{}' })
    await expect(client.start('bad')).rejects.toMatchObject({ code: 'agent_not_prepared' })
    const file = join(dir, 'big.bin')
    writeFileSync(file, 'x'.repeat(200_000))
    expect(await client.placeStream('private', { filename: 'big.bin', sha256: 'a'.repeat(64), bytes: 200_000, open: () => createReadStream(file) })).toMatchObject({ ok: true })
    expect(seen.at(-1).body.length).toBe(200_000)
  })

  it('a missing socket is runtime_unreachable, and only absolute socket paths are taken', async () => {
    const client = createRuntimeClient({ url: `unix:${join(scratch(), 'none.sock')}`, token: 't'.repeat(32) })
    await expect(client.apply('private')).rejects.toMatchObject({ code: 'runtime_unreachable' })
    expect(() => createRuntimeClient({ url: 'unix:relative.sock', token: 'x' })).toThrow()
    expect(() => createRuntimeClient({ url: 'unix:/run/../etc/x.sock', token: 'x' })).toThrow()
  })

  it('talks to the real helper started with --socket', async () => {
    const dir = scratch()
    const sock = join(dir, 'runtime.sock')
    writeFileSync(join(dir, 'token'), 'r'.repeat(32))
    const py = spawn('python3', ['ops/agent-runtime/agent_runtime.py', '--driver', 'compose', '--agents-dir', dir, '--token-file', join(dir, 'token'), '--socket', sock], { stdio: ['ignore', 'ignore', 'pipe'] })
    closers.push(() => py.kill('SIGTERM'))
    let err = ''
    py.stderr.on('data', (c) => { err += c })
    for (let i = 0; i < 100 && !err.includes('driver on unix:'); i++) await new Promise((r) => setTimeout(r, 50))
    expect(err).toContain(`driver on unix:${sock}`)
    const client = createRuntimeClient({ url: `unix:${sock}`, token: 'r'.repeat(32) })
    // No such agent: the helper's own refusal comes back through the socket.
    await expect(client.apply('nobody')).rejects.toMatchObject({ code: 'agent_not_found' })
    const wrong = createRuntimeClient({ url: `unix:${sock}`, token: 'w'.repeat(32) })
    await expect(wrong.apply('nobody')).rejects.toMatchObject({ code: expect.stringMatching(/unauthorized|runtime_http_401/u) })
  }, 20_000)
})
