import { it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'
import { normalizeProviderPreflightFailure, providerSignInNotice } from '../server/run-provider-failure.mjs'

it.each([['claude-opus-5-5', 'Opus'], ['claude-sonnet-4-6', 'Claude'], ['', 'Claude']])('expired sign-in names only the confirmed target (%s)', (model, target) => {
  const result = normalizeProviderPreflightFailure({ status: 'completed', runtime: { model }, output: "No Anthropic credentials found. Run 'hermes auth add anthropic' to sign in, or set ANTHROPIC_TOKEN / ANTHROPIC_API_KEY.", usage: { total_tokens: 0 } })
  expect(result.output).toBe('') // explanation belongs to the shared card, not a duplicate assistant turn
  expect(result.wizard_reconnect.provider).toBe('claude')
  expect(providerSignInNotice("No Anthropic credentials found. Run 'hermes auth add anthropic' to sign in, or set ANTHROPIC_TOKEN / ANTHROPIC_API_KEY.", model)?.message).toContain(`it will send to ${target} on its own.`)
})

it('a dead Claude login fails the chat instead of switching to ChatGPT', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'no-switch-')), attempts: any[] = []
  let connected = false
  const body = JSON.stringify({ session_id: 'same-thread', input: 'Keep this exact original message.', provider: 'anthropic', model: 'claude-opus-5-5' })
  const payload = () => ({ run_id: 'upstream-' + attempts.length, session_id: 'same-thread', status: 'completed', completed: true, runtime: { model: 'claude-opus-5-5', provider: 'anthropic' },
    output: connected ? 'Synthetic Opus reply.' : "No Anthropic credentials found. Run 'hermes auth add anthropic' to sign in, or set ANTHROPIC_TOKEN / ANTHROPIC_API_KEY.",
    usage: { input_tokens: connected ? 1 : 0, output_tokens: connected ? 1 : 0, total_tokens: connected ? 2 : 0 } })
  const q = new DurableRunQueue({ statePath: join(dir, 'runs.db'), pollIntervalMs: 0, activeSessionIds: async () => [],
    launch: async (record: any) => { attempts.push(JSON.parse(record.body)); return { upstreamRunId: 'upstream-' + attempts.length, payload: payload() } }, lookup: async () => ({ payload: payload() }) })
  try {
    const request = { runtime: 'direct', sessionId: 'same-thread', body, requestHash: queueRequestHash('direct', body), idempotencyKey: 'first' }
    const failed = await q.admit(request)
    expect(q.publicPayload(failed.record)).toMatchObject({ status: 'failed', completed: false, error: { type: 'provider_sign_in_expired' } })
    expect(q.publicPayload(failed.record).output).toBe('')
    expect(q.publicPayload(failed.record).runtime.model).toBe('claude-opus-5-5')
    for (let i = 0; i < 3; i++) await q.tick(true)
    expect(attempts).toEqual([JSON.parse(body)]) // no hidden fallback or automatic replay
    connected = true
    const retried = await q.admit({ ...request, idempotencyKey: 'owner-retry' })
    expect(q.publicPayload(retried.record)).toMatchObject({ status: 'completed', output: 'Synthetic Opus reply.' })
    expect(attempts).toEqual([JSON.parse(body), JSON.parse(body)])
    expect(attempts.every(a => a.provider === 'anthropic' && a.model === 'claude-opus-5-5')).toBe(true)
  } finally { q.close(); await rm(dir, { recursive: true, force: true }) }
})
