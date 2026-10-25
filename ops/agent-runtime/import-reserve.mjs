// Local owner CLI adapter. Uses the Service registry's allocator and validation;
// not an HTTP endpoint and never owns Docker authority.
import { readFileSync } from 'node:fs'
import { createAgentRegistry } from '../../server/agents.mjs'
const p = JSON.parse(readFileSync(0, 'utf8'))
try {
  const registry = createAgentRegistry({ agentsDir: p.agentsDir, isolation: 'restricted', basePort: p.port,
    image: p.image, runtime: { apply() { throw new Error('reserved import must not start') } },
    mainProviders: async () => [{ slug: p.provider, models: [p.model], authenticated: true }],
  })
  const { agent } = await registry.create({ label: p.id, model: { provider: p.provider, model: p.model, fallback: false },
    permissions: { preset: 'standard', files: 'own', outside_tools: p.outside_tools, wizard_apps: [], agent_apps: [], other_agents: 'read', shared_with_agents: true },
  }, { deferStart: true })
  if (agent.id !== p.id) throw new Error('import id collision')
  console.log(JSON.stringify({ id: agent.id }))
} catch { console.error('import_registry_reservation_failed'); process.exitCode = 1 }
