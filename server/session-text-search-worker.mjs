// Message-body search can scan a runtime's entire historical text. Never run it
// on the shared HTTP event loop: aborting a browser fetch cannot interrupt SQLite.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { searchHermesSessionText } from './session-truth.mjs'

if (!isMainThread && workerData?.kind === 'wizard-session-text-search') {
  const { path, ids, query } = workerData
  const hits = new Map()
  for (let i = 0; i < ids.length; i += 200) {
    for (const [id, text] of searchHermesSessionText(path, ids.slice(i, i + 200), query)) hits.set(id, text)
  }
  parentPort.postMessage([...hits])
}

// Share identical in-flight searches and bound CPU/memory across clients. The
// deadline covers queue time as well as SQLite execution, terminating late work.
const pending = new Map(), queue = []
let active = 0
const MAX_ACTIVE = 2, MAX_PENDING = 16, DEADLINE_MS = 30_000
const unavailable = message => Object.assign(new Error(message), { status: 503 })
function pump() {
  while (active < MAX_ACTIVE && queue.length) queue.shift()()
}
export function searchHermesSessionTextAsync(path, sessionIds, query) {
  const ids = [...new Set(sessionIds.filter(id => typeof id === 'string' && id.length <= 256))]
  if (!ids.length || !String(query || '').trim()) return Promise.resolve(new Map())
  const key = JSON.stringify([path, ids, query])
  if (pending.has(key)) return pending.get(key)
  if (pending.size >= MAX_PENDING) return Promise.reject(unavailable('session search busy'))
  const promise = new Promise((resolve, reject) => {
    let worker, done = false, started = false
    const finish = (error, result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      const index = queue.indexOf(start)
      if (index >= 0) queue.splice(index, 1)
      const release = () => { if (started) active--; pump() }
      // Do not admit replacement work until the old SQLite worker really stopped.
      if (worker) void worker.terminate().then(release, release)
      else release()
      if (error) reject(error); else resolve(new Map(result))
    }
    const start = () => {
      if (done) return
      started = true; active++
      try {
        worker = new Worker(new URL(import.meta.url), {
          workerData: { kind: 'wizard-session-text-search', path, ids, query },
          resourceLimits: { maxOldGenerationSizeMb: 256 },
        })
        worker.once('message', rows => finish(null, rows))
        worker.once('error', error => finish(error))
        worker.once('exit', code => { if (!done) finish(unavailable(`session search exited (${code})`)) })
      } catch (error) { finish(error) }
    }
    const timer = setTimeout(() => finish(unavailable('session search deadline exceeded')), DEADLINE_MS)
    timer.unref?.()
    queue.push(start)
    pump()
  })
  pending.set(key, promise)
  const clear = () => { if (pending.get(key) === promise) pending.delete(key) }
  promise.then(clear, clear)
  return promise
}
