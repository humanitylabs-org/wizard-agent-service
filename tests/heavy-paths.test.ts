import { heavyRoot } from './support/heavy-root'
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { DurableHeavyQueue, heavySshTransport } from '../server/heavy-queue.mjs'

vi.mock('node:child_process', () => ({ execFile: vi.fn((_file, _args, _options, callback) => {
  callback(null, '{"state":"queued"}')
  return { stdin: { on() {}, end() {} } }
}) }))
const queues: any[] = []
afterEach(async () => { for (const q of queues.splice(0)) await q.close(); vi.clearAllMocks(); vi.unstubAllEnvs() })
function queue() {
  const q = new DurableHeavyQueue({ statePath: join(heavyRoot, `queue-${queues.length}.sqlite`),
    transport: async () => ({}), current: async () => true, continuation: async () => ({}) })
  queues.push(q)
  return q
}
const submit = (q: any, cwd: string, key = 'fixture') => q.submit({ sessionId: 'fixture', origin: 'fixture', key,
  spec: { cwd, argv: ['true'], timeout_seconds: 1 } })

it('refuses an unconfigured heavy lane without dispatching anything', async () => {
  vi.stubEnv('WIZARD_HEAVY_ROOT', undefined); vi.stubEnv('WIZARD_WORK_ROOT', undefined)
  const q = queue()
  expect(() => submit(q, heavyRoot)).toThrow('heavy lane not configured: set WIZARD_HEAVY_ROOT')
  expect(q.rows()).toEqual([])
  const rpc = heavySshTransport({ host: 'build-fixture', script: '/worker.py', root: '/spool', lock: '/worker.lock' })
  await expect(rpc({ action: 'status' })).rejects.toThrow('heavy lane not configured: set WIZARD_HEAVY_ROOT')
  expect(execFile).not.toHaveBeenCalled()
})

it('falls back to the work root, honors explicit heavy root, and rejects traversal and prefix siblings', () => {
  vi.stubEnv('WIZARD_HEAVY_ROOT', undefined); vi.stubEnv('WIZARD_WORK_ROOT', heavyRoot)
  const q = queue()
  expect(submit(q, join(heavyRoot, 'project')).state).toBe('queued')
  for (const cwd of [heavyRoot + '-other/project', heavyRoot + '/../escape', 'relative/project'])
    expect(() => submit(q, cwd, 'bad')).toThrow('invalid heavy command')
  vi.stubEnv('WIZARD_HEAVY_ROOT', join(heavyRoot, 'dedicated'))
  expect(() => submit(q, join(heavyRoot, 'project'), 'outside')).toThrow('invalid heavy command')
  expect(submit(q, join(heavyRoot, 'dedicated/project'), 'inside').state).toBe('queued')
})

it('forwards only validated operator sandbox settings with shell-safe quoting', async () => {
  vi.stubEnv('WIZARD_HEAVY_ROOT', '/worker')
  vi.stubEnv('WIZARD_HEAVY_AGENT_IMAGE', 'python@sha256:' + 'a'.repeat(64))
  vi.stubEnv('WIZARD_HEAVY_DOCKER_BIN', "/opt/tool's dir/docker")
  vi.stubEnv('WIZARD_HEAVY_DOCKER_HOST', 'unix:///disk/colima/docker.sock')
  vi.stubEnv('WIZARD_HEAVY_RPC_TOKEN', 'fixture-never-forward')
  vi.stubEnv('DOCKER_HOST', 'tcp://never-forward:2375')
  const rpc = heavySshTransport({ host: 'build-fixture', script: '/worker.py', root: '/spool', lock: '/worker.lock' })
  await rpc({ action: 'status' })
  const cmd = (vi.mocked(execFile).mock.calls[0][1] as string[]).at(-1)!
  expect(cmd).toContain("'WIZARD_HEAVY_AGENT_IMAGE=python@sha256:" + 'a'.repeat(64) + "'")
  expect(cmd).toContain("'WIZARD_HEAVY_DOCKER_BIN=/opt/tool'\\''s dir/docker'")
  expect(cmd).toContain("'WIZARD_HEAVY_DOCKER_HOST=unix:///disk/colima/docker.sock'")
  expect(cmd).not.toContain('fixture-never-forward')
  expect(cmd).not.toContain('tcp://')
})

it.each([
  ['WIZARD_HEAVY_AGENT_IMAGE', 'image;id'],
  ['WIZARD_HEAVY_AGENT_IMAGE', ''],
  ['WIZARD_HEAVY_DOCKER_BIN', 'docker'],
  ['WIZARD_HEAVY_DOCKER_BIN', '/bin/../docker'],
  ['WIZARD_HEAVY_DOCKER_BIN', '/bin/docker\nBAD=1'],
  ['WIZARD_HEAVY_DOCKER_HOST', 'tcp://localhost:2375'],
  ['WIZARD_HEAVY_DOCKER_HOST', 'unix:///disk/../docker.sock'],
  ['WIZARD_HEAVY_DOCKER_HOST', 'unix:///disk/docker.sock\nBAD=1'],
])('refuses malformed %s before SSH', async (name, value) => {
  vi.stubEnv('WIZARD_HEAVY_ROOT', '/worker'); vi.stubEnv(name, value)
  const rpc = heavySshTransport({ host: 'build-fixture', script: '/worker.py', root: '/spool', lock: '/worker.lock' })
  await expect(rpc({ action: 'status' })).rejects.toThrow('invalid heavy worker setting: ' + name)
  expect(execFile).not.toHaveBeenCalled()
})

it('forwards configured Forum identity and leaves the default Thales SSH command byte-identical', async () => {
  const config = { host: 'fixture-worker', script: '/worker.py', root: '/spool', lock: '/worker.lock', workRoot: '/worker', python: 'python3' }
  await heavySshTransport(config)({ action: 'status' })
  const legacy = (vi.mocked(execFile).mock.calls[0][1] as string[]).at(-1)!
  expect(legacy).toBe("'env' 'WIZARD_HEAVY_ROOT=/worker' 'python3' '/worker.py' '--root' '/spool' '--lock' '/worker.lock'")
  await heavySshTransport({ ...config, workerHost: 'forum' })({ action: 'status' })
  const forum = (vi.mocked(execFile).mock.calls[1][1] as string[]).at(-1)!
  expect(forum).toBe(legacy.replace("'python3'", "'WIZARD_HEAVY_HOST=forum' 'python3'"))
  await expect(heavySshTransport({ ...config, workerHost: 'invalid' })({ action: 'status' })).rejects.toThrow('invalid heavy worker host')
  expect(execFile).toHaveBeenCalledTimes(2)
})

it('forwards the configured remote root over SSH with shell-safe quoting', async () => {
  vi.stubEnv('WIZARD_HEAVY_ROOT', "/worker/root with 'quote")
  const rpc = heavySshTransport({ host: 'build-fixture', script: '/worker.py', root: '/spool', lock: '/worker.lock', python: 'python3' })
  await rpc({ action: 'status' })
  const args = vi.mocked(execFile).mock.calls[0][1] as string[]
  expect(args.at(-2)).toBe('build-fixture')
  expect(args.at(-1)).toContain("'env' 'WIZARD_HEAVY_ROOT=/worker/root with '\\''quote'")
})
