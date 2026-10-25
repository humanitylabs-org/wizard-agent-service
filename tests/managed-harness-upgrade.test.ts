import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAgentRegistry, hermesConfigYaml, PRESETS } from '../server/agents.mjs'
import { createWizardServer, listen } from '../server/service.mjs'
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })))
function scene() {
  const dir = mkdtempSync(join(tmpdir(), 'harness-upgrade-')); dirs.push(dir)
  const calls: string[] = []; let fail = false
  const runtime = { apply: async (id: string) => { calls.push(id); if (fail) throw new Error('runtime_unreachable'); return { ok: true } } }
  const options = { agentsDir: dir, gatewayUrl: 'http://gateway/wizard/mcp', runtime }
  function seed(id: string, extra: any = {}, stopped = false) {
    const agent = { schema: 1, id, label: id, harness: 'hermes', privacy: 'private', model: { provider: 'local', model: 'fixture', allowed_models: ['fixture'], fallback: false }, permissions: { preset: 'private', ...PRESETS[0].permissions, read_standard_chats: false }, runtime: { kind: 'container', app_id: `agent-${id}`, port: 18650 }, ...extra }
    const root = join(dir, id), home = join(root, agent.runtime.isolation === 'restricted' ? 'managed' : 'home')
    mkdirSync(home, { recursive: true }); mkdirSync(join(root, 'home'), { recursive: true })
    writeFileSync(join(root, 'agent.json'), JSON.stringify(agent))
    writeFileSync(join(root, 'runtime.key'), 'synthetic-runtime-key'); writeFileSync(join(root, 'gateway.key'), 'synthetic-gateway-key')
    writeFileSync(join(root, 'service-state.json'), JSON.stringify({ desired: stopped ? 'stopped' : 'running' }))
    writeFileSync(join(home, 'config.yaml'), '# old managed configuration\nmcp_servers: {}\n')
    writeFileSync(join(home, '.env'), 'API_SERVER_KEY=synthetic-runtime-key\n')
    writeFileSync(join(root, 'home', 'private-canary.txt'), 'DO NOT TOUCH')
    return { agent, root, home }
  }
  return { dir, calls, runtime, options, seed, fail: (value: boolean) => { fail = value } }
}
it('upgrades only managed harness files, reapplies running agents once, and keeps stopped/imported/profile/unmanaged agents untouched', async () => {
  const s = scene(), a = s.seed('legacy'), stopped = s.seed('stopped', {}, true), restricted = s.seed('restricted', { runtime: { kind: 'container', app_id: 'agent-restricted', port: 18651, isolation: 'restricted' } })
  const imported = s.seed('imported', { imported: { schema: 1, format: 'hermes' } }), profile = s.seed('profile', { runtime: { kind: 'profile', profile: 'fixture' } }), importing = s.seed('importing', { runtime: { kind: 'container', app_id: 'agent-importing', port: 18652, admission: 'importing' } })
  mkdirSync(join(s.dir, 'experiment')); writeFileSync(join(s.dir, 'experiment', 'notes.txt'), 'untouched')
  const registry = createAgentRegistry(s.options)
  await registry.migrateManagedHarnesses()
  expect(s.calls.sort()).toEqual(['legacy', 'restricted'])
  for (const row of [a, stopped, restricted]) {
    expect(readFileSync(join(row.home, 'config.yaml'), 'utf8')).toContain('  wizard:')
    expect(readFileSync(join(row.home, '.env'), 'utf8')).toContain('WIZARD_MCP_TOKEN=synthetic-gateway-key')
    expect(readFileSync(join(row.root, 'home', 'private-canary.txt'), 'utf8')).toBe('DO NOT TOUCH')
    expect(JSON.parse(readFileSync(join(row.root, 'agent.json'), 'utf8'))).toEqual(row.agent)
  }
  for (const row of [imported, profile, importing]) expect(readFileSync(join(row.home, 'config.yaml'), 'utf8')).toContain('old managed')
  // Hermes/user normalisation must not make the managed stamp stale.
  writeFileSync(join(a.home, 'config.yaml'), readFileSync(join(a.home, 'config.yaml'), 'utf8') + '# user normalisation\n')
  await registry.migrateManagedHarnesses(); await createAgentRegistry(s.options).migrateManagedHarnesses()
  expect(s.calls).toHaveLength(2)
  expect(readFileSync(join(a.home, 'config.yaml'), 'utf8')).toContain('user normalisation')
})
it('repairs missing gateway env even with a current config stamp and retries a failed apply after restart', async () => {
  const s = scene(), row = s.seed('legacy')
  writeFileSync(join(row.root, 'config.sha256'), createHash('sha256').update(hermesConfigYaml(row.agent, { gatewayUrl: s.options.gatewayUrl })).digest('hex'))
  s.fail(true); await createAgentRegistry(s.options).migrateManagedHarnesses()
  expect(s.calls).toEqual(['legacy']); expect(existsSync(join(row.root, '.harness-apply-pending'))).toBe(true)
  s.fail(false); await createAgentRegistry(s.options).migrateManagedHarnesses()
  expect(s.calls).toEqual(['legacy', 'legacy']); expect(existsSync(join(row.root, '.harness-apply-pending'))).toBe(false)
})
it('service startup invokes managed upgrade without an owner update or inference', async () => {
  const s = scene(), row = s.seed('legacy')
  const server = createWizardServer({ wizardOsHome: s.dir, agentsDir: s.dir, agentGatewayUrl: s.options.gatewayUrl, agentRuntime: s.runtime, agentBridge: false, requireAccess: false, followThrough: false })
  try {
    await listen(server)
    await new Promise<void>((resolve, reject) => { const started = Date.now(); const check = () => { if (s.calls.length) resolve(); else if (Date.now() - started > 1000) reject(new Error('startup upgrade missing')); else setTimeout(check, 10) }; check() })
    expect(readFileSync(join(row.home, 'config.yaml'), 'utf8')).toContain('  wizard:')
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
