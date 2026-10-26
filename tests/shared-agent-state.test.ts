import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentRegistry, normalizeNotesDir } from '../server/agents.mjs'
import { createAgentBridge, SHARED_AGENT_TOOLS } from '../server/agent-bridge.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

const roots: string[] = []
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
const model = { provider: 'tinfoil', model: 'glm-5-3' }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'shared-agent-state-')); roots.push(root)
  const mainHome = join(root, 'main-home'); mkdirSync(mainHome)
  const appsJsonPath = join(root, 'apps.json'); writeFileSync(appsJsonPath, JSON.stringify({ apps: [] }))
  const runtime = { apply: vi.fn(async () => ({})), stop: vi.fn(async () => ({})), start: vi.fn(async () => ({})) }
  const registry = createAgentRegistry({ agentsDir: join(root, 'agents'), mainHome, localModels: ['fixture-local'], runtime, fetchImpl: async () => new Response(JSON.stringify({ data: [], has_more: false })) })
  const logs: string[] = []
  const bridge = (createAgentBridge as any)({ appsJsonPath, agents: () => registry, writeSkills: false, watchIntervalMs: 0, log: (line: string) => logs.push(line) })
  const create = async (label: string, permissions = {}, extra = {}) => (await registry.create({ label, model, permissions: { preset: 'standard', ...permissions }, ...extra })).agent
  const call = (kind: string, agent: string, args = {}, reader = 'hermes') => bridge.callTool(`wizard_agents__${kind}`, { agent, ...args }, reader)
  const value = (result: any) => { expect(result.isError).not.toBe(true); return JSON.parse(result.content[0].text) }
  const write = (id: string, relative: string, text: string) => { const path = join(registry.stateHome(id), relative); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); return path }
  return { root, registry, bridge, logs, create, call, value, write, runtime }
}

