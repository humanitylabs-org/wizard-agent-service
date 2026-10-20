import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { createAgentRegistry, hermesConfigYaml, isConfidentialProvider, migrateProvider, privateProviderApps, parseAgentFile } from '../server/agents.mjs'

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise(r => s.close(r)) } })
async function fixture() {
  let reachable = true
  const server = createServer((req, res) => {
    res.writeHead(reachable ? 200 : 503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(reachable ? { status: 'connected', models: [{ id: 'private-chat', label: 'Private Chat' }] } : { error: 'stopped' }))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  const dir = mkdtempSync(join(tmpdir(), 'private-provider-contract-'))
  const apps = [{ id: 'new-private-app', name: 'New provider', status: 'running', view: { local: origin }, private_inference: { kind: 'local', relay_port: 8090, egress: [] } }]
  const appsJsonPath = join(dir, 'apps.json')
  const save = () => writeFileSync(appsJsonPath, JSON.stringify({ apps }))
  save()
  const calls: string[] = []
  const registry = createAgentRegistry({ agentsDir: join(dir, 'agents'), appsJsonPath,
    runtime: { apply: async (id: string) => calls.push(`apply ${id}`), start: async (id: string) => calls.push(`start ${id}`), delete: async (id: string) => calls.push(`delete ${id}`) },
    mainProviders: async () => [{ slug: 'anthropic', authenticated: true, models: ['public-model'] }],
  })
  const create = () => registry.create({ label: 'Private', harness: 'hermes', model: { provider: apps[0].id, model: 'private-chat' }, permissions: { preset: 'private' } })
  return { dir, apps, save, registry, create, calls, unavailable: () => { reachable = false } }
}

it('derives confidential providers from installed private_inference, not ids', () => {
  const app = { id: 'unknown-vendor', private_inference: { kind: 'local' } }
  expect(privateProviderApps({ apps: [app, { id: 'wizard-tinfoil' }, { id: 'bad/id', private_inference: { kind: 'local' } }] })).toEqual([app])
  expect(isConfidentialProvider('unknown-vendor', [app])).toBe(true)
  expect(isConfidentialProvider('tinfoil')).toBe(false)
})
it('migrates legacy ids, preserving arbitrary app ids', () => {
  expect(migrateProvider('tinfoil')).toBe('wizard-tinfoil')
  expect(migrateProvider('local')).toBe('wizard-local-model')
  expect(migrateProvider('unknown-vendor')).toBe('unknown-vendor')
})
it('fetches models over real provider HTTP and emits no credential in Hermes config', async () => {
  const f = await fixture()
  expect(await f.registry.providers()).toContainEqual(expect.objectContaining({ id: 'new-private-app', confidential: true, kind: expect.stringMatching(/^(attested-relay|local)$/), available: true, models: [{ id: 'private-chat', label: 'Private Chat' }] }))
  const result = await f.create()
  const config = readFileSync(join(f.dir, 'agents', result.agent.id, 'home/config.yaml'), 'utf8')
  expect(config).toContain(`http://agent-${result.agent.id}-client:3301/v1`)
  expect(config).toContain('api_key: none')
  expect(config).toContain('fallback_providers: []')
  expect(config).not.toMatch(/TINFOIL_API_KEY|WIZARD_LOCAL_MODEL_KEY/)
  const record = JSON.parse(readFileSync(join(f.dir, 'agents', result.agent.id, 'agent.json'), 'utf8'))
  expect(record.runtime.private_client).toBe(true)
  expect(record.runtime.network.sandbox).toMatch(/^10\.251\./)
})
it('keeps stopped installed provider visible with an error; create cannot fall back', async () => {
  const f = await fixture()
  f.apps[0].status = 'stopped'; f.save()
  expect(await f.registry.providers()).toContainEqual(expect.objectContaining({ id: 'new-private-app', available: false, models: [], error: 'private_provider_unavailable' }))
  await expect(f.create()).rejects.toMatchObject({ status: 503, error: 'private_provider_unavailable' })
  expect(f.calls).toEqual([])
})
it('fails start and requests after HTTP failure or uninstall; never calls public runtime', async () => {
  const f = await fixture()
  const { agent } = await f.create()
  const before = [...f.calls]
  f.unavailable()
  await expect(f.registry.assertProviderAvailable(f.registry.read(agent.id))).rejects.toMatchObject({ status: 503 })
  await expect(f.registry.setRunning(agent.id, true)).rejects.toMatchObject({ status: 503 })
  f.apps.splice(0); f.save()
  await expect(f.registry.assertProviderAvailable(f.registry.read(agent.id))).rejects.toMatchObject({ error: 'private_provider_unavailable' })
  expect(f.calls).toEqual(before)
})
it('read-time legacy migration does not mutate disk, and start persists canonical app id', async () => {
  const f = await fixture()
  f.apps[0].id = 'wizard-local-model'; f.save()
  const { agent } = await f.create()
  const path = join(f.dir, 'agents', agent.id, 'agent.json')
  const legacy = JSON.parse(readFileSync(path, 'utf8')); legacy.model.provider = 'local'
  writeFileSync(path, JSON.stringify(legacy))
  expect(f.registry.read(agent.id).model.provider).toBe('wizard-local-model')
  expect(JSON.parse(readFileSync(path, 'utf8')).model.provider).toBe('local')
  await f.registry.setRunning(agent.id, true)
  expect(JSON.parse(readFileSync(path, 'utf8')).model.provider).toBe('wizard-local-model')
})
it('standard agents switching away revoke and stop their previous private client first', async () => {
  const f = await fixture()
  const { agent } = await f.registry.create({ label: 'Research', harness: 'hermes', model: { provider: f.apps[0].id, model: 'private-chat' }, permissions: { preset: 'standard' } })
  await f.registry.update(agent.id, { model: { provider: 'anthropic', model: 'public-model' } })
  expect(f.calls).toEqual([`apply ${agent.id}`, `delete ${agent.id}`, `apply ${agent.id}`])
  const stored = JSON.parse(readFileSync(join(f.dir, 'agents', agent.id, 'agent.json'), 'utf8'))
  expect(stored.runtime.private_client).toBeUndefined()
  expect(stored.model.provider).toBe('anthropic')
})
it('deletion asks runtime to revoke first and retains owner history', async () => {
  const f = await fixture()
  const { agent } = await f.create()
  await f.registry.remove(agent.id)
  expect(f.calls.at(-1)).toBe(`delete ${agent.id}`)
  expect(f.registry.read(agent.id)).toBeNull()
  expect(readFileSync(join(f.dir, 'agents', agent.id, 'home/config.yaml'), 'utf8')).toContain('api_key: none')
})
