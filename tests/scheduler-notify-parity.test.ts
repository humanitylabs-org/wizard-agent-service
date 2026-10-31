import { describe, it } from 'vitest'
import { kinds } from '../qa/agent-parity/fixture.mjs'
import { notificationScene, checkBoundNotification, checkFallbackNotification } from '../qa/agent-parity/scheduler-notify.mjs'

describe.each(kinds)('scheduler deliver: notification / %s', kind => {
  it('uses the bound app as that agent, reads silent output internally only, hides its thread, then unhides on fallback', async () => {
    const s = await notificationScene(kind, true)
    try { await checkBoundNotification(s) } finally { await s.close() }
  })

  it('falls back visibly without sending when the notifications app is not bound', async () => {
    const s = await notificationScene(kind, false)
    try { await checkFallbackNotification(s) } finally { await s.close() }
  })
})
