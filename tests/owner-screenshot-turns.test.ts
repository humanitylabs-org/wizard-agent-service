import { describe, expect, it } from 'vitest'
import { restoreOwnerTurns } from '../server/service.mjs'

// Issue 145, point 4: an owner turn with an inline screenshot reaches Hermes as a multipart list, and
// Hermes' text-only projection stores it as the owner's words plus "[screenshot]" (or the marker alone).
// Synthetic thread; no real conversation content.
const SID = 'wizard_synthetic_screenshot_thread'
const PNG = 'data:image/png;base64,iVBORw0KGgo='
const shotBody = (text: string) => JSON.stringify({ session_id: SID, input: [{ role: 'user', content: [
  ...(text ? [{ type: 'text', text }] : []), { type: 'image_url', image_url: { url: PNG } }] }] })
const rec = (publicRunId: string, createdAt: number, body: string, status = 'completed') => ({
  publicRunId, upstreamRunId: `run_${publicRunId}`, status, createdAt, body, payload: { created_at: createdAt },
})
const records = [
  rec('wizardq_words', 1000, shotBody('Synthetic: what is wrong on this screen?')),
  rec('wizardq_only', 2000, shotBody('')),
  rec('wizardq_gone', 500, shotBody('Synthetic: old screenshot turn')),
  rec('wizardq_wake', 2500, JSON.stringify({ input: '[Wizard follow-through] Synthetic machine wake' })),
]
const queue = { admittedForSession: (runtime: string, sid: string) => (runtime === 'direct' && sid === SID ? records : []) }
const page = () => ({ object: 'list', session_id: SID, pagination: { limit: 500, offset: 0, order: 'latest', returned: 6 }, data: [
  { id: 11, session_id: SID, role: 'user', display_kind: 'internal_notification', timestamp: 1100, content: 'Synthetic: what is wrong on this screen?\n[screenshot]' },
  { id: 12, session_id: SID, role: 'assistant', timestamp: 1200, content: 'Synthetic reply one.' },
  { id: 21, session_id: SID, role: 'user', display_kind: 'internal_notification', timestamp: 2100, content: '[screenshot]' },
  { id: 22, session_id: SID, role: 'assistant', timestamp: 2200, content: 'Synthetic reply two.' },
  { id: 31, session_id: SID, role: 'user', display_kind: 'internal_notification', timestamp: 2600, content: '[Wizard follow-through] Synthetic machine wake' },
  { id: 32, session_id: SID, role: 'assistant', timestamp: 2700, content: 'Synthetic reply three.' },
] })
const run = (screenshots: boolean) => JSON.parse(restoreOwnerTurns(Buffer.from(JSON.stringify(page())), queue, SID, null,
  screenshots ? { screenshots: true } : undefined).toString()).data as Array<Record<string, any>>

describe('restoreOwnerTurns: screenshot owner turns (issue 145)', () => {
  it('switch on: a words-plus-screenshot row shows as the owner\'s own message', () => {
    const row = run(true).find((r) => r.id === 11)!
    expect(row.display_kind).toBeUndefined()
    expect(row.content).toBe('Synthetic: what is wrong on this screen?\n[screenshot]')
  })
  it('switch on: a screenshot-only row shows as the owner\'s own message', () => {
    expect(run(true).find((r) => r.id === 21)!.display_kind).toBeUndefined()
  })
  it('switch on: a screenshot turn whose Hermes row is gone is restored once, with its marker, in time order', () => {
    const out = run(true)
    const synthetic = out.filter((r) => String(r.id).startsWith('queue-'))
    expect(synthetic.map((r) => [r.id, r.content])).toEqual([['queue-wizardq_gone', 'Synthetic: old screenshot turn\n[screenshot]']])
    expect(out.indexOf(synthetic[0])).toBe(0)
  })
  it('switch on: a machine wake stays hidden', () => {
    expect(run(true).find((r) => r.id === 31)!.display_kind).toBe('internal_notification')
  })
  it('switch on: matches whatever whitespace Hermes puts around the marker', () => {
    const p: any = page(); p.data[0].content = 'Synthetic: what is wrong on this screen? [screenshot]'
    const out = JSON.parse(restoreOwnerTurns(Buffer.from(JSON.stringify(p)), queue, SID, null, { screenshots: true }).toString()).data
    expect(out.find((r: any) => r.id === 11).display_kind).toBeUndefined()
  })
  it('switch off: screenshot rows keep their kind, as before', () => {
    const out = run(false)
    expect(out.find((r) => r.id === 11)!.display_kind).toBe('internal_notification')
    expect(out.find((r) => r.id === 21)!.display_kind).toBe('internal_notification')
  })
})
