import { heavyRoot } from './support/heavy-root'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { heavyHostConfigs } from '../server/heavy-hosts.mjs'
import { DurableHeavyQueue, heavyHostTransport, heavyRpcTransport } from '../server/heavy-queue.mjs'
import { createHeavyRpcServer } from '../server/heavy-rpc-server.mjs'

const cleanup: (() => any)[] = []
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0; vi.unstubAllEnvs() })
const spec = { cwd: heavyRoot, argv: ['true'], timeout_seconds: 10 }
function queue(transport: any) {
  vi.stubEnv('WIZARD_BUILD_HOSTS', 'thales,forum')
  vi.stubEnv('WIZARD_HEAVY_FORUM_ROOT', '/srv/work')
  const root = mkdtempSync(join(heavyRoot, 'hosts-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const options = { statePath: join(root, 'queue.db'), transport, current: async () => false, continuation: async () => ({}) }
  const q = new DurableHeavyQueue(options)
  cleanup.push(() => q.close())
  return { q, options }
}
const submit = (q: any, s: any = spec, key = 'k') => q.submit({ sessionId: 's', origin: 'o', key, spec: s })
const forum = { ...spec, cwd: '/srv/work/project', host: 'forum' }

it('keeps legacy configuration and default command bytes; explicit thales replays the same key', async () => {
  const rpc = vi.fn(async (p: any) => ({ job_id: p.job_id, state: 'queued' }))
  const { q } = queue(rpc)
  const first = submit(q)
  expect(first.host).toBe('thales')
  expect(first.spec).toEqual(spec)
  expect(submit(q, { ...spec, host: 'thales' }).job_id).toBe(first.job_id)
  // Pre-upgrade rows have no host. No migration or rehash is needed.
  const { host, ...old } = first; q.save(old)
  await q.tick()
  expect(rpc).toHaveBeenCalledExactlyOnceWith({ action: 'submit', job_id: first.job_id, spec })
  const config = heavyHostConfigs({ WIZARD_BUILD_HOST: 'old-ssh', WIZARD_HEAVY_ROOT: '/old', WIZARD_HEAVY_REMOTE_ROOT: '/old/spool' })
  expect(Object.keys(config)).toEqual(['thales'])
  expect(config.thales).toMatchObject({ host: 'old-ssh', workRoot: '/old', root: '/old/spool', python: '/opt/homebrew/bin/python3' })
})

it('isolates forum root/python/settings from the single-host Mac settings', () => {
  const c = heavyHostConfigs({ WIZARD_BUILD_HOSTS: 'thales,forum', WIZARD_BUILD_HOST: 'mac', WIZARD_HEAVY_ROOT: '/mac',
    WIZARD_HEAVY_DOCKER_HOST: 'unix:///mac/docker.sock', WIZARD_HEAVY_REMOTE_PYTHON: '/mac/python',
    WIZARD_HEAVY_FORUM_ROOT: '/srv/work', WIZARD_HEAVY_FORUM_REMOTE_SCRIPT: '/srv/work/heavy/worker.py' })
  expect(c.forum).toMatchObject({ workerHost: 'forum', host: 'forum', workRoot: '/srv/work', python: '/usr/bin/python3', script: '/srv/work/heavy/worker.py' })
  expect(c.forum.lock).toBeUndefined()
  expect(c.forum.settings.WIZARD_HEAVY_DOCKER_HOST).toBeUndefined()
  expect(() => heavyHostConfigs({ WIZARD_BUILD_HOSTS: 'thales,unknown' })).toThrow('invalid heavy hosts')
})

it('routes forum submit/status/cancel through the loopback bridge, strips only the host envelope', async () => {
  const received: any[] = []
  const transport = heavyHostTransport({ thales: { host: 'mac' }, forum: { host: 'linux', workRoot: '/srv/work' } } as any,
    (config: any) => async (p: any) => { received.push([config.host, p]); return { job_id: p.job_id, state: 'queued' } })
  const token = 'fixture-multihost-token-00000000000000'
  const server = createHeavyRpcServer({ token, transport })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  cleanup.push(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()) }))
  const rpc = heavyRpcTransport({ origin: `http://127.0.0.1:${(server.address() as any).port}`, token })
  const { q, options } = queue(rpc)
  const job = submit(q, forum)
  await q.tick(); await q.close()
  const reopened = new DurableHeavyQueue(options); cleanup.push(() => reopened.close())
  expect(reopened.get(job.job_id).host).toBe('forum')
  await reopened.tick()
  reopened.cancel(job.job_id, 's'); await reopened.tick()
  expect(received.map(([host, p]) => [host, p.action])).toEqual([['linux', 'submit'], ['linux', 'status'], ['linux', 'status'], ['linux', 'cancel']])
  expect(received[0][1]).toEqual({ action: 'submit', job_id: job.job_id, spec: forum })
  expect(reopened.summary().hosts.forum.queued).toBe(1)
  expect(reopened.summary().hosts.thales.queued).toBe(0)
  expect(reopened.summary().max_active).toBe(1) // legacy field unchanged
})

it('rejects unknown/disabled hosts and wrong host roots without dispatch', () => {
  const rpc = vi.fn(); const { q } = queue(rpc)
  expect(() => submit(q, { ...spec, host: 'other' })).toThrow('invalid heavy host')
  expect(() => submit(q, { ...spec, cwd: '/mac-only/project', host: 'forum' })).toThrow('invalid heavy command')
  vi.stubEnv('WIZARD_BUILD_HOSTS', 'thales')
  expect(() => submit(q, forum)).toThrow('heavy lane not configured')
  expect(q.rows()).toEqual([]); expect(rpc).not.toHaveBeenCalled()
  expect(() => heavyHostTransport({ thales: {} } as any, () => rpc)({ host: 'forum' })).toThrow('not configured')
  expect(() => heavyHostTransport({ thales: {} } as any, () => rpc)({ host: 'other' })).toThrow('invalid heavy host')
})

it('never reroutes an unreachable host and still dispatches the other host in the same tick', async () => {
  const calls: any[] = []
  const transport = heavyHostTransport({ thales: { host: 'thales' }, forum: { host: 'forum', workRoot: '/srv/work' } } as any,
    (config: any) => async (p: any) => { calls.push([config.host, p]); if (config.host === 'forum') throw new Error('offline'); return { job_id: p.job_id, state: 'queued' } })
  const { q } = queue(transport)
  const offline = submit(q, forum)
  submit(q, forum, 'second-offline')
  const mac = submit(q, spec, 'mac')
  await q.tick(); await q.tick()
  expect(calls.filter(([host]) => host === 'forum').map(([, p]) => p.job_id)).toEqual([offline.job_id, offline.job_id])
  expect(calls.filter(([host]) => host === 'thales').map(([, p]) => p.job_id)).toEqual([mac.job_id, mac.job_id])
  expect(q.get(offline.job_id)).toMatchObject({ state: 'queued', reason: 'worker_unavailable', host: 'forum', remote_ack: false })
  expect(q.summary().hosts.forum.unavailable).toBe(true)
  expect(q.summary().hosts.thales.unavailable).toBe(false)
  expect(() => submit(q, { ...forum, host: 'thales', cwd: heavyRoot })).toThrow('idempotency conflict')
})
