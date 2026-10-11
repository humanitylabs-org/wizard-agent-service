import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createWizardServer, listen } from '../server/service.mjs'
import { FOLLOW_THROUGH_PREFIX } from '../server/delegation-follow-through.mjs'

// Two Agent Services on one Hermes (staging beside the daily driver): only the one with follow-through
// on may start automatic turns on shared threads. followThrough: false must never admit a run.
const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined))))) })

async function startHermes() {
  const posted: string[] = []
  const server = createServer((request, response) => {
    if (request.method === 'POST') posted.push(request.url ?? '')
    // Stock Hermes HTTP only: no state.db anywhere in this test.
    if (request.url?.startsWith('/api/sessions?')) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      return response.end(JSON.stringify({ object: 'list', data: [{ id: 'wizard_shared', last_active: Date.now() / 1000, message_count: 1 }] }))
    }
    if (request.url?.startsWith('/api/sessions/wizard_shared/messages')) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      return response.end(JSON.stringify({ object: 'list', data: [{ id: 7, role: 'user', content: `${FOLLOW_THROUGH_PREFIX} — deleg_1] results`, timestamp: Date.now() / 1000, display_kind: 'async_delegation_complete' }] }))
    }
    if (request.url === '/v1/capabilities') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      return response.end(JSON.stringify({ features: { run_instructions: true, markdown_rendering: true } }))
    }
    response.writeHead(202, { 'Content-Type': 'application/json' }); response.end('{"run_id":"r1","status":"queued"}')
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const address = server.address() as import('node:net').AddressInfo
  return { origin: `http://127.0.0.1:${address.port}`, posted }
}

describe('follow-through ownership with two services on one Hermes', () => {
  async function runFor(followThrough: boolean | undefined) {
    const hermes = await startHermes()
    const options: Record<string, unknown> = { hermesKey: 'fixture-key', requireAccess: false, upstreamOrigin: hermes.origin,
      joinedDelegation: 'off' }
    if (followThrough !== undefined) options.followThrough = followThrough
    const wizard = createWizardServer(options)
    servers.push(wizard)
    await listen(wizard, '127.0.0.1', 0)
    await new Promise((r) => setTimeout(r, 6500)) // the watcher scans every 5 s
    return hermes.posted.filter((u) => u.includes('/v1/runs'))
  }

  it('the default service starts the follow-through turn (control)', async () => {
    expect((await runFor(undefined)).length).toBeGreaterThan(0)
  }, 15000)

  it('followThrough: false (the staging copy) never starts a turn on the shared thread', async () => {
    expect(await runFor(false)).toEqual([])
  }, 15000)
})
