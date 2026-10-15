import { describe, it, expect } from 'vitest'
import { createHiddenCanarySession } from '../scripts/hidden-canary-session.mjs'

describe('hidden canary admission prerequisite', () => {
  it('hides and verifies the session before returning it for test input', async () => {
    const calls: any[] = []
    const fetcher = async (url: string, options: any) => {
      calls.push({ url, ...options })
      return { ok: true, json: async () => ({ session: { hidden: true } }) }
    }
    await createHiddenCanarySession('http://test', { id: 'test_canary', source: 'wizard-mobile' }, fetcher)
    expect(calls.map(call => call.method)).toEqual(['POST', 'PATCH', 'GET'])
    expect(JSON.parse(calls[0].body).hidden).toBe(true)
    expect(JSON.parse(calls[1].body)).toEqual({ hidden: true })
  })
  it('fails closed if hiding is rejected', async () => {
    const calls: string[] = []
    const fetcher = async (_url: string, options: any) => {
      calls.push(options.method)
      return { ok: options.method !== 'PATCH', status: 403, json: async () => ({}) }
    }
    await expect(createHiddenCanarySession('http://test', { id: 'test_canary' }, fetcher)).rejects.toThrow('PATCH failed')
    expect(calls).toEqual(['POST', 'PATCH'])
  })
  it.each([false, undefined, 'true'])('fails closed when readback hidden is %s', async hidden => {
    const fetcher = async () => ({ ok: true, json: async () => ({ session: { hidden } }) })
    await expect(createHiddenCanarySession('http://test', { id: 'test_canary' }, fetcher)).rejects.toThrow('Refusing test input')
  })
})
