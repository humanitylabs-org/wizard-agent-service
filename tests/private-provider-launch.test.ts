import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { agentVisionHelper, createAgentRegistry, hermesConfigYaml, parseAgentFile } from '../server/agents.mjs'

const roots: string[] = []
const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise(r => s.close(r)) }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
async function box({ installed = true, healthy = true, identity = { uid: 1234, gid: 1235 } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pp-')); roots.push(root)
  const calls: string[] = []
  const provider = createServer((_req, res) => { res.writeHead(healthy ? 200 : 503); res.end(JSON.stringify({ status: 'connected', models: [{ id: 'glm-5-3' }, { id: 'deepseek-v4-1-flash' }] })) })
  servers.push(provider)
  await new Promise<void>(r => provider.listen(0, '127.0.0.1', r))
  const appsJsonPath = join(root, 'apps.json')
  const apps = [{ id: 'wizard-tinfoil', status: 'running', view: { local: `http://127.0.0.1:${(provider.address() as any).port}` }, private_inference: { kind: 'attested-relay', relay_port: 8090 } }]
  const save = () => writeFileSync(appsJsonPath, JSON.stringify({ apps: installed ? apps : [] }))
  save()
  const dir = join(root, 'agents', 'private'); mkdirSync(join(dir, 'home'), { recursive: true })
  const agent = { schema: 1, id: 'private', label: 'Private', harness: 'hermes', privacy: 'private', model: { provider: 'tinfoil', model: 'glm-5-3', allowed_models: ['glm-5-3', 'deepseek-v4-1-flash'], fallback: false }, permissions: { preset: 'private', outside_tools: [], files: 'own', wizard_apps: [], agent_apps: [], other_agents: 'none' }, runtime: { kind: 'container', app_id: 'agent-private', port: 18650 }, created_at: 1 }
  const file = join(dir, 'agent.json'); writeFileSync(file, JSON.stringify(agent))
  writeFileSync(join(dir, 'home', 'history.db'), 'synthetic-history')
  const registry = createAgentRegistry({ agentsDir: join(root, 'agents'), appsJsonPath,
    runtime: { identity: async () => { calls.push('identity'); return identity }, apply: async () => { calls.push('apply') }, start: async () => { calls.push('start') } },
    fetchImpl: async (url: any, init: any) => String(url).includes('/api/connection') ? fetch(url, init) : new Response('{}'),
  })
  return { root, dir, file, apps, save, registry, calls, uninstall: () => { installed = false; save() } }
}
it.each([false, true])('legacy start with installed=%s never migrates or queries identity', async installed => {
  const f = await box({ installed })
  await f.registry.setRunning('private', true)
  const record = JSON.parse(readFileSync(f.file, 'utf8'))
  expect(record.model.provider).toBe('tinfoil')
  expect(record.runtime.private_client).toBeUndefined()
  expect(f.calls).not.toContain('identity')
  expect(hermesConfigYaml(f.registry.read('private'))).toContain('agent-private-tinfoil:3301/v1')
})
it('explicit healthy installed-provider migration preserves identity/history and removal closes admission and status', async () => {
  const f = await box()
  await f.registry.update('private', { migrate_private_provider: true })
  const agent = f.registry.read('private')
  expect(agent.runtime).toMatchObject({ private_client: true, isolation: 'restricted', uid: 1234, gid: 1235 })
  expect(agent.model.provider).toBe('wizard-tinfoil')
  expect(f.calls).toEqual(['identity', 'apply'])
  expect(readFileSync(join(f.dir, 'home/history.db'), 'utf8')).toBe('synthetic-history')
  const config = readFileSync(join(f.dir, 'managed/config.yaml'), 'utf8')
  expect(config).toContain('agent-private-client:3301/v1')
  expect(config).not.toContain('TINFOIL_API_KEY')
  f.uninstall()
  const before = [...f.calls]
  await expect(f.registry.setRunning('private', true)).rejects.toMatchObject({ status: 503, error: 'private_provider_unavailable' })
  await expect(f.registry.assertProviderAvailable(agent)).rejects.toMatchObject({ status: 503, error: 'private_provider_unavailable' })
  expect(await f.registry.status(agent, { fresh: true })).toEqual({ status: 'error', status_detail: 'private_provider_unavailable' })
  expect(f.calls).toEqual(before)
  expect(JSON.parse(readFileSync(f.file, 'utf8')).runtime.private_client).toBe(true)
})
it.each([{ installed: false }, { healthy: false }])('migration without installed healthy capability leaves record and home untouched: %j', async options => {
  const f = await box(options)
  const before = readFileSync(f.file, 'utf8')
  await expect(f.registry.update('private', { migrate_private_provider: true })).rejects.toMatchObject({ error: 'private_provider_unavailable' })
  expect(readFileSync(f.file, 'utf8')).toBe(before)
  expect(f.calls).toEqual([])
  expect(readFileSync(join(f.dir, 'home/history.db'), 'utf8')).toBe('synthetic-history')
})
it('capability is required, not just a matching installed app ID', async () => {
  const f = await box(); delete (f.apps[0] as any).private_inference; f.save()
  await expect(f.registry.update('private', { migrate_private_provider: true })).rejects.toMatchObject({ error: 'private_provider_unavailable' })
  expect(f.calls).toEqual([])
})
it.each([false, true])('vision helper stays on the agent own route, migrated=%s', async migrated => {
  const f = await box()
  if (migrated) await f.registry.update('private', { migrate_private_provider: true })
  const agent = f.registry.read('private'), config = hermesConfigYaml(agent)
  expect(agentVisionHelper(agent)).toBe('deepseek-v4-1-flash')
  expect(config).toContain('auxiliary:\n  vision:\n    provider: custom\n    model: "deepseek-v4-1-flash"')
  expect(config.match(/base_url: .*/g)).toEqual(Array(2).fill(`base_url: "http://agent-private-${migrated ? 'client' : 'tinfoil'}:3301/v1"`))
  if (migrated) expect(config).not.toMatch(/TINFOIL_API_KEY|key_env:/)
  else expect(config).toContain('key_env: TINFOIL_API_KEY')
})
it('unknown legacy IDs remain readable, listable and admitted without implicit migration', async () => {
  const f = await box({ installed: false })
  const raw = JSON.parse(readFileSync(f.file, 'utf8')); raw.model.provider = 'unknown-vendor'; writeFileSync(f.file, JSON.stringify(raw))
  expect(parseAgentFile(raw, 'private')?.model.provider).toBe('unknown-vendor')
  expect(f.registry.list().some((a: any) => a.id === 'private')).toBe(true)
  await expect(f.registry.assertProviderAvailable(f.registry.read('private'))).resolves.toBeUndefined()
})
