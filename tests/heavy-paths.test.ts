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
afterEach(async () => { for (const q of queues.splice(0)) await q.close(); vi.clearAllMocks() })
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

it('forwards the configured remote root over SSH with shell-safe quoting', async () => {
  vi.stubEnv('WIZARD_HEAVY_ROOT', "/worker/root with 'quote")
  const rpc = heavySshTransport({ host: 'build-fixture', script: '/worker.py', root: '/spool', lock: '/worker.lock', python: 'python3' })
  await rpc({ action: 'status' })
  const args = vi.mocked(execFile).mock.calls[0][1] as string[]
  expect(args.at(-2)).toBe('build-fixture')
  expect(args.at(-1)).toContain("'env' 'WIZARD_HEAVY_ROOT=/worker/root with '\\''quote'")
})
