// Issue 513: one looping device (PUT /wizard/thread-seen, ~120 KB, ~8 a second) froze Chats on every device.
// The service now shares identical in-flight writes, caps each device + route and says so in /wizard/health.
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { createWizardServer, listen } from '../server/service.mjs'
import { BUFFERED_BODY, createClientStormGuard, deviceOf } from '../server/client-storm.mjs'

const servers: import('node:http').Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections?.(); await new Promise(r => s.close(() => r(undefined))) }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const PHONE = 'WizardPhone/1.0 (synthetic looping device)'
const MAC = 'WizardMac/1.0 (synthetic second device)'

// ~120 KB of synthetic seen records (the cap is 500 records).
function seenState(seed = 0) {
  const at = Date.parse('2026-11-13T06:00:00Z')
  const threads: Record<string, unknown> = {}
  for (let i = 0; i < 500; i++) threads[`hermes:wizard_${String(i).padStart(4, '0')}_${'s'.repeat(150)}`] = { updatedAt: new Date(at + i * 1000).toISOString(), previewFingerprint: `fp${i}`, seenAt: at + i * 1000 + seed }
  return { initializedAt: at - 86_400_000, threads }
}

async function box(clientStorm?: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'client-storm-'))
  dirs.push(dir)
  const now = Date.now() / 1000
  const rows = Array.from({ length: 120 }, (_, i) => ({ id: `wizard_synthetic_${i}`, source: 'api_server', title: `Synthetic ${i}`, hidden: false, parent_session_id: null, message_count: 2, last_active: now - i, started_at: now - i, archived: false, latest_message: { role: 'assistant', content: 'synthetic reply', timestamp: now - i } }))
  const up = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    const url = new URL(req.url ?? '/', 'http://fixture')
    if (url.pathname === '/api/sessions') { res.end(JSON.stringify({ data: rows, has_more: false })); return }
    if (url.pathname === '/v1/capabilities') { res.end('{}'); return }
    res.end('{}')
  })
  servers.push(up)
  const u = await listen(up) as import('node:net').AddressInfo
  const svc = createWizardServer({
    upstreamOrigin: `http://127.0.0.1:${u.port}`, hermesKey: 'synthetic-api-key', requireAccess: false, agents: false, agentBridge: false,
    followThrough: false, joinedDelegation: 'off', wizardOsHome: dir, canonicalSessionReader: () => rows, runQueue: false,
    threadSeenStatePath: join(dir, 'seen.json'), threadDispositionStatePath: join(dir, 'dispositions.json'), settingsPath: join(dir, 'settings.json'),
    ...(clientStorm ? { clientStorm } : {}),
  })
  servers.push(svc)
  const a = await listen(svc) as import('node:net').AddressInfo
  return `http://127.0.0.1:${a.port}`
}

const putSeen = (base: string, body: string, agent = PHONE) => fetch(`${base}/wizard/thread-seen`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'User-Agent': agent }, body })
async function timed(url: string) {
  const started = performance.now()
  const r = await fetch(url, { headers: { 'User-Agent': MAC } })
  await r.arrayBuffer()
  return { status: r.status, ms: performance.now() - started }
}

describe('client storm guard over HTTP (issue 513)', () => {
  it('500 identical 120 KB PUTs from one device keep /wizard/health and the sessions list under 500 ms for another device', async () => {
    const base = await box()
    const body = JSON.stringify(seenState())
    expect(body.length).toBeGreaterThan(110_000)
    // The second device already has Chats open: its first (cold) list read is not part of the measure.
    await timed(`${base}/wizard/hermes/api/sessions?limit=100`)
    await timed(`${base}/wizard/health`)
    const statuses = new Map<number, number>()
    let sent = 0
    let retryAfter = ''
    const storm = (async () => {
      while (sent < 500) {
        const burst = Array.from({ length: Math.min(50, 500 - sent) }, () => putSeen(base, body).then(async r => {
          statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1)
          if (r.status === 429) retryAfter = r.headers.get('retry-after') ?? ''
          await r.arrayBuffer()
        }))
        sent += burst.length
        await Promise.all(burst)
      }
    })()
    const probes: { status: number, ms: number }[] = []
    while (sent < 500) {
      probes.push(await timed(`${base}/wizard/health`))
      probes.push(await timed(`${base}/wizard/hermes/api/sessions?limit=100`))
    }
    await storm
    probes.push(await timed(`${base}/wizard/health`), await timed(`${base}/wizard/hermes/api/sessions?limit=100`))
    if (process.env.STORM_DEBUG) console.log(JSON.stringify(probes.map(p => Math.round(p.ms))))
    expect(probes.every(p => p.status === 200)).toBe(true)
    expect(Math.max(...probes.map(p => p.ms))).toBeLessThan(500)
    // Never queued: past 60 a minute the device is told to back off.
    expect(statuses.get(429)).toBeGreaterThan(300)
    expect((statuses.get(200) ?? 0)).toBeLessThanOrEqual(60)
    expect(Number(retryAfter)).toBeGreaterThan(0)
    // The other device's own write still goes through.
    expect((await putSeen(base, JSON.stringify(seenState(1)), MAC)).status).toBe(200)
    const health = await (await fetch(`${base}/wizard/health`)).json()
    expect(health.status).toBe('ok')
    expect(health.client_storm.tripping).toHaveLength(1)
    expect(health.client_storm.tripping[0]).toMatchObject({ route: '/wizard/thread-seen', rate: 500 })
    expect(health.client_storm.tripping[0].body_bytes).toBe(Buffer.byteLength(body))
    expect(health.client_storm.tripping[0].device).toMatch(/^d-[0-9a-f]{10}$/)
  }, 60_000)

  it('identical concurrent writes share one answer; a different body still saves', async () => {
    const base = await box({ perMinute: 1000 })
    const body = JSON.stringify(seenState())
    const answers = await Promise.all(Array.from({ length: 20 }, () => putSeen(base, body).then(async r => ({ status: r.status, text: await r.text() }))))
    expect(answers.every(a => a.status === 200)).toBe(true)
    expect(new Set(answers.map(a => a.text)).size).toBe(1)
    const changed = await putSeen(base, JSON.stringify(seenState(5)))
    expect(changed.status).toBe(200)
    const state = (await (await fetch(`${base}/wizard/thread-seen`)).json()).state
    expect(Object.values(state.threads).some((r: any) => (r.seenAt - Date.parse('2026-11-13T06:00:00Z')) % 1000 === 5)).toBe(true)
  }, 30_000)

  it('a few ordinary concurrent preference writes are never refused', async () => {
    const base = await box()
    const put = (value: unknown) => fetch(`${base}/wizard/v1/ui-preferences`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
    const results = await Promise.all([put({ compact: true }), put({ readyOrder: 'subject' }), put({ archiveAfterDays: 14 })])
    expect(results.map(r => r.status)).toEqual([200, 200, 200])
  })
})

