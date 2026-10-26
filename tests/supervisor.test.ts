import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Supervisor, SUPERVISOR_PRIVATE_REFUSAL, supervisorThreadTitle, builderThreadTitle } from '../server/supervisor.mjs'
import { installSupervisorAssets } from '../server/supervisor-assets.mjs'

const roots: string[] = [], services: any[] = []
const root = () => { const r = mkdtempSync(join(tmpdir(), 'supervisor-test-')); roots.push(r); return r }
const worker = (thread = 'origin', agent = 'hermes') => ({ agent_id: agent, thread_id: thread, run_id: 'run-worker', privacy: 'shareable' })
const feedback = (id = 'one') => ({ kind: 'feedback', title: 'Reports are unclear', what_happened: 'The result used internal words.', feedback_verbatim: '  Say it plainly.\nPlease. ', evidence: [{ type: 'thread', ref: 'wizard://origin', excerpt: 'Old result' }], proposed_home: 'Reporter skill', client_report_id: id })
function fixture(extra = {}) {
  const sent: any[] = [], states = new Map()
  const s = new Supervisor({ statePath: join(root(), 'supervisor.sqlite3'), deliver: async (o: any) => { sent.push(o); return { run_id: o.key, session_id: o.thread } }, lookup: async (_o: any, r: any) => states.get(r.run_id), ...extra })
  services.push(s)
  return { s, sent, states, report: (id = 'one', caller = worker()) => s.call('report', feedback(id), caller), review: () => s.rows('reviews')[0], reviewCaller: () => worker(s.rows('reviews')[0].thread) }
}
afterEach(async () => { for (const s of services.splice(0)) await s.close(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

describe('Supervisor thread titles', () => {
  it('review thread titles are Supervisor · <topic> within 32 characters', async () => {
    const fits = (t: string) => { expect(t.startsWith('Supervisor · ')).toBe(true); expect(t.length).toBeLessThanOrEqual(32) }
    expect(supervisorThreadTitle('Shared names: Supervisor, Reporter, Maintenance')).toBe('Supervisor · Shared names')
    const long = supervisorThreadTitle('Review thread titles too long'); fits(long)
    expect(long).toBe('Supervisor · Review thread') // whole words, no trailing stop word, no ellipsis
    const word = supervisorThreadTitle('x'.repeat(60)); fits(word); expect(word).toBe('Supervisor · ' + 'x'.repeat(19))
    expect(supervisorThreadTitle('')).toBe('Supervisor · Review')
    expect(supervisorThreadTitle('Supervisor: titles of the')).toBe('Supervisor · titles')
    expect(builderThreadTitle('Supervisor · Short thread titles for every review')).toBe('Supervisor · Short thread titles')
    const plain = builderThreadTitle('Fix the review thread title length rule'); fits(plain); expect(plain).not.toMatch(/\s(the|of|to|for)$/)
    const own = builderThreadTitle('Wizard OS · Supervisor thread titles within limit')
    expect(own).toBe('Wizard OS · Supervisor thread'); expect(own.length).toBeLessThanOrEqual(32)
    const f = fixture()
    f.s.call('report', { ...feedback(), title: 'Shared names: Supervisor, Reporter, Maintenance' }, worker())
    await f.s.tick()
    const opened = f.sent.filter(o => o.createThread)
    expect(opened).toHaveLength(1); fits(opened[0].title); expect(opened[0].title).toBe('Supervisor · Shared names')
    expect(f.s.reportBy(f.review().report).title).toBe('Shared names: Supervisor, Reporter, Maintenance') // ledger keeps the full title
    f.s.call('build', { title: 'Supervisor · Review thread titles too long for the list', brief: 'Fit titles.' }, f.reviewCaller())
    await f.s.tick()
    const builder = f.sent.filter(o => o.createThread)[1]
    fits(builder.title); expect(builder.title).toBe('Supervisor · Review thread')
    expect(JSON.parse(f.s.rows('builds')[0].data).title).toBe('Supervisor · Review thread titles too long for the list')
  })
})

describe('Supervisor durable feedback workflow', () => {
  it('requires verbatim feedback and evidence; service owns identity and depth', () => {
    const f = fixture()
    expect(() => f.s.call('report', { ...feedback(), feedback_verbatim: '' }, worker())).toThrow('feedback_verbatim')
    expect(() => f.s.call('report', { ...feedback(), evidence: [] }, worker())).toThrow('evidence')
    expect(() => f.s.call('report', { ...feedback(), depth: 0 }, worker())).toThrow('service-owned')
    expect(() => f.s.call('report', { ...feedback(), title: 'x'.repeat(61) }, worker())).toThrow('title')
    expect(() => f.s.call('report', { ...feedback(), what_happened: 'word '.repeat(401) }, worker())).toThrow('400 words')
    const { report } = f.report()
    expect(report).toMatchObject({ agent_id: 'hermes', thread_id: 'origin', run_id: 'run-worker', depth: 0, feedback_verbatim: feedback().feedback_verbatim })
  })
  it('suppresses only same-thread client resends, not similar feedback or another thread', async () => {
    const f = fixture()
    const first = f.report(); expect(f.report()).toMatchObject({ suppressed: true, report: { id: first.report.id } })
    f.report('two'); f.report('one', worker('another'))
    await f.s.tick()
    expect(f.s.rows('reports')).toHaveLength(3)
    expect(f.s.rows('reviews')).toHaveLength(3)
    expect(f.sent).toHaveLength(2)
    expect(f.s.rows('reviews').filter(r => r.state === 'queued')).toHaveLength(1)
  })
  it('caps two open reviews, retains extras and promotes exactly one on close', async () => {
    const f = fixture(); for (let i=0;i<5;i++) f.report(String(i))
    await f.s.tick(); expect(f.sent).toHaveLength(2)
    f.s.call('close', { outcome: 'shipped', home: 'Reporter skill', summary: 'Reports now use plain words.' }, f.reviewCaller())
    await f.s.tick()
    expect(f.s.rows('reviews').filter(r => r.state === 'open')).toHaveLength(2)
    expect(f.s.rows('reviews').filter(r => r.state === 'queued')).toHaveLength(2)
    expect(f.sent.filter(o => o.createThread)).toHaveLength(3)
  })
  it('mechanically attaches feedback from review and builder threads, never spawning loops', async () => {
    const f = fixture(); f.report()
    f.report('review-feedback', f.reviewCaller())
    const build = f.s.call('build', { title: 'Fix the format', brief: 'Add the test.' }, f.reviewCaller())
    const completion = f.s.call('report', { ...feedback('completion'), kind: 'completion' }, worker(build.thread))
    expect(completion.report).toMatchObject({ depth: 1, parent_id: f.review().id })
    const lateFeedback = f.report('builder-feedback', worker(build.thread))
    expect(lateFeedback.report.depth).toBe(1)
    expect(f.s.rows('reviews')).toHaveLength(1)
    await f.s.tick()
    expect(f.sent.filter(o => o.body.input.startsWith('[supervisor review]'))).toHaveLength(1)
    expect(f.sent.filter(o => o.body.input.startsWith('[supervisor update]'))).toHaveLength(3)
  })
  it('questions queue behind worker turns; limit two and timeout wakes once with no answer', async () => {
    let clock = 1000; const f = fixture({ now: () => clock }); f.report()
    const q1 = f.s.call('ask', { question: 'Which words?' }, f.reviewCaller())
    f.s.call('ask', { question: 'Which result?' }, f.reviewCaller())
    expect(() => f.s.call('ask', { question: 'Third?' }, f.reviewCaller())).toThrow('two questions')
    expect(() => f.s.call('answer', { question_id: q1.question_id, answer: 'answer' }, worker('foreign'))).toThrow('another worker')
    f.s.call('answer', { question_id: q1.question_id, answer: 'The final result.' }, worker())
    clock += 30*60_000; await f.s.tick(); await f.s.tick()
    expect(f.s.rows('questions').map(q => q.state)).toEqual(['answered', 'timeout'])
    expect(f.sent.filter(o => o.body.input.includes('no answer'))).toHaveLength(1)
    expect(f.sent.filter(o => o.body.input.startsWith('[supervisor question]')).every(o => o.thread === 'origin')).toBe(true)
  })
  it('builder completion wakes review; run ending without a report wakes it once', async () => {
    const f = fixture(); f.report()
    const b = f.s.call('build', { title: 'Fix it', brief: 'Test it.' }, f.reviewCaller())
    await f.s.tick()
    const row = f.s.rows('builds')[0]
    f.states.set(`supervisor-build:${row.id}`, { status: 'failed', output: 'Could not finish.' })
    await f.s.tick(); await f.s.tick()
    expect(f.sent.filter(o => o.body.input.includes('without reporting'))).toHaveLength(1)
    f.s.call('report', { ...feedback('late'), kind: 'completion' }, worker(b.thread))
    await f.s.tick(); expect(f.s.rows('builds')[0].state).toBe('reported')
    expect(f.sent.filter(o => o.body.input.includes('"kind":"completion"'))).toHaveLength(1)
  })
  it('close posts exactly one origin line, persists outcomes and lessons, and is idempotent', async () => {
    const f = fixture(); f.report(); await f.s.tick()
    const args = { outcome: 'shipped', home: 'Reporter skill', summary: 'Reports now use plain words.' }
    f.s.call('close', args, f.reviewCaller()); f.s.call('close', args, f.reviewCaller()); await f.s.tick()
    const closes = f.sent.filter(o => o.body.input.startsWith('[supervisor closed]'))
    expect(closes).toHaveLength(1); expect(closes[0].thread).toBe('origin'); expect(closes[0].createThread).toBe(false)
    expect(closes[0].body.input).toContain('exactly this one line, nothing else:\nReports now use plain words. Home: Reporter skill')
    f.report('new'); const review = f.s.rows('reviews')[1]
    expect(f.s.call('lessons', { query: 'plain' }, worker(String(review.thread))).lessons).toHaveLength(1)
    expect(() => f.s.call('close', { ...args, outcome: 'covered', covered_by: 'missing' }, worker(String(review.thread)))).toThrow('earlier closed')
    expect(f.s.call('close', { ...args, outcome: 'covered', covered_by: f.review().id }, worker(String(review.thread))).closed).toBe(true)
  })
  it('limits lessons to main reviews and rechecks source visibility after sealing', () => {
    let visible = true
    const f = fixture({ canReadSource: () => visible })
    f.report('source', worker('source-thread', 'helper'))
    f.s.call('close', { outcome: 'shipped', home: 'Reporter skill', summary: 'Use plain words.' }, f.reviewCaller())
    f.report('review'); const c = worker(String(f.s.rows('reviews')[1].thread))
    for (const caller of [worker(), worker('arbitrary', 'helper'), worker(c.thread_id, 'helper')]) {
      expect(() => f.s.call('lessons', { query: '' }, caller)).toThrow('open Supervisor review')
    }
    expect(f.s.call('lessons', { query: '' }, c).total).toBe(1)
    visible = false
    expect(f.s.call('lessons', { query: '' }, c)).toMatchObject({ lessons: [], total: 0 })
  })
  it('bounds lesson indexes below the plugin response limit and marks omitted matches', () => {
    const f = fixture()
    for (let i = 0; i < 35; i++) {
      const report = f.s.call('report', { ...feedback(`large-${i}`), feedback_verbatim: '界'.repeat(16000) }, worker())
      const r = f.s.rows('reviews').find((r: any) => r.report === report.report.id)
      f.s.call('close', { outcome: 'shipped', home: '界'.repeat(2000), summary: '界'.repeat(800) }, worker(String(r!.thread)))
    }
    f.report('search'); const r = f.s.rows('reviews').at(-1)
    const result = f.s.call('lessons', { query: '' }, worker(String(r!.thread)))
    expect(result.total).toBe(35); expect(result.truncated).toBe(true)
    expect(result.lessons.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(66 * 1024)
    expect(result.lessons[0].report.evidence).toBeUndefined()
  })
  it('refuses private or siloed callers before any ledger writes or reads', () => {
    const f = fixture()
    for (const action of ['report','ask','answer','build','lessons','close']) expect(() => f.s.call(action, feedback(), { ...worker(), privacy: 'private-agent' })).toThrow(SUPERVISOR_PRIVATE_REFUSAL)
    expect(f.s.rows('reports')).toHaveLength(0); expect(f.s.rows('reviews')).toHaveLength(0)
  })
  it('replays a frozen outbox key across ambiguous admission and restart', async () => {
    const path = join(root(), 'supervisor.sqlite3'), keys: string[] = []
    let ambiguous = true
    const opts = { statePath: path, deliver: async (o: any) => { keys.push(o.key); if (ambiguous) throw Error('lost response'); return { run_id: 'r' } } }
    let s = new Supervisor(opts); s.report(feedback(), worker()); await s.tick(); await s.close()
    ambiguous = false; s = new Supervisor(opts); services.push(s); await s.tick(); await s.tick()
    expect(keys).toHaveLength(2); expect(new Set(keys).size).toBe(1)
    expect(s.rows('reviews')).toHaveLength(1)
  })
  it('explicit host installer appends reporter to agent cron jobs without losing original skills or changing script-only tasks', () => {
    const home = root(); mkdirSync(join(home,'cron'))
    const jobs = {jobs:[{id:'active',enabled:true,skill:'cold-read-reports',skills:['existing'],prompt:'Read'}, {id:'system',no_agent:true,script:'system.sh'}, {id:'paused',enabled:false,prompt:'Wait'}]}
    const path=join(home,'cron/jobs.json'), raw=JSON.stringify(jobs)
    writeFileSync(path,raw)
    const args=['scripts/install-supervisor-assets.mjs','--hermes-home',home,'--attach-cron-reporter']
    const first=JSON.parse(execFileSync(process.execPath,args,{encoding:'utf8'}))
    const second=JSON.parse(execFileSync(process.execPath,args,{encoding:'utf8'}))
    expect(first.cronAttached).toBe(1); expect(second.cronAttached).toBe(0)
    const updated=JSON.parse(readFileSync(path,'utf8')).jobs
    expect(updated[0].skills).toEqual(['existing','cold-read-reports','reporter'])
    expect(updated[1]).toEqual(jobs.jobs[1]); expect(updated[2]).toEqual(jobs.jobs[2])
    expect(readFileSync(path+'.before-reporter','utf8')).toBe(raw)
  })
  it('installs the same six context-injected tools and both skills into every declared home', () => {
    const r = root()
    for (const kind of ['main','host-profile','container','restricted-managed']) {
      const home = join(r, kind); installSupervisorAssets(home)
      const tools = JSON.parse(readFileSync(join(home, 'plugins/wizard-supervisor-tools/tools.json'), 'utf8'))
      expect(tools).toHaveLength(6)
      expect(tools.every((t: any) => !Object.hasOwn(t.parameters.properties, 'session_id'))).toBe(true)
      for (const skill of ['reporter','supervisor']) expect(existsSync(join(home, `skills/${skill}/SKILL.md`))).toBe(true)
    }
    const evil = join(r,'evil'); mkdirSync(evil); symlinkSync(join(r,'main/plugins'),join(evil,'plugins'))
    expect(() => installSupervisorAssets(evil)).toThrow('symlink')
  })
})
