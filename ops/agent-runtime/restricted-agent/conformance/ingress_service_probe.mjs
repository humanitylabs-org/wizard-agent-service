// Run inside the network-none Service container: production registry and native streaming transport.
import assert from 'node:assert/strict'
import { createAgentRegistry } from '../../../../server/agents.mjs'
const registry = createAgentRegistry({ agentsDir: '/state/agents' })
const one = registry.read('one'), two = registry.read('two')
const checks = []
async function check(name, action) {
  await action()
  checks.push({ check: name, pass: true })
}
await check('Service health over ingress socket is 200', async () => {
  const r = await registry.fetchAgent(one, '/health'); assert.equal(r.status, 200); await r.text()
})
await check('Service authenticated API over ingress socket is 200', async () => {
  const r = await registry.fetchAgent(one, '/v1/models', { headers: { Authorization: `Bearer ${registry.apiKey('one')}` } })
  assert.equal(r.status, 200); await r.text()
})
await check('wrong API key refused over ingress socket', async () => {
  const r = await registry.fetchAgent(one, '/v1/models', { headers: { Authorization: 'Bearer wrong-synthetic-api-key' } })
  assert.equal(r.status, 401); await r.text()
})
await check('missing API key refused over ingress socket', async () => {
  const r = await registry.fetchAgent(one, '/v1/models'); assert.equal(r.status, 401); await r.text()
})
await check('another agent cannot select the first agent ingress socket', async () => {
  // Agent two has no ingress relay; a poisoned stored path must not redirect its calls to one.
  await assert.rejects(async () => registry.fetchAgent({ ...two, runtime: { ...two.runtime,
    ingress_socket: '/state/agents/one/gateway/ingress.sock' } }, '/health'))
})
console.log(JSON.stringify({ checks, passed: checks.length, total: checks.length }, null, 2))
