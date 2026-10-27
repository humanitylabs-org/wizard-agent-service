// Real Service lifecycle fixture on synthetic state, talking to the actual stock runtime helper.
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createWizardServer, listen } from '../../server/service.mjs'
const root = process.env.QA_FIXTURE_ROOT
if (!root || !/incognito-stock-service-/.test(root) || !process.env.QA_HELPER_ORIGIN) throw new Error('synthetic_root_required')
mkdirSync(join(root, 'main-home'), { recursive: true })
const upstream = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(req.url === '/api/model/options' ? { provider: 'custom', model: 'glm-5-3', providers: [] } : { data: [], has_more: false })) })
const ua = await listen(upstream)
const helper = async (id, action, body) => {
  if (id !== 'synthetic') throw new Error('synthetic_agent_required')
  const response = await fetch(`${process.env.QA_HELPER_ORIGIN}/agents/synthetic/incognito/${action}`, { method: 'POST', headers: { Authorization: 'Bearer synthetic-helper-token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) throw new Error('synthetic_helper_unavailable')
  return response.json()
}
const runtime = { apply: async () => ({ ok: true }), start: async () => ({ ok: true }), stop: async () => ({ ok: true }),
  incognitoStart: (id, body) => helper(id, 'start', body), incognitoStop: (id, body) => helper(id, 'stop', body), incognitoLease: (id, body) => helper(id, 'lease', body) }
const service = createWizardServer({ upstreamOrigin: `http://127.0.0.1:${ua.port}`, hermesKey: 'synthetic-main-key', requireAccess: false,
  agentBridge: false, followThrough: false, joinedDelegation: 'off', hermesHome: join(root, 'main-home'), wizardOsHome: root,
  appsJsonPath: join(root, 'apps.json'), settingsPath: join(root, 'settings.json'), threadSeenStatePath: join(root, 'seen.json'), agentRuntime: runtime, agentBasePort: 47650 })
const address = await listen(service, '127.0.0.1', Number(process.env.QA_PORT || 19744))
const base = `http://127.0.0.1:${address.port}`, file = join(root, 'agents/synthetic/agent.json')
if (!existsSync(file)) {
  const response = await fetch(base + '/wizard/v1/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Synthetic', model: { provider: 'tinfoil', model: 'glm-5-3' }, permissions: { preset: 'private' } }) })
  if (response.status !== 201) throw new Error('synthetic_agent_create_failed')
}
const agent = JSON.parse(readFileSync(file)); agent.runtime.port = ua.port; writeFileSync(file, JSON.stringify(agent))
// Deliberately no content, credentials or transient session identifiers in the process log.
console.log(JSON.stringify({ ready: true, synthetic_only: true }))
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await new Promise(resolve => service.close(resolve)); await service.drained
  await new Promise(resolve => upstream.close(resolve)); process.exit(0)
})
