import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createAgentRegistry, publicAgent } from '../server/agents.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function fixture(identity = { uid: 1000, gid: 1000 }) {
  const root = mkdtempSync(join(tmpdir(), 'legacy-migration-')); roots.push(root)
  const agentsDir = join(root, 'agents'), appsJsonPath = join(root, 'apps.json')
  writeFileSync(appsJsonPath, JSON.stringify({ apps: [{ id: 'wizard-tinfoil', status: 'running', view: { local: 'http://127.0.0.1:1' }, private_inference: { kind: 'attested-relay', relay_port: 8090 } }] }))
  const calls: string[] = []
  const runtime = { scrubPrivateMigration: async () => { calls.push('scrub') }, identity: async () => { calls.push('identity'); return identity }, apply: async () => { calls.push('apply') }, start: async () => { calls.push('start') } }
  const registry = createAgentRegistry({ agentsDir, appsJsonPath, runtime, fetchImpl: async () => new Response(JSON.stringify({ status: 'connected', models: [{ id: 'gpt-oss-120b' }] })) })
  const { agent } = await registry.create({ label: 'Legacy', harness: 'hermes', model: { provider: 'wizard-tinfoil', model: 'gpt-oss-120b' }, permissions: { preset: 'private' } })
  expect(agent.runtime).toMatchObject({ isolation: 'restricted', uid: 10000, gid: 10000 })
  const dir = join(agentsDir, agent.id), file = join(dir, 'agent.json')
  const old = JSON.parse(readFileSync(file, 'utf8'))
  old.model.provider = 'tinfoil'; old.permissions.read_standard_chats = false
  for (const key of ['isolation', 'uid', 'gid', 'private_client', 'network']) delete old.runtime[key]
  writeFileSync(file, JSON.stringify(old)); rmSync(join(dir, 'managed'), { recursive: true })
  mkdirSync(join(dir, 'home'), { recursive: true })
  writeFileSync(join(dir, 'home', 'history.db'), 'synthetic-history-only')
  writeFileSync(join(dir, 'home', 'config.yaml'), 'legacy-config-untouched')
  calls.length = 0
  return { registry, calls, dir, file, old, appsJsonPath, runtime: runtime as any }
}
it.each(['explicit-patch'])('migrates legacy metadata via %s, writes managed files, preserves synthetic history and reruns idempotently', async (route) => {
  const { registry, calls, dir, file } = await fixture()
  const migrate = () => registry.update('legacy', { migrate_private_provider: true })
  await migrate()
  const first = JSON.parse(readFileSync(file, 'utf8'))
  expect(first.runtime).toMatchObject({ isolation: 'restricted', uid: 1000, gid: 1000, private_client: true })
  expect(first.model.provider).toBe('wizard-tinfoil')
  expect(publicAgent(first).runtime).toEqual({ isolation: 'restricted', uid: 1000, gid: 1000 })
  expect(existsSync(join(dir, 'managed/config.yaml'))).toBe(true)
  expect(readFileSync(join(dir, 'home/config.yaml'), 'utf8')).toBe('legacy-config-untouched')
  expect(readFileSync(join(dir, 'home/history.db'), 'utf8')).toBe('synthetic-history-only')
  const key = readFileSync(join(dir, 'runtime.key'), 'utf8')
  await migrate()
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(first)
  expect(readFileSync(join(dir, 'runtime.key'), 'utf8')).toBe(key)
  expect(calls.filter((v) => v === 'identity')).toHaveLength(1)
  expect(calls.filter((v) => v === 'scrub')).toHaveLength(1)
})
it('does not publish the seal or private config if stopped-home retirement fails', async () => {
  const { registry, runtime, dir, file, old } = await fixture()
  runtime.scrubPrivateMigration = async () => { throw new Error('synthetic scrub failure') }
  await expect(registry.update('legacy', { migrate_private_provider: true })).rejects.toThrow('synthetic scrub failure')
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(old)
  expect(existsSync(join(dir, 'managed'))).toBe(false)
})
it.each([{ uid: 0, gid: 1000 }, { uid: 1000, gid: 0 }, { uid: undefined, gid: undefined }])('refuses unsafe identity %j without publishing a migration or touching home', async (identity) => {
  const { registry, calls, dir, file, old } = await fixture(identity as any)
  await expect(registry.update('legacy', { migrate_private_provider: true })).rejects.toMatchObject({ error: 'agent_identity_invalid' })
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(old)
  expect(calls).toEqual(['identity'])
  expect(existsSync(join(dir, 'managed'))).toBe(false)
  expect(readFileSync(join(dir, 'home/config.yaml'), 'utf8')).toBe('legacy-config-untouched')
})
it('only matching owner rollback restores original confidential route after seal, retaining history and permissions', async () => {
  const { registry, runtime, calls, dir, file, old } = await fixture()
  const attempt = 'a'.repeat(32)
  runtime.unmigratePrivateProvider = async (_id: string, body: any) => { calls.push(body.phase) }
  await registry.update('legacy', { migrate_private_provider: true, private_migration_attempt: attempt })
  await expect(registry.update('legacy', { restore_private_provider: 'b'.repeat(32) })).rejects.toMatchObject({ error: 'private_restore_scope_mismatch' })
  await expect(registry.update('legacy', { restore_private_provider: attempt, privacy: 'standard' })).rejects.toMatchObject({ error: 'invalid_migration_attempt' })
  await registry.update('legacy', { restore_private_provider: attempt })
  const restored = JSON.parse(readFileSync(file, 'utf8'))
  expect(restored.model).toEqual(old.model)
  expect(restored.privacy).toBe('private')
  expect(restored.permissions).toEqual(old.permissions)
  expect(restored.runtime.private_client).toBeUndefined()
  expect(restored.runtime.private_restore_attempt).toBe(attempt)
  expect(calls.slice(-2)).toEqual(['prepare', 'commit'])
  expect(readFileSync(join(dir, 'home/history.db'), 'utf8')).toBe('synthetic-history-only')
})
it('leaves sealed metadata and harness intact when runtime refuses host-source rollback', async () => {
  const { registry, runtime, file } = await fixture()
  const attempt = 'c'.repeat(32)
  await registry.update('legacy', { migrate_private_provider: true, private_migration_attempt: attempt })
  const before = readFileSync(file, 'utf8')
  runtime.unmigratePrivateProvider = async () => { throw new Error('host-source-unavailable') }
  await expect(registry.update('legacy', { restore_private_provider: attempt })).rejects.toThrow('host-source-unavailable')
  expect(readFileSync(file, 'utf8')).toBe(before)
})
