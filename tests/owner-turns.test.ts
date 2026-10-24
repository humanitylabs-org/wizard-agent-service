import { describe, expect, it } from 'vitest'
import { restoreOwnerTurns, projectWizardMessageHistory } from '../server/service.mjs'

const SID = 'wizard_1792826187656_eea623522624'
const queue = (ids: string[], body = { input: 'hi' }, created = 1792826187.86) => ({ admittedForSession: (runtime: string, sid: string) => runtime === 'direct' && sid === SID ? ids.map((admission_id) => ({ body: JSON.stringify(body), payload: { admission_id, created_at: created } })) : [] })
const rows = (extra: object[] = []) => ({ data: [
  { id: 36, session_id: SID, role: 'user', display_kind: 'internal_notification', platform_message_id: 'adm-owner', timestamp: 1792826187.9, content: 'hi' },
  { id: 37, session_id: SID, role: 'assistant', content: 'Hi! What can I help with?', finish_reason: 'stop' },
  ...extra,
] })
const run = (payload: object, ids: string[]) => JSON.parse(restoreOwnerTurns(Buffer.from(JSON.stringify(payload)), queue(ids), SID).toString()).data

describe('restoreOwnerTurns (Hermes 0.22.5 api_server admissions)', () => {
  it("shows the owner's own admitted message as a user bubble", () => {
    const out = run(rows(), ['adm-owner'])
    expect(out[0].display_kind).toBeUndefined()
    expect(out[0].content).toBe('hi')
    const projected = JSON.parse(projectWizardMessageHistory(Buffer.from(JSON.stringify({ data: out }))).toString()).data
    expect(projected[0].display_kind).toBeUndefined()
  })
  it('matches by input text and time when Hermes omits platform_message_id (real 0.22.5 history shape)', () => {
    const live = { data: [
      { id: 36, session_id: SID, role: 'user', display_kind: 'internal_notification', timestamp: '1792826187.907264', content: 'hi' },
      { id: 37, session_id: SID, role: 'assistant', content: 'Hi! What can I help with?' },
    ] }
    expect(run(live, ['adm-owner'])[0].display_kind).toBeUndefined()
    const late = { data: [{ ...live.data[0], timestamp: 1792826187.9 + 600 }] }
    expect(run(late, ['adm-owner'])[0].display_kind).toBe('internal_notification')
    const other = { data: [{ ...live.data[0], content: 'something else' }] }
    expect(run(other, ['adm-owner'])[0].display_kind).toBe('internal_notification')
  })

  it('keeps real internal notifications (no matching admission) internal', () => {
    const wake = { id: 40, session_id: SID, role: 'user', display_kind: 'internal_notification', platform_message_id: 'wake-1', content: '[ASYNC DELEGATION BATCH COMPLETE]' }
    const out = run(rows([wake]), ['adm-owner'])
    expect(out[2].display_kind).toBe('internal_notification')
    expect(run(rows(), [])[0].display_kind).toBe('internal_notification')
  })
  it('never touches another session, assistant rows, or other kinds', () => {
    const other = { id: 41, session_id: 'other', role: 'user', display_kind: 'internal_notification', platform_message_id: 'adm-owner', content: 'x' }
    const hidden = { id: 42, session_id: SID, role: 'user', display_kind: 'hidden', platform_message_id: 'adm-owner', content: 'y' }
    const out = run(rows([other, hidden]), ['adm-owner'])
    expect(out[2].display_kind).toBe('internal_notification')
    expect(out[3].display_kind).toBe('hidden')
  })
  it('returns the input untouched without a queue or a parseable body', () => {
    const buf = Buffer.from(JSON.stringify(rows()))
    expect(restoreOwnerTurns(buf, null, SID)).toBe(buf)
    const bad = Buffer.from('internal_notification not json')
    expect(restoreOwnerTurns(bad, queue(['adm-owner']), SID)).toBe(bad)
  })
})