function fakeRequest(body: string, { method = 'PUT', agent = PHONE } = {}) {
  const request = Readable.from([Buffer.from(body)]) as any
  request.method = method
  request.headers = { 'content-length': String(Buffer.byteLength(body)), 'content-type': 'application/json', 'user-agent': agent }
  request.socket = { remoteAddress: '127.0.0.1' }
  return request
}
function fakeResponse() {
  const headers: Record<string, unknown> = {}
  const response: any = { statusCode: 200, body: Buffer.alloc(0), headers,
    getHeaders: () => ({}),
    writeHead(status: number, h: Record<string, unknown>) { this.statusCode = status; Object.assign(headers, h); return this },
    write(chunk: Buffer) { this.body = Buffer.concat([this.body, Buffer.from(chunk)]); return true },
    end(chunk?: Buffer | string) { if (chunk) this.body = Buffer.concat([this.body, Buffer.from(chunk)]); return this } }
  return response
}

describe('createClientStormGuard (issue 513)', () => {
  it('shares, caps in-flight, caps the rate, logs once a minute and resets the next minute', async () => {
    let clock = 1_000_000
    const lines: string[] = []
    const guard = createClientStormGuard({ inFlight: 2, perMinute: 6, now: () => clock, log: line => lines.push(line) })
    const lead = await guard.admit(fakeRequest('{"a":1}'), '/wizard/thread-seen') as any
    expect(lead.status).toBe('lead')
    const response = fakeResponse()
    const read = lead.watch(response)
    const joinedRequest = fakeRequest('{"a":1}')
    const joined = guard.admit(joinedRequest, '/wizard/thread-seen')
    await new Promise(r => setTimeout(r, 5))
    expect(joinedRequest[BUFFERED_BODY].toString()).toBe('{"a":1}')
    // Two different bodies fill the in-flight cap; the third is refused (never queued).
    const second = await guard.admit(fakeRequest('{"a":2}'), '/wizard/thread-seen') as any
    expect(second.status).toBe('lead')
    expect(await guard.admit(fakeRequest('{"a":3}'), '/wizard/thread-seen')).toEqual({ status: 'refused', retryAfter: 1 })
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"state":1}')
    lead.release(read)
    second.release(() => null)
    expect(await joined).toEqual({ status: 'joined', result: { status: 200, headers: { 'Content-Type': 'application/json' }, body: Buffer.from('{"state":1}') } })
    // Other devices and other routes have their own lanes.
    expect((await guard.admit(fakeRequest('{"a":3}', { agent: MAC }), '/wizard/thread-seen') as any).status).toBe('lead')
    expect(await guard.admit(fakeRequest('{}', { method: 'GET' }), '/wizard/thread-seen')).toBeNull()
    expect(await guard.admit(fakeRequest('{}', { method: 'POST' }), '/wizard/hermes/v1/runs')).toBeNull()
    // Rate: 4 so far on the phone's lane, 2 more pass, the 7th is refused with the rest of the minute.
    for (let i = 0; i < 2; i++) (await guard.admit(fakeRequest(`{"b":${i}}`), '/wizard/thread-seen') as any).release()
    clock += 10_000
    expect(await guard.admit(fakeRequest('{"c":1}'), '/wizard/thread-seen')).toEqual({ status: 'refused', retryAfter: 50 })
    expect(await guard.admit(fakeRequest('{"c":2}'), '/wizard/thread-seen')).toEqual({ status: 'refused', retryAfter: 50 })
    // One line per device + route per minute, however often it trips.
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0].replace('[client-storm] ', ''))).toMatchObject({ device: deviceOf(fakeRequest('')), route: '/wizard/thread-seen', rate: 4, in_flight: 2, body_bytes: 7 })
    expect(guard.summary()?.tripping[0]).toMatchObject({ route: '/wizard/thread-seen', refused: 3 })
    clock += 50_000
    expect((await guard.admit(fakeRequest('{"c":3}'), '/wizard/thread-seen') as any).status).toBe('lead')
    clock += 120_000
    expect(guard.summary()).toBeNull()
  })
})
