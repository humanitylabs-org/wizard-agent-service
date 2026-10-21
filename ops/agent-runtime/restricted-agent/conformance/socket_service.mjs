// Synthetic records only. Real Service, registry reader, socket manager, auth and app-context projection.
import { mkdirSync, writeFileSync } from 'node:fs'
import { createWizardServer } from '../../../../server/service.mjs'

for (const id of ['one', 'two']) {
  const dir = `/state/agents/${id}`
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/agent.json`, JSON.stringify({
    schema: 1, id, label: id, harness: 'hermes', privacy: 'standard',
    model: { provider: 'anthropic', model: 'fixture', allowed_models: ['fixture'] },
    permissions: { preset: 'standard', wizard_apps: [`${id}-app`] },
    runtime: { kind: 'container', app_id: `agent-${id}`, port: id === 'one' ? 19001 : 19002, isolation: 'restricted' },
  }))
  writeFileSync(`${dir}/runtime.key`, 'socket-fixture-api-key', { mode: 0o600 })
  writeFileSync(`${dir}/gateway.key`, `socket-fixture-token-${id}-0123456789abcdef`, { mode: 0o600 })
}
writeFileSync('/state/apps.json', JSON.stringify({ schema: 1, apps: ['one', 'two'].map(id => ({
  id: `${id}-app`, name: `${id.toUpperCase()}-ONLY`, status: 'running', mcp: { url: 'http://127.0.0.1:1/mcp' },
})) }))
const service = createWizardServer({
  upstreamOrigin: 'http://127.0.0.1:1', hermesKey: 'fixture', requireAccess: false,
  ownerProof: 'socket-fixture-owner-proof-0123456789abcdef', wizardOsHome: '/state',
  appsJsonPath: '/state/apps.json', settingsPath: '/state/settings.json',
  threadAppsStatePath: '/state/thread-apps.json', followThrough: false, joinedDelegation: 'off',
  bridgeWriteSkills: false, bridgeWatchMs: 0, mcpToken: 'fixture-main-token-0123456789abcdef',
})
await service.agentSocketsReady
// Deliberately no TCP listen, including 8929. Both agent sockets use the real Service request handler.
console.log('socket service ready')
