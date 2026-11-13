import { describe, expect, it } from 'vitest'
import { heldWords, markHeldFirstSends } from '../server/held-first-send.mjs'

// wizard-ux issue 1362: a new chat whose first message a graceful restart holds has no messages yet, so every list
// reader dropped it. It stays listed as a saved first send, titled with the owner's words.
const queue = (records: Record<string, any>) => ({ latestForSession: (id: string) => records[id] ?? null })
const held = (input: string, extra: Record<string, any> = {}) => ({ status: 'queued', waitingReason: 'restart_pending', publicRunId: 'wizardq_' + 'a'.repeat(32), idempotencyKey: 'key-1', createdAt: 1_800_000_000, body: JSON.stringify({ input }), ...extra })

describe('held first sends', () => {
  it('marks an empty session whose first message the restart holds, with the owner words as title and preview', () => {
    const rows = [{ id: 'wizard_new', message_count: 0, title: null }]
    const [row] = markHeldFirstSends(rows, queue({ wizard_new: held('Find a ferry time') }))
    expect(row).toMatchObject({ id: 'wizard_new', wizard_pending_first_send: true, status: 'queued', queue_reason: 'restart_pending',
      title: 'Find a ferry time', preview: 'Find a ferry time', wizard_request_preview: 'Find a ferry time', wizard_last_run_idempotency_key: 'key-1' })
  })

  it('keeps an owner title and leaves every other row as the same object', () => {
    const rows = [
      { id: 'titled', message_count: 0, title: 'Trip' },
      { id: 'has_messages', message_count: 3 },
      { id: 'not_held', message_count: 0 },
      { id: 'provider_wait', message_count: 0 },
      { id: 'running', message_count: 0 },
      { id: 'hidden', message_count: 0, hidden: true },
    ]
    const out = markHeldFirstSends(rows, queue({
      titled: held('Plan it'), has_messages: held('More'), provider_wait: held('x', { waitingReason: 'provider_access' }), running: held('y', { status: 'running' }), hidden: held('z'),
    }))
    expect(out[0].title).toBe('Trip')
    for (const index of [1, 2, 3, 4, 5]) expect(out[index]).toBe(rows[index])
  })

  it('changes nothing without a queue (the restart switch is off)', () => {
    const rows = [{ id: 'wizard_new', message_count: 0 }]
    expect(markHeldFirstSends(rows, null)).toBe(rows)
  })

  it('drops the file block from the words and calls a words-less send a voice message', () => {
    expect(heldWords(JSON.stringify({ input: 'See this\n[WIZARD_FILES_V1][{"filename":"a.png"}][/WIZARD_FILES_V1]' }))).toBe('See this')
    const [row] = markHeldFirstSends([{ id: 'v', message_count: 0 }], queue({ v: held('') }))
    expect(row.title).toBe('Voice message')
  })

  it('never lets a queue read error break the list', () => {
    const rows = [{ id: 'x', message_count: 0 }]
    expect(markHeldFirstSends(rows, { latestForSession: () => { throw new Error('closed') } })).toEqual(rows)
  })
})
