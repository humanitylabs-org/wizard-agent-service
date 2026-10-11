import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'
import { readWizardApps } from '../server/wizard-apps-views.mjs'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

function appsJson() {
  const dir = mkdtempSync(join(tmpdir(), 'wav-'))
  const path = join(dir, 'apps.json')
  writeFileSync(path, JSON.stringify({
    schema: 2, store: 'wizardapps',
    apps: [
      { id: 'defleur-video', name: 'DeFleur Video', type: 'service', category: 'app', uses: ['transcriber', 'browser'], provides: ['video-editing'], view: null,
        summary: 'Cuts video.', status: 'running', mcp: { url: 'http://127.0.0.1:20002/mcp' }, repo: 'humanitylabs-org/defleur-video', commit: 'abc', health: 'http://127.0.0.1:20002/healthz' },
      { id: 'hello-wizard', name: 'Hello Wizard', type: 'view', category: 'interface', uses: ['transcriber'], view: { open: '/apps/hello/' }, status: 'running' },
      { id: 'Bad Id', name: 'x' },
      { id: 'evil', view: 'javascript:alert(1)' },
    ],
  }))
  return path
}

async function start(fetchImpl?: typeof fetch) {
  const calls: string[] = []
  const fake = fetchImpl || (async (url: string | URL) => {
    calls.push(String(url))
    if (String(url).includes('/tags')) return new Response(JSON.stringify({ tags: [{ id: 'audio', count: 1 }] }))
    if (String(url).includes('/search')) return new Response(JSON.stringify({ apps: [{ id: 'transcriber', name: 'Transcriber' }], next_offset: null }))
    return new Response('{"error":"nope"}', { status: 404 })
  }) as unknown as typeof fetch
  const wizard = createWizardServer({ hermesKey: 'fixture-key', requireAccess: false, appsJsonPath: appsJson(), appIndexUrl: 'https://index.test/v1', appIndexFetch: fake })
  servers.push(wizard)
  const address = await listen(wizard)
  return { base: `http://127.0.0.1:${(address as import('node:net').AddressInfo).port}`, calls }
}

describe('App Manager views routes (read-only)', () => {
  it('serves apps.json without MCP addresses, repos, commits or health URLs', async () => {
    const { base } = await start()
    const r = await fetch(`${base}/wizard/v1/wizard-apps`)
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.apps.map((a: { id: string }) => a.id)).toEqual(['defleur-video', 'hello-wizard', 'evil'])
    const dv = body.apps[0]
    expect(dv).toMatchObject({ type: 'service', category: 'app', uses: ['transcriber', 'browser'], view: null, status: 'running' })
    expect(JSON.stringify(body)).not.toMatch(/mcp|20002|healthz|commit|abc/u)
    expect(body.apps[1].view).toEqual({ open: '/apps/hello/' })
    expect(body.apps[2].view).toBeNull()
  })

  it('proxies only index search, tags and app pages, with an allowlisted query and a cache', async () => {
    const { base, calls } = await start()
    const s = await fetch(`${base}/wizard/v1/index/search?q=tr&sort=popular&limit=48&secret=1`)
    expect(s.status).toBe(200)
    expect((await s.json()).apps[0].id).toBe('transcriber')
    expect(calls[0]).toBe('https://index.test/v1/search?q=tr&sort=popular&limit=48')
    await fetch(`${base}/wizard/v1/index/search?q=tr&sort=popular&limit=48`)
    expect(calls.length).toBe(1)
    expect((await fetch(`${base}/wizard/v1/index/tags`)).status).toBe(200)
    expect((await fetch(`${base}/wizard/v1/index/admin`)).status).toBe(404)
    expect((await fetch(`${base}/wizard/v1/index/../../etc/passwd`)).status).toBe(404)
  })

  it('refuses every write, including the index install counter', async () => {
    const { base, calls } = await start()
    for (const path of ['/wizard/v1/wizard-apps', '/wizard/v1/index/installs', '/wizard/v1/index/search']) {
      const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      expect(r.status).toBe(405)
    }
    expect(calls.length).toBe(0)
  })

  it('reports the index as unavailable instead of throwing', async () => {
    const { base } = await start((async () => { throw new Error('offline') }) as unknown as typeof fetch)
    const r = await fetch(`${base}/wizard/v1/index/search`)
    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({ error: 'index_unavailable' })
  })

  it('reads a missing apps.json as an empty list', () => {
    expect(readWizardApps('/nonexistent/apps.json')).toEqual({ schema: 1, store: 'wizardapps', apps: [] })
  })
})
