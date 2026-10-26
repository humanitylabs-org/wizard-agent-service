import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { hermesConfigYaml, PRESETS } from '../server/agents.mjs'

// Every generated harness, not an Archimedes/persona exception. No live registry.
for (const privacy of ['standard', 'private']) {
  for (const provider of ['anthropic', 'openai-codex', 'local', 'tinfoil']) {
    it(`defaults ${privacy}/${provider} to stock local holographic memory`, () => {
      const agent = { id: 'memory-test', privacy, model: { provider, model: 'fixture', fallback: false },
        permissions: { ...PRESETS[0].permissions, outside_tools: [], wizard_apps: [], agent_apps: [] },
        memory: { user_chars: 1234, notes_chars: 5678 } }
      const cfg = parse(hermesConfigYaml(agent))
      expect(cfg.memory).toEqual({ provider: 'holographic', memory_enabled: true, user_profile_enabled: true,
        user_char_limit: 1234, memory_char_limit: 5678 })
      expect(cfg.plugins.enabled).toContain('holographic')
      expect(cfg.plugins['hermes-memory-store']).toEqual({ db_path: '$HERMES_HOME/memory_store.db', auto_extract: false })
      expect(cfg.agent.disabled_toolsets).not.toContain('memory')
      expect(cfg.agent.disabled_toolsets).not.toContain('holographic')
    })
  }
}
