import { afterEach, describe, expect, it } from 'vitest'
// @ts-ignore -- plain ESM fixture shared with qa/agent-parity
import { scene, post } from '../qa/agent-parity/fixture.mjs'

// #379: Hermes 0.22.7 stamps every /v1/runs admission's user row internal_notification, the owner's own messages
// included. Main restores them from its run queue (restoreOwnerTurns); routed agents do the same from their own
// queue only with WIZARD_ROUTED_OWNER_TURNS=1 (routedOwnerTurns), which is off by default.
const words = 'Synthetic routed owner turn stamped as an internal notification.'
let open: any = null
afterEach(async () => { await open?.close(); open = null })

async function ownerRow(kind: string, options: Record<string, unknown>) {
  const s = open = await scene(kind, options)
  expect((await s.request('/api/sessions', post({ id: 'wizard_parity', source: 'wizard-mobile', hidden: true }))).status).toBe(201)
  const admitted = await s.request('/v1/runs', post({ session_id: 'wizard_parity', input: [{ role: 'user', content: [{ type: 'text', text: words }] }] }))
  expect(admitted.status).toBe(202)
  const thread = s.sessions.get('wizard_parity')
  for (let i = 0; i < 40 && !thread.messages.length; i++) await new Promise(r => setTimeout(r, 25))
  const upstream = thread.messages.findLast((m: any) => m.role === 'user')
  upstream.display_kind = 'internal_notification'
  const history = await (await s.request('/api/sessions/wizard_parity/messages?view=wizard&order=oldest')).json()
  return history.data.filter((m: any) => m.role === 'user' && JSON.stringify(m.content).includes(words))
}

describe('routed owner turns (#379)', () => {
  for (const kind of ['host-profile', 'container', 'restricted']) {
    it(`${kind}: switch off by default leaves the routed history as Hermes sent it`, async () => {
      const rows = await ownerRow(kind, {})
      expect(rows).toHaveLength(1)
      expect(rows[0].display_kind).toBe('internal_notification')
    }, 20000)
    it(`${kind}: switch on shows the owner's own message once as a normal user row`, async () => {
      const rows = await ownerRow(kind, { routedOwnerTurns: true })
      expect(rows).toHaveLength(1)
      expect(rows[0].display_kind).toBeUndefined()
    }, 20000)
  }
  it('main is unchanged by the switch: always restored', async () => {
    const rows = await ownerRow('main', {})
    expect(rows).toHaveLength(1)
    expect(rows[0].display_kind).toBeUndefined()
  }, 20000)
})
