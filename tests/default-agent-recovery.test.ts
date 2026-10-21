import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createWizardServer } from './helpers/private-provider-fixture.mjs'
import { createAgentRegistry } from '../server/agents.mjs'
import { normalizeSettings } from '../server/wizard-os-settings.mjs'
import { ThreadSeenStore } from '../server/thread-seen.mjs'
import { ThreadDispositionStore } from '../server/thread-dispositions.mjs'
import { DurableRunQueue } from '../server/run-queue.mjs'
import { threadKey } from '../server/thread-reference.mjs'

const proof = 'fixture-owner-proof-not-a-real-secret'
const owner = { 'X-Wizard-Owner-Proof': proof }
const cleanup: (() => any)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const json = (value: any, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
async function scene({ queued = false, manifest = null as any, badOptional = false } = {}) {
  // Run only the fresh-box snapshot against an archived contract base to prove byte compatibility.
  const makeServer = process.env.WAS_S2C_BASELINE ? (await import(/* @vite-ignore */ `${process.env.WAS_S2C_BASELINE}/server/service.mjs`)).createWizardServer : createWizardServer
  const dir = mkdtempSync(join(tmpdir(), 'default-agent-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const settingsPath = join(dir, 'settings.json'), agentsDir = join(dir, 'agents')
  const manifestPath = join(dir, 'voice-manifest.json')
  const optionalPaths = { threadTitleStatePath: join(dir, 'titles.json'), subjectsPath: join(dir, 'subjects.json'), threadStatusBackfillPath: join(dir, 'status.json') }
  if (badOptional) for (const path of Object.values(optionalPaths)) writeFileSync(path, '{bad')
  if (manifest) writeFileSync(manifestPath, JSON.stringify(manifest))
  const appsJsonPath = join(dir, 'apps.json')
  writeFileSync(appsJsonPath, JSON.stringify({ schema: 1, apps: [{ id: 'notes', name: 'Notes', agent_binding: true, status: 'running', view: { url: '/notes/' }, mcp: { url: 'http://127.0.0.1:9876/mcp' } }] }))
  const calls: any[] = [], histories = new Map<string, Set<string>>([['hermes', new Set(['wizard_old'])]])
  const dispatch = { healthy: false }
  const ports = new Map<number, string>([[1, 'hermes']]), status = new Map<string, string>()
  const runtime = {
    inspect: async (id: string) => ({status: status.get(id) ?? 'running', generation: `${id}:${status.get(id) ?? 'running'}`}),
    census: async (id: string) => ({...await runtime.inspect(id), ids: [...histories.get(id)!]}),
    apply: async (id: string) => { const config = JSON.parse(readFileSync(join(agentsDir, id, 'agent.json'), 'utf8')); ports.set(config.runtime.port, id); histories.set(id, new Set()); status.set(id, 'running'); return {} },
    status: async (id: string) => ({ status: status.get(id) ?? 'running', status_detail: '' }),
    start: async (id: string) => { status.set(id, 'running'); return {} }, stop: async (id: string) => { status.set(id, 'stopped'); return { ok: true, census: await runtime.census(id) } },
  }
  const fetchImpl = async (url: any, init: any = {}) => {
    const u = new URL(String(url)), agent = ports.get(Number(u.port))
    if (!agent) return fetch(url, init)
    const method = init.method || 'GET', body = init.body ? JSON.parse(String(init.body)) : null
    calls.push({ agent, method, path: u.pathname, body })
    if (status.get(agent) === 'stopped') return json({ error: 'offline' }, 503)
    if (u.pathname === '/v1/capabilities') return json({ features: {} })
    if (u.pathname === '/health') return json({ status: 'ok' })
    if (u.pathname === '/api/sessions' && method === 'POST') { const id = body.id || 'wizard_generated'; histories.get(agent)!.add(id); return json({ session: { id, source: 'wizard-mobile', title: 'Chat' } }, 201) }
    if (u.pathname === '/api/sessions') return json({ data: [...histories.get(agent)!].map(id => ({ id, source: 'wizard-mobile', title: id, message_count: 1 })), has_more: false })
    if (u.pathname.startsWith('/api/sessions/')) {
      const id = decodeURIComponent(u.pathname.split('/')[3])
      if (!histories.get(agent)!.has(id)) return json({ error: 'not_found' }, 404)
      if (u.pathname.endsWith('/messages')) return json({ data: [{ id: 'm1', session_id: id, role: 'assistant', content: agent }] })
      return json({ session: { id, source: 'wizard-mobile', title: agent } })
    }
    if (u.pathname === '/v1/runs' && method === 'POST') { histories.get(agent)!.add(body.session_id); return json({ run_id: `run_${agent}`, session_id: body.session_id, status: 'queued' }, 202) }
    return json({ error: 'not_found' }, 404)
  }
  const service = makeServer({ upstreamOrigin: 'http://127.0.0.1:1', hermesKey: 'fixture', fetchImpl, agentsDir, agentRuntime: runtime,
    agentUpstreamMode: 'localhost', agentTinfoilUrl: 'http://127.0.0.1:9/v1', settingsPath, appsJsonPath, wizardOsHome: dir,
    requireAccess: false, ownerProof: proof, agentBridge: false, followThrough: false, voiceRouting: false, mySkin: false, joinedDelegation: 'prefer',
    voiceRecoveryManifestPath: manifestPath,
    ...(badOptional ? optionalPaths : {}),
    ...(queued ? { runQueueStatePath: join(dir, 'queue.sqlite'), runQueuePollIntervalMs: 0, dispatchHealthReader: () => dispatch.healthy, activeSessionReader: () => [] } : {}),
    threadSeenStatePath: join(dir, 'seen.json'), threadDispositionStatePath: join(dir, 'dispositions.json') })
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { service.close(() => resolve()); service.closeAllConnections() }))
  const base = `http://127.0.0.1:${(service.address() as any).port}`
  const call = async (path: string, method = 'GET', body?: any, headers: any = owner) => fetch(`${base}${path}`, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const create = async (label: string, privacy = 'standard') => {
    const r = await call('/wizard/v1/agents', 'POST', { label, harness: 'hermes', permissions: { preset: privacy }, model: { provider: 'tinfoil', model: 'glm-5-3' } })
    const value = await r.json(); expect([r.status, value.error]).toEqual([201, undefined]); return value.agent
  }
  return { dir, settingsPath, agentsDir, base, call, create, calls, histories, status, dispatch, manifestPath }
}

describe('persisted default and recovery contract', () => {
  it('starts and serves chats with corrupt optional metadata, preserving every corrupt byte', async () => {
    const s = await scene({ badOptional: true })
    expect((await s.call('/wizard/hermes/api/sessions', 'POST', { source: 'wizard-mobile' })).status).toBe(201)
    expect((await s.call('/wizard/v1/bootstrap')).status).toBe(200)
    for (const name of ['titles', 'subjects', 'status']) expect(readFileSync(join(s.dir, name + '.json'), 'utf8')).toBe('{bad')
  })
  it('a stopped unrelated agent does not couple server-minted new chats to its availability', async () => {
    const s = await scene(), offline = await s.create('Offline')
    await s.call('/wizard/v1/agents/' + offline.id + '/stop', 'POST', {})
    const offset = s.calls.length
    const response = await s.call('/wizard/hermes/api/sessions', 'POST', { source: 'wizard-mobile' })
    const body = await response.json()
    expect(response.status).toBe(201)
    expect(body.session.id).toMatch(/^wizard_\d+_[a-f0-9]{32}$/)
    expect(s.calls.slice(offset).some(row => row.agent === offline.id)).toBe(false)
    expect(createAgentRegistry({ agentsDir: s.agentsDir }).pinnedAgent(body.session.id)).toBe('hermes')
    // Service-driven stop sealed the offline index against the driver generation.
    expect((await s.call('/wizard/hermes/api/sessions', 'POST', { id: 'wizard_fresh', source: 'wizard-mobile' })).status).toBe(201)
    // A known indexed pair can continue without querying unrelated agents.
    expect((await s.call('/wizard/hermes/api/sessions/' + body.session.id + '?agent=hermes', 'PATCH', { title: 'Changed' })).status).toBe(200)
  })
  it('main-only actions authorize recovery and reject explicit secondary pairs before touching main', async () => {
    const s = await scene(), managed = await s.create('Managed')
    s.histories.get(managed.id)!.add('wizard_old')
    const actions: [string, string, any][] = [
      ['/wizard/filings', 'POST', { session_id: 'wizard_old', client_command_id: 'review-file', runtime: 'direct' }],
      ['/wizard/filings/wizard_old/status', 'POST', { runtime: 'direct' }],
      ['/wizard/session-failure/wizard_old/dismiss', 'POST', {}],
    ]
    for (const [path, method, body] of actions) {
      const offset = s.calls.length
      const r = await s.call(path, method, { ...body, agent_id: managed.id })
      expect([r.status, (await r.json()).check]).toEqual([409, 'agent.unsupported_action'])
      expect(s.calls.slice(offset)).toEqual([])
    }
    await s.call('/wizard/v1/settings', 'PUT', { agents: { default_agent_id: managed.id } })
    await s.call('/wizard/v1/agents/hermes', 'PATCH', { role: 'recovery' })
    for (const [path, method, body] of actions) {
      const offset = s.calls.length
      const hidden = await s.call(path, method, { ...body, agent_id: 'hermes' }, {})
      const missing = await s.call(path, method, { ...body, agent_id: 'missing' }, {})
      expect(hidden.status).toBe(404); expect(await hidden.json()).toEqual(await missing.json())
      expect(s.calls.slice(offset)).toEqual([])
      expect((await s.call(path, method, body)).status).toBe(409)
    }
    for (const [path, method, body] of [
      ['/wizard/hermes/api/sessions/wizard_old?agent=hermes', 'PATCH', { archived: true, title: 'changed' }],
      ['/wizard/operator/api/sessions/operator:old?agent=hermes', 'PATCH', { archived: true }],
    ] as [string, string, any][]) {
      const offset = s.calls.length
      expect((await s.call(path, method, body, {})).status).toBe(404)
      expect(s.calls.slice(offset)).toEqual([])
    }
    for (const path of ['/wizard/attention', '/wizard/background-results', '/wizard/attachments/' + 'a'.repeat(32)]) expect((await s.call(path, 'GET', undefined, {})).status).toBe(404)
  })

  it('settings/bootstrap omit a hidden default and clients can boot and explicitly select a visible agent without it', async () => {
    const s = await scene(), hidden = await s.create('Hidden Default', 'private')
    await s.call('/wizard/v1/settings', 'PUT', { agents: { default_agent_id: hidden.id } })
    for (const path of ['/wizard/v1/settings', '/wizard/v1/bootstrap']) {
      const r = await s.call(path, 'GET', undefined, {}), body = await r.json()
      expect(r.status).toBe(200)
      expect(body.settings.agents).not.toHaveProperty('default_agent_id')
      expect(JSON.stringify(body)).not.toContain(hidden.id)
      expect((await (await s.call(path)).json()).settings.agents.default_agent_id).toBe(hidden.id)
    }
    // A settings client roundtripping the redacted projection must preserve the stored default.
    const redacted = (await (await s.call('/wizard/v1/settings', 'GET', undefined, {})).json()).settings
    expect((await s.call('/wizard/v1/settings', 'PUT', redacted, {})).status).toBe(200)
    expect(JSON.parse(readFileSync(s.settingsPath, 'utf8')).agents.default_agent_id).toBe(hidden.id)
    expect((await s.call('/wizard/hermes/api/sessions', 'POST', { source: 'wizard-mobile' }, {})).status).toBe(404)
    expect((await s.call('/wizard/hermes/api/sessions?agent=hermes', 'POST', { id: 'wizard_visible', source: 'wizard-mobile' }, {})).status).toBe(201)
  })
  it('fresh box snapshot: legacy agents and default binding stay identical; new chat still reaches Hermes', async () => {
    const s = await scene()
    const list = await (await s.call('/wizard/v1/agents')).json()
    expect(list.agents).toMatchInlineSnapshot(`
      [
        {
          "appearance": {
            "glyph": "spark",
            "hue": 265,
          },
          "bound_apps": [
            {
              "id": "notes",
              "label": "Notes",
              "purpose": "",
            },
          ],
          "created_at": null,
          "harness": "hermes",
          "id": "hermes",
          "is_default": true,
          "label": "Hermes",
          "model": {
            "allowed_models": [],
            "fallback": true,
            "model": "",
            "provider": "host",
          },
          "permissions": {
            "agent_apps": [],
            "files": "shared-write",
            "other_agents": "none",
            "outside_tools": [
              "web",
              "search",
              "browser",
              "x_search",
              "vision",
              "video",
              "image_gen",
              "video_gen",
              "tts",
              "delegation",
              "connections",
              "homeassistant",
              "spotify",
            ],
            "preset": "standard",
            "wizard_apps": [
              "notes",
            ],
          },
          "privacy": "standard",
          "status": "running",
          "status_detail": "",
        },
      ]
    `)
    expect((await (await s.call('/wizard/v1/app-bindings')).json()).bindings).toMatchInlineSnapshot(`
      [
        {
          "agent": "hermes",
          "agent_info": {
            "appearance": {
              "glyph": "spark",
              "hue": 265,
            },
            "id": "hermes",
            "label": "Hermes",
            "privacy": "standard",
          },
          "app_id": "notes",
          "is_default": true,
          "label": "Notes",
          "purpose": "",
          "required": false,
        },
      ]
    `)
    expect((await s.call('/wizard/hermes/api/sessions', 'POST', { id: 'wizard_fresh', source: 'wizard-mobile' })).status).toBe(201)
    expect(s.calls.filter(c => c.method === 'POST')).toEqual([{ agent: 'hermes', method: 'POST', path: '/api/sessions', body: { id: 'wizard_fresh', source: 'wizard-mobile' } }])
  })

  it('normalizes unknown settings and only an owner changes the default, including invalid attempted selections', async () => {
    const s = await scene(), managed = await s.create('Managed')
    expect(normalizeSettings({ agents: { default_agent_id: 'unknown' } }).agents.default_agent_id).toBe('hermes')
    for (const id of [managed.id, 'unknown']) {
      const denied = await s.call('/wizard/v1/settings', 'PUT', { agents: { default_agent_id: id } }, {})
      expect(denied.status).toBe(200)
      expect((await denied.json()).settings.agents.default_agent_id).toBe('hermes')
    }
    expect((await s.call('/wizard/v1/settings', 'PUT', { agents: { default_agent_id: managed.id } })).status).toBe(200)
    expect(JSON.parse(readFileSync(s.settingsPath, 'utf8')).agents.default_agent_id).toBe(managed.id)
    expect((await (await s.call('/wizard/v1/settings')).json()).settings.agents.default_agent_id).toBe(managed.id)
    const agents = (await (await s.call('/wizard/v1/agents')).json()).agents
    expect(agents.filter((a: any) => a.is_default).map((a: any) => a.id)).toEqual([managed.id])
    expect(createAgentRegistry({ agentsDir: s.agentsDir }).read('hermes').runtime.kind).toBe('external')
    expect(JSON.parse(readFileSync(join(s.agentsDir, managed.id, 'agent.json'), 'utf8')).runtime.kind).toBe('container')
  })

  it('new chats, voice-shaped runs, automation requests and default bindings move; existing threads do not', async () => {
    const s = await scene(), managed = await s.create('Managed')
    await s.call('/wizard/hermes/api/sessions/wizard_old')
    await s.call('/wizard/v1/settings', 'PUT', { agents: { default_agent_id: managed.id } })
    for (const input of [
      { path: '/wizard/hermes/api/sessions', body: { id: 'wizard_new', source: 'wizard-mobile' } },
      { path: '/wizard/hermes/v1/runs', body: { session_id: 'wizard_voice', input: 'transcribed voice' } },
      { path: '/wizard/hermes/v1/runs', body: { session_id: 'wizard_cron', input: 'automation result' } },
    ]) expect((await s.call(input.path, 'POST', input.body, {})).status).toBeLessThan(300)
    expect(s.calls.filter(c => c.method === 'POST').map(c => c.agent)).toEqual([managed.id, managed.id, managed.id])
    expect((await (await s.call('/wizard/v1/apps/notes/binding')).json()).binding).toMatchObject({ agent: managed.id, is_default: true })
    const old = await (await s.call('/wizard/hermes/api/sessions/wizard_old')).json()
    expect(old.session.agent_id).toBe('hermes')
    s.status.set(managed.id, 'stopped')
    const before = s.calls.filter(c => c.agent === 'hermes' && c.method === 'POST').length
    expect((await s.call('/wizard/hermes/v1/runs', 'POST', { session_id: 'wizard_offline', input: 'not a fallback' })).status).toBeGreaterThanOrEqual(400)
    expect(s.calls.filter(c => c.agent === 'hermes' && c.method === 'POST')).toHaveLength(before)
  })

  it('a private container can be default; an offline pinned private binding never falls back to a new default', async () => {
    const s = await scene(), priv = await s.create('Private', 'private'), managed = await s.create('Managed')
    expect((await s.call('/wizard/v1/settings', 'PUT', { agents: { default_agent_id: priv.id } })).status).toBe(200)
    expect((await s.call('/wizard/hermes/v1/runs', 'POST', { session_id: 'wizard_private_default', input: 'owner' })).status).toBe(202)
    expect((await s.call('/wizard/hermes/v1/runs', 'POST', { session_id: 'wizard_private_denied', input: 'not owner' }, {})).status).toBe(404)
    expect((await s.call('/wizard/v1/apps/notes/binding', 'PUT', { agent: priv.id, is_default: false })).status).toBe(200)
    await s.call('/wizard/v1/settings', 'PUT', { agents: { default_agent_id: managed.id } })
    s.status.set(priv.id, 'stopped')
    const before = s.calls.filter(c => c.method === 'POST' && c.agent !== priv.id).length
    expect((await s.call('/wizard/hermes/v1/runs', 'POST', { session_id: 'wizard_private_default', input: 'still private', agent_id: priv.id })).status).toBe(503)
    expect(s.calls.filter(c => c.method === 'POST' && c.agent !== priv.id)).toHaveLength(before)
    expect((await (await s.call('/wizard/v1/apps/notes/binding')).json()).binding).toMatchObject({ agent: priv.id, is_default: false })
  })

  it('recovery promotion refuses a pre-existing grant until the owner removes it', async () => {
    const s = await scene(), managed = await s.create('Managed')
    await s.call('/wizard/v1/settings', 'PUT', { agents: { default_agent_id: managed.id } })
    const grant = await (await s.call('/wizard/v1/agent-grants', 'POST', { reader: managed.id, source: 'hermes', scope: 'titles' })).json()
    expect(grant.grant.id).toBeTruthy()
    const denied = await s.call('/wizard/v1/agents/hermes', 'PATCH', { role: 'recovery' })
    expect([denied.status, (await denied.json()).error]).toEqual([409, 'recovery_agent_granted'])
    expect((await s.call(`/wizard/v1/agent-grants/${grant.grant.id}`, 'DELETE')).status).toBe(200)
    expect((await s.call('/wizard/v1/agents/hermes', 'PATCH', { role: 'recovery' })).status).toBe(200)
  })

  it('qualified duplicate ids open independently, id-only is ambiguous, side state never mixes', async () => {
    const s = await scene(), managed = await s.create('Managed'), id = 'wizard_duplicate'
    s.histories.get('hermes')!.add(id); s.histories.get(managed.id)!.add(id)
    for (const agent of ['hermes', managed.id]) {
      const result = await s.call(`/wizard/hermes/api/sessions/${id}?agent_id=${agent}`)
      expect((await result.json()).session).toMatchObject({ agent_id: agent, session_id: id })
      expect((await s.call('/wizard/thread-dispositions', 'PUT', { runtime: 'direct', session_id: id, agent_id: agent, deferred: agent === 'hermes' })).status).toBe(200)
    }
    const ambiguous = await s.call(`/wizard/hermes/api/sessions/${id}`)
    expect([ambiguous.status, (await ambiguous.json()).check]).toEqual([409, 'agent.ambiguous_thread'])
    const pins = JSON.parse(readFileSync(join(s.agentsDir, '.threads.json'), 'utf8'))
    expect(Object.values(pins.threads).filter((row: any) => row.session_id === id)).toHaveLength(2)
    const state = (await (await s.call('/wizard/thread-dispositions')).json()).state
    expect(state[`direct:${id}`]).toMatchObject({ agent_id: 'hermes', deferred: true })
    expect(state[`agent/${managed.id}/direct:${id}`]).toMatchObject({ agent_id: managed.id, deferred: false })
    const seen = new ThreadSeenStore(join(s.dir, 'pair-seen.json'))
    const record = { updatedAt: '2026-01-01T00:00:00Z', previewFingerprint: 'abc', seenAt: 1 }
    seen.merge('owner', { initializedAt: 0, threads: { [`direct:${id}`]: record, [`agent/${managed.id}/direct:${id}`]: { ...record, seenAt: 2 } } })
    expect(Object.keys(seen.get('owner').threads)).toHaveLength(2)
    const voice = { sessionId: id, intentId: 'intent', sourceFileId: 'audio', audioSha256: 'a'.repeat(64), inputSha256: 'b'.repeat(64) }
    const ambiguousReceipt = await s.call('/wizard/voice/recovery-receipt', 'POST', voice)
    expect([ambiguousReceipt.status, (await ambiguousReceipt.json()).check]).toEqual([409, 'agent.ambiguous_thread'])
    const importedReceipt = await s.call('/wizard/voice/recovery-receipt', 'POST', { ...voice, agent_id: managed.id })
    expect([importedReceipt.status, await importedReceipt.json()]).toEqual([200, { receipt: null }])
  })

  it('a non-owner sees the visible duplicate only; a never-pinned private id cannot be claimed', async () => {
    const s = await scene(), priv = await s.create('Private', 'private'), other = await s.create('Other')
    const id = 'wizard_private_unlisted'
    s.histories.get(priv.id)!.add(id)
    const denied = await s.call('/wizard/hermes/v1/runs', 'POST', { agent: other.id, session_id: id, input: 'claim' }, {})
    expect(denied.status).toBe(404)
    expect(s.calls.filter(c => c.agent === other.id && c.method === 'POST')).toHaveLength(0)
    const hidden = await s.call(`/wizard/hermes/api/sessions/${id}`, 'GET', undefined, {})
    const missing = await s.call('/wizard/hermes/api/sessions/wizard_missing', 'GET', undefined, {})
    expect([hidden.status, await hidden.text()]).toEqual([missing.status, await missing.text()])
    s.histories.get('hermes')!.add(id)
    for (const agent of ['hermes', priv.id]) await s.call(`/wizard/hermes/api/sessions/${id}?agent=${agent}`)
    const visible = await s.call(`/wizard/hermes/api/sessions/${id}`, 'GET', undefined, {})
    expect((await visible.json()).session.agent_id).toBe('hermes')
  })

  it('recovery is owner-only, explicitly selected, never a default, binding, app member or model route', async () => {
    const s = await scene(), managed = await s.create('Managed')
    expect((await s.call('/wizard/v1/agents/hermes', 'PATCH', { role: 'recovery' })).status).toBe(409)
    await s.call('/wizard/v1/settings', 'PUT', { agents: { default_agent_id: managed.id } })
    expect((await s.call('/wizard/v1/agents/hermes', 'PATCH', { role: 'recovery' }, {})).status).toBe(403)
    const update = await s.call('/wizard/v1/agents/hermes', 'PATCH', { role: 'recovery' })
    expect(update.status).toBe(200)
    expect((await update.json()).agent).toMatchObject({ id: 'hermes', role: 'recovery', label: 'Hermes (system)', is_default: false })
    expect((await s.call('/wizard/v1/settings', 'PUT', { agents: { default_agent_id: 'hermes' } })).status).toBe(409)
    expect((await s.call('/wizard/v1/apps/notes/binding', 'PUT', { agent: 'hermes' })).status).toBe(409)
    expect((await (await s.call('/wizard/v1/agents', 'GET', undefined, {})).json()).agents.map((a: any) => a.id)).not.toContain('hermes')
    for (const path of ['/wizard/v1/agents/hermes', '/wizard/hermes/api/sessions?agent=hermes']) {
      const hidden = await s.call(path, 'GET', undefined, {}), missing = await s.call(path.replace('=hermes', '=nobody').replace('/agents/hermes', '/agents/nobody'), 'GET', undefined, {})
      expect([hidden.status, await hidden.text()]).toEqual([missing.status, await missing.text()])
    }
    expect((await s.call('/wizard/hermes/api/sessions/wizard_old?agent=hermes')).status).toBe(200)
    expect((await s.call('/wizard/hermes/v1/runs?agent=hermes', 'POST', { session_id: 'wizard_old', input: 'owner recovery' })).status).toBe(202)
    const before = s.calls.filter(c => c.agent === 'hermes' && c.method === 'POST').length
    expect((await s.call('/wizard/hermes/v1/runs', 'POST', { session_id: 'wizard_automatic', input: 'automatic' }, {})).status).toBe(202)
    expect(s.calls.filter(c => c.agent === 'hermes' && c.method === 'POST')).toHaveLength(before)
    const members = (await (await s.call('/wizard/v1/apps/notes/agents')).json()).agents
    expect(members.map((a: any) => a.id)).not.toContain('hermes')
    expect((await s.call(`/wizard/v1/agents/${managed.id}`, 'PATCH', { role: 'recovery' })).status).toBe(409)
  })

  it('agent credentials cannot change the default or name recovery, and recovery is not a grant/app target', async () => {
    const s = await scene(), managed = await s.create('Managed')
    writeFileSync(join(s.agentsDir, managed.id, 'gateway.key'), 'fixture-agent-credential')
    const bearer = { Authorization: 'Bearer fixture-agent-credential' }
    const denied = await s.call('/wizard/v1/settings', 'PUT', { agents: { default_agent_id: managed.id } }, bearer)
    expect([denied.status, await denied.json()]).toEqual([403, { error: 'agent_scope', check: 'principal.agent_scope' }])
    await s.call('/wizard/v1/settings', 'PUT', { agents: { default_agent_id: managed.id } })
    await s.call('/wizard/v1/agents/hermes', 'PATCH', { role: 'recovery' })
    for (const path of ['/wizard/v1/agents/hermes', '/wizard/hermes/api/sessions?agent=hermes']) {
      const hidden = await s.call(path, 'GET', undefined, bearer)
      const missing = await s.call(path.replace('=hermes', '=nobody').replace('/agents/hermes', '/agents/nobody'), 'GET', undefined, bearer)
      expect([hidden.status, await hidden.text()]).toEqual([missing.status, await missing.text()]); expect(hidden.status).toBe(404)
    }
    expect((await s.call('/wizard/v1/agent-grants', 'POST', { reader: managed.id, source: 'hermes', level: 'read' })).status).toBeGreaterThanOrEqual(400)
    expect((await s.call('/wizard/v1/apps/notes/agents', 'PUT', { agents: ['hermes'] })).status).toBeGreaterThanOrEqual(400)
    expect((await s.call('/wizard/background-results', 'GET', undefined, {})).status).toBe(404)
    const run = await s.call('/wizard/hermes/v1/runs', 'POST', { input: 'model routing', session_id: 'wizard_model', provider: 'tinfoil', model: 'glm-5-3' })
    expect(run.status).toBe(202)
    expect(s.calls.filter(c => c.method === 'POST').every(c => c.agent !== 'hermes')).toBe(true)
  })

  it('queued work admitted before recovery is fenced; explicit owner recovery admission can dispatch', async () => {
    const s = await scene({ queued: true }), managed = await s.create('Managed')
    const queued = await (await s.call('/wizard/hermes/v1/runs', 'POST', { input: 'old queued automation', session_id: 'wizard_old' }, { ...owner, 'Idempotency-Key': 'old-automation' })).json()
    expect(queued.agent_id).toBe('hermes')
    await s.call('/wizard/v1/settings', 'PUT', { agents: { default_agent_id: managed.id } })
    await s.call('/wizard/v1/agents/hermes', 'PATCH', { role: 'recovery' })
    s.dispatch.healthy = true
    await s.call(`/wizard/hermes/v1/runs/${queued.run_id}?agent=hermes`)
    expect(s.calls.filter(c => c.agent === 'hermes' && c.method === 'POST')).toEqual([])
    const manual = await s.call('/wizard/hermes/v1/runs?agent=hermes', 'POST', { input: 'owner recovery', session_id: 'wizard_owner_recovery' }, { ...owner, 'Idempotency-Key': 'owner-recovery' })
    expect(manual.status).toBe(202)
    const payload = await manual.json()
    await s.call(`/wizard/hermes/v1/runs/${payload.run_id}?agent=hermes`)
    expect(s.calls.filter(c => c.agent === 'hermes' && c.method === 'POST' && c.path === '/v1/runs').map(c => c.body.input)).toEqual(['owner recovery'])
  })

  it('voice recovery manifests acquire explicit pairs with their original backup; run mappings survive registry reopen', async () => {
    const manifest = { version: 1, entries: [{ sessionId: 'wizard_old', sourceFileId: 'audio-fixture' }] }
    const s = await scene({ manifest }), managed = await s.create('Managed')
    expect(JSON.parse(readFileSync(s.manifestPath, 'utf8')).entries[0]).toMatchObject({ agent_id: 'hermes', session_id: 'wizard_old' })
    expect(JSON.parse(readFileSync(s.manifestPath + '.pre-agent-pairs-v1.bak', 'utf8'))).toEqual(manifest)
    const run = await (await s.call('/wizard/hermes/v1/runs', 'POST', { input: 'new', session_id: 'wizard_imported', agent_id: managed.id })).json()
    const reopened = createAgentRegistry({ agentsDir: s.agentsDir, settingsPath: s.settingsPath })
    expect(reopened.runAgent(run.run_id)).toBe(managed.id)
    expect(JSON.parse(readFileSync(join(s.agentsDir, '.run-threads.json'), 'utf8')).runs[run.run_id]).toContainEqual({ run_id: run.run_id, agent_id: managed.id, session_id: 'wizard_imported' })
  })

  it('legacy pin/seen/disposition stores migrate once with original backups and can be restored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pairs-migrate-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const agentsDir = join(dir, 'agents'); mkdirSync(agentsDir)
    const pinPath = join(agentsDir, '.threads.json'), seenPath = join(dir, 'seen.json'), dispositionPath = join(dir, 'dispositions.json')
    const record = { updatedAt: '2026-01-01T00:00:00Z', previewFingerprint: 'abc', seenAt: 1 }
    const originals: Record<string, string> = {
      [pinPath]: JSON.stringify({ schema: 1, threads: { wizard_old: 'hermes' } }),
      [seenPath]: JSON.stringify({ schema: 1, scopes: { owner: { initializedAt: 0, threads: { 'direct:wizard_old': record } } } }),
      [dispositionPath]: JSON.stringify({ schema: 1, scopes: { owner: { 'direct:wizard_old': { deferred: true, updatedAt: record.updatedAt } } } }),
    }
    for (const [path, value] of Object.entries(originals)) writeFileSync(path, value)
    const load = () => { createAgentRegistry({ agentsDir }); new ThreadSeenStore(seenPath); new ThreadDispositionStore(dispositionPath) }
    load()
    const first = Object.fromEntries(Object.keys(originals).map(path => [path, readFileSync(path, 'utf8')]))
    expect(JSON.parse(first[pinPath]).threads[threadKey('hermes', 'wizard_old')]).toEqual({ agent_id: 'hermes', session_id: 'wizard_old', provenance: 'migrated_pin' })
    load()
    for (const [path, original] of Object.entries(originals)) {
      expect(readFileSync(path, 'utf8')).toBe(first[path])
      expect(readFileSync(`${path}.pre-agent-pairs-v1.bak`, 'utf8')).toBe(original)
      writeFileSync(path, readFileSync(`${path}.pre-agent-pairs-v1.bak`))
    }
    load()
    for (const path of Object.keys(originals)) expect(readFileSync(path, 'utf8')).toBe(first[path])
  })

  it('queue migration backs up WAL data, old rows stay Hermes, reopen is idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-pairs-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'queue.sqlite'), options = { statePath: path, pollIntervalMs: 0, canDispatch: () => false, launch: async () => ({}), lookup: async () => ({}) }
    const first = new DurableRunQueue(options)
    await first.admit({ runtime: 'direct', sessionId: 'wizard_old', idempotencyKey: 'old', requestHash: 'a'.repeat(64), body: '{"input":"old"}' })
    first.close()
    // Reset the creation inventory when downgrading this fixture to the archived schema.
    rmSync(join(dir, '.agent-pairs-v1.inventory.json'))
    const legacy = new DatabaseSync(path)
    legacy.exec('PRAGMA wal_autocheckpoint=0; ALTER TABLE wizard_run_queue DROP COLUMN agent_id; ALTER TABLE wizard_run_queue DROP COLUMN recovery_authorized')
    legacy.prepare('UPDATE wizard_run_queue SET body=?,continuation_json=?').run('{"input":"wal-only"}', JSON.stringify({ kind: 'helper', sessionId: 'wizard_old', receipt: { sessionId: 'wizard_old' } }))
    const migrated = new DurableRunQueue(options)
    legacy.close()
    expect(migrated.byIdempotencyKey('direct', 'old').agent_id).toBe('hermes')
    expect(migrated.byIdempotencyKey('direct', 'old')?.continuation).toMatchObject({ agent_id: 'hermes', session_id: 'wizard_old', receipt: { agent_id: 'hermes', session_id: 'wizard_old' } })
    migrated.close()
    const backup = new DatabaseSync(`${path}.pre-agent-pairs-v1.bak`, { readOnly: true })
    expect(backup.prepare('SELECT session_id FROM wizard_run_queue').get().session_id).toBe('wizard_old')
    expect(backup.prepare('SELECT body FROM wizard_run_queue').get()?.body).toBe('{"input":"wal-only"}')
    expect(backup.prepare('PRAGMA table_info(wizard_run_queue)').all().map((r: any) => r.name)).not.toContain('agent_id'); backup.close()
    const reopened = new DurableRunQueue(options)
    expect(reopened.byIdempotencyKey('direct', 'old').agent_id).toBe('hermes'); reopened.close()
    const original = readFileSync(`${path}.pre-agent-pairs-v1.bak`)
    rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true }); writeFileSync(path, original)
    const restored = new DurableRunQueue(options)
    expect(restored.byIdempotencyKey('direct', 'old')).toMatchObject({ agent_id: 'hermes', sessionId: 'wizard_old', body: '{"input":"wal-only"}' }); restored.close()
    expect(readFileSync(`${path}.pre-agent-pairs-v1.bak`)).toEqual(original)
  })
})
