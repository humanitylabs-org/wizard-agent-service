import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'

const services: ReturnType<typeof createWizardServer>[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(services.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve()))))
})

async function fixture(extra = {}) {
  let mode = 'ready'
  const fetchImpl = vi.fn(async (url: string, { signal }: RequestInit = {}) => {
    if (!url.startsWith('http://127.0.0.1:8864/')) return Response.json({ features: {} })
    if (mode === 'slow') return await new Promise<Response>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
    })
    if (mode.startsWith('models-') && url.endsWith('/health')) return new Response('', { status: 404 })
    if (mode === 'models-ready') return Response.json({ data: [{ id: 'fixture-local' }] })
    if (mode === 'models-timeout') throw Object.assign(new Error('models slow'), { name: 'TimeoutError' })
    if (mode === 'timeout' || mode === 'abort') throw Object.assign(new Error('probe interrupted'), { name: mode === 'timeout' ? 'TimeoutError' : 'AbortError' })
    if (mode === 'refused') throw new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) })
    return new Response(JSON.stringify({ status: mode === 'ready' ? 'ok' : 'error', provider: 'tinfoil', model: 'fixture' }))
  })
  const svc = createWizardServer({ requireAccess: false, followThrough: false, agents: false, fetchImpl, ...extra })
  services.push(svc)
  const base = `http://127.0.0.1:${(await listen(svc)).port}`
  const boot = async () => (await fetch(`${base}/wizard/v1/bootstrap`)).json()
  const status = async () => (await fetch(`${base}/wizard/voice/status`)).json()
  const now = Date.now()
  let elapsed = 0
  vi.spyOn(Date, 'now').mockImplementation(() => now + elapsed)
  return { boot, status, fetchImpl, mode: (next: string) => { mode = next }, age: (ms: number) => { elapsed = ms } }
}

describe('STT timeout is unknown, not a confirmed outage', () => {
  it.each(['timeout', 'abort'])('keeps voice and its endpoint for 15 minutes after ready on %s, without renewing confirmation', async mode => {
    const f = await fixture()
    expect((await f.boot()).capabilities.voice).toBe(true)
    f.mode(mode)
    for (const age of [180_000, 899_000, 900_000]) {
      f.age(age)
      expect(await f.boot()).toMatchObject({ capabilities: { voice: true }, endpoints: { transcribe: '/wizard/voice/transcribe' } })
      expect(await f.status()).toMatchObject({ ready: true })
    }
    f.age(901_000)
    expect((await f.boot()).capabilities.voice).toBe(false)
  })

  it('a slow health request really reaches the 800 ms abort and keeps voice', async () => {
    const f = await fixture()
    expect((await f.boot()).capabilities.voice).toBe(true)
    f.mode('slow')
    f.age(180_000)
    expect((await f.boot()).capabilities.voice).toBe(true)
  })

  it('an OpenAI-compatible models timeout also keeps the confirmed voice', async () => {
    const f = await fixture()
    f.mode('models-ready')
    expect((await f.boot()).capabilities.voice).toBe(true)
    f.mode('models-timeout')
    f.age(180_000)
    expect((await f.boot()).capabilities.voice).toBe(true)
  })

  it('bootstrap connection refused after cache expiry does not get timeout grace', async () => {
    const f = await fixture()
    expect((await f.boot()).capabilities.voice).toBe(true)
    f.age(31_000)
    f.mode('refused')
    expect(await f.boot()).toMatchObject({ capabilities: { voice: false }, endpoints: { transcribe: '' } })
  })

  it('connection refused after one second disables voice immediately on a fresh probe', async () => {
    const f = await fixture()
    expect((await f.boot()).capabilities.voice).toBe(true)
    f.age(1000)
    f.mode('refused')
    expect(await f.status()).toMatchObject({ ready: false })
    expect(await f.boot()).toMatchObject({ capabilities: { voice: false }, endpoints: { transcribe: '' } })
  })

  it('a definite not-ready answer clears the last confirmation, including after a subsequent timeout', async () => {
    const f = await fixture()
    expect((await f.boot()).capabilities.voice).toBe(true)
    f.mode('not-ready')
    expect(await f.status()).toMatchObject({ ready: false })
    f.mode('timeout')
    f.age(31_000)
    expect((await f.boot()).capabilities.voice).toBe(false)
  })

  it('retries an unknown probe in the background, with no further bootstrap request', async () => {
    const f = await fixture()
    expect((await f.boot()).capabilities.voice).toBe(true)
    f.mode('timeout')
    f.age(180_000)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    expect((await f.boot()).capabilities.voice).toBe(true)
    f.mode('ready')
    f.fetchImpl.mockClear()
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.fetchImpl).toHaveBeenCalled()
    f.fetchImpl.mockClear()
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })

  it('WIZARD_STT_ENABLED=0 (sttConfigured: false) stays off without probing', async () => {
    const f = await fixture({ sttConfigured: false })
    expect((await f.boot()).capabilities.voice).toBe(false)
    expect(await f.status()).toMatchObject({ ready: false, name: 'Voice off' })
    expect(f.fetchImpl.mock.calls.filter(([url]) => url.startsWith('http://127.0.0.1:8864/'))).toHaveLength(0)
  })
})
