// Owner-session-only, read-only agent notebooks for the Notes app (GET /wizard/v1/agent-notes…).
// Synthetic agents and notes only; private-agent content is a fixture canary, never real data.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentRegistry } from '../server/agents.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

const PROOF = 'owner-proof-fixture-0123456789abcdef0123456789'
const OWNER = { 'X-Wizard-Owner-Proof': PROOF }
const HEAVY = 'main-agent-loopback-token-fixture-0123456789'
const model = { provider: 'tinfoil', model: 'glm-5-3' }
const roots: string[] = []
const servers: any[] = []
afterEach(async () => {
  for (const svc of servers.splice(0)) { svc.closeAllConnections?.(); await new Promise(resolve => svc.close(resolve)) }
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-notes-http-')); roots.push(root)
  const mainHome = join(root, 'main-home'); mkdirSync(mainHome)
  const appsJsonPath = join(root, 'apps.json'); writeFileSync(appsJsonPath, JSON.stringify({ apps: [] }))
  const runtime = { apply: vi.fn(async () => ({})), stop: vi.fn(async () => ({})), start: vi.fn(async () => ({})) }
  const registry = createAgentRegistry({ agentsDir: join(root, 'agents'), mainHome, localModels: ['fixture-local'], runtime, fetchImpl: async () => new Response(JSON.stringify({ data: [], has_more: false })) })
  const create = async (label: string, extra: any = {}, preset = 'standard') => (await registry.create({ label, model, permissions: { preset }, ...extra })).agent
  const write = (id: string, relative: string, text: string) => { const path = join(registry.stateHome(id), relative); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); return path }
  const svc = createWizardServer({ heavyToken: HEAVY, upstreamOrigin: 'http://127.0.0.1:9', hermesKey: 'fixture-hermes', requireAccess: false, ownerProof: PROOF, appsJsonPath, wizardOsHome: root, hermesHome: mainHome, agentRuntime: runtime, mcpToken: 'fixture-main', bridgeWatchMs: 0, bridgeWriteSkills: false, followThrough: false, bridgeLog: () => {} })
  servers.push(svc)
  const origin = `http://127.0.0.1:${((await listen(svc)) as any).port}`
  const get = (path: string, init: any = {}) => fetch(`${origin}/wizard/v1/agent-notes${path}`, { ...init, headers: { ...OWNER, ...(init.headers ?? {}) } })
  return { root, registry, create, write, get, origin }
}

