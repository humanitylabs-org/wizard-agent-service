import { describe, expect, it } from 'vitest'
import { readAbandonedRunOutcomeHttp, readInterruptedRunOutcomeHttp } from '../server/hermes-http-readers.mjs'

const failures = [
  { content: 'Operation interrupted: waiting for model response (70.2s elapsed).' },
  { content: 'Operation interrupted: handling API error (timeout).' },
  { content: 'Your request was not processed. Send it again if you still want me to carry it out.' },
  { content: 'This turn did not complete. Some actions may already have run; verify their effects before resending.' },
  { content: 'A future localized failure notice', display_kind: 'failed_turn' },
  { content: '', display_kind: 'failed_turn' },
]

for (const reader of [readAbandonedRunOutcomeHttp, readInterruptedRunOutcomeHttp]) {
  describe(reader.name, () => {
    for (const failure of failures) {
      it(`does not reconcile a failed boundary as completed: ${failure.content || 'empty'}`, async () => {
        const request = async () => ({ data: [
          { role: 'user', content: 'Synthetic task', timestamp: 1001 },
          { role: 'assistant', content: 'Earlier commentary', tool_calls: [{ id: 't' }], timestamp: 1002 },
          { role: 'tool', content: 'Synthetic result', timestamp: 1003 },
          { role: 'assistant', ...failure, timestamp: 1004 },
        ] })
        expect(await reader(request, 'wizard_synthetic', 1000)).toBe('interrupted')
      })
    }
    it('still accepts a real final answer, including one quoting an interruption', async () => {
      for (const content of ['Done: verified.', 'The earlier error was "Operation interrupted: waiting for model response".']) {
        expect(await reader(async () => ({ data: [{ role: 'assistant', content, timestamp: 1001 }] }), 'wizard_synthetic', 1000)).toBe('completed')
      }
    })
  })
}
