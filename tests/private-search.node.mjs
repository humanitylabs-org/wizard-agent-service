import assert from 'node:assert/strict'
import test from 'node:test'
import { parse } from 'yaml'
import { hermesConfigYaml } from '../server/agents.mjs'
const privateAgent = {
  id: 'synthetic', privacy: 'private', model: { provider: 'tinfoil', model: 'glm-5-3', fallback: false },
  permissions: { outside_tools: [], files: 'own', wizard_apps: [], agent_apps: [] },
}
test('private native MCP search always pins the in-network attested route and safety headers', () => {
  const text = hermesConfigYaml(privateAgent)
  const cfg = parse(text)
  assert.equal(cfg.mcp_servers.tinfoil_search.url, 'http://agent-synthetic-tinfoil:3302/mcp')
  assert.deepEqual(cfg.mcp_servers.tinfoil_search.headers, {
    Authorization: 'Bearer ${TINFOIL_API_KEY}',
    'X-Tinfoil-Tool-PII-Check': 'true', 'X-Tinfoil-Tool-Injection-Check': 'true',
  })
  assert.equal(cfg.mcp_servers.tinfoil_search.sampling.enabled, false)
  assert.deepEqual(cfg.fallback_providers, [])
  assert.ok(cfg.agent.disabled_toolsets.includes('web'))
  assert.equal(new URL(cfg.mcp_servers.tinfoil_search.url).protocol, 'http:')
})
test('native search coexists with scoped app and explicit standard-history transports', () => {
  const cfg = parse(hermesConfigYaml({ ...privateAgent, permissions: { ...privateAgent.permissions, read_standard_chats: true } }, { gatewayUrl: 'http://scoped/wizard/mcp' }))
  assert.deepEqual(Object.keys(cfg.mcp_servers), ['tinfoil_search', 'wizard', 'standard_chats'])
  assert.equal(cfg.mcp_servers.wizard.headers.Authorization, 'Bearer ${WIZARD_MCP_TOKEN}')
})
test('other providers and non-private agents do not receive the private search bearer/route', () => {
  for (const changed of [{ privacy: 'standard' }, { model: { provider: 'local', model: 'synthetic' } }]) {
    assert.ok(!hermesConfigYaml({ ...privateAgent, ...changed }).includes('tinfoil_search:'))
  }
})
