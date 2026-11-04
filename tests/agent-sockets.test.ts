import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentSocketPath, createAgentSocketGateway } from '../server/agent-sockets.mjs'
import { createAgentIngress } from '../server/service.mjs'
import { createPrincipalResolver } from '../server/principals.mjs'

const cleanups: (() => unknown)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'as-'))
  for (const id of ['one', 'two']) mkdirSync(join(root, id))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const resolver = createPrincipalResolver({ agentForToken: (t: string) => t === 'token-one' ? 'one' : t === 'token-two' ? 'two' : '', agentRestricted: () => true, ownerProof: 'proof-0123456789abcdef0123456789abcdef' })
  const service = createServer(async (req, res) => { res.end(JSON.stringify(await resolver.resolve(req))) })
  const sockets = createAgentSocketGateway({ agentsDir: root, ingress: (id: string) => createAgentIngress(service, id) })
  cleanups.push(() => sockets.close())
  return { root, service, sockets }
}
function call(path: string, token = '', extra = {}) {
  return new Promise<any>((resolve, reject) => {
    const req = request({ socketPath: path, path: '/wizard/v1/agent-context', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra } }, res => {
      let data = ''; res.on('data', c => { data += c }); res.on('end', () => resolve(JSON.parse(data)))
    })
    req.on('error', reject); req.end()
  })
}

describe('per-agent socket gateway', () => {
  it('refuses the retired TCP listener configuration before starting the Service', () => {
    const child = spawnSync(process.execPath, ['server/index.mjs'], { env: { ...process.env, WIZARD_AGENT_PORT: '8929' }, encoding: 'utf8' })
    expect(child.status).toBe(1)
    expect(child.stderr).toContain('WIZARD_AGENT_PORT/HOST are retired')
  })
  it('binds identity to receiving socket as well as token, never HTTP headers or owner proof', async () => {
    const { sockets } = fixture()
    const one = await sockets.ensure('one'), two = await sockets.ensure('two')
    expect(await call(one.path, 'token-one')).toEqual({ kind: 'agent', agentId: 'one' })
    expect(await call(two.path, 'token-two')).toEqual({ kind: 'agent', agentId: 'two' })
    expect((await call(one.path, 'token-two', { 'X-Wizard-Agent': 'two', 'X-Forwarded-For': '127.0.0.1', 'X-Wizard-Owner-Proof': 'proof' })).check).toBe('principal.agent_socket')
    expect((await call(two.path, 'token-one')).check).toBe('principal.agent_socket')
    expect((await call(one.path, '', { 'X-Wizard-Owner-Proof': 'proof' })).kind).toBe('refused')
  })
  it('creates private directory and socket and coalesces concurrent lifecycle calls', async () => {
    const { root, sockets } = fixture()
    const [a, b] = await Promise.all([sockets.ensure('one'), sockets.ensure('one')])
    expect(a).toBe(b)
    expect(lstatSync(join(root, 'one', 'gateway')).mode & 0o777).toBe(0o700)
    expect(lstatSync(a.path).mode & 0o777).toBe(0o600)
    expect(lstatSync(a.path).uid).toBe(process.getuid!())
  })
  it('rebinds after owner undo deletes an imported directory, coalescing retries', async () => {
    const { root, sockets } = fixture()
    const first = await sockets.ensure('one')
    rmSync(join(root, 'one'), { recursive: true })
    mkdirSync(join(root, 'one'))
    const [a, b] = await Promise.all([sockets.ensure('one'), sockets.ensure('one')])
    expect(a).toBe(b)
    expect(a.server).not.toBe(first.server)
    expect((await call(a.path, 'token-one')).agentId).toBe('one')
  })
  it('uses a stable directory across shutdown and restart (no pinned socket inode mount)', async () => {
    const { root, sockets, service } = fixture()
    const first = await sockets.ensure('one'), dirInode = lstatSync(join(root, 'one', 'gateway')).ino
    await sockets.close()
    expect(existsSync(first.path)).toBe(false)
    const next = createAgentSocketGateway({ agentsDir: root, ingress: (id: string) => createAgentIngress(service, id) })
    cleanups.push(() => next.close())
    expect(await call((await next.ensure('one')).path, 'token-one')).toEqual({ kind: 'agent', agentId: 'one' })
    expect(lstatSync(join(root, 'one', 'gateway')).ino).toBe(dirInode)
  })
  it('refuses symlink directories and non-socket files without modifying their targets', async () => {
    const { root, sockets } = fixture()
    symlinkSync(join(root, 'two'), join(root, 'one', 'gateway'))
    await expect(sockets.ensure('one')).rejects.toThrow('agent_socket_directory_unsafe')
    mkdirSync(join(root, 'two', 'gateway'))
    const path = agentSocketPath(root, 'two'); writeFileSync(path, 'keep')
    await expect(sockets.ensure('two')).rejects.toThrow('agent_socket_not_socket')
    expect(lstatSync(path).isFile()).toBe(true)
  })
  it('never unlinks a live socket from another instance', async () => {
    const { root, sockets, service } = fixture()
    const one = await sockets.ensure('one')
    const next = createAgentSocketGateway({ agentsDir: root, ingress: (id: string) => createAgentIngress(service, id) })
    cleanups.push(() => next.close())
    await expect(next.ensure('one')).rejects.toThrow('agent_socket_in_use')
    expect((await call(one.path, 'token-one')).agentId).toBe('one')
  })
  it('recovers a stale socket after process death', async () => {
    const { root, sockets } = fixture()
    mkdirSync(join(root, 'one', 'gateway'))
    const path = agentSocketPath(root, 'one')
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', "import net from 'node:net'; net.createServer().listen(process.argv[1], () => process.exit(0))", path])
    expect(child.status).toBe(0)
    expect(lstatSync(path).isSocket()).toBe(true)
    expect((await call((await sockets.ensure('one')).path, 'token-one')).agentId).toBe('one')
  })
  it('refuses unsafe identifiers, overlong paths and starts after shutdown', async () => {
    const { root, sockets, service } = fixture()
    await expect(sockets.ensure('../two')).rejects.toThrow('agent_socket_invalid_id')
    const long = createAgentSocketGateway({ agentsDir: join(root, 'a'.repeat(104)), ingress: (id: string) => createAgentIngress(service, id) })
    await expect(long.ensure('one')).rejects.toThrow('agent_socket_path_too_long')
    await sockets.close()
    await expect(sockets.ensure('one')).rejects.toThrow('agent_socket_closing')
  })
})
