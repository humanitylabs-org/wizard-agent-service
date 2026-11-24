// Issue 463: agents find built-in WizardOS capabilities before installing their own.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bridgeApps, capabilityIndex, KERNEL_LIMIT, renderKernel } from '../server/agent-bridge.mjs'
import { BUILTIN_JOBS, CAPABILITY_TOOL, createCapabilities } from '../server/capabilities.mjs'

const PLUGIN = join(__dirname, '..', 'hermes-plugin', 'wizard-os')
const SUPERVISOR = join(__dirname, '..', 'hermes-plugin', 'wizard-supervisor-tools')
const app = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id.replace(/-/gu, ' '), status: 'running', provides: [id], mcp: { url: `http://127.0.0.1:9/${id}/mcp` }, ...extra })
const tool = (name: string) => ({ name, description: name, inputSchema: { type: 'object', properties: { path: { type: 'string' } } } })
const py = (code: string, input = '') => execFileSync('python3', ['-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(PLUGIN)}); import kernel, capability_guard as g; ${code}`], { input }).toString()

describe('kernel index line (issue 463)', () => {
  const lists = [[], ['transcription'], BUILTIN_JOBS.map((b) => b.job), [...BUILTIN_JOBS.map((b) => b.job), ...Array.from({ length: 30 }, (_, i) => `job-number-${i}`)]]
  it('replaces the speech-only line with one generated line, within KERNEL_LIMIT, the same in JS and Python', () => {
    for (const opts of <any[]>[{}, { harness: 'generic' }, { skillsIndex: false }, { jobMap: true }]) {
      const off = renderKernel([], opts)
      expect(renderKernel([], <any>{ ...opts, capabilities: null })).toBe(off)
      for (const jobs of lists) {
        const on = renderKernel([], <any>{ ...opts, capabilities: jobs })
        expect(on).not.toContain('never install speech models')
        expect(on).toContain(opts.harness === 'generic' ? '`wizard_capabilities`' : '`mcp__wizard__wizard_capabilities`')
        const line = on.split('\n').find((l) => l.startsWith('Built in: '))
        expect(line).toBeTruthy()
        if (jobs.length) expect(line).toContain('transcription')
        expect(on.split('\nJobs on this box:')[0].length).toBeLessThanOrEqual(KERNEL_LIMIT)
        const args = `${opts.harness === 'generic' ? "'generic'" : "'hermes'"}, job_map=${opts.jobMap ? 'True' : 'False'}, skills_index=${opts.skillsIndex === false ? 'False' : 'None'}`
        expect(py(`print(kernel.render_kernel([], ${args}, capabilities=json.load(sys.stdin)), end='')`, JSON.stringify(jobs))).toBe(on)
      }
      expect(py(`print(kernel.render_kernel([], ${opts.harness === 'generic' ? "'generic'" : "'hermes'"}, job_map=${opts.jobMap ? 'True' : 'False'}, skills_index=${opts.skillsIndex === false ? 'False' : 'None'}), end='')`)).toBe(off)
    }
  })
  it('caps the list with an ellipsis and keeps the job words', () => {
    expect(capabilityIndex(['transcription', 'reminders', 'follow-ups'], 100)).toBe('transcription, reminders, follow ups')
    expect(capabilityIndex(['transcription', 'reminders', 'scheduling'], 30)).toBe('transcription, reminders, …')
    expect(capabilityIndex(['transcription'], 3)).toBe('…')
    for (const [jobs, budget] of [[['transcription', 'reminders', 'scheduling'], 30], [['a-b', 'c'], 5], [[], 10]] as const) {
      expect(py(`print(kernel.capability_index(${JSON.stringify(jobs)}, ${budget}), end='')`)).toBe(capabilityIndex(jobs, budget))
    }
  })
})

describe('capability registry (issue 463)', () => {
  const make = (over: Record<string, unknown> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'caps-'))
    const all = bridgeApps({ apps: [app('notes'), app('calendar'), app('vault', { privacy: 'private' }), app('video', { status: 'stopped' })] })
    let on = true
    const caps = createCapabilities(<any>{
      on: () => on, allApps: () => all, apps: (id: string) => all.filter((a) => (id === 'hermes' ? true : ['notes', 'video'].includes(a.id))),
      builtins: (id: string) => [tool('wizard_remind'), tool('wizard_devices'), ...(id === 'sealed' ? [] : [tool('wizard_transcribe')])],
      isPrivate: (id: string) => id === 'sealed', agentLabel: (id: string) => (id === 'hermes' ? 'Wizard' : 'Philosopher'),
      voice: async () => ({ ready: true, reachable: true }), statePath: join(dir, 'capabilities.json'), ...over,
    })
    return { caps, dir, off: () => { on = false } }
  }
  const json = async (caps: ReturnType<typeof createCapabilities>, agent: string, args: Record<string, unknown> = { format: 'json' }) => JSON.parse((await caps.call(CAPABILITY_TOOL, args, agent))!.content[0].text)

  it('lists built-ins first, then app jobs; an app the agent may not use is not-granted with the exact ask', async () => {
    const { caps, dir } = make()
    try {
      expect(caps.jobs('philosopher')).toEqual(['transcription', 'reminders', 'devices', 'notes', 'video', 'calendar'])
      const data = await json(caps, 'philosopher')
      const calendar = data.capabilities.find((r: { job: string }) => r.job === 'calendar')
      expect(calendar.status).toBe('not-granted')
      expect(calendar.ask).toBe('calendar does calendar on this box but is not granted to Philosopher. Ask the owner to allow calendar for Philosopher in Connections; do not install or build your own.')
      expect(data.capabilities.find((r: { job: string }) => r.job === 'video').status).toBe('unavailable')
      // A private app stays unnamed (#58/#59), also as not-granted.
      expect(JSON.stringify(data)).not.toContain('vault')
      expect(data.capabilities[0]).toMatchObject({ job: 'transcription', tool: 'wizard_transcribe', status: 'ready', provider: { kind: 'host-service', id: 'wizard-voice-service' } })
      expect(data.capabilities[0].equivalents).toEqual(expect.arrayContaining(['whisper', 'faster-whisper', 'vosk']))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('answers "can you transcribe audio?" with wizard_transcribe, its inputs and limits; voice down = unavailable', async () => {
    const { caps, dir } = make()
    try {
      const hit = (await json(caps, 'philosopher', { job: 'can you transcribe audio?' })).matches[0]
      expect(hit).toMatchObject({ job: 'transcription', tool: 'wizard_transcribe', status: 'ready', how: 'Call `wizard_transcribe` on the wizard MCP server.' })
      expect(hit.inputs.properties.path).toBeTruthy()
      expect(hit.limits).toMatch(/2 GB/u)
      const down = make({ voice: async () => ({ ready: false, reachable: false }) })
      const r = (await json(down.caps, 'philosopher', { job: 'transcribe' })).matches[0]
      expect(r.status).toBe('unavailable')
      expect(r.how).toMatch(/tell the owner \(`wam doctor`\); do not install a replacement/u)
      rmSync(down.dir, { recursive: true, force: true })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a private agent keeps the seal: no transcription, no not-granted names', async () => {
    const { caps, dir } = make()
    try {
      const data = await json(caps, 'sealed')
      expect(data.capabilities.map((r: { job: string }) => r.job)).toEqual(['reminders', 'devices', 'notes', 'video'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('records a gap (words + agent, no content), lets the owner turn the guard off per agent, and is silent when off', async () => {
    const { caps, dir, off } = make()
    try {
      const text = (await caps.call(CAPABILITY_TOOL, { job: 'OCR this scanned PDF for me' }, 'philosopher'))!.content[0].text
      expect(text).toMatch(/^Nothing on this box does "OCR this scanned PDF for me" yet\. Tell the owner plainly/u)
      const view = await caps.ownerView('hermes')
      expect(view.gaps[0]).toMatchObject({ agent: 'philosopher', words: 'ocr this scanned pdf for me' })
      caps.setGuard('philosopher', false)
      expect((await json(caps, 'philosopher')).guard).toBe(false)
      expect((await json(caps, 'hermes')).guard).toBe(true)
      expect(() => caps.setGuard('../x', false)).toThrow()
      expect(JSON.parse(readFileSync(join(dir, 'capabilities.json'), 'utf8')).guard_off).toEqual(['philosopher'])
      off()
      expect((<any>caps).list('philosopher')).toEqual([])
      expect(caps.jobs('philosopher')).toBe(null)
      expect(caps.runNote('philosopher')).toBe('')
      expect(await caps.call(CAPABILITY_TOOL, {}, 'philosopher')).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('install guard (hermes-plugin capability_guard.py, issue 463)', () => {
  const records = JSON.stringify(BUILTIN_JOBS.map((b) => ({ job: b.job, tool: b.tool, status: 'ready', provider: b.provider, words: b.words, equivalents: b.equivalents })))
  const guard = (calls: Array<[string, Record<string, string>]>, registry = `{"guard": True, "capabilities": json.loads(sys.stdin.read())}`) =>
    JSON.parse(py(`reg = ${registry}; g.registry = lambda fresh=False: reg; print(json.dumps([g.pre_tool_call(t, a) for t, a in ${JSON.stringify(calls)}]))`, records))

  it('refuses known duplicates of a capability the box has, with the tool to use; everything else runs', () => {
    const blocked = guard([
      ['terminal', { command: 'pip install faster-whisper' }],
      ['terminal', { command: 'cd /tmp && uv pip install openai-whisper==20240930' }],
      ['terminal', { command: 'huggingface-cli download Systran/faster-whisper-small --local-dir m' }],
      ['terminal', { command: 'git clone https://github.com/ggerganov/whisper.cpp' }],
      ['execute_code', { code: 'import subprocess, sys\nsubprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "faster-whisper"])' }],
      ['execute_code', { code: 'from faster_whisper import WhisperModel\nm = WhisperModel("small")' }],
      ['terminal', { command: 'npm i node-cron' }],
    ])
    for (const v of blocked) expect(v?.action).toBe('block')
    expect(blocked[0].message).toBe('WizardOS: not run. This box already does transcription with Wizard Voice Service: use `mcp__wizard__wizard_transcribe` (details: `mcp__wizard__wizard_capabilities` with job "transcription"). Installing faster-whisper would make a second copy outside the box\'s privacy and update controls. If the owner wants their own copy anyway, they can turn this check off for you.')
    expect(blocked[6].message).toContain('mcp__wizard__wizard_schedule')
    const allowed = guard([
      ['terminal', { command: 'pip install pandas' }],
      ['terminal', { command: 'pip install schedule watch' }],
      ['terminal', { command: 'sudo apt-get install -y ffmpeg' }],
      ['terminal', { command: 'echo pip install whisper; ls' }],
      ['terminal', { command: 'pip install -r requirements.txt' }],
      ['execute_code', { code: 'import pandas as pd\nprint(pd.__version__)' }],
      ['write_file', { path: 'whisper.txt', content: 'pip install whisper' }],
    ])
    expect(allowed).toEqual([null, null, null, null, null, null, null])
  })

  it('not-granted asks the owner; guard off, switch off or no gateway: nothing is refused', () => {
    const notGranted = guard([['terminal', { command: 'pip install vosk' }]], `{"guard": True, "capabilities": [{"job": "transcription", "status": "not-granted", "ask": "Ask the owner.", "equivalents": ["vosk"], "provider": {"name": "x"}}]}`)
    expect(notGranted[0]).toEqual({ action: 'block', message: 'WizardOS: not run. Ask the owner.' })
    expect(guard([['terminal', { command: 'pip install faster-whisper' }]], `{"guard": False, "capabilities": json.loads(sys.stdin.read())}`)).toEqual([null])
    expect(guard([['terminal', { command: 'pip install faster-whisper' }]], 'None')).toEqual([null])
    // A refusal is decided on a fresh read: the owner's guard-off is honoured on the very next try (Codex P2).
    const fresh = JSON.parse(py(`on = {"guard": True, "capabilities": json.loads(sys.stdin.read())}; off = {**on, "guard": False}; g.registry = lambda fresh=False: off if fresh else on; print(json.dumps(g.pre_tool_call('terminal', {'command': 'pip install faster-whisper'})))`, records))
    expect(fresh).toBe(null)
    // No gateway configured at all (switch state unknown): the real lookup returns None and the call runs.
    const env = { ...process.env, HERMES_HOME: mkdtempSync(join(tmpdir(), 'hh-')), WIZARD_MCP_TOKEN: '' }
    const out = execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(PLUGIN)}); import capability_guard as g; print(g.registry(), g.index_jobs(), g.pre_tool_call('terminal', {'command': 'pip install faster-whisper'}))`], { env }).toString().trim()
    expect(out).toBe('None None None')
    rmSync(env.HERMES_HOME, { recursive: true, force: true })
  })

  it('ships the same guard in wizard-os and wizard-supervisor-tools, registered by both plugins', () => {
    expect(readFileSync(join(SUPERVISOR, 'capability_guard.py'), 'utf8')).toBe(readFileSync(join(PLUGIN, 'capability_guard.py'), 'utf8'))
    expect(readFileSync(join(PLUGIN, '__init__.py'), 'utf8')).toContain('_capability_guard.register(ctx)')
    expect(readFileSync(join(SUPERVISOR, '__init__.py'), 'utf8')).toContain('capability_guard.register(ctx)')
  })
})
