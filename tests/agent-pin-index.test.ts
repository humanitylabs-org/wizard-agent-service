import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createAgentRegistry } from '../server/agents.mjs'
import { threadKey } from '../server/thread-reference.mjs'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

it('pinned-agent lookups are indexed and follow pin-table changes (the private-thread filter was quadratic)', () => {
  const root = mkdtempSync(join(tmpdir(), 'pin-index-')); roots.push(root)
  const agentsDir = join(root, 'agents'); mkdirSync(agentsDir, { recursive: true })
  const threads: Record<string, any> = {}
  const add = (agent_id: string, session_id: string, provenance: string) => { threads[threadKey(agent_id, session_id)] = { agent_id, session_id, provenance } }
  for (let i = 0; i < 3000; i++) add('hermes', `s${i}`, 'runtime_verified')
  add('other', 's7', 'service_admission')
  add('other', 's8', 'legacy_unverified')
  writeFileSync(join(agentsDir, '.threads.json'), JSON.stringify({ schema: 2, threads }))
  const registry = createAgentRegistry({ agentsDir })
  const started = performance.now()
  for (let i = 0; i < 3000; i++) registry.pinnedAgents(`s${i}`)
  expect(performance.now() - started).toBeLessThan(500)
  expect(registry.pinnedAgents('s7').sort()).toEqual(['hermes', 'other'])
  expect(registry.pinnedAgents('s8')).toEqual(['hermes'])
  expect(registry.pinnedAgents('missing')).toEqual([])
  const copy = registry.pinnedAgents('s1'); copy.push('mutated')
  expect(registry.pinnedAgents('s1')).toEqual(['hermes'])
  registry.pin('brand_new', 'hermes', 'service_admission')
  expect(registry.pinnedAgents('brand_new')).toEqual(['hermes'])
})
