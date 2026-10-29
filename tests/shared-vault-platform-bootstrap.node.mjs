import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, lstatSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { createStagingServer } from '../qa/shared-vault-platform/service.mjs'

function seed(root) {
  const put = (path, value) => {
    mkdirSync(join(root, path, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 })
  }
  put('service-private/proof', 'synthetic-proof-for-bootstrap-regression-000')
  put('service-private/token', 'synthetic-owner-for-bootstrap-regression-000')
  put('service-private/owner.json', { publicOrigin: 'https://owner.fixture.test', brokerOrigin: 'http://127.0.0.1:8799', ownerTokenFile: join(root, 'service-private/token') })
  put('os/apps.json', { apps: [] })
  for (const id of ['agent-a', 'agent-b']) {
    put(`agents/${id}/agent.json`, { schema: 1, id, label: id, harness: 'hermes', privacy: 'private',
      model: { provider: 'openrouter', model: 'fixture-only', allowed_models: [] },
      permissions: { preset: 'private', files: 'own', outside_tools: [], wizard_apps: [], agent_apps: [], other_agents: 'none', shared_with_agents: false },
      runtime: { kind: 'container', isolation: 'restricted', app_id: 'svtest-' + id, port: id === 'agent-a' ? 18651 : 18652 } })
    put(`agents/${id}/gateway.key`, 'synthetic-gateway-key-' + id)
  }
}
async function close(server) {
  await new Promise(resolve => server.close(resolve))
  await server.drained
}
function status(path, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath: path, path: route, headers, agent: false }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
    req.on('error', reject)
  })
}
const skip = process.getuid?.() === 0 ? 'Owner-route registration refuses root' : false

test('real staging bootstrap reproduces the rejected 117-byte agent socket path', { skip }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'sv-'))
  // Match the failed Forum receipt path length, without touching that host or state.
  const root = join(base, 'x'.repeat(117 - Buffer.byteLength(join(base, 'agents/agent-a/gateway/gateway.sock')) - 1))
  seed(root)
  let server
  try {
    server = await createStagingServer(root)
    assert.equal(Buffer.byteLength(join(root, 'agents/agent-a/gateway/gateway.sock')), 117)
    await assert.rejects(server.agentSocketsReady, /agent_socket_path_too_long/)
  } finally { if (server) await close(server); rmSync(base, { recursive: true, force: true }) }
})

test('real staging bootstrap creates both private agent sockets before Service listen and survives restart', { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sv-'))
  seed(root)
  let server
  try {
    for (let pass = 0; pass < 2; pass++) {
      server = await createStagingServer(root)
      await server.agentSocketsReady
      assert.equal(server.listening, false)
      for (const id of ['agent-a', 'agent-b']) {
        const dir = join(root, 'agents', id, 'gateway'), path = join(dir, 'gateway.sock')
        assert(Buffer.byteLength(path) <= 103)
        assert(lstatSync(path).isSocket())
        assert.equal(lstatSync(path).uid, process.getuid())
        assert.equal(lstatSync(path).mode & 0o777, 0o600)
        assert.equal(lstatSync(dir).mode & 0o777, 0o700)
        // Owner proof/anonymous access cannot become an agent identity on its socket.
        assert([401, 403].includes(await status(path, '/wizard/apps/shared-vault/api/status')))
        assert([401, 403].includes(await status(path, '/wizard/apps/shared-vault/api/status', { 'x-wizard-owner-proof': 'synthetic-proof-for-bootstrap-regression-000' })))
      }
      const socket = join(root, 'service-private/service.sock')
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
      assert.equal(await status(socket, '/wizard/health'), 200)
      assert.equal(await status(socket, '/wizard/apps/shared-vault/api/status'), 403)
      await close(server); server = null
    }
  } finally { if (server) await close(server); rmSync(root, { recursive: true, force: true }) }
})
