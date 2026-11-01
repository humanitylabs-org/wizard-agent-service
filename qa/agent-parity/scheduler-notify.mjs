import assert from 'node:assert/strict'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scene, post } from './fixture.mjs'

const output = '**Synthetic alert**\nSynthetic disk is almost full.\n[SILENT]'
const notification = { title: 'Synthetic alert', message: 'Synthetic disk is almost full.' }

// Keep the real Scheduler, scheduleNotifier, app bridge, auth and agent proxies.
// Only Hermes and the notifications MCP provider are synthetic boundaries.
export async function notificationScene(kind, bound) {
  let clock = Date.parse('2026-10-21T00:00:00Z')
  let setAllowed
  const internalReads = [], internalPatches = [], appCalls = [], sends = []
  const s = await scene(kind, ({ root, id, folder, osHome }) => {
    writeFileSync(join(root, 'apps.json'), JSON.stringify({
      slots: { notifications: { default: 'notifications' } },
      apps: [{ id: 'notifications', name: 'Synthetic notifications', status: 'running',
        provides: ['notifications'], mcp: { url: 'http://notifications.fixture/mcp' } }],
    }))
    // Explicit owner choices: in routed cases main must NOT have this app. A
    // mistaken default/main-agent send would fail the bridge's real allowlist.
    writeFileSync(join(osHome, 'agents', '.apps-seen.json'), JSON.stringify({ schema: 1, apps: ['notifications'], private: [] }))
    setAllowed = allowed => {
      writeFileSync(join(osHome, 'agents', '.main-agent.json'), JSON.stringify({
        schema: 1, wizard_apps: [], agent_apps: kind === 'main' && allowed ? ['notifications'] : [],
      }))
      if (kind !== 'main') {
        const path = join(folder, 'agent.json'), agent = JSON.parse(readFileSync(path, 'utf8'))
        agent.permissions.agent_apps = allowed ? ['notifications'] : []
        if (agent.runtime.kind === 'container') agent.runtime.isolation = kind === 'restricted' ? 'restricted' : 'standard'
        writeFileSync(path, JSON.stringify(agent))
      }
    }
    setAllowed(bound)
    return {
      agentBridge: true, bridgeWriteSkills: false, bridgeWatchMs: 0, bridgeLog: () => {},
      schedulerStatePath: join(root, 'schedules.sqlite3'), schedulerNow: () => clock,
      schedulerTimezone: 'UTC', schedulerEnabled: false,
      fetchImpl: async (url, init = {}) => {
        const parsed = new URL(url), headers = new Headers(init.headers)
        if (parsed.hostname === 'notifications.fixture') {
          const rpc = JSON.parse(init.body)
          if (rpc.method === 'tools/call') appCalls.push(rpc.params)
          const result = rpc.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'synthetic', version: '1' } }
            : rpc.method === 'tools/list' ? { tools: [{ name: 'notify', description: 'Synthetic alert', inputSchema: { type: 'object' } }] }
              : { content: [{ type: 'text', text: 'sent' }] }
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }), { headers: { 'Content-Type': 'application/json' } })
        }
        const response = await fetch(url, init)
        if (headers.has('X-Wizard-Internal-Token') && parsed.pathname.startsWith('/wizard/hermes/')) {
          const entry = { agent: parsed.searchParams.get('agent'), path: parsed.pathname, headers, status: response.status }
          if (init.method === 'PATCH') internalPatches.push({ ...entry, body: JSON.parse(init.body) })
          if (/\/v1\/runs\/[^/]+$/.test(parsed.pathname)) internalReads.push({ ...entry, payload: await response.clone().json() })
        }
        return response
      },
    }
  })
  // Observe identity without substituting the real notifier or its bridge call.
  const send = s.server.scheduler.notifier.send
  s.server.scheduler.notifier.send = async note => { sends.push(note); return send(note) }
  return Object.assign(s, { internalReads, internalPatches, appCalls, sends, setAllowed,
    advance: () => { clock += 1000 },
  })
}

async function assertBinding(s, allowed) {
  const response = await s.raw('/wizard/v1/apps/notifications/agents')
  assert.equal(response.status, 200)
  const bindings = (await response.json()).agents
  assert.equal(bindings.find(agent => agent.id === s.id)?.enabled, allowed)
  if (s.kind !== 'main') assert.equal(bindings.find(agent => agent.id === 'hermes')?.enabled, false)
  assert.equal(s.server.scheduler.notifier.available(s.id), allowed)
}

async function runNow(s, jobId) {
  const response = await s.raw(`/wizard/v1/schedules/${jobId}/run`, post({}))
  assert.equal(response.status, 202)
  const occurrence = await response.json()
  await s.server.scheduler.tick(false)
  const row = s.server.scheduler.latest(jobId)
  assert.equal(row.admitted, 1, row.error || 'scheduled run must be admitted')
  return { occurrence, runId: JSON.parse(row.receipt).run_id }
}

async function createJob(s) {
  const response = await s.raw('/wizard/v1/schedules', post({ name: 'Parity · Synthetic alert',
    kind: 'run', prompt: 'Check the synthetic disk.', deliver: 'notification', agent: s.id,
    enabled: false, when: { every: 60 },
  }))
  assert.equal(response.status, 201)
  return (await response.json()).id
}

async function complete(s, runId, text) {
  const run = [...s.runs.values()].at(-1)
  assert.ok(run, 'real admission must reach this runtime')
  Object.assign(run, { status: 'completed', output: text })
  s.sessions.get(run.session_id).messages.push({ id: `answer-${run.run_id}`, role: 'assistant', content: text, timestamp: Date.now() / 1000 })
  // Both main and routed queues force a reconciliation on the real GET. The
  // scheduler must obtain the same run itself, with its own internal raw header.
  const response = await s.request(`/v1/runs/${runId}`)
  assert.equal(response.status, 200)
  await response.json()
  await s.server.scheduler.refreshRuns()
}

