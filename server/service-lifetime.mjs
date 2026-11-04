// The restore fence outlives HTTP: stop producers, drain continuations, then close handles.
export function serviceLifetime(release, { drainTimeoutMs = 30_000 } = {}) {
  const resources = [], leases = [release], requests = new Set()
  let draining
  const lifetime = {
    closing: false,
    lease(releaseLease) { leases.push(releaseLease) },
    own(close, stop = () => {}) { resources.push({ close, stop }) },
    request() {
      let done
      const pending = new Promise(resolve => { done = resolve })
      requests.add(pending)
      return () => { requests.delete(pending); done() }
    },
    track(promise) {
      const done = lifetime.request()
      return Promise.resolve(promise).finally(done)
    },
    drain() {
      if (draining) return draining
      lifetime.closing = true
      // Stop every timer immediately, before waiting on any one continuation.
      const stops = resources.map(({ stop }) => { try { return Promise.resolve(stop()) } catch (e) { return Promise.reject(e) } })
      let timedOut = false, timer
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(new Error(`writer drain timed out after ${drainTimeoutMs}ms; service lease retained until process exit`))
        }, drainTimeoutMs)
        timer.unref?.()
      })
      const work = (async () => {
        await Promise.all(stops)
        while (requests.size) await Promise.all([...requests])
        for (const { close } of [...resources].reverse()) await close()
        // A timeout is an operator-visible failed shutdown, not permission to
        // restore. Even if the abandoned continuation settles later, keep fence.
        if (!timedOut) for (const releaseLease of leases.reverse()) releaseLease()
      })()
      draining = Promise.race([work, deadline]).finally(() => clearTimeout(timer))
      // A failed teardown must retain the fence, not grant restore permission.
      void draining.catch(error => console.error('[agent-pairs] writer teardown failed; service lease retained:', error.message))
      return draining
    },
  }
  return lifetime
}
