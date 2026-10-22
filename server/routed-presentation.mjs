// The same title/subject rules as main, with service-owned state isolated per agent.
import { join } from 'node:path'
import { ThreadTitleStore, titleToApply, titleContextLine } from './thread-titles.mjs'

export function createRoutedPresentation({ registry, subjects }) {
  const stores = new Map(), currentSubjects = new Map()
  const store = agent => {
    if (!stores.has(agent.id)) stores.set(agent.id, new ThreadTitleStore(join(registry.agentsDir, agent.id, 'wizard-thread-titles.json')))
    return stores.get(agent.id)
  }
  const pair = (agent, id) => JSON.stringify([agent.id, id])
  return {
    async project(agent, row, attention, assistantAt, headers) {
      const titles = store(agent)
      const applied = subjects.apply(row.id, attention, agent.id)
      if (applied?.subject) { currentSubjects.set(pair(agent, row.id), applied.subject); if (currentSubjects.size > 2000) currentSubjects.delete(currentSubjects.keys().next().value) }
      const record = titles.get(row.id)
      // Hermes remains canonical; user titles and explicit owner renames are never overwritten.
      const unknownAuthority = !record && row.title && !['llm', 'auto'].includes(row.title_source)
      const proposal = unknownAuthority || row.title_source === 'user' && !record ? '' : titleToApply({ currentTitle: row.title, proposed: applied?.title, record, assistantAt })
      if (proposal) {
        const patchHeaders = new Headers(headers); patchHeaders.set('Content-Type', 'application/json')
        const response = await registry.fetchAgent(agent, `/api/sessions/${encodeURIComponent(row.id)}`, { method: 'PATCH', headers: patchHeaders, body: JSON.stringify({ title: proposal }), redirect: 'manual', signal: AbortSignal.timeout(3000) })
        await response.body?.cancel()
        if (response.ok) {
          titles.recordRename(row.id, { from: row.title || '', to: proposal, by: 'agent', assistantAt, since: row.created_at || row.started_at || null })
          row = { ...row, title: proposal }
        }
      }
      return { ...row, ...(applied ? { wizard_attention: applied } : {}), wizard_title_history: titles.visibleHistory(row.id) }
    },
    noteRename(agent, id, title) {
      const titles = store(agent)
      titles.recordRename(id, { from: titles.get(id)?.title || '', to: title, by: 'you' })
    },
    async runNote(agent, id, headers) {
      // Read only this exact selected pair. No main/profile fallback or cross-agent search.
      const response = await registry.fetchAgent(agent, `/api/sessions/${encodeURIComponent(id)}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(1500) })
      if (!response.ok) { await response.body?.cancel(); return subjects.runNote() }
      const payload = await response.json(), row = payload.session || payload
      return [titleContextLine(row.title, store(agent).get(id)), subjects.runNote(currentSubjects.get(pair(agent, id)) || '')].filter(Boolean).join('\n')
    },
  }
}