async function assertVisibility(s, occurrence, hidden) {
  const patches = s.internalPatches.filter(p => p.path.endsWith(`/${occurrence.thread}`))
  assert.deepEqual(patches.at(-1)?.body, { hidden })
  assert.equal(patches.at(-1)?.agent, s.id, 'visibility PATCH must name the scheduled agent')
  assert.equal(patches.at(-1)?.status, 200)
  const response = await s.request(`/api/sessions/${occurrence.thread}`)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).session.hidden, hidden)
  const list = await s.request('/api/sessions?view=list')
  assert.equal(list.status, 200)
  const payload = await list.json()
  assert.equal((payload.data || payload.sessions).some(row => row.id === occurrence.thread), !hidden,
    'Chats must exclude notification history and show the fallback thread')
  const upstream = s.seen.filter(r => r.method === 'PATCH' && r.path.endsWith(`/${occurrence.thread}`)).at(-1)
  assert.equal(upstream?.body.hidden, hidden, 'the agent runtime must receive the visibility change')
  if (s.kind === 'host-profile') assert.ok(upstream.path.startsWith('/p/parity-profile/'))
  assert.equal(upstream.headers.authorization, `Bearer ${s.kind === 'main' ? 'parity-main-secret' : 'parity-runtime-secret'}`)
  if (s.kind === 'restricted') {
    const socket = join(s.root, 'os', 'agents', s.id, 'gateway', 'ingress.sock')
    assert.ok(statSync(socket).isSocket())
    assert.equal(statSync(socket).mode & 0o777, 0o600)
  }
}

export async function checkBoundNotification(s) {
  await assertBinding(s, true)
  const jobId = await createJob(s)
  const { occurrence, runId } = await runNow(s, jobId)
  assert.equal(occurrence.deliver, 'notification')
  assert.equal(occurrence.fallback, undefined)
  await assertVisibility(s, occurrence, true)
  await complete(s, runId, output)
  const read = s.internalReads.filter(r => r.path.endsWith(`/${runId}`)).at(-1)
  assert.equal(read?.status, 200)
  assert.equal(read?.agent, s.id)
  assert.equal(read?.headers.get('X-Wizard-Schedule-Raw'), '1')
  assert.equal(read?.payload.output, output, 'scheduler must read the UNSCRUBBED silent answer for every kind')
  assert.deepEqual(s.sends, [{ ...notification, key: occurrence.key, agent: s.id }])
  assert.deepEqual(s.appCalls, [{ name: 'notify', arguments: notification }])
  assert.equal(s.server.scheduler.project(s.server.scheduler.get(jobId)).lastRun.outcome, 'notified')
  for (const headers of [{}, { 'X-Wizard-Schedule-Raw': '1' }]) {
    const response = await s.request(`/v1/runs/${runId}`, { headers })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).output, '', 'owner proof cannot opt into the internal raw view')
  }
  const history = await (await s.request(`/api/sessions/${occurrence.thread}/messages?view=wizard`, { headers: { 'X-Wizard-Schedule-Raw': '1' } })).json()
  assert.ok(!JSON.stringify(history).includes('Synthetic disk is almost full.'), 'thread history stays silent')
  await s.server.scheduler.refreshRuns()
  assert.equal(s.appCalls.length, 1, 'refresh must not send twice')

  // Losing the app must unhide the SAME previously hidden schedule thread.
  s.setAllowed(false)
  s.advance()
  await assertBinding(s, false)
  await checkFallbackNotification(s, jobId, occurrence.thread)
}

export async function checkFallbackNotification(s, jobId, priorThread) {
  await assertBinding(s, false)
  jobId ||= await createJob(s)
  const priorCalls = s.appCalls.length, priorSends = s.sends.length
  const { occurrence, runId } = await runNow(s, jobId)
  assert.equal(occurrence.deliver, undefined)
  assert.equal(occurrence.fallback, true)
  if (priorThread) assert.equal(occurrence.thread, priorThread)
  await assertVisibility(s, occurrence, false)
  // A thread-delivered run is a Reporter report on main, so the fallback answer uses the report format.
  await complete(s, runId, '**Synthetic visible fallback alert.**\n\n**What happened:** Nothing needs your attention.\n[WIZARD_STATUS_V1]{"state":"done","ask":"The check finished"}[/WIZARD_STATUS_V1]')
  // Main's scheduler reads every run raw (internal token only, 096f920); the owner-visible thread still shows the alert.
  assert.ok(s.internalReads.some(r => r.path.endsWith(`/${runId}`)), 'the scheduler observed the fallback run')
  const response = await s.request(`/v1/runs/${runId}`)
  assert.equal(response.status, 200)
  assert.ok((await response.json()).output.includes('Synthetic visible fallback alert.'))
  assert.equal(s.server.scheduler.project(s.server.scheduler.get(jobId)).lastRun.outcome, 'posted')
  const history = await s.request(`/api/sessions/${occurrence.thread}/messages?view=wizard`)
  assert.equal(history.status, 200)
  assert.ok(JSON.stringify(await history.json()).includes('Synthetic visible fallback alert.'))
  assert.equal(s.appCalls.length, priorCalls, 'unbound agent must not call notifications')
  assert.equal(s.sends.length, priorSends, 'unbound agent must not send as itself or main')
}
