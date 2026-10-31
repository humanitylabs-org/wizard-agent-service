import { Worker } from 'node:worker_threads'
import { createListEvidenceReader } from './list-evidence.mjs'

// One worker per service, bounded request batches supplied by projectListSlices.
// No controllers, write handles, credentials or private-agent paths cross here.
export function createListEvidenceLane({ hermesStatePath, enabled = true, log = console.log,
  workerUrl = new URL('./list-evidence-worker.mjs', import.meta.url), timeoutMs = 120_000 } = {}) {
  let worker, failed = false, closed = false, sequence = 0, fallback
  const pending = new Map()
  const stats = { reads: 0, worker_reads: 0, fallbacks: 0, last_ms: 0, last_main_ms: 0, max_main_ms: 0 }
  const fail = () => {
    if (failed || closed) return
    failed = true
    log('[list-cache] evidence worker unavailable; using the in-thread reader')
    const old = worker; worker = null; void old?.terminate().catch(() => undefined)
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('list evidence worker unavailable')) }
    pending.clear()
  }
  const start = () => {
    if (worker || failed || closed || !enabled) return
    try {
      worker = new Worker(workerUrl, { workerData: { hermesStatePath } })
      worker.on('error', fail)
      worker.on('exit', () => { if (!closed) fail() })
      worker.on('message', ({ id, value, error }) => {
        const entry = pending.get(id)
        if (!entry) return
        if (error) { fail(); return }
        pending.delete(id); clearTimeout(entry.timer); entry.resolve(value)
        if (!pending.size) worker.unref()
      })
      worker.unref()
    } catch { fail() }
  }
  return {
    stats: () => ({ ...stats, pending: pending.size, failed }),
    async read(input) {
      if (closed) throw new Error('list evidence lane closed')
      const started = performance.now()
      stats.reads++
      start()
      if (worker && !failed) {
        try {
          const value = await new Promise((resolve, reject) => {
            const id = ++sequence
            const timer = setTimeout(fail, timeoutMs); timer.unref?.()
            pending.set(id, { resolve, reject, timer })
            try { worker.ref(); worker.postMessage({ id, input }) } catch { fail() }
          })
          stats.worker_reads++; stats.last_ms = performance.now() - started
          return value
        } catch { if (closed) throw new Error('list evidence lane closed') }
      }
      stats.fallbacks++
      fallback ??= createListEvidenceReader(hermesStatePath)
      const at = performance.now(), value = fallback.read(input)
      stats.last_main_ms = performance.now() - at
      stats.max_main_ms = Math.max(stats.max_main_ms, stats.last_main_ms)
      stats.last_ms = performance.now() - started
      return value
    },
    async close() {
      if (closed) return
      closed = true
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('list evidence lane closed')) }
      pending.clear(); fallback?.close()
      const old = worker; worker = null
      await old?.terminate()
    },
  }
}
