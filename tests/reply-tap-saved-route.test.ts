import { describe, it, expect } from 'vitest'
import { scene, post } from '../qa/agent-parity/fixture.mjs'

// wizard-ux issue 1973, part 1 (on for everyone): the single-thread read carries the thread's saved route exactly as
// its list row does. Hermes' session API omits the provider; the list row gets it from the thread's model lock, and the
// detail read (`?view=detail`) used to name only the model, so a shell that had only that read (an archived thread
// opened from its pin) had to guess the provider from the phone's model list and failed when that list was missing:
// "Not sent · Model provider unavailable". Routed agents route on their own agent's provider and are not affected.
describe('the single-thread read names the thread\'s saved provider', () => {
  it('detail names the model, provider and lock time of the thread\'s model lock', async () => {
    const s: any = await scene('main', { fixtureSelectorLock: true })
    try {
      const id = 'wizard_saved_route_1973'
      expect((await s.request('/api/sessions', post({ id, source: 'wizard-mobile' }))).status).toBe(201)
      expect((await s.request(`/api/sessions/${id}/model`, post({ model: 'claude-sonnet-5-5', provider: 'anthropic' }))).status).toBe(200)
      const detail = await (await s.request(`/api/sessions/${id}?view=detail`)).json()
      const row = detail.session || detail
      expect(row.model).toBe('claude-sonnet-5-5')
      expect(row.provider).toBe('anthropic')
      expect(Number(row.wizard_model_lock_updated_at)).toBeGreaterThan(0)
    } finally { await s.close() }
  }, 30_000)
  it('a thread with no saved route gets no invented provider', async () => {
    const s: any = await scene('main', { fixtureSelectorLock: true })
    try {
      const id = 'wizard_no_route_1973'
      expect((await s.request('/api/sessions', post({ id, source: 'wizard-mobile', model: 'claude-sonnet-5-5' }))).status).toBe(201)
      const detail = await (await s.request(`/api/sessions/${id}?view=detail`)).json()
      const row = detail.session || detail
      expect(row.provider ?? '').toBe('')
      expect(row.wizard_model_lock_updated_at).toBeUndefined()
    } finally { await s.close() }
  }, 30_000)
  // A reply the phone could not name a route for goes with none (wizard-ux issue 1973): the thread's model lock runs it,
  // and a thread with no saved route at all fails in words that say what to do.
  it('a send with no route runs on the saved lock; with no lock it says what to do', async () => {
    const s: any = await scene('main', { fixtureSelectorLock: true })
    try {
      const sends = () => s.seen.filter((x: any) => x.method === 'POST' && /\/chat\/stream$/.test(x.path))
      const id = 'wizard_routeless_1973'
      expect((await s.request('/api/sessions', post({ id, source: 'cron' }))).status).toBe(201)
      expect((await s.request(`/api/sessions/${id}/model`, post({ model: 'claude-sonnet-5-5', provider: 'anthropic' }))).status).toBe(200)
      expect((await s.request('/v1/runs', post({ session_id: id, input: 'Tapped Done · Read', require_model_lock: true }))).status).toBe(202)
      const until = Date.now() + 5000
      while (!sends().some((x: any) => x.path.includes(id)) && Date.now() < until) await new Promise(r => setTimeout(r, 50))
      expect(sends().find((x: any) => x.path.includes(id))?.body).toMatchObject({ model: 'claude-sonnet-5-5', provider: 'anthropic' })
      const none = 'wizard_no_lock_1973'
      expect((await s.request('/api/sessions', post({ id: none, source: 'cron' }))).status).toBe(201)
      const r = await s.request('/v1/runs', post({ session_id: none, input: 'Tapped Done · Read', require_model_lock: true }))
      const run = await r.json()
      expect(run.status).toBe('failed')
      expect(run.safe_error).toBe('Couldn’t tell which AI runs this chat · tap the model name, pick one, then Retry')
      expect(sends().some((x: any) => x.path.includes(none))).toBe(false)
    } finally { await s.close() }
  }, 30_000)
})
