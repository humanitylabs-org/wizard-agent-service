// Issue 501: a seen-state save of many threads must not re-read and re-parse apps.json / grants.json per thread.
// The frozen box spent 9.6 s of 10 s in qualifySeenInput -> sideAgent -> agents.read -> appAgentRuntimes.
import { mkdtempSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const reads = vi.hoisted(() => ({ files: [] as string[] }))
vi.mock('node:fs', async (load) => {
  const fs = await load<typeof import('node:fs')>()
  const readFileSync = ((path: any, ...rest: any[]) => { reads.files.push(String(path)); return (fs.readFileSync as any)(path, ...rest) }) as typeof fs.readFileSync
  return { ...fs, default: { ...fs, readFileSync }, readFileSync }
})

const { createWizardServer, listen } = await import('../server/service.mjs')
const { appAgentRuntimes } = await import('../server/app-agent-runtimes.mjs')

const servers: import('node:http').Server[] = []
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined))) })

const agentApp = { id: 'agent-example', type: 'agent', name: 'Example', agent_runtime: { id: 'example', label: 'Example', harness: 'another-harness', port: 18659, host_port: 28659, model: { provider: 'wizard-router', model: 'reply' } } }
const grants = { outgoing: { 'agent-example': 'a'.repeat(64) }, provider_endpoints: { 'agent-example': 'http://agent-example:18659' } }

// About the size of the live box's apps.json (369 KB): many apps plus a large connections block.
function bigApps() {
  const apps: unknown[] = [agentApp]
  for (let i = 0; i < 150; i++) apps.push({ id: `app-${i}`, name: `App ${i}`, status: 'running', view: { url: `/app-${i}/` }, description: 'x'.repeat(800) })
  return { schema: 1, apps, connections: { apps: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`c-${i}`, { note: 'y'.repeat(480) }])) } }
}

function box() {
  const dir = mkdtempSync(join(tmpdir(), 'seen-registry-'))
  writeFileSync(join(dir, 'apps.json'), JSON.stringify(bigApps()))
  writeFileSync(join(dir, 'grants.json'), JSON.stringify(grants))
  return dir
}

async function start(dir: string) {
  const svc = createWizardServer({
    upstreamOrigin: 'http://127.0.0.1:9', hermesKey: 'fixture-key', requireAccess: false, agentBridge: false,
    appsJsonPath: join(dir, 'apps.json'), appRuntimeGrantsPath: join(dir, 'grants.json'), launcherPath: join(dir, 'launcher.json'),
    settingsPath: join(dir, 'settings.json'), wizardOsHome: dir, followThrough: false, joinedDelegation: 'off',
    threadDispositionStatePath: join(dir, 'dispositions.json'), threadSeenStatePath: join(dir, 'seen.json'),
  })
  servers.push(svc)
  const address = await listen(svc) as import('node:net').AddressInfo
  return `http://127.0.0.1:${address.port}`
}

const put = (base: string, body: unknown) => fetch(`${base}/wizard/thread-seen`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const record = (seenAt: number, agent_id?: string, session_id?: string) => ({ updatedAt: new Date(seenAt).toISOString(), previewFingerprint: 'abc', seenAt, ...(agent_id ? { agent_id, session_id } : {}) })

describe('seen-state saves and the app registry (issue 501)', () => {
  it('1,000 seen records finish in under 100 ms and read apps.json and grants.json once per file version', async () => {
    const dir = box()
    const base = await start(dir)
    // Warm-up save: the first request also loads the seen store and the registry.
    expect((await put(base, { initializedAt: 1000, threads: { 'direct:warm': record(1000) } })).status).toBe(200)
    const threads: Record<string, unknown> = {}
    // The store keeps at most 500 marks per save, so half are retired-agent marks a stale device still sends
    // (dropped after the same agent lookup).
    for (let i = 0; i < 1000; i++) {
      if (i < 250) threads[`agent/example/direct:wizard_app_${i}`] = record(2000 + i, 'example', `wizard_app_${i}`)
      else if (i < 500) threads[`direct:wizard_main_${i}`] = record(2000 + i)
      else threads[`agent/retired/direct:wizard_old_${i}`] = record(2000 + i, 'retired', `wizard_old_${i}`)
    }
    // A fresh file version, as App Manager writes it (atomic rename), so the save may parse it once.
    writeFileSync(join(dir, 'apps.next'), JSON.stringify(bigApps())); renameSync(join(dir, 'apps.next'), join(dir, 'apps.json'))
    reads.files.length = 0
    const started = performance.now()
    const response = await put(base, { initializedAt: 1000, threads })
    const elapsed = performance.now() - started
    expect([response.status, response.status === 200 ? '' : await response.text()]).toEqual([200, ''])
    const saved = (await response.json()).state.threads
    expect(saved['agent/example/direct:wizard_app_1']).toMatchObject({ agent_id: 'example', session_id: 'wizard_app_1' })
    expect(saved['direct:wizard_main_250']).toBeTruthy()
    expect(Object.keys(saved).length).toBe(500)
    expect(Object.keys(saved).some((k) => k.includes('retired'))).toBe(false)
    // Once per file version, never per record: one parse for app agents, one for the new-app sync (before: 1,501).
    expect(reads.files.filter((f) => f === join(dir, 'apps.json')).length).toBeLessThanOrEqual(2)
    expect(reads.files.filter((f) => f === join(dir, 'grants.json')).length).toBeLessThanOrEqual(1)
    console.log(`issue 501: 1,000 seen records in ${elapsed.toFixed(1)} ms`)
    expect(elapsed).toBeLessThan(100)
    // Files unchanged: the next save reads neither of them.
    reads.files.length = 0
    expect((await put(base, { initializedAt: 1000, threads })).status).toBe(200)
    expect(reads.files.filter((f) => f === join(dir, 'apps.json') || f === join(dir, 'grants.json'))).toEqual([])
  })

  it('re-reads the registry when App Manager rewrites either file, and callers cannot change the cached rows', () => {
    const dir = box()
    const apps = join(dir, 'apps.json'), grantsPath = join(dir, 'grants.json')
    const first = appAgentRuntimes(apps, grantsPath)
    expect(first.map((a: any) => a.id)).toEqual(['example'])
    first[0].label = 'changed by a caller'
    expect(appAgentRuntimes(apps, grantsPath)[0].label).toBe('Example')
    reads.files.length = 0
    appAgentRuntimes(apps, grantsPath)
    expect(reads.files.filter((f) => f === apps || f === grantsPath)).toEqual([])
    // Grants removed: the app agent disappears at once.
    writeFileSync(join(dir, 'grants.next'), JSON.stringify({})); renameSync(join(dir, 'grants.next'), grantsPath)
    expect(appAgentRuntimes(apps, grantsPath)).toEqual([])
    writeFileSync(join(dir, 'grants.next'), JSON.stringify(grants)); renameSync(join(dir, 'grants.next'), grantsPath)
    expect(appAgentRuntimes(apps, grantsPath).map((a: any) => a.id)).toEqual(['example'])
    // App uninstalled.
    writeFileSync(join(dir, 'apps.next'), JSON.stringify({ schema: 1, apps: [] })); renameSync(join(dir, 'apps.next'), apps)
    expect(appAgentRuntimes(apps, grantsPath)).toEqual([])
  })
})
