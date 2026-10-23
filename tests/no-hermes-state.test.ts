import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// With WIZARD_HERMES_STATE_PATH unset, the Agent Service must reach Hermes over HTTP only: listing,
// follow-through scans and run admission open only service-owned queue/coordination SQLite files.
const opened: string[] = []
vi.mock('node:sqlite', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:sqlite')>()
  class Watched extends real.DatabaseSync {
    constructor(path: string, options?: object) { opened.push(String(path)); options === undefined ? super(path) : super(path, options as never) }
  }
  return { ...real, DatabaseSync: Watched, default: { ...real, DatabaseSync: Watched } }
})

const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined))))) })

describe('no Hermes state fallback configured', () => {
  it('lists threads, scans follow-throughs and admits runs without opening a Hermes state.db', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wizard-nostate-'))
    mkdirSync(join(home, '.hermes'), { recursive: true })
    writeFileSync(join(home, '.hermes', 'state.db'), '') // a decoy at the old default location
    const seen: string[] = []
    const hermes = createServer((request, response) => {
      seen.push(`${request.method} ${String(request.url).split('?')[0]}`)
      response.writeHead(request.method === 'POST' ? 202 : 200, { 'Content-Type': 'application/json' })
      if (request.url?.startsWith('/api/sessions/') && request.url.includes('/messages')) {
        return response.end(JSON.stringify({ object: 'list', data: [{ id: 2, role: 'assistant', content: 'done', timestamp: Date.now() / 1000 }] }))
      }
      if (request.url?.startsWith('/api/sessions')) {
        return response.end(JSON.stringify({ object: 'list', data: [{ id: 'wizard_x', source: 'api', title: 'x', message_count: 2, last_active: Date.now() / 1000 }] }))
      }
      if (request.url === '/v1/capabilities') return response.end('{"features":{"run_instructions":true}}')
      if (request.method === 'POST' && request.url === '/v1/runs') return response.end('{"run_id":"r1","status":"queued"}')
      response.end('{"status":"completed"}')
    })
    servers.push(hermes)
    await new Promise<void>((r) => hermes.listen(0, '127.0.0.1', () => r()))
    const origin = `http://127.0.0.1:${(hermes.address() as import('node:net').AddressInfo).port}`

    const { createWizardServer, listen } = await import('../server/service.mjs')
    const wizard = createWizardServer({
      hermesKey: 'fixture-key', requireAccess: false, upstreamOrigin: origin, canonicalSessionListing: true,
      joinedDelegation: 'off', runQueueStatePath: join(home, 'queue', 'run-queue.sqlite3'),
      hermesStatePath: '', helmDbPath: '',
    })
    servers.push(wizard)
    await listen(wizard, '127.0.0.1', 0)
    const base = `http://127.0.0.1:${(wizard.address() as import('node:net').AddressInfo).port}`
    const list = await fetch(`${base}/wizard/hermes/api/sessions`)
    expect(list.status).toBe(200)
    const run = await fetch(`${base}/wizard/hermes/v1/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k1' }, body: JSON.stringify({ session_id: 'wizard_x', input: 'hi' }) })
    expect(run.status).toBeLessThan(300)
    await new Promise((r) => setTimeout(r, 5_600)) // one follow-through scan

    expect(seen).toContain('GET /api/sessions')
    expect(seen).toContain('GET /api/sessions/wizard_x/messages')
    // The service lease is a lock-only DB, not Hermes state. storeDirectories resolves aliases
    // (including macOS /var -> /private/var), so allow only this exact canonical lease path.
    const serviceLeasePath = join(realpathSync(join(home, 'queue')), '.agent-pairs.service-lease.sqlite')
    expect(opened.filter((path) => !path.includes('run-queue') && !path.startsWith(join(home, 'queue')) && path !== serviceLeasePath)).toEqual([])
  }, 20_000)
})
