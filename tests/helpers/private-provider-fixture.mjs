// Compatibility fixtures for the existing agent auth/sealing tests. New provider contract tests
// exercise real HTTP separately; these deliberately stub only this exact connection URL.
import { readFileSync, writeFileSync } from 'node:fs'
import { createWizardServer as service } from '../../server/service.mjs'
import { fixtureAgentSockets } from './fixture-agent-sockets.mjs'
export const fixtureModels = [{ id: 'glm-5-3', label: 'GLM 5.3' }, { id: 'deepseek-v4-1-flash', label: 'DeepSeek V4.1 Flash' }]
export const fixtureProvider = { id: 'wizard-tinfoil', name: 'Tinfoil', status: 'running', health: 'http://127.0.0.1:1/healthz',
  provides: ['ai-connection', 'private-inference'], private_inference: { kind: 'attested-relay', client: 'tinfoil', relay_port: 8090, egress: [] } }
export function createWizardServer(options) {
  let registry = { schema: 1, apps: [] }
  try { registry = JSON.parse(readFileSync(options.appsJsonPath, 'utf8')) } catch {}
  registry.apps = [...(registry.apps || []).filter(a => a.id !== fixtureProvider.id), fixtureProvider]
  writeFileSync(options.appsJsonPath, JSON.stringify(registry))
  const fetchImpl = options.fetchImpl || fetch
  const sockets = fixtureAgentSockets(options)
  return sockets.attach(service({ ...options, ...(options.agentRuntime ? { agentRuntime: sockets.runtime } : {}), fetchImpl: (url, init) => String(url) === 'http://127.0.0.1:1/api/connection'
    ? Promise.resolve(new Response(JSON.stringify({ status: 'connected', models: fixtureModels }))) : fetchImpl(url, init) }))
}
