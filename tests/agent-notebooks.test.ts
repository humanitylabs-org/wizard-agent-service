// All notebooks and keys below are synthetic fixtures.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createAgentRegistry } from '../server/agents.mjs'
import { createWizardServer, listen } from '../server/service.mjs'
const PROOF = 'owner-proof-fixture-0123456789abcdef0123456789'
const OWNER = { 'X-Wizard-Owner-Proof': PROOF }
const KEY = 'a'.repeat(64), OTHER = 'b'.repeat(64)
const hash = (key: string) => createHash('sha256').update(key).digest('hex')
const roots: string[] = [], servers: any[] = []
afterEach(async () => {
  for (const svc of servers.splice(0)) { svc.closeAllConnections?.(); await new Promise(resolve => svc.close(resolve)) }
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'app-notebooks-')); roots.push(root)
  const mainHome = join(root, 'main-home'); mkdirSync(mainHome)
  const appsJsonPath = join(root, 'apps.json'); writeFileSync(appsJsonPath, JSON.stringify({ apps: [{ id: 'reader-app', view: '/reader' }, { id: 'other-app', view: '/other' }] }))
  const grantsFile = join(root, 'app-grants.json')
  const keys = (incoming = [{ from: 'reader-app', sha256: hash(KEY) }, { from: 'other-app', sha256: hash(OTHER) }]) => writeFileSync(grantsFile, JSON.stringify({ enforce: true, incoming }), { mode: 0o600 })
  keys()
  const runtime = { apply: vi.fn(async () => ({})), stop: vi.fn(async () => ({})), start: vi.fn(async () => ({})) }
  const registry = createAgentRegistry({ agentsDir: join(root, 'agents'), mainHome, appsJsonPath, localModels: ['fixture-local'], runtime, fetchImpl: async () => new Response(JSON.stringify({ data: [], has_more: false })) })
  const create = async (label: string, extra: any = {}, preset = 'standard') => (await registry.create({ label, model: { provider: 'tinfoil', model: 'glm-5-3' }, permissions: { preset }, ...extra })).agent
  const write = (id: string, relative: string, text: string) => { const path = join(registry.stateHome(id), relative); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); return path }
  const svc = createWizardServer({ upstreamOrigin: 'http://127.0.0.1:9', hermesKey: 'fixture-hermes', requireAccess: false, ownerProof: PROOF, appsJsonPath, appGrantsFile: grantsFile, wizardOsHome: root, hermesHome: mainHome, agentRuntime: runtime, mcpToken: 'fixture-main', bridgeWatchMs: 0, bridgeWriteSkills: false, followThrough: false, bridgeLog: () => {} })
  servers.push(svc)
  const origin = `http://127.0.0.1:${((await listen(svc)) as any).port}`
  const get = (path = '', key = KEY, init: any = {}) => fetch(`${origin}/wizard/v1/agent-notebooks${path}`, { ...init, headers: { 'X-Wizard-Grant': key, ...(init.headers ?? {}) } })
  const grant = async (id: string, reader = 'app:reader-app', extra: any = {}) => fetch(`${origin}/wizard/v1/agent-grants`, { method: 'POST', headers: { ...OWNER, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'app-notebook', reader, source: id, scope: 'read', ...extra }) })
  return { root, registry, create, write, get, grant, origin, keys, grantsFile }
}
it('requires both normal per-app identity and an explicit owner source grant, revocable separately', async () => {
  const f = await fixture(), sage = await f.create('Sage', { notes_dir: 'wiki' })
  expect((await (await f.get()).json()).sources).toEqual([])
  const granted = await f.grant(sage.id); expect(granted.status).toBe(201)
  const grant = (await granted.json()).grant
  expect(grant).toMatchObject({ kind: 'app-notebook', reader: 'app:reader-app', source: sage.id, scope: 'read' })
  expect((await (await f.get()).json()).sources.map((s: any) => s.id)).toEqual([sage.id])
  expect((await (await f.get('', OTHER)).json()).sources).toEqual([])
  expect((await f.get(`/${sage.id}`, OTHER)).status).toBe(404)
  expect((await f.get('', '', { headers: OWNER })).status).toBe(403)
  expect((await f.get('', 'forged', { headers: { ...OWNER, 'X-Wizard-App': 'reader-app' } })).status).toBe(403)
  const listing = await fetch(`${f.origin}/wizard/v1/agent-grants?reader=app:reader-app`, { headers: OWNER })
  expect((await listing.json()).grants).toHaveLength(1)
  expect((await fetch(`${f.origin}/wizard/v1/agent-grants/${grant.id}`, { method: 'DELETE', headers: OWNER })).status).toBe(200)
  expect((await f.get(`/${sage.id}`)).status).toBe(404)
})
it('does not confuse an ordinary app-to-app connection with permission to read an agent', async () => {
  const f = await fixture(), sage = await f.create('Sage', { notes_dir: 'wiki' })
  expect((await f.get(`/${sage.id}/read?path=index.md`)).status).toBe(404)
  expect((await f.grant(sage.id, 'reader-app')).status).toBe(404)
  expect((await f.grant(sage.id, 'app:missing-app')).status).toBe(404)
  expect((await f.grant(sage.id, 'app:reader-app', { scope: 'write' })).status).toBe(400)
})
it('excludes private, hidden, recovery and undeclared sources even with forged stored grants', async () => {
  const f = await fixture()
  const agents = [await f.create('Private', { notes_dir: 'wiki' }, 'private'), await f.create('Hidden', { notes_dir: 'wiki' }), await f.create('No notebook'), await f.create('Recovery', { notes_dir: 'wiki' })]
  for (const [index, agent] of agents.entries()) {
    const file = join(f.root, 'agents', agent.id, 'agent.json'), record = JSON.parse(readFileSync(file, 'utf8'))
    if (index === 1) record.hidden = true
    if (index === 3) record.role = 'recovery'
    writeFileSync(file, JSON.stringify(record))
    expect((await f.grant(agent.id)).status).toBe(404)
  }
  writeFileSync(join(f.root, 'agents/.agent-grants.json'), JSON.stringify({ grants: agents.map((agent, index) => ({ id: `forged-${index}`, kind: 'app-notebook', reader: 'app:reader-app', source: agent.id, scope: 'read' })) }))
  expect((await (await f.get()).json()).sources).toEqual([])
  for (const agent of agents) for (const suffix of ['', '/read?path=index.md', '/search?q=canary']) {
    const r = await f.get(`/${agent.id}${suffix}`); expect(r.status).toBe(404); expect(await r.text()).not.toMatch(/Private|Hidden|Recovery/)
  }
})
it('reuses the bounded filesystem gates, returns no-store and refuses all writes', async () => {
  const f = await fixture(), sage = await f.create('Sage', { notes_dir: 'wiki' }); await f.grant(sage.id)
  const path = f.write(sage.id, 'wiki/index.md', '# Map\nThe tetralemma refuses all four corners.')
  f.write(sage.id, 'wiki/other.txt', 'Other page'); f.write(sage.id, 'wiki/.env', 'SECRET')
  const outside = join(f.root, 'outside.md'); writeFileSync(outside, 'OUTSIDE'); symlinkSync(outside, join(f.registry.stateHome(sage.id), 'wiki/link.md'))
  expect((await (await f.get(`/${sage.id}`)).json()).entries).toEqual(['index.md', 'other.txt'])
  expect((await (await f.get(`/${sage.id}/search?q=corners`)).json()).notes).toHaveLength(1)
  const r = await f.get(`/${sage.id}/read?path=index.md`); expect(r.headers.get('cache-control')).toBe('no-store'); expect((await r.json()).text).toContain('tetralemma')
  for (const p of ['../SOUL.md', '.env', 'link.md', '/etc/passwd', 'a/../index.md']) expect((await f.get(`/${sage.id}/read?path=${encodeURIComponent(p)}`)).status).toBeGreaterThanOrEqual(400)
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect((await f.get(`/${sage.id}/read?path=index.md`, KEY, { method })).status).toBe(405)
  expect(readFileSync(path, 'utf8')).toContain('tetralemma')
})
it('sees key revoke/rotation at once, fails closed on malformed and symlinked grants', async () => {
  const f = await fixture(), sage = await f.create('Sage', { notes_dir: 'wiki' }); await f.grant(sage.id)
  expect((await f.get()).status).toBe(200)
  f.keys([]); expect((await f.get()).status).toBe(403)
  f.keys([{ from: 'reader-app', sha256: hash(OTHER) }]); expect((await f.get()).status).toBe(403)
  expect((await (await f.get('', OTHER)).json()).sources).toHaveLength(1)
  writeFileSync(f.grantsFile, '{broken'); expect((await f.get('', OTHER)).status).toBe(403)
  rmSync(f.grantsFile); const other = join(f.root, 'outside-grants.json'); writeFileSync(other, JSON.stringify({ incoming: [{ from: 'reader-app', sha256: hash(KEY) }] }))
  symlinkSync(other, f.grantsFile); expect((await f.get()).status).toBe(403)
})
it('retires the unscoped browser route without widening owner or agent authority', async () => {
  const f = await fixture()
  expect((await fetch(`${f.origin}/wizard/v1/agent-notes`, { headers: OWNER })).status).toBe(410)
  const r = await fetch(`${f.origin}/wizard/v1/agent-grants`, { method: 'POST', headers: { 'X-Wizard-Grant': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'app-notebook', reader: 'app:reader-app', source: 'sage', scope: 'read' }) })
  expect(r.status).toBe(403)
})