describe('agent notebooks for the Notes app', () => {
  it('lists every registered agent for the owner: standard, private, hidden and notebook-less, with privacy labels', async () => {
    const f = await fixture()
    const sage = await f.create('Sage', { notes_dir: 'wiki' })
    const plain = await f.create('Plain')
    const priv = await f.create('Sealed', {}, 'private')
    const hidden = await f.create('Quiet')
    const file = join(f.root, 'agents', hidden.id, 'agent.json'), record = JSON.parse(readFileSync(file, 'utf8'))
    record.hidden = true; writeFileSync(file, JSON.stringify(record))
    const listed = await (await f.get('')).json()
    expect(listed.sources.map((s: any) => s.id).sort()).toEqual([sage.id, plain.id, priv.id, hidden.id].sort())
    expect(listed.sources.find((s: any) => s.id === priv.id)).toMatchObject({ label: 'Sealed', privacy: 'private' })
    expect(listed.sources.find((s: any) => s.id === sage.id)).toMatchObject({ label: 'Sage', privacy: 'standard' })
    // Main Archimedes is the host Hermes profile, not a registered container: it stays out until it moves.
    expect(listed.sources.map((s: any) => s.id)).not.toContain('hermes')
    expect((await f.get('/hermes')).status).toBe(404)
    expect((await f.get('/missing-agent')).status).toBe(404)
  })

  it('a freshly registered agent with no notebook config appears automatically on the default wiki folder', async () => {
    const f = await fixture()
    expect((await (await f.get('')).json()).sources).toEqual([])
    const fresh = await f.create('Fresh')
    expect((await (await f.get('')).json()).sources.map((s: any) => s.id)).toEqual([fresh.id])
    // No wiki folder yet: an empty notebook, not an error (the app shows "No notes yet").
    const empty = await f.get(`/${fresh.id}`)
    expect(empty.status).toBe(200)
    expect(await empty.json()).toMatchObject({ source: { id: fresh.id, label: 'Fresh' }, entries: [], truncated: false })
    expect((await (await f.get(`/${fresh.id}/search?q=x`)).json()).notes).toEqual([])
    f.write(fresh.id, 'wiki/index.md', '# Fresh map')
    f.write(fresh.id, 'memories/MEMORY.md', 'NOT-A-NOTE-CANARY')
    expect((await (await f.get(`/${fresh.id}`)).json()).entries).toEqual(['index.md'])
    expect((await (await f.get(`/${fresh.id}/read?path=index.md`)).json()).text).toBe('# Fresh map')
    expect((await f.get(`/${fresh.id}/read?path=${encodeURIComponent('../memories/MEMORY.md')}`)).status).toBeGreaterThanOrEqual(400)
  })

  it('the owner session opens a synthetic private fixture notebook read-only', async () => {
    const f = await fixture()
    const priv = await f.create('Sealed', {}, 'private')
    f.write(priv.id, 'wiki/index.md', 'SYNTHETIC-PRIVATE-FIXTURE')
    expect((await (await f.get(`/${priv.id}`)).json()).entries).toEqual(['index.md'])
    expect((await (await f.get(`/${priv.id}/read?path=index.md`)).json()).text).toBe('SYNTHETIC-PRIVATE-FIXTURE')
    expect((await f.get(`/${priv.id}/read?path=index.md`, { method: 'PUT', body: 'x' })).status).toBe(405)
  })

  it('agent-to-agent stays sealed: no agent credential reads a private notebook through either route', async () => {
    const f = await fixture()
    const priv = await f.create('Sealed', {}, 'private')
    const file = join(f.root, 'agents', priv.id, 'agent.json'), record = JSON.parse(readFileSync(file, 'utf8'))
    record.notes_dir = 'wiki'; writeFileSync(file, JSON.stringify(record))
    f.write(priv.id, 'wiki/index.md', 'PRIVATE-CANARY-9c1e')
    const reader = await f.create('Reader')
    const sibling = await f.create('Sibling', {}, 'private')
    // Even a forged stored grant does not open a private agent's notes to another agent.
    writeFileSync(join(f.root, 'agents/.agent-grants.json'), JSON.stringify({ grants: [{ id: 'forged', reader: 'hermes', source: priv.id, scope: 'read' }, { id: 'forged-2', reader: reader.id, source: priv.id, scope: 'read' }] }))
    const tokens = [reader, sibling].map((agent) => readFileSync(join(f.root, 'agents', agent.id, 'gateway.key'), 'utf8').trim())
    for (const token of [...tokens, HEAVY, 'fixture-main', 'fixture-hermes']) {
      // The owner route: any bearer credential without the owner session is refused before any read.
      for (const suffix of ['', `/${priv.id}`, `/${priv.id}/read?path=index.md`, `/${priv.id}/search?q=canary`]) {
        const r = await fetch(`${f.origin}/wizard/v1/agent-notes${suffix}`, { headers: { Authorization: `Bearer ${token}` } })
        expect(r.status, `${token.slice(0, 6)} ${suffix}`).toBe(403)
        expect(await r.text()).not.toMatch(/PRIVATE-CANARY|Sealed/u)
      }
    }
    // The bearer-token agent route keeps refusing private agents exactly as before, for the main token too.
    const internal = (tool: string, body: any, token = HEAVY) => fetch(`${f.origin}/wizard/internal/agents/${tool}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const list = await (await internal('list', {})).json()
    expect(list.content[0].text).not.toContain(priv.id)
    for (const [tool, body] of [['notes_list', { agent: priv.id }], ['notes_read', { agent: priv.id, path: 'index.md' }]] as const) {
      for (const token of [HEAVY, ...tokens]) {
        const r = await internal(tool, body, token)
        expect(r.status, `${tool} ${token.slice(0, 6)}`).toBe(403)
        expect(await r.text()).not.toContain('PRIVATE-CANARY')
      }
    }
    // The owner proof never opens the agent route either: it is not an agent credential.
    expect((await fetch(`${f.origin}/wizard/internal/agents/notes_read`, { method: 'POST', headers: { ...OWNER, 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: priv.id, path: 'index.md' }) })).status).toBe(403)
  })

  it('lists, reads and searches a notebook through the shared path gates', async () => {
    const f = await fixture()
    const sage = await f.create('Sage', { notes_dir: 'wiki' })
    f.write(sage.id, 'wiki/index.md', '# Map\n\nSee [[ideas/emptiness]].')
    f.write(sage.id, 'wiki/ideas/emptiness.md', '---\ntitle: Emptiness\nkind: idea\n---\nThe tetralemma refuses all four corners.')
    f.write(sage.id, 'wiki/quotes.md', 'Nothing about corners here, only quotes.')
    f.write(sage.id, 'wiki/.env', 'SECRET'); f.write(sage.id, 'wiki/config.yaml', 'x')
    const outside = join(f.root, 'outside.md'); writeFileSync(outside, 'OUTSIDE-CANARY')
    symlinkSync(outside, join(f.registry.stateHome(sage.id), 'wiki/link.md'))
    const list = await (await f.get(`/${sage.id}`)).json()
    expect(list).toMatchObject({ source: { id: sage.id, label: 'Sage' }, truncated: false })
    expect(list.entries).toEqual(['ideas/emptiness.md', 'index.md', 'quotes.md'])
    const read = await (await f.get(`/${sage.id}/read?path=ideas/emptiness.md`)).json()
    expect(read.text).toContain('tetralemma')
    for (const path of ['../SOUL.md', '.env', 'config.yaml', 'link.md', '/etc/passwd', 'index', 'ideas/../index.md']) {
      const r = await f.get(`/${sage.id}/read?path=${encodeURIComponent(path)}`)
      expect(r.status, path).toBeGreaterThanOrEqual(400)
      expect(await r.text()).not.toMatch(/OUTSIDE-CANARY|SECRET|\/tmp\//u)
    }
    const hits = await (await f.get(`/${sage.id}/search?q=corners`)).json()
    expect(hits.source.label).toBe('Sage')
    expect(hits.notes.map((n: any) => n.path)).toEqual(['ideas/emptiness.md', 'quotes.md'])
    expect(hits.notes[0]).toMatchObject({ title: 'emptiness' })
    expect(hits.notes[0].snippet).not.toContain('kind: idea') // frontmatter is not a snippet
    const titled = await (await f.get(`/${sage.id}/search?q=quotes`)).json()
    expect(titled.notes[0].path).toBe('quotes.md')
  })

  it('rejects every write method server-side and leaves the notebook unchanged', async () => {
    const f = await fixture()
    const sage = await f.create('Sage', { notes_dir: 'wiki' })
    const path = f.write(sage.id, 'wiki/index.md', 'original')
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const suffix of ['', `/${sage.id}`, `/${sage.id}/read?path=index.md`]) {
        const r = await f.get(suffix, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'index.md', content: 'overwritten' }) })
        expect(r.status, `${method} ${suffix}`).toBe(405)
        expect((await r.json()).error).toBe('read_only')
      }
    }
    expect(readFileSync(path, 'utf8')).toBe('original')
  })

  it('answers the owner only: no owner proof and agent credentials are refused', async () => {
    const f = await fixture()
    const sage = await f.create('Sage', { notes_dir: 'wiki' })
    const reader = await f.create('Reader')
    f.write(sage.id, 'wiki/index.md', 'OWNER-ONLY-CANARY')
    const anonymous = await fetch(`${f.origin}/wizard/v1/agent-notes/${sage.id}/read?path=index.md`)
    expect(anonymous.status).toBe(403)
    const token = readFileSync(join(f.root, 'agents', reader.id, 'gateway.key'), 'utf8').trim()
    const agent = await fetch(`${f.origin}/wizard/v1/agent-notes/${sage.id}/read?path=index.md`, { headers: { Authorization: `Bearer ${token}` } })
    expect(agent.status).toBe(403)
    expect(await agent.text()).not.toContain('OWNER-ONLY-CANARY')
    expect((await f.get('/Bad_Id')).status).toBe(404)
  })
})
