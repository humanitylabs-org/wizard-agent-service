import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createAgentRegistry } from '../server/agents.mjs'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) }
})
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.clearAllMocks() })
it('parses each agent version once, isolates returned copies and invalidates on managed migration writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-json-cache-')); roots.push(root)
  const agentsDir = join(root, 'agents'), dir = join(agentsDir, 'legacy'), file = join(dir, 'agent.json'), appsJsonPath = join(root, 'apps.json')
  mkdirSync(agentsDir, { recursive: true })
  writeFileSync(appsJsonPath, JSON.stringify({ apps: [{ id: 'wizard-tinfoil', status: 'running', private_inference: { kind: 'attested-relay', relay_port: 8090 }, view: { local: 'http://127.0.0.1:1' } }] }))
  const registry = createAgentRegistry({ agentsDir, appsJsonPath, runtime: { identity: async () => ({ uid: 1000, gid: 1000 }), start: async () => ({ ok: true }) }, fetchImpl: async () => new Response(JSON.stringify({ status: 'connected', models: ['gpt-oss-120b'] })) })
  await registry.create({ label: 'Legacy', harness: 'hermes', model: { provider: 'wizard-tinfoil', model: 'gpt-oss-120b' }, permissions: { preset: 'private' } })
  const old = registry.read('legacy')!
  old.model.provider = 'tinfoil'
  for (const key of ['isolation', 'uid', 'gid', 'private_client', 'network']) delete old.runtime[key]
  writeFileSync(file, JSON.stringify(old))
  vi.mocked(readFileSync).mockClear()
  const first = registry.read('legacy')!
  first.label = 'not persisted'
  registry.read('legacy'); registry.list(); registry.read('legacy')
  expect(registry.read('legacy')!.label).toBe('Legacy')
  expect(vi.mocked(readFileSync).mock.calls.filter(args => args[0] === file)).toHaveLength(1)
  await registry.setRunning('legacy', true)
  const stamped = registry.read('legacy')!
  expect(stamped.model.provider).toBe('wizard-tinfoil')
  expect(stamped.runtime).toMatchObject({ isolation: 'restricted', uid: 1000, gid: 1000, private_client: true })
  expect(readFileSync(join(dir, 'managed/config.yaml'), 'utf8')).toContain('http://agent-legacy-client:3301/v1')
  expect(JSON.parse(readFileSync(file, 'utf8')).runtime).toMatchObject(stamped.runtime)
  const calls = vi.mocked(readFileSync).mock.calls.filter(args => args[0] === file).length
  registry.read('legacy'); registry.list()
  expect(vi.mocked(readFileSync).mock.calls.filter(args => args[0] === file)).toHaveLength(calls)
})
