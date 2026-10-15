// Isolated real-Hermes/real-Thales canary. Never changes or restarts the live service.
// Set HERMES_HOME and WIZARD_OS_HOME to a disposable directory BEFORE launch.
// Credentials arrive in environment only. Remote work and artifacts stay on Thales.
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { createWizardServer, listen } from '../server/service.mjs'

const exec = promisify(execFile)
const base = process.env.CANARY_STATE_DIR
const remote = process.env.CANARY_REMOTE_DIR
const key = process.env.WIZARD_HERMES_API_KEY
if (!base || !remote || !key || !process.env.HERMES_HOME?.startsWith(base)) throw new Error('isolated canary configuration required')
mkdirSync(base, { recursive: true, mode: 0o700 })
const token = randomBytes(32).toString('hex')
const run = randomBytes(5).toString('hex')
const session = `wizard_resource_canary_${run}`
const questionSession = `wizard_resource_question_${run}`
const remoteSpool = `${remote}/canary-${run}`
const gate = `${remote}/release-${run}`
const results = { kind: 'real-model-real-worker-isolated-service', session, questionSession,
  handler: 'registered plugin handler invoked by canary harness, not yet installed in live Hermes', events: [] }
const server = createWizardServer({ upstreamOrigin: process.env.HERMES_ORIGIN || 'http://127.0.0.1:8642',
  hermesKey: key, requireAccess: false, followThrough: false, joinedDelegation: 'off',
  runQueueStatePath: join(base, 'runs.sqlite3'), runQueueMaxActive: 2, runQueuePollIntervalMs: 250,
  heavyStatePath: join(base, 'heavy.sqlite3'), heavyToken: token, heavyPollIntervalMs: 250,
  heavyWorker: { host: process.env.CANARY_SSH_HOST || 'thales', script: `${remote}/scripts/heavy-worker.py`,
    root: remoteSpool, lock: '/Volumes/ThalesMedia/AndroidBuilds/worker.lock' },
  settingsPath: join(base, 'settings.json'), appsJsonPath: join(base, 'apps.json'), launcherPath: join(base, 'launcher.json'),
  threadTitleStatePath: join(base, 'titles.json'), threadStatusBackfillPath: join(base, 'status.json'),
  threadDispositionStatePath: join(base, 'dispositions.json'), threadSeenStatePath: join(base, 'seen.json'),
  dismissedFailureStatePath: join(base, 'failures.json'), subjectCatalogPath: join(base, 'subjects.json'),
})
let origin
const event = (name, value) => { const item = { name, at: new Date().toISOString(), ...value }; results.events.push(item); console.log(JSON.stringify(item)) }
const request = async (path, body) => {
  const response = await fetch(origin + path, { ...(body ? { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `canary-${run}-${randomBytes(8).toString('hex')}` } } : {}) })
  const value = await response.json()
  if (!response.ok) throw new Error(`${path} ${response.status}: ${JSON.stringify(value)}`)
  return value
}
const wait = async (name, fn, timeout = 180000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 500)) }
  throw new Error(`deadline waiting for ${name}`)
}
const seenStatus = new Map()
const tool = async (action, args) => {
  const source = `import importlib.util,json,os; s=importlib.util.spec_from_file_location('heavy',os.environ['PLUGIN_FILE']); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); tools={}; ctx=type('Ctx',(),{'register_tool':lambda self,**kw:tools.update({kw['name']:kw['handler']})})(); m.register(ctx); print(tools['wizard_heavy_'+os.environ['TOOL_ACTION']](json.loads(os.environ['TOOL_ARGS']),session_id=os.environ['TOOL_SESSION']))`
  const started = Date.now()
  const { stdout } = await exec('python3', ['-c', source], { env: { ...process.env,
    PLUGIN_FILE: new URL('../hermes-plugin/wizard-heavy/__init__.py', import.meta.url).pathname,
    WIZARD_HEAVY_ORIGIN: origin, WIZARD_HEAVY_TOKEN: token,
    TOOL_SESSION: session, TOOL_ACTION: action, TOOL_ARGS: JSON.stringify(args) } })
  const value = JSON.parse(stdout)
  if (value.error) throw new Error(JSON.stringify(value))
  if (action !== 'status' || seenStatus.get(args.job_id) !== JSON.stringify(value)) {
    event(`tool_${action}`, { latency_ms: Date.now() - started, ...value })
    seenStatus.set(args.job_id, JSON.stringify(value))
  }
  return value
}
try {
  await listen(server, '127.0.0.1', 0)
  origin = `http://127.0.0.1:${server.address().port}`
  event('staging_started', { pid: process.pid, origin, remoteSpool })
  for (const id of [session, questionSession]) await request('/wizard/hermes/api/sessions', { id, title: `Resource lanes · canary ${id}`, source: 'wizard-mobile' })
  const originRun = await request('/wizard/hermes/v1/runs', { session_id: session, input:
    'This is an authorized isolated scheduler canary. A test controller will submit two remote worker jobs for this thread. For this turn, answer only: Canary origin acknowledged. Do not call tools or start work. When later given a heavy-work completion receipt, briefly report only its job ID and state, without tools or claiming any wider task complete.' })
  event('origin_admitted', originRun)
  await wait('origin human message', async () => {
    const messages = await request(`/wizard/hermes/api/sessions/${session}/messages?order=latest&limit=5`)
    return messages.data?.some(row => row.role === 'user')
  }, 30000)
  const code = `import pathlib,subprocess,time; print('real targeted suite starting',flush=True); subprocess.run(['/opt/homebrew/bin/node','node_modules/vitest/vitest.mjs','run','tests/heavy-queue.test.ts','tests/run-queue.test.ts','tests/proxy-queue.test.ts'],check=True); print('suite passed; holding canary barrier',flush=True); deadline=time.monotonic()+150\nwhile not pathlib.Path(${JSON.stringify(gate)}).exists() and time.monotonic()<deadline: time.sleep(.2)\nprint('barrier released',flush=True)`
  const first = await tool('submit', { key: 'canary-first', cwd: remote, argv: ['/opt/homebrew/bin/python3', '-c', code], timeout_seconds: 180 })
  const second = await tool('submit', { key: 'canary-second', cwd: remote, argv: ['/usr/bin/printf', 'second-real-command\n'], timeout_seconds: 30 })
  await wait('real running plus queued', async () => {
    const a = await tool('status', { job_id: first.job_id }); const b = await tool('status', { job_id: second.job_id })
    return a.state === 'running' && b.state === 'queued'
  })
  await wait('origin terminal', async () => {
    const value = await request(`/wizard/hermes/v1/runs/${originRun.run_id}`)
    return ['completed', 'failed', 'interrupted'].includes(value.status) && value
  })
  const started = Date.now()
  const question = await request('/wizard/hermes/v1/runs', { session_id: questionSession,
    input: 'Answer without tools, in one sentence: why does a durable background job queue help a chat service remain responsive?' })
  const answer = await wait('real model answer', async () => {
    const value = await request(`/wizard/hermes/v1/runs/${question.run_id}`)
    if (['failed', 'interrupted'].includes(value.status)) throw new Error(`real model failed: ${JSON.stringify(value)}`)
    return value.status === 'completed' && value
  })
  const stillFirst = await tool('status', { job_id: first.job_id }); const stillSecond = await tool('status', { job_id: second.job_id })
  if (stillFirst.state !== 'running' || stillSecond.state !== 'queued') throw new Error('question did not finish within occupied-worker barrier')
  event('responsive_real_answer', { latency_ms: Date.now() - started, answer,
    worker_state: stillFirst.state, second_state: stillSecond.state, health: await request('/wizard/health') })
  await exec('ssh', ['thales', `/usr/bin/touch '${gate}'`])
  for (const receipt of [first, second]) {
    const result = await wait('worker completion and originating continuation', async () => {
      const value = await tool('status', { job_id: receipt.job_id })
      if (['failed', 'interrupted', 'cancelled'].includes(value.state)) throw new Error(`worker failed: ${JSON.stringify(value)}`)
      return value.state === 'completed' && value.continuation.startsWith('wizardq_') && value
    })
    const continuation = await wait('real continuation answer', async () => {
      const value = await request(`/wizard/hermes/v1/runs/${result.continuation}`)
      if (['failed', 'interrupted', 'cancelled'].includes(value.status)) throw new Error(`continuation failed: ${JSON.stringify(value)}`)
      return value.status === 'completed' && value
    })
    event('origin_resumed', { job_id: receipt.job_id, continuation })
  }
  const database = new DatabaseSync(join(base, 'runs.sqlite3'), { readOnly: true })
  const counts = database.prepare("SELECT idempotency_key,count(*) AS count FROM wizard_run_queue WHERE idempotency_key LIKE 'wizard-heavy-%' GROUP BY idempotency_key").all()
  database.close()
  if (counts.length !== 2 || counts.some(r => r.count !== 1)) throw new Error('logical continuation count mismatch')
  results.passed = true; event('verified', { counts })
} catch (error) {
  results.passed = false; results.error = error.message; event('failed', { error: error.message }); process.exitCode = 1
} finally {
  // A failed canary must not leave its own workers holding the shared resource.
  if (!results.passed && origin) {
    const db = new DatabaseSync(join(base, 'heavy.sqlite3'), { readOnly: true })
    const jobs = db.prepare('SELECT id FROM heavy_jobs').all(); db.close()
    for (const job of jobs) await tool('cancel', { job_id: job.id }).catch(() => {})
    await new Promise(r => setTimeout(r, 3000))
  }
  writeFileSync(join(base, 'canary-evidence.json'), JSON.stringify(results, null, 2), { mode: 0o600 })
  server.closeAllConnections()
  await new Promise(r => server.close(r))
}
