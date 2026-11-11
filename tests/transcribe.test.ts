import { linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TRANSCRIBE_TOOL, readAgentAudio, resolveAgentAudioPath, transcribeTool } from '../server/transcribe.mjs'
import { createAgentBridge } from '../server/agent-bridge.mjs'
import { createAgentRegistry } from '../server/agents.mjs'
import { speechText } from '../server/service.mjs'

let root: string
let home: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wizard-transcribe-'))
  home = join(root, 'agents', 'helper', 'home')
  mkdirSync(join(home, 'inbox', '2026-11-11'), { recursive: true })
  writeFileSync(join(home, 'inbox', '2026-11-11', 'note.wav'), Buffer.from('RIFFfakewav'))
  writeFileSync(join(home, '.env'), 'WIZARD_MCP_TOKEN=secret')
  writeFileSync(join(root, 'outside.wav'), Buffer.from('outside'))
  mkdirSync(join(root, 'agents', 'other', 'home'), { recursive: true })
  writeFileSync(join(root, 'agents', 'other', 'home', 'theirs.wav'), Buffer.from('theirs'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const text = (r: any) => r.content[0].text
const json = (r: any) => JSON.parse(text(r))
type Seen = { url: string; form: FormData }
function tool(reply: any, seen: Seen[] = [], extra: any = {}) {
  const fetchImpl = async (url: string, init: any) => { seen.push({ url, form: init.body }); return typeof reply === 'function' ? reply() : reply }
  return transcribeTool({ homeOf: (id: string) => (id === 'helper' ? home : ''), sttOrigin: 'http://127.0.0.1:8864', fetchImpl: fetchImpl as any, ...extra })
}
const jsonReply = (value: any, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

describe('path confinement', () => {
  it('maps /opt/data, the host path and relative paths into the agent home', () => {
    const real = resolveAgentAudioPath(home, '/opt/data/inbox/2026-11-11/note.wav')
    expect(real.endsWith(join('agents', 'helper', 'home', 'inbox', '2026-11-11', 'note.wav'))).toBe(true)
    expect(resolveAgentAudioPath(home, 'inbox/2026-11-11/note.wav')).toBe(real)
    expect(resolveAgentAudioPath(home, join(home, 'inbox/2026-11-11/note.wav'))).toBe(real)
  })

  it('rejects traversal, outside paths, other agents, symlink escapes, non-files and non-audio', () => {
    symlinkSync(join(root, 'outside.wav'), join(home, 'link.wav'))
    symlinkSync(join(root, 'agents', 'other', 'home'), join(home, 'dirlink'))
    const bad = [
      '/opt/data/../../outside.wav', '../../../outside.wav', '/opt/data/inbox/../../x.wav', 'inbox/..\\..\\outside.wav',
      join(root, 'outside.wav'), join(root, 'agents', 'other', 'home', 'theirs.wav'), '/etc/passwd', '/opt/datax/x.wav',
      '/opt/data/link.wav', '/opt/data/dirlink/theirs.wav', '/opt/data/inbox', '/opt/data/.env', '/opt/data/missing.wav',
      '', '   ', 'a\0b.wav', 'x'.repeat(2000), 42 as any, null as any,
    ]
    for (const p of bad) expect(() => resolveAgentAudioPath(home, p), String(p)).toThrow()
    expect(() => resolveAgentAudioPath('', '/opt/data/inbox/2026-11-11/note.wav')).toThrow()
  })

  it('the tool reports these as errors and never calls the voice service', async () => {
    const seen: Seen[] = []
    const t = tool(jsonReply({ text: 'x' }), seen)
    for (const path of ['/opt/data/../../outside.wav', join(root, 'outside.wav'), '/opt/data/.env']) {
      const r = await t.call(TRANSCRIBE_TOOL, { path }, 'helper')
      expect(r.isError).toBe(true)
    }
    expect(seen).toHaveLength(0)
  })
})

describe('wizard_transcribe', () => {
  it('uploads the agent file to the voice service and returns the text', async () => {
    const seen: Seen[] = []
    const t = tool(jsonReply({ text: ' Hello there. ', provider: 'tinfoil-attested', model: 'voxtral-small-24b', latency_ms: 12 }), seen)
    const r = await t.call(TRANSCRIBE_TOOL, { path: '/opt/data/inbox/2026-11-11/note.wav', language: 'en' }, 'helper')
    expect(r.isError).toBeUndefined()
    expect(json(r)).toMatchObject({ text: 'Hello there.', provider: 'tinfoil-attested', model: 'voxtral-small-24b', mode: 'meeting' })
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe('http://127.0.0.1:8864/v1/audio/transcriptions')
    expect(seen[0].form.get('mode')).toBe('meeting')
    expect(seen[0].form.get('language')).toBe('en')
    expect((seen[0].form.get('file') as File).name).toBe('note.wav')
  })

  it('validates mode and language and passes a chosen mode through', async () => {
    const seen: Seen[] = []
    const t = tool(jsonReply({ text: 'ok' }), seen)
    expect((await t.call(TRANSCRIBE_TOOL, { path: 'inbox/2026-11-11/note.wav', mode: 'shout' }, 'helper')).isError).toBe(true)
    expect((await t.call(TRANSCRIBE_TOOL, { path: 'inbox/2026-11-11/note.wav', language: 'en; rm' }, 'helper')).isError).toBe(true)
    expect(json(await t.call(TRANSCRIBE_TOOL, { path: 'inbox/2026-11-11/note.wav', mode: 'verbatim' }, 'helper')).mode).toBe('verbatim')
    expect(seen[0].form.get('mode')).toBe('verbatim')
  })

  it('reports a silent take as no speech, from either the empty text or the service 422', async () => {
    expect(json(await tool(jsonReply({ text: '' })).call(TRANSCRIBE_TOOL, { path: 'inbox/2026-11-11/note.wav' }, 'helper'))).toMatchObject({ text: '', no_speech: true })
    expect(json(await tool(jsonReply({ detail: 'No speech detected' }, 422)).call(TRANSCRIBE_TOOL, { path: 'inbox/2026-11-11/note.wav' }, 'helper'))).toMatchObject({ text: '', no_speech: true })
  })

  it('says the voice service is down, and tells the agent not to install anything', async () => {
    const logs: string[] = []
    const t = tool(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }, [], { log: (l: string) => logs.push(l) })
    const r = await t.call(TRANSCRIBE_TOOL, { path: '/opt/data/inbox/2026-11-11/note.wav' }, 'helper')
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('not reachable')
    expect(text(r)).toContain('do not install speech software')
    expect(logs.join('\n')).not.toContain('note.wav')
  })

  it('maps a service error, an unusable reply and a timeout to errors without leaking host paths', async () => {
    const down = await tool(jsonReply({ error: 'boom' }, 502)).call(TRANSCRIBE_TOOL, { path: 'inbox/2026-11-11/note.wav' }, 'helper')
    expect(down.isError).toBe(true); expect(text(down)).toContain('502')
    const junk = await tool(new Response('<html>', { status: 200 })).call(TRANSCRIBE_TOOL, { path: 'inbox/2026-11-11/note.wav' }, 'helper')
    expect(junk.isError).toBe(true)
    const slow = transcribeTool({ homeOf: () => home, sttOrigin: 'http://x', timeoutMs: 20, fetchImpl: ((_u: string, init: any) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as any })
    const r = await slow.call(TRANSCRIBE_TOOL, { path: 'inbox/2026-11-11/note.wav' }, 'helper')
    expect(r.isError).toBe(true); expect(text(r)).toContain('too long')
    for (const r2 of [down, junk, r]) expect(text(r2)).not.toContain(root)
  })

  it('refuses empty and oversize files, an unknown agent, and a busy transcriber', async () => {
    writeFileSync(join(home, 'empty.wav'), '')
    writeFileSync(join(home, 'big.wav'), Buffer.alloc(2048))
    const t = tool(jsonReply({ text: 'x' }), [], { maxBytes: 1024 })
    expect(text(await t.call(TRANSCRIBE_TOOL, { path: 'empty.wav' }, 'helper'))).toContain('empty')
    expect(text(await t.call(TRANSCRIBE_TOOL, { path: 'big.wav' }, 'helper'))).toContain('limit')
    expect((await t.call(TRANSCRIBE_TOOL, { path: 'inbox/2026-11-11/note.wav' }, 'nobody')).isError).toBe(true)
    expect((await t.call(TRANSCRIBE_TOOL, { path: 'inbox/2026-11-11/note.wav' }, '')).isError).toBe(true)
    let release: any
    const gate = new Promise((r) => { release = r })
    const busy = tool(() => gate.then(() => jsonReply({ text: 'x' })))
    const first = [1, 2].map(() => busy.call(TRANSCRIBE_TOOL, { path: 'inbox/2026-11-11/note.wav' }, 'helper'))
    await new Promise((r) => setTimeout(r, 10))
    expect(text(await busy.call(TRANSCRIBE_TOOL, { path: 'inbox/2026-11-11/note.wav' }, 'helper'))).toContain('busy')
    release(); await Promise.all(first)
  })

  it('ignores other tool names, hides itself when voice is off or the agent is not allowed', async () => {
    const t = tool(jsonReply({ text: 'x' }), [], { allowed: (id: string) => id !== 'sealed' })
    expect(await t.call('wizard_remind', {}, 'helper')).toBeUndefined()
    expect(t.list('helper').map((x: any) => x.name)).toEqual([TRANSCRIBE_TOOL])
    expect(t.list('sealed')).toEqual([])
    expect((await t.call(TRANSCRIBE_TOOL, { path: 'inbox/2026-11-11/note.wav' }, 'sealed')).isError).toBe(true)
    const off = tool(jsonReply({ text: 'x' }), [], { enabled: () => false })
    expect(off.list('helper')).toEqual([])
    expect((await off.call(TRANSCRIBE_TOOL, { path: 'inbox/2026-11-11/note.wav' }, 'helper')).isError).toBe(true)
  })

  it('tells agents to use it for audio and never to install speech software', () => {
    const [definition] = tool(jsonReply({})).list('helper')
    expect(definition.description).toMatch(/any audio or voice transcription/i)
    expect(definition.description).toMatch(/Never install Whisper/)
    expect(definition.inputSchema.required).toEqual(['path'])
  })

  it('is listed and dispatched on the gateway for the calling agent', async () => {
    const appsJsonPath = join(root, 'apps.json')
    writeFileSync(appsJsonPath, JSON.stringify({ apps: [] }))
    const t = tool(jsonReply({ text: 'from gateway' }))
    const bridge: any = (createAgentBridge as any)({ appsJsonPath, osHome: root, builtins: { list: (id: string) => t.list(id), call: (n: string, a: any, id: string) => t.call(n, a, id) }, watchIntervalMs: 3_600_000 })
    try {
      expect((await bridge.listTools('helper')).map((x: any) => x.name)).toContain(TRANSCRIBE_TOOL)
      expect(json(await bridge.callTool(TRANSCRIBE_TOOL, { path: '/opt/data/inbox/2026-11-11/note.wav' }, 'helper')).text).toBe('from gateway')
    } finally { bridge.close() }
  })
})

describe('hardening', () => {
  it('reads through a pinned descriptor: refuses a hardlinked or symlinked final component and anything oversize', () => {
    linkSync(join(home, 'inbox', '2026-11-11', 'note.wav'), join(home, 'twin.wav'))
    expect(() => readAgentAudio(home, 'twin.wav', 1 << 20)).toThrow(/plain file/)
    symlinkSync(join(root, 'outside.wav'), join(home, 'sneaky.wav'))
    expect(() => readAgentAudio(home, 'sneaky.wav', 1 << 20)).toThrow()
    writeFileSync(join(home, 'ok.wav'), Buffer.from('abcdef'))
    expect(readAgentAudio(home, '/opt/data/ok.wav', 1 << 20)).toEqual({ name: 'ok.wav', bytes: Buffer.from('abcdef') })
    expect(() => readAgentAudio(home, 'ok.wav', 3)).toThrow(/limit/)
  })

  it('sends the discovered transcriber model and keeps only scored speech, like the shell voice routes', async () => {
    const seen: Seen[] = []
    const t = tool(jsonReply({ segments: [{ text: ' Hello.', no_speech_prob: 0.01, avg_logprob: -0.1 }, { text: ' you', no_speech_prob: 0.9, avg_logprob: -0.9 }] }), seen, { modelInfo: async () => ({ id: 'speaches-model', segments: true }), readingOf: speechText })
    expect(json(await t.call(TRANSCRIBE_TOOL, { path: 'inbox/2026-11-11/note.wav' }, 'helper')).text).toBe('Hello.')
    expect(seen[0].form.get('model')).toBe('speaches-model')
    expect(seen[0].form.get('response_format')).toBe('verbose_json')
  })
})

// Per agent kind (main, host-profile, container, restricted): the real registry resolves each agent's own home, the
// tool reads only inside it, and a private agent is refused.
describe('per agent kind', () => {
  it('resolves each kind to its own home, and never another agent\'s', async () => {
    const mainHome = join(root, 'main-home'); mkdirSync(join(mainHome, 'profiles', 'prof'), { recursive: true })
    const registry: any = createAgentRegistry({ agentsDir: join(root, 'registry'), mainHome, localModels: ['fixture-local'], runtime: { apply: async () => ({}), stop: async () => ({}), start: async () => ({}) }, fetchImpl: async () => new Response(JSON.stringify({ data: [], has_more: false })) })
    const make = async (label: string, preset: string) => (await registry.create({ label, model: { provider: 'tinfoil', model: 'glm-5-3' }, permissions: { preset } })).agent
    const container = await make('Container', 'standard'); const restricted = await make('Restricted', 'standard'); const priv = await make('Private', 'private')
    const rewrite = (id: string, runtime: any) => { const file = join(root, 'registry', id, 'agent.json'); const record = JSON.parse(readFileSync(file, 'utf8')); record.runtime = { ...record.runtime, ...runtime }; writeFileSync(file, JSON.stringify(record)) }
    rewrite(restricted.id, { isolation: 'restricted', network: { uplink: '127.0.0.0/28', sandbox: '127.0.1.0/28' } })
    const profile = await make('Profile', 'standard')
    rewrite(profile.id, { kind: 'profile', profile: 'prof' })
    const place = (id: string, name: string, bytes: string) => { const dir = registry.stateHome(id); mkdirSync(join(dir, 'inbox'), { recursive: true }); writeFileSync(join(dir, 'inbox', name), bytes) }
    const ids = ['hermes', container.id, restricted.id, profile.id]
    for (const id of ids) place(id, 'take.wav', `bytes-of-${id}`)
    place(priv.id, 'take.wav', 'private-bytes')
    const seen: Seen[] = []
    const t = transcribeTool({ homeOf: (id: string) => registry.stateHome(id), allowed: (id: string) => registry.read(id)?.privacy !== 'private', sttOrigin: 'http://x', fetchImpl: (async (_u: string, init: any) => { seen.push({ url: _u, form: init.body }); return jsonReply({ text: 'ok' }) }) as any })
    for (const id of ids) {
      expect(json(await t.call(TRANSCRIBE_TOOL, { path: '/opt/data/inbox/take.wav' }, id)).text).toBe('ok')
      expect(await (seen.at(-1)!.form.get('file') as File).text()).toBe(`bytes-of-${id}`)
    }
    // Another agent's home is never reachable, by host path or traversal.
    for (const path of [join(registry.stateHome(priv.id), 'inbox', 'take.wav'), '/opt/data/../' + priv.id + '/home/inbox/take.wav']) expect((await t.call(TRANSCRIBE_TOOL, { path }, container.id)).isError).toBe(true)
    expect((await t.call(TRANSCRIBE_TOOL, { path: '/opt/data/inbox/take.wav' }, priv.id)).isError).toBe(true)
    expect(t.list(priv.id)).toEqual([])
    expect(seen).toHaveLength(ids.length)
  })
})
