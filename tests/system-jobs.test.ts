import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SystemJobs, SystemdJobTimers, systemJobsSocket } from '../server/system-jobs.mjs'
import { createWizardServer, listen, scheduleNotifier } from '../server/service.mjs'
import { triggerSystemJob } from '../scripts/system-job-trigger.mjs'
import { formatSystemJobs, systemJobsCommand } from '../scripts/system-jobs.mjs'

let root: string, clock: number
const stores: any[] = [], servers: any[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wz-sj-')); clock = Date.parse('2026-10-28T00:00:00Z')
  for (const key of ['HOME', 'HERMES_HOME', 'WIZARD_OS_HOME', 'TMPDIR']) {
    const dir = join(root, key.toLowerCase()); mkdirSync(dir); vi.stubEnv(key, dir)
  }
})
afterEach(async () => {
  for (const server of servers.splice(0)) { await new Promise<void>(r => server.close(() => r())); await server.drained }
  for (const store of stores.splice(0)) if (!store.closed) await store.close()
  vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true })
})
function store(extra: any = {}): any {
  const jobs = new SystemJobs({ statePath: join(root, 'jobs.sqlite'), hermesHome: join(root, 'source'), timers: { apply: vi.fn() }, now: () => clock, ...extra }); stores.push(jobs); return jobs
}
const input = (extra: any = {}) => ({ name: 'Daily backup', when: { every: 5 }, command: [process.execPath, '-e', 'process.exit(0)'], cwd: root, ...extra })
async function settle(jobs: any) { await Promise.all([...jobs.active.values()].map((v: any) => v.task)) }
function fixture(rows: any[]) { const home = join(root, 'source'); mkdirSync(join(home, 'cron'), { recursive: true }); const path = join(home, 'cron', 'jobs.json'); writeFileSync(path, JSON.stringify({ jobs: rows })); return path }
const source = (extra: any = {}) => ({ id: 'synthetic_backup', name: 'Daily backup', no_agent: true, script: 'backup.py', schedule: { kind: 'cron', expr: '0 17 * * *' }, ...extra })

