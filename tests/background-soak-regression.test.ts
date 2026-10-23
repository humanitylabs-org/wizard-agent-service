import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBackgroundResults } from '../server/background-results.mjs'
import { startDelegationFollowThrough } from '../server/delegation-follow-through.mjs'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
const flush = () => new Promise<void>(r => setImmediate(r))

describe('background soak regressions', () => {
  it('defers a busy receipt without consuming it or making repeated admission attempts', async () => {
    let held = true
    const admit = vi.fn(async () => ({})), log = vi.fn()
    const watcher = startDelegationFollowThrough({
      find: () => [{ agent_id: 'hermes', session_id: 'wizard_busy', sessionId: 'wizard_busy', messageId: 1, at: Date.now() / 1000 }],
      enabled: async () => true, busySession: async () => held, admit, log, intervalMs: 60_000,
    })
    try {
      await watcher.tick(); await watcher.tick(); await watcher.tick()
      expect(admit).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled()
      held = false
      await watcher.tick(); await watcher.tick()
      expect(admit).toHaveBeenCalledTimes(1)
    } finally { await watcher.stop() }
  })

  it('revalidates after a busy admission race, retaining exactly-once identity', async () => {
    const keys: string[] = []
    let attempts = 0
    const watcher = startDelegationFollowThrough({
      find: () => [{ agent_id: 'hermes', session_id: 'wizard_race', sessionId: 'wizard_race', messageId: 2, at: Date.now() / 1000 }], enabled: async () => true,
      admit: async (_id: string, _input: string, key: string) => {
        keys.push(key)
        if (!attempts++) throw Object.assign(new Error('Agent already active'), { code: 'helper_session_busy' })
      }, intervalMs: 60_000,
    })
    try {
      await watcher.tick(); await watcher.tick(); await watcher.tick()
      expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1])
    } finally { await watcher.stop() }
  })

  it('finishes a >40-second catalog in bounded slices, including a falsely final full page', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('read deadline', 'TimeoutError')), ms)
      return controller.signal
    })
    const began = Date.now(), offsets: number[] = []
    const bg = createBackgroundResults({ queue: () => null, request: async (path: string, init: any) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 4000)
        init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason) }, { once: true })
      })
      if (path.includes('/messages?')) return { data: [
        { id: 1, role: 'user', content: 'Finish the task', timestamp: began / 1000 - 11000 },
        { id: 2, role: 'user', content: '[ASYNC DELEGATION BATCH COMPLETE — deleg_tail] saved', timestamp: began / 1000 - 10800 },
      ] }
      const offset = Number(new URL(path, 'http://fixture').searchParams.get('offset'))
      offsets.push(offset)
      return { has_more: false, data: offset < 2400
        ? Array.from({ length: Number(new URL(path, 'http://fixture').searchParams.get('limit')) }, (_, i) => ({ id: `cron_${offset + i}` }))
        : [{ id: 'wizard_tail', message_count: 2, last_active: began / 1000 - 10800 }] }
    } })
    let result: any
    for (let n = 0; n < 220; n++) {
      result = await bg.list()
      if (!result.scanning) break
      await vi.advanceTimersByTimeAsync(4000)
    }
    expect(Date.now() - began).toBeGreaterThan(40_000)
    expect(offsets).toContain(2400)
    expect(offsets.filter(x => x === 0)).toHaveLength(1)
    expect(result.available).toBe(true); expect(result.scan_complete).toBe(true)
    expect(result.results.map((r: any) => r.session_id)).toEqual(['wizard_tail'])
  })

  it('uses small catalog pages and at most two concurrent history reads', async () => {
    let active = 0, peak = 0
    const limits: number[] = []
    const bg = createBackgroundResults({ queue: () => null, request: async (path: string) => {
      if (path.includes('/messages?')) {
        peak = Math.max(peak, ++active)
        await flush(); active--
        return { data: [] }
      }
      const url = new URL(path, 'http://fixture')
      const limit = Number(url.searchParams.get('limit')); limits.push(limit)
      return { data: Array.from({ length: 12 }, (_, i) => ({ id: `wizard_load_${i}` })) }
    } })
    for (let n = 0; n < 30; n++) { await bg.list(); await flush() }
    expect(limits).toEqual([50])
    expect(peak).toBe(2)
  })

  it('keeps the failed page cursor, backs off polling, and resumes past 10,000 catalog rows', async () => {
    let clock = 1000, fail = true
    const offsets: number[] = [], warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bg = createBackgroundResults({ now: () => clock, queue: () => ({ byBackgroundRecovery: () => null }), request: async (path: string) => {
      if (path.includes('/messages?')) return { data: [] }
      const url = new URL(path, 'http://fixture'), offset = Number(url.searchParams.get('offset'))
      const limit = Number(url.searchParams.get('limit')); offsets.push(offset)
      if (offset === 50 && fail) throw new DOMException('deadline', 'TimeoutError')
      return { has_more: false, data: offset < 10350 ? Array.from({ length: limit }, (_, i) => ({ id: `cron_${offset + i}` })) : [] }
    } })
    await bg.list(); await flush(); await bg.list(); await flush()
    expect((await bg.list()).available).toBe(false)
    expect(offsets).toEqual([0, 50, 50]); expect(warn).toHaveBeenCalledOnce()
    // Neither polling nor explicit Continue can spin on a persistently failed page.
    for (let i = 0; i < 5; i++) await bg.list()
    await expect(bg.continueOnce('bg_' + 'a'.repeat(32), 'wizard_missing')).rejects.toThrow('history is temporarily unavailable')
    expect(offsets).toEqual([0, 50, 50])
    fail = false; clock += 15001
    let result: any
    for (let n = 0; n < 220; n++) {
      result = await bg.list(); if (!result.scanning) break
      await flush()
    }
    expect(offsets.filter(x => x === 0)).toHaveLength(1)
    expect(offsets).toContain(10350)
    expect(result.available).toBe(true); expect(result.scan_complete).toBe(true)
  })

  it('adapts only bounded read deadlines, retries once with a fresh signal, and still exposes failure', async () => {
    let clock = 1000
    const deadlines: number[] = [], signals: AbortSignal[] = []
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      deadlines.push(ms); return new AbortController().signal
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bg = createBackgroundResults({ now: () => clock, queue: () => null, request: async (path: string, init: any) => {
      signals.push(init.signal)
      const offset = Number(new URL(path, 'http://fixture').searchParams.get('offset'))
      if (offset === 0) { clock += 3500; return { data: Array.from({ length: 50 }, (_, i) => ({ id: `cron_${i}` })) } }
      throw new DOMException('deadline', 'TimeoutError')
    } })
    await bg.list(); await flush(); await bg.list(); await flush()
    expect(deadlines).toEqual([5000, 8000, 10000])
    expect(new Set(signals).size).toBe(3)
    expect((await bg.list()).available).toBe(false); expect(warn).toHaveBeenCalledOnce()
  })

  it('retries a transient read deadline once, but exposes a persistent catalog failure', async () => {
    let attempts = 0
    const request = vi.fn(async () => {
      if (!attempts++) throw new DOMException('busy upstream', 'TimeoutError')
      return { data: [] }
    })
    const bg = createBackgroundResults({ queue: () => null, request })
    await bg.list(); await flush(); await bg.list(); await flush()
    expect((await bg.list()).scan_complete).toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failed = createBackgroundResults({ queue: () => null, request: async () => { throw new DOMException('still busy', 'TimeoutError') } })
    await failed.list(); await flush()
    expect((await failed.list()).available).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
  })
})
