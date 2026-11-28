import { describe, it, expect } from 'vitest'
import { scene, post } from '../qa/agent-parity/fixture.mjs'

// wizard-ux issue 2055: tapping a Ready thread waited 3-5 s for the whole Chats list before the phone would show the
// copy of that thread it had already saved, because only the list said what the thread holds. The single-thread read
// (`?view=detail`, ~0.1 s) now carries the same newest owner and reply times the list row has, so the phone can check
// that one thread's saved copy against it and paint it at once.
describe('the single-thread read carries the list row\'s content clock', () => {
  it('detail and list name the same newest owner and reply times', async () => {
    const s: any = await scene('main', { canonicalSessionListing: true })
    try {
      const id = 'wizard_content_clock_2055'
      expect((await s.request('/api/sessions', post({ id, source: 'wizard-mobile', title: 'Synthetic clock' }))).status).toBe(201)
      const at = Math.floor(Date.now() / 1000) - 60
      s.sessions.get(id).messages.push({ id: 'u1', role: 'user', content: 'Synthetic question', timestamp: at },
        { id: 'a1', role: 'assistant', content: 'Synthetic answer', timestamp: at + 5, finish_reason: 'stop', display_kind: 'final' })
      const list = await (await s.request('/api/sessions?view=list&window=archive-50&limit=100&offset=0&include_children=false')).json()
      const row = list.data.find((r: any) => r.id === id)
      expect(row.lastUserAt).toBe(new Date(at * 1000).toISOString())
      expect(row.lastAssistantAt).toBe(new Date((at + 5) * 1000).toISOString())
      const detail = await (await s.request(`/api/sessions/${id}?view=detail`)).json()
      const one = detail.session || detail
      expect(new Date(Number(one.wizard_last_user_at) * 1000).toISOString()).toBe(row.lastUserAt)
      expect(new Date(Number(one.wizard_last_assistant_at) * 1000).toISOString()).toBe(row.lastAssistantAt)
    } finally { await s.close() }
  }, 30_000)
})