describe('standard-agent shared state', () => {
  it('defaults new standard/main to read + shared; private remains none + sealed; old levels are never migrated', async () => {
    const f = fixture(); const a = await f.create('Helper')
    expect(a.permissions).toMatchObject({ other_agents: 'read', shared_with_agents: true })
    expect(f.registry.read('hermes').permissions).toMatchObject({ other_agents: 'read', shared_with_agents: true })
    const priv = (await f.registry.create({ label: 'Private', model, permissions: { preset: 'private' } })).agent
    expect(priv.permissions).toMatchObject({ other_agents: 'none', shared_with_agents: false })
    const file = join(f.root, 'agents', a.id, 'agent.json'), old = JSON.parse(readFileSync(file, 'utf8'))
    delete old.permissions.shared_with_agents; old.permissions.other_agents = 'none'; writeFileSync(file, JSON.stringify(old))
    const bytes = readFileSync(file, 'utf8')
    expect(f.registry.read(a.id).permissions).toMatchObject({ other_agents: 'none', shared_with_agents: true })
    expect(readFileSync(file, 'utf8')).toBe(bytes)
    const privateFile = join(f.root, 'agents', priv.id, 'agent.json'), forged = JSON.parse(readFileSync(privateFile, 'utf8'))
    forged.permissions.shared_with_agents = true; writeFileSync(privateFile, JSON.stringify(forged))
    expect(f.registry.read(priv.id).permissions.shared_with_agents).toBe(false)
    expect(f.registry.readableSources('hermes').map(s => s.source)).not.toContain(priv.id)
    await expect(f.registry.update(priv.id, { permissions: { shared_with_agents: true } })).rejects.toMatchObject({ status: 409, check: 'agent.private_sealed' })
    await expect(f.registry.create({ label: 'Bad private', model, permissions: { preset: 'private', shared_with_agents: true } })).rejects.toMatchObject({ status: 409, check: 'agent.private_sealed' })
  })

  it('silo revokes every reader and stored grant immediately without changing its own read level', async () => {
    const f = fixture(); const a = await f.create('Source'); const b = await f.create('Reader', { other_agents: 'none' })
    f.registry.addGrant({ reader: b.id, source: a.id, scope: 'read' })
    f.write(a.id, 'memories/MEMORY.md', 'source-only-marker')
    expect(f.value(await f.call('memory_read', a.id, {}, b.id)).memory).toBe('source-only-marker')
    await f.registry.update(a.id, { permissions: { shared_with_agents: false } })
    expect(f.registry.read(a.id).permissions.other_agents).toBe('read')
    expect(f.registry.readableSources(b.id)).toEqual([])
    expect((await f.call('memory_read', a.id, {}, b.id)).isError).toBe(true)
    expect(() => f.registry.addGrant({ reader: 'hermes', source: a.id, scope: 'titles' })).toThrowError(expect.objectContaining({ status: 409, check: 'agent.not_shared' }))
    expect(f.value(await f.call('list', '', {}, 'hermes')).agents.map((a: any) => a.id)).not.toContain(a.id)
    await f.registry.update('hermes', { permissions: { shared_with_agents: false, other_agents: 'titles' } })
    expect(f.registry.read('hermes').permissions).toMatchObject({ shared_with_agents: false, other_agents: 'titles' })
    expect(f.registry.readableSources(a.id).map(s => s.source)).not.toContain('hermes')
    for (const bad of [null, 'false', 1, []]) await expect(f.registry.update(a.id, { permissions: { shared_with_agents: bad } })).rejects.toMatchObject({ status: 400 })
    await expect(f.registry.update('hermes', { permissions: { shared_with_agents: 'yes' } })).rejects.toMatchObject({ status: 400 })
  })

  it.each(['none', 'titles', 'search', 'read'])('gates all six calls at %s, including hand-crafted calls', async level => {
    const f = fixture(); const a = await f.create('Source', {}, { notes_dir: 'wiki' }); const b = await f.create('Reader', { other_agents: level })
    f.write(a.id, 'skills/how/SKILL.md', '---\nname: how\n---\nSynthetic skill')
    f.write(a.id, 'wiki/note.md', 'Synthetic note'); f.write(a.id, 'SOUL.md', 'Synthetic persona')
    const listed = f.value(await f.call('list', '', {}, b.id))
    expect(listed.agents.some((x: any) => x.id === a.id)).toBe(level !== 'none')
    for (const kind of ['skills_list', 'notes_list', 'memory_read', 'skill_read', 'notes_read']) {
      const result = await f.call(kind, a.id, { name: 'how', path: 'note.md' }, b.id)
      const allowed = kind.endsWith('_list') ? ['search', 'read'].includes(level) : level === 'read'
      expect(!result.isError).toBe(allowed)
    }
    expect((await f.call('memory_read', b.id, {}, b.id)).isError).toBe(true) // own tools already read own state
  })

  it('labels memory, persona and adapted skills; logs metadata only and preserves original bytes', async () => {
    const f = fixture(); const a = await f.create('Source', {}, { notes_dir: 'wiki' })
    const memory = f.write(a.id, 'memories/MEMORY.md', 'memory-marker'); f.write(a.id, 'memories/USER.md', 'user-marker')
    f.write(a.id, 'SOUL.md', 'persona-marker'); f.write(a.id, 'skills/group/how/SKILL.md', 'skill-marker'); f.write(a.id, 'wiki/topic.md', 'note-marker')
    expect(f.value(await f.call('memory_read', a.id))).toMatchObject({ source: { id: a.id }, memory: 'memory-marker', user: 'user-marker', 'persona (read-only)': 'persona-marker' })
    expect(f.value(await f.call('skills_list', a.id)).entries).toEqual(['group/how', 'reporter', 'supervisor']) // service-owned playbooks ship with each managed harness
    expect(f.value(await f.call('skill_read', a.id, { name: 'group/how' })).text).toContain(`Written by ${a.id} for the hermes harness. Tools and paths it names may not exist for you. Adapt it into your own skill before relying on it.`)
    expect(f.value(await f.call('notes_list', a.id)).entries).toEqual(['topic.md'])
    expect(f.value(await f.call('notes_read', a.id, { path: 'topic.md' })).text).toBe('note-marker')
    expect(readFileSync(memory, 'utf8')).toBe('memory-marker')
    const audits = f.logs.filter(line => line.includes('agent_state_read')).map(line => JSON.parse(line))
    expect(audits).toHaveLength(5)
    expect(audits[0]).toEqual({ event: 'agent_state_read', reader: 'hermes', source: a.id, kind: 'memory_read', scope: 'read', ok: true })
    expect(f.logs.join('')).not.toMatch(/memory-marker|user-marker|persona-marker|skill-marker|note-marker|topic.md/)
    const noNotes = await f.create('No notes')
    expect(f.value(await f.call('notes_list', noNotes.id)).entries).toEqual([])
    expect((await f.call('notes_read', noNotes.id, { path: 'topic.md' })).isError).toBe(true)
  })

  it('refuses traversal, dotfiles, secrets, raw databases, symlinks, hardlinks and oversized content', async () => {
    const f = fixture(); const a = await f.create('Source', {}, { notes_dir: 'wiki' })
    f.write(a.id, 'wiki/good.md', 'safe'); f.write(a.id, 'wiki/config.yaml', 'denied'); f.write(a.id, 'wiki/auth.md', 'denied')
    f.write(a.id, 'wiki/.env', 'denied'); f.write(a.id, 'wiki/.hidden/file.md', 'denied'); f.write(a.id, 'state.db', 'denied')
    const outside = join(f.root, 'outside.md'); writeFileSync(outside, 'outside-marker')
    symlinkSync(outside, join(f.registry.stateHome(a.id), 'wiki/link.md'))
    symlinkSync(f.root, join(f.registry.stateHome(a.id), 'wiki/linkdir'))
    linkSync(outside, join(f.registry.stateHome(a.id), 'wiki/hard.md'))
    for (const path of ['../SOUL.md', '/outside.md', '.env', '.hidden/file.md', 'config.yaml', 'auth.md', '../../state.db', 'link.md', 'linkdir/outside.md', 'hard.md', 'good.md/..', 'a\\b.md']) {
      expect((await f.call('notes_read', a.id, { path })).isError, path).toBe(true)
    }
    expect(f.value(await f.call('notes_list', a.id)).entries).toEqual(['good.md'])
    f.write(a.id, 'wiki/huge.md', 'x'.repeat(65537))
    expect((await f.call('notes_read', a.id, { path: 'huge.md' })).content[0].text).toBe('agent.too_large')
    f.write(a.id, 'memories/MEMORY.md', 'x'.repeat(40000)); f.write(a.id, 'memories/USER.md', 'x'.repeat(40000))
    expect((await f.call('memory_read', a.id)).content[0].text).toBe('agent.too_large')
    mkdirSync(join(f.registry.stateHome(a.id), 'skills'), { recursive: true }); symlinkSync(f.root, join(f.registry.stateHome(a.id), 'skills/escape'))
    expect((await f.call('skill_read', a.id, { name: 'escape' })).isError).toBe(true)
    for (const dir of ['..', '/wiki', '.hidden', 'wiki/../x', 'wiki\\x']) expect(() => normalizeNotesDir(dir)).toThrow()
    for (let i = 0; i < 220; i++) f.write(a.id, `wiki/item-${i}.md`, 'x')
    const capped = f.value(await f.call('notes_list', a.id)); expect(capped.entries.length).toBeLessThanOrEqual(200); expect(capped.truncated).toBe(true)
  })

  it('explicit grants extend but never reduce a broader level; private sources with forged flags/grants stay sealed', async () => {
    const f = fixture(); const a = await f.create('Source'); const b = await f.create('Reader')
    f.registry.addGrant({ reader: b.id, source: a.id, scope: 'titles' })
    expect(f.registry.readableSources(b.id).find(s => s.source === a.id)?.scope).toBe('read')
    const priv = (await f.registry.create({ label: 'Private', model, permissions: { preset: 'private' } })).agent
    writeFileSync(join(f.root, 'agents/.agent-grants.json'), JSON.stringify({ grants: [{ id: 'forged', reader: b.id, source: priv.id, scope: 'read' }] }))
    const record = JSON.parse(readFileSync(join(f.root, 'agents', priv.id, 'agent.json'), 'utf8')); record.permissions.shared_with_agents = true
    writeFileSync(join(f.root, 'agents', priv.id, 'agent.json'), JSON.stringify(record))
    expect((await f.call('memory_read', priv.id, {}, b.id)).isError).toBe(true)
    expect(f.value(await f.call('list', '', {}, b.id)).agents.map((x: any) => x.id)).not.toContain(priv.id)
  })

  it.each(['container', 'profile', 'restricted'])('resolves %s source homes without granting writes or changing runtime configuration', async kind => {
    const f = fixture(); const a = await f.create('Source', {}, { model: { provider: 'local', model: 'fixture-local' } })
    const file = join(f.root, 'agents', a.id, 'agent.json')
    const record = JSON.parse(readFileSync(file, 'utf8'))
    if (kind === 'profile') {
      record.runtime = { kind: 'profile', profile: 'profile-source' }
      mkdirSync(join(f.registry.stateHome('hermes'), 'profiles', 'profile-source'), { recursive: true })
    } else if (kind === 'restricted') record.runtime.isolation = 'restricted'
    writeFileSync(file, JSON.stringify(record))
    f.write(a.id, 'memories/MEMORY.md', `${kind}-memory-marker`)
    expect(f.value(await f.call('memory_read', a.id)).memory).toBe(`${kind}-memory-marker`)
    // Hand-editing isolation leaves harness files stale; settle that first so only the silo toggle is measured.
    await f.registry.update(a.id, {})
    Object.assign(record, JSON.parse(readFileSync(file, 'utf8')))
    f.runtime.apply.mockClear()
    await f.registry.update(a.id, { permissions: { shared_with_agents: false } })
    expect((await f.call('memory_read', a.id)).isError).toBe(true)
    expect(f.runtime.apply).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(file, 'utf8')).runtime).toEqual(record.runtime)
    f.write('hermes', 'memories/MEMORY.md', 'configured-main-home-marker')
    expect(f.value(await f.call('memory_read', 'hermes', {}, a.id)).memory).toBe('configured-main-home-marker')
  })

  it('serves all six tools through authenticated /wizard/mcp and rechecks silo on an existing session', async () => {
    const f = fixture(); const a = await f.create('Source'); const b = await f.create('Reader')
    f.write(a.id, 'memories/MEMORY.md', 'http-memory-marker')
    const svc = createWizardServer({ upstreamOrigin: 'http://127.0.0.1:9', hermesKey: 'fixture-hermes', requireAccess: false, appsJsonPath: join(f.root, 'apps.json'), wizardOsHome: f.root, hermesHome: f.registry.stateHome('hermes'), agentRuntime: f.runtime, mcpToken: 'fixture-main', bridgeWatchMs: 0, bridgeWriteSkills: false, followThrough: false, bridgeLog: (line: string) => f.logs.push(line) })
    try {
      const address: any = await listen(svc), url = `http://127.0.0.1:${address.port}/wizard/mcp`
      const token = readFileSync(join(f.root, 'agents', b.id, 'gateway.key'), 'utf8').trim()
      const request = async (method: string, params = {}, key = token) => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()
      const listed = await request('tools/list')
      expect(listed.result.tools.map((t: any) => t.name).filter((n: string) => !n.startsWith('spaces_'))).toEqual(['wizard_apps', ...SHARED_AGENT_TOOLS])
      const read = () => request('tools/call', { name: 'wizard_agents__memory_read', arguments: { agent: a.id } })
      expect(f.value((await read()).result).memory).toBe('http-memory-marker')
      await f.registry.update(a.id, { permissions: { shared_with_agents: false } })
      expect((await read()).result.isError).toBe(true)
      expect((await request('tools/list', {}, 'wrong-token')).error).toBe('unauthorized')
    } finally { svc.closeAllConnections?.(); await new Promise(resolve => svc.close(resolve)) }
  })
  it('lets the main agent read other agents over the loopback token only, under the same live seals', async () => {
    const f = fixture(); const a = await f.create('Source')
    f.write(a.id, 'memories/MEMORY.md', 'loopback-memory-marker')
    const heavy = 'fixture-heavy-token-with-more-than-32-chars'
    const svc = createWizardServer({ heavyToken: heavy, upstreamOrigin: 'http://127.0.0.1:9', hermesKey: 'fixture-hermes', requireAccess: false, appsJsonPath: join(f.root, 'apps.json'), wizardOsHome: f.root, hermesHome: f.registry.stateHome('hermes'), agentRuntime: f.runtime, mcpToken: 'fixture-main', bridgeWatchMs: 0, bridgeWriteSkills: false, followThrough: false, bridgeLog: (line: string) => f.logs.push(line) })
    try {
      const origin = `http://127.0.0.1:${((await listen(svc)) as any).port}`
      const call = (tool: string, body: any, auth = heavy, extra: any = {}) => fetch(`${origin}/wizard/internal/agents/${tool}`, { method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) })
      expect((await call('memory_read', { agent: a.id }, 'wrong-token-wrong-token-wrong-token-xx')).status).toBe(403)
      expect((await call('memory_read', { agent: a.id }, heavy, { Origin: 'https://evil.example' })).status).toBe(403)
      expect((await call('memory_write', { agent: a.id })).status).toBe(404)
      expect((await (await call('list', {})).json()).content[0].text).toContain(a.id)
      const ok = await call('memory_read', { agent: a.id })
      expect(ok.status).toBe(200)
      expect(JSON.parse((await ok.json()).content[0].text).memory).toBe('loopback-memory-marker')
      await f.registry.update(a.id, { permissions: { shared_with_agents: false } })
      const sealed = await call('memory_read', { agent: a.id })
      expect(sealed.status).toBe(403)
      expect((await sealed.json()).isError).toBe(true)
    } finally { svc.closeAllConnections?.(); await new Promise(resolve => svc.close(resolve)) }
  })
})
