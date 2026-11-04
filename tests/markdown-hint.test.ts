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
      // The override is scoped to the plain-text line: stock Hermes' own "keep replies brief and conversational"
      // default must survive it, or Wizard silently removes the runtime's only length guidance.
      expect(text).toContain('Only that plain-text line is overridden')
      expect(text).toMatch(/keep replies brief and conversational, not a document, still applies/)
    })
  }
})

describe('Wizard nudges add no reply-shape rule (Own style: the persona is the one style source)', () => {
  it('the delegated-results follow-through only asks to finish the request', async () => {
    const { FOLLOW_THROUGH_INPUT } = await import('../server/delegation-follow-through.mjs')
    expect(FOLLOW_THROUGH_INPUT).toBe('[Wizard follow-through] The delegated results above have arrived. Finish the original request now.')
    const resume = (await import('node:fs')).readFileSync(new URL('../server/helper-resume.mjs', import.meta.url), 'utf8')
    expect(resume).not.toMatch(/self-contained reply/)
    expect(resume).toContain(FOLLOW_THROUGH_INPUT.slice(0, 60))
  })
})
