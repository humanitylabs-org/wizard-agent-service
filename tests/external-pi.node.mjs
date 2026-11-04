import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAgentRegistry, parseAgentFile } from '../server/agents.mjs'

const fixture = () => ({ schema: 1, id: 'pi', label: 'Pi', harness: 'pi', privacy: 'standard',
  appearance: { glyph: 'spark', hue: 45 },
  model: { provider: 'openai-codex', model: 'gpt-6.1-sol', allowed_models: ['gpt-6.1-sol'], fallback: false },
  permissions: { preset: 'standard', outside_tools: [], files: 'none', wizard_apps: [], agent_apps: [],
    other_agents: 'none', shared_with_agents: false },
  runtime: { kind: 'external', port: 18659 }, created_at: 123 })

function box() {
  const dir = mkdtempSync(join(tmpdir(), 'external-pi-'))
  const folder = join(dir, 'agents', 'pi'); mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'agent.json'), JSON.stringify(fixture()))
  writeFileSync(join(folder, 'runtime.key'), 'pi-fixture-key', { mode: 0o600 })
  return { dir, folder }
}

test('Pi accepts only reply-only standard external records with bounded loopback ports', () => {
  assert.equal(parseAgentFile(fixture(), 'pi').harness, 'pi')
  for (const port of [0, -1, 80, 65536, '18659', NaN]) {
    assert.equal(parseAgentFile({ ...fixture(), runtime: { kind: 'external', port } }, 'pi'), null)
  }
  for (const kind of ['container','profile']) assert.equal(parseAgentFile({ ...fixture(), runtime: { kind, port: 18659, app_id: 'agent-pi', profile: 'pi' } }, 'pi'), null)
  assert.equal(parseAgentFile({ ...fixture(), privacy: 'private' }, 'pi'), null)
  assert.equal(parseAgentFile({ ...fixture(), harness: 'hermes' }, 'pi'), null)
})

test('The main external Hermes retains Service-owned settings while Pi remains read-only', async () => {
  const b = box()
  try {
    const registry = createAgentRegistry({ agentsDir: join(b.dir, 'agents') })
    const main = registry.read('hermes')
    assert.equal(main.harness, 'hermes')
    assert.equal(main.runtime.kind, 'external')
    assert.equal((await registry.update('hermes', { hidden: true })).hidden, true)
    assert.notEqual((await registry.update('hermes', { hidden: false })).hidden, true)
    await assert.rejects(registry.update('hermes', { label: 'Changed' }), e => e.status === 409 && e.check === 'agent.main')
    await assert.rejects(registry.update('pi', { hidden: true }), e => e.status === 409 && e.error === 'external_agent_read_only')
  } finally { rmSync(b.dir, { recursive: true }) }
})

test('External origins are fixed loopback even with container-network mode; dedicated health auth', async () => {
  const b = box(); const seen = []
  try {
    for (const upstreamMode of ['host','network']) {
      const registry = createAgentRegistry({ agentsDir: join(b.dir, 'agents'), upstreamMode,
        upstreamHost: 'untrusted-host', fetchImpl: async (url, init) => {
          seen.push({ url, auth: new Headers(init.headers).get('authorization') }); return new Response('{}')
        } })
      const a = registry.read('pi')
      assert.equal(registry.upstream(a), 'http://127.0.0.1:18659')
      assert.equal((await registry.status(a)).status, 'running')
      assert.equal(registry.stateHome('pi'), '')
    }
    assert.deepEqual(seen, Array(2).fill({ url: 'http://127.0.0.1:18659/health', auth: 'Bearer pi-fixture-key' }))
  } finally { rmSync(b.dir, { recursive: true }) }
})

test('External lifecycle, config, auto-upgrade and app sync never invoke Hermes driver or write a home', async () => {
  const b = box(); const calls = []
  try {
    const apps = join(b.dir, 'apps.json'); writeFileSync(apps, JSON.stringify({ apps: [] }))
    const registry = createAgentRegistry({ agentsDir: join(b.dir, 'agents'), appsJsonPath: apps,
      runtime: Object.fromEntries(['apply','start','stop'].map(k => [k, async () => calls.push(k)])) })
    registry.list(); const before = readFileSync(join(b.folder, 'agent.json'), 'utf8')
    await assert.rejects(registry.setRunning('pi', true), e => e.status === 409 && e.error === 'external_agent_read_only')
    await assert.rejects(registry.setRunning('pi', false), e => e.status === 409 && e.error === 'external_agent_read_only')
    await assert.rejects(registry.update('pi', { label: 'Changed' }), e => e.status === 409 && e.error === 'external_agent_read_only')
    await assert.rejects(registry.create(fixture()), e => e.status === 400)
    writeFileSync(apps, JSON.stringify({ apps: [{ id: 'new-app', name: 'New', view: '/app/' }] }))
    registry.list(); await registry.migrateManagedHarnesses()
    assert.equal(registry.appAgents('new-app').agents.some(a => a.id === 'pi'), false)
    await assert.rejects(registry.setAppAgents('new-app', { agents: ['hermes', 'pi'] }), e => e.status === 404 && e.error === 'agent_not_found')
    assert.equal(registry.appAgents('new-app').agents.find(a => a.id === 'hermes').enabled, false)
    assert.equal(readFileSync(join(b.folder, 'agent.json'), 'utf8'), before)
    assert.deepEqual(calls, []); assert.equal(existsSync(join(b.folder, 'home')), false)
    assert.equal(existsSync(join(b.folder, 'service-state.json')), false)
  } finally { rmSync(b.dir, { recursive: true }) }
})
