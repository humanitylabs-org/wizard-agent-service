import { it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'

it('a dead Claude login fails the chat instead of switching to ChatGPT', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'no-switch-')), attempts: any[] = []
  let connected = false
  const body = JSON.stringify({ session_id: 'same-thread', input: 'Keep this exact original message.', provider: 'anthropic', model: 'claude-opus-5-5' })
  const payload = () => ({ run_id: 'upstream-' + attempts.length, session_id: 'same-thread', status: 'completed', completed: true,
    output: connected ? 'Synthetic Opus reply.' : "No Anthropic credentials found. Run 'hermes auth add anthropic' to sign in, or set ANTHROPIC_TOKEN / ANTHROPIC_API_KEY.",
    usage: { input_tokens: connected ? 1 : 0, output_tokens: connected ? 1 : 0, total_tokens: connected ? 2 : 0 } })
  const q = new DurableRunQueue({ statePath: join(dir, 'runs.db'), pollIntervalMs: 0, activeSessionIds: async () => [],
    launch: async (record: any) => { attempts.push(JSON.parse(record.body)); return { upstreamRunId: 'upstream-' + attempts.length, payload: payload() } }, lookup: async () => ({ payload: payload() }) })
  try {
    const request = { runtime: 'direct', sessionId: 'same-thread', body, requestHash: queueRequestHash('direct', body), idempotencyKey: 'first' }
    const failed = await q.admit(request)
    expect(q.publicPayload(failed.record)).toMatchObject({ status: 'failed', completed: false, error: { type: 'provider_sign_in_expired' } })
    expect(q.publicPayload(failed.record).output).toContain("this message wasn't sent to Opus")
    for (let i = 0; i < 3; i++) await q.tick(true)
    expect(attempts).toEqual([JSON.parse(body)]) // no hidden fallback or automatic replay
    connected = true
    const retried = await q.admit({ ...request, idempotencyKey: 'owner-retry' })
    expect(q.publicPayload(retried.record)).toMatchObject({ status: 'completed', output: 'Synthetic Opus reply.' })
    expect(attempts).toEqual([JSON.parse(body), JSON.parse(body)])
    expect(attempts.every(a => a.provider === 'anthropic' && a.model === 'claude-opus-5-5')).toBe(true)
  } finally { q.close(); await rm(dir, { recursive: true, force: true }) }
})
