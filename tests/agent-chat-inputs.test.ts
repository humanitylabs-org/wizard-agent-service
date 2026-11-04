import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentChatInputs } from '../server/agent-chat-inputs.mjs'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const body = JSON.stringify({ input: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,synthetic-fixture-only' } }] }] })
it('keeps colliding sessions/runs and deletion scoped to the exact agent pair across restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'chat-inputs-')); roots.push(root)
  const path = join(root, 'receipts.sqlite3')
  let store = new AgentChatInputs(path)
  store.note('fixture-a', 'same-session', 'same-run', body, 100)
  store.note('fixture-a', 'same-session', 'same-run', body, 101)
  store.note('fixture-b', 'same-session', 'same-run', body.replace('Synthetic', 'Other'), 102)
  store.note('fixture-a', 'other-session', 'same-run', body, 103)
  expect(store.forSession('fixture-a', 'same-session')).toEqual([{ body, createdAt: 100 }])
  expect(store.forSession('fixture-a', 'missing')).toEqual([])
  store.close(); store = new AgentChatInputs(path)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(store.forSession('fixture-b', 'same-session')[0].body).toContain('Other')
  store.forget('fixture-a', 'same-session')
  expect(store.forSession('fixture-a', 'same-session')).toEqual([])
  expect(store.forSession('fixture-b', 'same-session')).toHaveLength(1)
  expect(store.forSession('fixture-a', 'other-session')).toHaveLength(1)
  store.close()
})
it('does not retain text-only turns and keeps distinct screenshot steers in one run', () => {
  const store = new AgentChatInputs()
  store.note('fixture-a', 'same-session', 'one-run', JSON.stringify({ input: 'Synthetic text only' }), 100)
  expect(store.forSession('fixture-a', 'same-session')).toEqual([])
  store.note('fixture-a', 'same-session', 'one-run', body, 101)
  store.note('fixture-a', 'same-session', 'one-run', body.replace('Synthetic', 'Steer'), 102)
  expect(store.forSession('fixture-a', 'same-session')).toHaveLength(2)
  store.close()
})
