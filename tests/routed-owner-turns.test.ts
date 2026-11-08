import { afterEach, describe, expect, it } from 'vitest'
// @ts-ignore -- plain ESM fixture shared with qa/agent-parity
import { scene, post } from '../qa/agent-parity/fixture.mjs'
import { restoreOwnerTurns } from '../server/service.mjs'

// Issue 379: Hermes 0.22.7 stamps every /v1/runs admission's user row internal_notification, the owner's own messages
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

// A restricted agent's state.db is unreadable to the Service, so no submission id: the owner's words must match even
// when Hermes returns the multipart list's Python repr or appends its own [System: ...] part to a short message.
describe('restoreOwnerTurns ownerText (routed rows without state.db ids)', () => {
  const SID = 'wizard_synthetic_routed'
  const Buffer = globalThis.Buffer
  const body = (text: string) => JSON.stringify({ session_id: SID, input: [{ role: 'user', content: [{ type: 'text', text }] }] })
  const queue = (text: string) => ({ admittedForSession: () => [{ publicRunId: 'wizardq_a', upstreamRunId: 'run_a', status: 'completed', createdAt: 1000, body: body(text), payload: { created_at: 1000 } }] })
  // Without ownerText the unmatched queued turn only comes back as a synthetic queue row beside the hidden original;
  // with it, Hermes' own row (its id and time) is the one shown.
  const read = (rows: { id: number }[], text: string, ownerText: boolean, status = 'running') => {
    const records = queue(text).admittedForSession().map((r) => ({ ...r, status }))
    const out = JSON.parse(restoreOwnerTurns(Buffer.from(JSON.stringify({ data: rows })), { admittedForSession: () => records }, SID, null, { ownerText }).toString('utf8')).data
    return [out.find((r: { id: unknown }) => r.id === rows[0].id), out]
  }
  const notice = "[System: Synthetic Hermes notice.]"
  it('matches a Python-repr multipart row and shows the queued words', () => {
    const row = { id: 7, role: 'user', display_kind: 'internal_notification', timestamp: 1300, content: `[{'type': 'text', 'text': 'Fix it, it\\'s short'}, {'type': 'text', 'text': '${notice}'}]` }
    expect(read([row], "Fix it, it's short", false)[0].display_kind).toBe('internal_notification')
    const [out, all] = read([row], "Fix it, it's short", true, 'completed')
    expect(all).toHaveLength(1)
    expect(out.display_kind).toBeUndefined()
    expect(out.content).toBe("Fix it, it's short")
  })
  it('matches a short multipart row once its [System:] part is set aside, and drops that part', () => {
    const row = { id: 8, role: 'user', display_kind: 'internal_notification', timestamp: 1300, content: [{ type: 'text', text: 'Short ask' }, { type: 'text', text: notice }] }
    expect(read([row], 'Short ask', false)[0].display_kind).toBe('internal_notification')
    const [out, all] = read([row], 'Short ask', true, 'completed')
    expect(all).toHaveLength(1)
    expect(out.display_kind).toBeUndefined()
    expect(out.content).toEqual([{ type: 'text', text: 'Short ask' }])
  })
  it('never turns a machine wake into an owner turn', () => {
    const row = { id: 9, role: 'user', display_kind: 'internal_notification', timestamp: 1300, content: [{ type: 'text', text: notice }] }
    expect(read([row], 'Short ask', true)[0].display_kind).toBe('internal_notification')
  })
})

describe('routed owner turns (issue 379)', () => {
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
