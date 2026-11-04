import { expect, it } from 'vitest'
import { scene, kinds } from '../qa/agent-parity/fixture.mjs'

for (const kind of kinds) it(`Spaces metadata search projects assistant-only subject for ${kind}`, async () => {
  const s = await scene(kind, { agentBridge: true, bridgeWriteSkills: false, mcpToken: 'parity-main-gateway', agentGatewayUrl: 'http://gateway/wizard/mcp' })
  try {
    s.sessions.set('synthetic-status', { id: 'synthetic-status', title: 'Unrelated title', source: 'wizard-mobile', created_at: 1, messages: [{ role: 'assistant', timestamp: 2, content: 'CONTENT_MUST_NOT_LEAK\n[WIZARD_STATUS_V1] {"state":"done","ask":"Synthetic result","subject":"SubjectOnlyNeedle"}[/WIZARD_STATUS_V1]' }] })
    const r = await s.agentMcp('tools/call', { name: 'spaces_search_threads', arguments: { query: 'SubjectOnlyNeedle' } })
    expect(r.status).toBe(200)
    const result = (await r.json()).result
    expect(result.isError).not.toBe(true)
    const value = JSON.parse(result.content[0].text)
    expect(value).toMatchObject({ total: 1, threads: [{ id: 'synthetic-status', subject: 'SubjectOnlyNeedle' }] })
    expect(JSON.stringify(value)).not.toContain('CONTENT_MUST_NOT_LEAK')
    const history = s.seen.filter(x => x.path.includes('/synthetic-status/messages'))
    expect(history.length).toBeGreaterThan(0)
    expect(history.every(x => x.headers.authorization === `Bearer ${kind === 'main' ? 'parity-main-secret' : 'parity-runtime-secret'}`)).toBe(true)
    if (kind === 'host-profile') expect(history.every(x => x.path.startsWith('/p/parity-profile/'))).toBe(true)
  } finally { await s.close() }
})
