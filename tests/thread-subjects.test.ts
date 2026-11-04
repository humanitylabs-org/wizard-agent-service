import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { STATUS_INSTRUCTIONS } from '../server/thread-status.mjs'
import { SUBJECT_RULE, SubjectCatalog, normalizeSubjects } from '../server/thread-subjects.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

const directories: string[] = []
const servers: Array<ReturnType<typeof createServer>> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
const tempDir = async () => { const d = await mkdtemp(join(tmpdir(), 'wizard-subjects-')); directories.push(d); return d }
const tag = (value: object) => `Reply.\n\n[WIZARD_STATUS_V1]${JSON.stringify(value)}[/WIZARD_STATUS_V1]`

const SUBJECTS = {
  subjects: [
    { name: 'Wizard OS', about: 'the shell: chats, Ready, orb' },
    { name: 'Wizard Apps', about: 'apps inside Wizard' },
    { name: 'AI Wizards', about: 'the business' },
    'Music',
  ],
  aliases: { 'Wizard App': 'wizard os', 'Wizard Movement': 'AI Wizards', 'McKenna Track': 'Music', 'Wizard Signal': 'Wizard Apps', 'Music': 'Music' },
  threads: { wizard_grab: { from: 'Wizard OS', subject: 'Wizard Apps' }, '../bad': { subject: 'Music' } },
}

describe('subject list', () => {
  it('tells every run what a subject is, list or no list', () => {
    expect(STATUS_INSTRUCTIONS).toContain(SUBJECT_RULE)
    expect(STATUS_INSTRUCTIONS).toContain('never a single feature, app screen, meeting, track or one-off question')
    expect(new SubjectCatalog('').runNote()).toBe('')
  })

  it('normalises the file: canonical names, aliases onto them, safe thread ids only', () => {
    const data = normalizeSubjects(SUBJECTS)
    expect(data.subjects.map((s) => s.name)).toEqual(['Wizard OS', 'Wizard Apps', 'AI Wizards', 'Music'])
    expect(data.aliases.get('wizard app')).toBe('Wizard OS') // target spelled the canonical way
    expect(data.aliases.has('music')).toBe(false) // a self-alias is dropped
    expect([...data.threads.keys()]).toEqual(['wizard_grab'])
    expect(normalizeSubjects(null).subjects).toEqual([])
  })

  it('folds stray subjects into the list and applies one-thread corrections only while they still match', async () => {
    const path = join(await tempDir(), 'subjects.json')
    await writeFile(path, JSON.stringify(SUBJECTS))
    const catalog = new SubjectCatalog(path)
    expect(catalog.resolve('t1', 'McKenna Track')).toBe('Music')
    expect(catalog.resolve('t1', 'wizard movement')).toBe('AI Wizards')
    expect(catalog.resolve('t1', 'wizard apps')).toBe('Wizard Apps')
    expect(catalog.resolve('t1', 'Gardening')).toBe('Gardening') // unknown subjects pass through
    expect(catalog.resolve('wizard_grab', 'Wizard OS')).toBe('Wizard Apps')
    expect(catalog.resolve('wizard_grab', 'Music')).toBe('Music') // the agent moved on: correction no longer applies
    expect(catalog.apply('t1', { state: 'check', ask: 'Try it', subject: 'Wizard App' })).toEqual({ state: 'check', ask: 'Try it', subject: 'Wizard OS' })
    const same = { state: 'fyi', ask: 'Done', subject: 'Music' }
    expect(catalog.apply('t1', same)).toBe(same)
    const note = catalog.runNote('Wizard Apps')
    expect(note).toContain('Wizard OS (the shell: chats, Ready, orb); Wizard Apps (apps inside Wizard); AI Wizards (the business); Music.')
    expect(note).toContain('This thread\'s subject is “Wizard Apps”')
    // Edits apply without a restart; a broken file means no list rather than a crash.
    await writeFile(path, '{nope')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await writeFile(path, '{nope ')
    expect(catalog.resolve('t1', 'McKenna Track')).toBe('McKenna Track')
    expect(catalog.runNote()).toBe('')
  })

  it('serves folded subjects on the session list and tells the next run the list and the thread\'s subject', async () => {
    const directory = await tempDir()
    const subjectsPath = join(directory, 'subjects.json')
    await writeFile(subjectsPath, JSON.stringify(SUBJECTS))
    const now = 1_790_000_000
    const runs: any[] = []
    const threads: Record<string, string> = { wizard_grab: 'Wizard OS', wizard_track: 'McKenna Track', wizard_shell: 'Wizard OS' }
    const upstream = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      res.setHeader('Content-Type', 'application/json')
      if (url.pathname === '/v1/capabilities') { res.end(JSON.stringify({ features: {} })); return }
      if (req.method === 'POST' && url.pathname === '/v1/runs') { runs.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); res.end(JSON.stringify({ run_id: 'run_1', status: 'running' })); return }
      if (url.pathname === '/api/sessions') {
        res.end(JSON.stringify({ object: 'list', data: Object.keys(threads).map((id, i) => ({ id, source: 'api_server', title: id, message_count: 2, last_active: now - i })) }))
        return
      }
      const history = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/)
      if (history) {
        const id = decodeURIComponent(history[1])
        res.end(JSON.stringify({ data: [
          { role: 'user', timestamp: now - 60, content: 'Go' },
          { role: 'assistant', display_kind: 'final', timestamp: now - 10, content: tag({ state: 'check', ask: 'Try it', subject: threads[id] }) },
        ] }))
        return
      }
      res.statusCode = 404; res.end('{}')
    })
    servers.push(upstream)
    const upstreamAddress = await listen(upstream) as any
    const app = createWizardServer({
      requireJoinedDelegationCapability: false,
      upstreamOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      hermesKey: 'fixture-key',
      requireAccess: false,
      archivedSessionReader: () => [],
      subjectsPath,
    })
    servers.push(app)
    const origin = `http://127.0.0.1:${(await listen(app) as any).port}`
    const body = await (await fetch(`${origin}/wizard/hermes/api/sessions?limit=20`)).json() as { data: Array<{ id: string, wizard_attention?: { subject?: string } }> }
    const subjects = Object.fromEntries(body.data.map((s) => [s.id, s.wizard_attention?.subject]))
    expect(subjects).toEqual({ wizard_grab: 'Wizard Apps', wizard_track: 'Music', wizard_shell: 'Wizard OS' })

    const sent = await fetch(`${origin}/wizard/hermes/v1/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: 'wizard_grab', input: 'hi' }) })
    expect(sent.ok).toBe(true)
    const instructions = String(runs[0].instructions)
    expect(instructions).toContain('Subjects for the status line: Wizard OS (the shell: chats, Ready, orb); Wizard Apps')
    expect(instructions).toContain('This thread\'s subject is “Wizard Apps”')
  })
})
