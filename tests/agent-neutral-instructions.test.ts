import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runInstructions, WIZARD_RUN_INSTRUCTIONS } from '../server/service.mjs'
import { agentRunInstructions } from '../server/agents-http.mjs'
import { SubjectCatalog } from '../server/thread-subjects.mjs'
import { createRoutedPresentation } from '../server/routed-presentation.mjs'

it('all shared run text uses agent-neutral identity and persona wording', () => {
  for (const style of ['own', 'summary', 'concise']) {
    for (const join of [true, false]) {
      const text = runInstructions({ join, response_style: style as any })
      expect(text).not.toMatch(/\bHermes\b|SOUL\.md/i)
      expect(text).toContain('your own persona file')
    }
    expect(agentRunInstructions(style)).not.toMatch(/\bHermes\b|SOUL\.md/i)
  }
  expect(WIZARD_RUN_INSTRUCTIONS).not.toMatch(/\bHermes\b/i)
})
it('legacy self-topic names are neutral in run notes only; owner data and unrelated subjects stay intact for every harness', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neutral-'))
  try {
    const path = join(dir, 'subjects.json')
    const bytes = JSON.stringify({ subjects: [{ name: 'Hermes', about: 'the agent itself: models, memory, skills, data providers, automations' }, { name: 'Work', about: 'client projects' }], aliases: { 'Old Agent': 'Hermes' } })
    writeFileSync(path, bytes)
    const catalog = new SubjectCatalog(path)
    for (const harness of ['hermes', 'pi', 'future-harness']) {
      const agent = { id: 'synthetic-' + harness, harness }
      const registry = { agentsDir: dir, fetchAgent: async () => new Response('{}', { status: 404 }) }
      const routed = createRoutedPresentation({ registry, subjects: catalog, spaces: undefined })
      const note = await routed.runNote(agent, 'new-chat', {})
      expect(note).toContain('Agents (the agent itself: models, memory, skills, data providers, automations)')
      expect(note).toContain('Work (client projects)')
      expect(note).not.toMatch(/\bHermes\b/)
    }
    expect(catalog.runNote('Hermes')).toContain('This thread\'s subject is “Agents”')
    expect(catalog.resolve('existing', 'Old Agent')).toBe('Hermes')
    expect(readFileSync(path, 'utf8')).toBe(bytes)
    // Semantic self-topic projection is not tied to one old harness name.
    writeFileSync(path, JSON.stringify({ subjects: [{ name: 'Any Old Engine', about: 'the agent itself: models and tools' }, 'Agents', 'Work'] }))
    const note = new SubjectCatalog(path).runNote('Any Old Engine')
    expect(note).not.toContain('Any Old Engine')
    expect(note.split('Use one of these names')[0].match(/\bAgents\b/g)).toHaveLength(1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
it('new installs get a neutral seeded self-topic without writing owner files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'neutral-seed-'))
  try {
    const path = join(dir, 'subjects.json')
    const note = new SubjectCatalog(path).runNote()
    expect(note).toContain('Agents (')
    expect(note).not.toMatch(/\bHermes\b/)
    expect(() => readFileSync(path)).toThrow()
    writeFileSync(path, JSON.stringify({ subjects: [] }))
    expect(new SubjectCatalog(path).runNote()).toBe('')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