describe('host system jobs', () => {
  it('imports only script-only jobs disabled, reads the source unchanged and dedupes after restart', async () => {
    const path = fixture([source(), source({ id: 'agent', no_agent: false, prompt: 'Use an agent' }), source({ id: 'interval', script: 'check.sh', schedule: { kind: 'interval', minutes: 5 } })])
    const before = readFileSync(path)
    let jobs = store()
    expect(jobs.importHermes({ timezone: 'UTC' }).results.map((r: any) => r.status)).toEqual(['would import disabled', 'skipped', 'would import disabled'])
    expect(jobs.list()).toEqual([])
    expect(jobs.importHermes({ dryRun: false, timezone: 'UTC' }).results.map((r: any) => r.status)).toEqual(['imported disabled', 'skipped', 'imported disabled'])
    expect(jobs.list().every((j: any) => !j.enabled && !j.nextRun && !j.lastRun)).toBe(true)
    expect(jobs.timers.apply).not.toHaveBeenCalled()
    expect(jobs.list()[0].command).toEqual(['python3', join(root, 'source/scripts/backup.py')])
    expect(jobs.list()[1].when).toEqual({ every: 5 })
    await jobs.close(); jobs = store()
    expect(jobs.importHermes({ dryRun: false, timezone: 'UTC' }).results.filter((r: any) => r.status === 'already imported')).toHaveLength(2)
    expect(readFileSync(path)).toEqual(before)
  })
  it('requires the source timezone and rejects finite repeats, chained work, malformed schedules and duplicate IDs', () => {
    fixture([source({ repeat: { times: 1 } }), source({ id: 'chain', context_from: ['a'] }), source({ id: 'bad', schedule: { kind: 'interval', minutes: 0 } }), source({ id: 'duplicate' }), source({ id: 'duplicate' })])
    const jobs = store()
    expect(() => jobs.importHermes({})).toThrow(/timezone/)
    expect(jobs.importHermes({ timezone: 'UTC' }).results.map((r: any) => r.status)).toEqual(['rejected', 'rejected', 'rejected', 'would import disabled', 'rejected'])
  })
  it('enables per job and persists success without an agent turn', async () => {
    const jobs = store(), a = jobs.create(input()), b = jobs.create(input({ name: 'Other maintenance' }))
    expect(() => jobs.run(a.id)).toThrow(/Enable/)
    jobs.edit(a.id, { enabled: true }); const receipt = jobs.run(a.id)
    await settle(jobs)
    expect(receipt.outcome).toBe('running')
    const all = jobs.list()
    expect(all[0].lastRun).toMatchObject({ outcome: 'succeeded', exitCode: 0, startedAt: new Date(clock).toISOString() })
    expect(all[1]).toMatchObject({ id: b.id, enabled: false, lastRun: null })
    expect(formatSystemJobs(all)).toContain('Daily backup')
    expect(formatSystemJobs(all)).toContain('succeeded')
  })
  it('runs a synthetic script with argument boundaries intact and no inherited provider secrets', async () => {
    vi.stubEnv('FAKE_PROVIDER_SECRET', 'must-not-inherit')
    const output = join(root, 'result.json')
    const jobs = store()
    const command = [process.execPath, '-e', `require('fs').writeFileSync(process.argv[1], JSON.stringify({arg:process.argv[2], secret:process.env.FAKE_PROVIDER_SECRET ?? null}))`, output, 'a; $(not-a-shell)']
    const j = jobs.create(input({ command })); jobs.edit(j.id, { enabled: true }); jobs.run(j.id); await settle(jobs)
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ arg: 'a; $(not-a-shell)', secret: null })
  })
  it('records failure, retries the Notifications outbox without aging it out, and never includes raw output', async () => {
    const sent: any[] = []; let down = true
    const jobs = store({ notifier: { send: vi.fn(async (value: any) => { if (down) throw new Error('unavailable'); sent.push(value) }) } })
    const j = jobs.create(input({ command: [process.execPath, '-e', 'console.error("private failure details"); process.exit(7)'] }))
    jobs.edit(j.id, { enabled: true }); jobs.run(j.id); await settle(jobs); await jobs.flushAlerts()
    expect(jobs.list()[0].lastRun).toMatchObject({ outcome: 'failed', exitCode: 7, notification: 'pending' })
    clock += 10 * 86400000; down = false; await jobs.flushAlerts(); await jobs.flushAlerts()
    expect(sent).toHaveLength(1); expect(JSON.stringify(sent)).not.toContain('private failure')
    expect(jobs.list()[0].lastRun.notification).toBe('sent')
  })
  it.each([
    ['output', 'Backup finished\nYour files are protected.', 1],
    ['output', '[SILENT]', 0],
    ['failure', 'private ordinary logs', 0],
    ['output', 'x'.repeat(20000), 0],
  ])('routes only explicitly opted-in bounded output: %s', async (notify, output, count) => {
    const calls: any[] = []
    const bridge = { apps: () => [{ id: 'bell', prefix: 'bell', jobs: ['notifications'], status: 'running' }], callTool: async (...args: any[]) => { calls.push(args); return {} } }
    const jobs = store({ notifier: scheduleNotifier({ bridge, appsJsonPath: join(root, 'none') }) })
    const j = jobs.create(input({ notify, command: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(output)})`] }))
    jobs.edit(j.id, { enabled: true }); jobs.run(j.id); await settle(jobs); await jobs.flushAlerts()
    expect(calls).toHaveLength(count)
    if (count) expect(calls[0]).toEqual(['bell__notify', { title: 'Backup finished', message: 'Your files are protected.' }, 'hermes'])
  })
  it('marks an uncertain execution interrupted on restart without replaying the command', async () => {
    let jobs = store(); const j = jobs.create(input()); jobs.edit(j.id, { enabled: true })
    jobs.db.prepare("INSERT INTO system_job_runs(id,job,started,outcome) VALUES(?,?,?,'running')").run('uncertain', j.id, clock)
    await jobs.close(); const execute = vi.fn(); jobs = store({ execute })
    expect(jobs.list()[0].lastRun).toMatchObject({ outcome: 'interrupted', notification: 'pending' })
    expect(execute).not.toHaveBeenCalled()
  })
  it('refuses a second scheduler writer in the same process and a child process', () => {
    store()
    expect(() => store()).toThrow(/exclusive writer ownership/)
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { SystemJobs } from './server/system-jobs.mjs'; new SystemJobs({statePath:process.argv[1]})`, join(root, 'jobs.sqlite')], { cwd: process.cwd(), encoding: 'utf8' })
    expect(child.status).not.toBe(0); expect(child.stderr).toContain('exclusive writer ownership')
  })
  it('refuses overlapping manual/timer execution and advances intervals without replaying missed work', async () => {
    let done: any; const jobs = store({ execute: () => new Promise(r => { done = r }) })
    const j = jobs.create(input()); jobs.edit(j.id, { enabled: true }); clock += 3600000
    jobs.run(j.id, { scheduled: true }); await Promise.resolve()
    expect(() => jobs.run(j.id)).toThrow(/already running/)
    expect(jobs.get(j.id).nextAt).toBe(clock + 300000)
    done({ code: 0 }); await settle(jobs)
    expect(() => jobs.run(j.id, { scheduled: true })).toThrow(/not due/)
  })
  it('claims a once job only once and rejects old timer callbacks after owner disable', async () => {
    const jobs = store(); const j = jobs.create(input({ when: { once: new Date(clock + 60000).toISOString() } }))
    jobs.edit(j.id, { enabled: true }); clock += 60000; jobs.run(j.id, { scheduled: true }); await settle(jobs)
    expect(jobs.get(j.id).enabled).toBe(false)
    expect(() => jobs.run(j.id, { scheduled: true })).toThrow(/Enable/)
    expect(() => jobs.edit(j.id, { enabled: true })).toThrow(/future/)
  })
  it('fails closed if systemd fails to enable, and permits a clean retry', () => {
    let broken = true; const jobs = store({ timers: { apply: () => { if (broken) throw Error('secret diagnostics') } } })
    const j = jobs.create(input()); expect(() => jobs.edit(j.id, { enabled: true })).toThrow(/disabled/)
    expect(jobs.get(j.id).enabled).toBe(false); expect(jobs.get(j.id).timerError).not.toContain('secret')
    broken = false; expect(jobs.edit(j.id, { enabled: true }).enabled).toBe(true)
  })
  it('times out scripts and records failure without hanging the scheduler', async () => {
    const jobs = store(), j = jobs.create(input({ timeoutSeconds: 1, command: [process.execPath, '-e', 'setInterval(()=>{},1000)'] }))
    jobs.edit(j.id, { enabled: true }); jobs.run(j.id); await settle(jobs)
    expect(jobs.list()[0].lastRun.outcome).toBe('failed')
  })
  it('keeps host execution unavailable with timers unconfigured', () => {
    const jobs = store({ timers: null }), j = jobs.create(input())
    expect(() => jobs.edit(j.id, { enabled: true })).toThrow(/not configured/)
  })
  it.each([{ command: 'echo unsafe' }, { cwd: 'relative' }, { when: { cron: 'invalid' } }, { envKeys: ['SECRET=value'] }, { timeoutSeconds: 0 }, { prompt: 'not host work' }])('rejects invalid definition %j', patch => {
    expect(() => store().create(input(patch))).toThrow()
  })
  it('renders only owned one-shot UTC timers and safely quotes executable paths', () => {
    const controls: any[] = [], unitDir = join(root, 'units')
    const timer = new SystemdJobTimers({ unitDir, socketPath: join(root, 'host.sock'), node: '/opt/node % $/node', trigger: '/opt/tools/trigger.mjs', control: a => { controls.push(a); return Buffer.from('') } })
    const job = { id: 'fixture', enabled: true, nextAt: clock }
    timer.apply(job)
    const service = readFileSync(join(unitDir, 'wizard-system-job-fixture.service'), 'utf8')
    expect(service).toContain('ExecStart="/opt/node %% $$/node"'); expect(service).not.toContain('/bin/sh')
    expect(readFileSync(join(unitDir, 'wizard-system-job-fixture.timer'), 'utf8')).toContain('OnCalendar=2026-10-28 00:00:00 UTC')
    expect(controls).toContainEqual(['restart', 'wizard-system-job-fixture.timer'])
    timer.apply({ ...job, enabled: false })
    expect(controls.at(-1)).toEqual(['disable', '--now', 'wizard-system-job-fixture.timer'])
    expect(() => timer.apply({ ...job, id: '../arbitrary' })).toThrow()
  })
  it('receives timer triggers through owner-only local IPC and rejects disabled/early jobs', async () => {
    const jobs = store(), j = jobs.create(input()), path = join(root, 'host.sock')
    const socket = systemJobsSocket(jobs, path); servers.push(socket)
    await new Promise(r => socket.once('listening', r))
    expect(statSync(path).mode & 0o777).toBe(0o600)
    await expect(triggerSystemJob(path, j.id)).rejects.toThrow(/refused/)
    jobs.edit(j.id, { enabled: true }); await expect(triggerSystemJob(path, j.id)).rejects.toThrow(/refused/)
    clock += 300000; await triggerSystemJob(path, j.id); await settle(jobs)
    expect(jobs.list()[0].lastRun.outcome).toBe('succeeded')
  })
})

