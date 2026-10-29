import { describe, expect, it } from 'vitest'
import { WIZARD_RUN_INSTRUCTIONS } from '../server/service.mjs'
import { AGENT_RUN_INSTRUCTIONS } from '../server/agents-http.mjs'

// Stock Hermes tells every api_server client "assume plain text, no markdown". Wizard renders Markdown,
// so both run instructions must explicitly override that default or replies lose code blocks and lists.
describe('Wizard run instructions override the stock plain-text hint', () => {
  for (const [name, text] of [['owner', WIZARD_RUN_INSTRUCTIONS], ['agent', AGENT_RUN_INSTRUCTIONS]] as const) {
    it(name, () => {
      expect(text).toContain('Wizard renders Markdown')
      expect(text).toMatch(/Ignore any generic API-server note telling you to reply in plain text/)
      expect(text).toMatch(/code fences/)
      // Fact, not a style push: how much to format stays with the agent's persona.
      expect(text).not.toMatch(/wherever they help/)
      expect(text).toContain('up to your own persona')
    })
  }
})
