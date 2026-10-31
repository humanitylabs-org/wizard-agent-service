// Owner-only, read-only agent notebooks for the Notes app (GET /wizard/v1/agent-notes…).
// Synthetic agents and notes only; private-agent content is a fixture canary, never real data.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentRegistry } from '../server/agents.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

const PROOF = 'owner-proof-fixture-0123456789abcdef0123456789'
const OWNER = { 'X-Wizard-Owner-Proof': PROOF }
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
  const svc = createWizardServer({ upstreamOrigin: 'http://127.0.0.1:9', hermesKey: 'fixture-hermes', requireAccess: false, ownerProof: PROOF, appsJsonPath, wizardOsHome: root, hermesHome: mainHome, agentRuntime: runtime, mcpToken: 'fixture-main', bridgeWatchMs: 0, bridgeWriteSkills: false, followThrough: false, bridgeLog: () => {} })
  servers.push(svc)
  const origin = `http://127.0.0.1:${((await listen(svc)) as any).port}`
  const get = (path: string, init: any = {}) => fetch(`${origin}/wizard/v1/agent-notes${path}`, { ...init, headers: { ...OWNER, ...(init.headers ?? {}) } })
  return { root, registry, create, write, get, origin }
}

describe('agent notebooks for the Notes app', () => {
  it('lists only standard agents that declare notes_dir; private, hidden-notes and notes-less agents never appear', async () => {
    const f = await fixture()
    const sage = await f.create('Sage', { notes_dir: 'wiki' })
    const plain = await f.create('Plain')
    const priv = await f.create('Sealed', {}, 'private')
    // A private agent that also claims a notes folder (hand-edited agent.json) stays sealed.
    const file = join(f.root, 'agents', priv.id, 'agent.json'), record = JSON.parse(readFileSync(file, 'utf8'))
    record.notes_dir = 'wiki'; writeFileSync(file, JSON.stringify(record))
    f.write(priv.id, 'wiki/index.md', 'PRIVATE-CANARY-9c1e')
    // Even a forged stored grant does not open a private agent's notes to the owner's app surface.
    writeFileSync(join(f.root, 'agents/.agent-grants.json'), JSON.stringify({ grants: [{ id: 'forged', reader: 'hermes', source: priv.id, scope: 'read' }] }))
    const listed = await (await f.get('')).json()
    expect(listed.sources.map((s: any) => s.id)).toEqual([sage.id])
    expect(listed.sources[0]).toMatchObject({ id: sage.id, label: 'Sage', privacy: 'standard' })
    for (const id of [priv.id, plain.id, 'missing-agent']) {
      const r = await f.get(`/${id}`)
      expect(r.status, id).toBe(404)
      expect(await r.text()).not.toContain('PRIVATE-CANARY')
    }
    expect((await f.get(`/${priv.id}/read?path=index.md`)).status).toBe(404)
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