describe('owner-facing API and shared notification authority', () => {
  it('lists, imports, enables and runs only through the authenticated owner surface', async () => {
    fixture([source()])
    const service = createWizardServer({ distDir: root, agents: false, requireAccess: false,
      ownerProof: 'fixture-owner-proof-with-32-characters', systemJobsStatePath: join(root, 'http.sqlite'), systemJobsHermesHome: join(root, 'source'), systemJobsTimers: { apply: () => {} } })
    servers.push(service); const origin = `http://127.0.0.1:${(await listen(service)).port}`
    const req = async (path = '', method = 'GET', body?: any, headers: any = {}) => fetch(`${origin}/wizard/v1/system-jobs${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Wizard-Owner-Proof': 'fixture-owner-proof-with-32-characters', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) })
    expect((await req('', 'POST', input(), { 'X-Wizard-Owner-Proof': '' })).status).toBe(403)
    expect((await req('', 'POST', input(), { Origin: 'https://attacker.invalid' })).status).toBe(403)
    expect((await req('/import-hermes', 'POST', { dryRun: false, timezone: 'UTC' })).status).toBe(200)
    let listed = await (await req()).json(); expect(listed.systemJobs[0].enabled).toBe(false)
    const created = await (await req('', 'POST', input())).json()
    expect((await req(`/${created.id}`, 'PATCH', { enabled: true })).status).toBe(200)
    expect((await req(`/${created.id}/run`, 'POST', {})).status).toBe(202)
    for (let n = 0; n < 30; n++) { listed = await (await req()).json(); if (listed.systemJobs[1].lastRun?.finishedAt) break; await new Promise(r => setTimeout(r, 10)) }
    expect(listed.systemJobs[1].lastRun.outcome).toBe('succeeded')
    expect(await systemJobsCommand(['list'], { origin, proof: 'fixture-owner-proof-with-32-characters' })).toContain('Daily backup')
  })
  it('selects only providers visible to the same agent used to send, and shares the existing notify tool', async () => {
    const called: any[] = []
    const bridge = { apps: (agent: string) => agent === 'hermes' ? [{ id: 'bell', prefix: 'bell', jobs: ['notifications'], status: 'running' }] : [], callTool: async (...args: any[]) => { called.push(args); return {} } }
    const notifier = scheduleNotifier({ bridge, appsJsonPath: join(root, 'absent') })
    expect(notifier.available({ agent: 'private-agent' })).toBe(false)
    await expect(notifier.send({ title: 'Test', message: 'Check maintenance', agent: 'private-agent' })).rejects.toThrow(/unavailable/)
    await notifier.send({ title: 'Test', message: 'Check maintenance', agent: 'main' })
    expect(called).toEqual([['bell__notify', { title: 'Test', message: 'Check maintenance' }, 'hermes']])
  })
})
