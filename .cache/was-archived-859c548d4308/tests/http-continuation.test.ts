import { expect, it } from 'vitest'
import { requireHttpContinuation } from '../server/hermes-http-readers.mjs'

const prefix = '[ASYNC DELEGATION BATCH COMPLETE'
const now = 1_800_000_000_000
const token = { kind: 'http-completion', sessionId: 'wizard_http', messageId: 7, at: now / 1000 - 10 }
const row = { id: 7, timestamp: token.at, role: 'user', content: `${prefix} fixture]` }
const request = async () => ({ data: [row] })
it('revalidates the exact current HTTP completion without opening state.db', async () => {
  await expect(requireHttpContinuation(request, token, prefix, now)).resolves.toBeUndefined()
})
it.each([
  { ...token, messageId: 8 }, { ...token, at: token.at - 1 }, { ...token, at: now / 1000 + 1 },
  { ...token, at: now / 1000 - 7201 }, { ...token, kind: 'invented' }, null,
])('rejects missing, stale, future or replaced HTTP authority: %j', async candidate => {
  await expect(requireHttpContinuation(request, candidate, prefix, now)).rejects.toMatchObject({ status: 410 })
})
it.each([
  [], [{ ...row, id: 8, content: 'New owner request' }], [{ ...row, role: 'assistant' }],
  [{ ...row, content: 'Stop the task' }],
])('does not resume after the owner moved on or completion disappeared: %j', async data => {
  await expect(requireHttpContinuation(async () => ({ data }), token, prefix, now)).rejects.toMatchObject({ status: 410 })
})
it('HTTP failure is unknown authority, never a continuation permit', async () => {
  await expect(requireHttpContinuation(async () => { throw new Error('offline') }, token, prefix, now)).rejects.toThrow('offline')
})
