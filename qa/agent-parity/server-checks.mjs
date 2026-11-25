import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { parse as parseYaml } from 'yaml'
import { TITLE_INSTRUCTIONS } from '../../server/thread-titles.mjs'
import { CLAUDE_MODEL_LIMIT_SAFE_ERROR } from '../../server/run-provider-failure.mjs'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { post, png, scene } from './fixture.mjs'
import { PRESETS } from '../../server/agents.mjs'
import { createChannelStore } from '../../server/channel-store.mjs'
import { importInboxUploads } from '../../server/inbox-import.mjs'
import { guardOwnedOpenWork } from '../../server/owned-open-work.mjs'
import { SUPERVISOR_SPELL, FINISH_REPORT_INSTRUCTIONS, CONCISE_REPLY_INSTRUCTIONS, STATUS_INSTRUCTIONS, STATUS_PROTOCOL_INSTRUCTIONS, OWNED_OPEN_WORK_INSTRUCTIONS } from '../../server/thread-status.mjs'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '../../hermes-plugin/wizard-os')
const sent = s => s.seen.filter(r => r.method === 'POST' && r.path.endsWith('/v1/runs')).at(-1).body
const history = async s => {
  const r = await s.request('/api/sessions/wizard_parity/messages?view=wizard&order=oldest')
  assert.equal(r.status, 200)
  return (await r.json()).data
}
const admit = async (s, body) => {
  const r = await s.request('/v1/runs', post({ session_id: 'wizard_parity', ...body }))
  assert.equal(r.status, 202)
  return r.json()
}
// The thread leaves Working as soon as the browser reads the finished run, well inside the 30 s
// cached Hermes listing. The listing is read while the run is live, so a stale cache would show.
const ACTIVE = new Set(['started', 'accepted', 'queued', 'running', 'stopping', 'waiting_for_approval'])
const finishedRunLeavesWorking = async (s, fresh = true) => {
  const listed = async () => (await (await s.request('/api/sessions?view=list')).json()).data.find(x => x.id === 'wizard_parity')
  const until = async (ok, label) => {
    for (let n = 0; n < 40; n++) { const item = await listed(); if (ok(item)) return item; await new Promise(r => setTimeout(r, 25)) }
    assert.fail(label)
  }
  const admitted = await s.request('/v1/runs', post({ session_id: 'wizard_parity', input: 'Synthetic request' }))
  assert.equal(admitted.status, 202)
  const runId = (await admitted.json()).run_id
  // A rename makes main re-read (and cache) the Hermes listing while the run is still live.
  assert.equal((await s.request('/api/sessions/wizard_parity', { ...post({ hidden: false, title: 'Parity · Working' }), method: 'PATCH' })).status, 200)
  await until(item => ACTIVE.has(item?.status), 'the live run lists as Working')
  const run = [...s.runs.values()].at(-1)
  Object.assign(run, { status: 'completed', updated_at: Date.now() / 1000, output: 'Synthetic reply' })
  s.sessions.get('wizard_parity').messages.push({ role: 'assistant', content: 'Synthetic reply', timestamp: Date.now() / 1000 + 1 })
  const read = await s.request(`/v1/runs/${runId}`)
  assert.equal(read.status, 200); assert.equal((await read.json()).status, 'completed')
  const done = await until(item => item && !ACTIVE.has(item.status), 'the finished run leaves Working within 1 s, not after the 30 s listing cache')
  assert.ok(!ACTIVE.has(done.status))
  // The listing behind the row is the finished one too (main's direct path re-reads its Hermes cache).
  if (fresh) assert.equal(done.messageCount, 2, 'the row is read from the finished listing, not the cached running one')
}
const envelope = text => [...String(text).matchAll(/<helm_attachments>([\s\S]*?)<\/helm_attachments>/g)].flatMap(match => JSON.parse(match[1]).items || [])

// Issue 527: the Daily channel's fake clock (the scene's dailyNow and schedulerNow read it).
export const dailyClock = { at: null }
// Issue 532: the synthetic loopback capability of the main agent's schedule tool in the Daily scene.
export const dailyScheduleToken = crypto.randomUUID() + crypto.randomUUID() // generated per run, never a fixed value
export const serverChecks = {
  // wizard-ux issue 1766: a chat started in another app (Hermes source telegram) keeps that source on every Chats list
  // shape, so the shell says it lives in Telegram instead of offering a Retry Hermes always refuses.
  // Issue 518 (switch wizard/plain-chat-titles, off by default): a title the Service dated because another chat holds
  // it is served without the date; Hermes keeps its unique stored title, and an owner's own title keeps every word.
  'plain-chat-titles': async s => {
    const look = on => { const dir = join(s.root, 'Pages', 'wizard-look'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'look.json'), JSON.stringify({ version: 1, skin: null, tweaks: { 'wizard/plain-chat-titles': { on, at: Date.now() } } })) }
    const other = await s.request('/api/sessions', post({ id: 'wizard_parity_vespa', title: 'Synthetic Vespa', source: 'wizard-mobile' }))
    assert.ok(other.ok, `${s.kind}: a second chat holds the title`)
    const row = s.sessions.get('wizard_parity'); row.hidden = false
    const before = row.title
    row.messages.push({ role: 'assistant', content: `Synthetic answer\n[WIZARD_STATUS_V1] ${JSON.stringify({ state: 'done', ask: 'Synthetic outcome', title: 'Synthetic Vespa', subject: 'Parity QA' })}[/WIZARD_STATUS_V1]`, timestamp: Date.now() / 1000 })
    const listed = async () => {
      const r = await s.request('/api/sessions?view=list'); assert.equal(r.status, 200)
      return (await r.json()).data.find(x => x.id === 'wizard_parity')
    }
    look(false)
    await listed()
    const dated = /^Synthetic Vespa \(\d{1,2} [A-Z][a-z]{2}\)$/u
    if (s.kind === 'main') for (let n = 0; n < 40 && !dated.test(row.title); n++) await new Promise(resolve => setTimeout(resolve, 25))
    else await new Promise(resolve => setTimeout(resolve, 100))
    if (s.kind === 'main') {
      // Main dates a clashing agent title in Hermes (clashCandidates); the switch only changes what is shown.
      assert.match(row.title, dated, 'main: Hermes holds the dated, unique title')
      assert.equal((await listed()).title, row.title, 'switch off: the dated title, as before')
      look(true)
      assert.equal((await listed()).title, 'Synthetic Vespa', 'switch on: the plain title')
      assert.match(row.title, dated, 'switch on: Hermes still holds the unique title')
      const detail = await (await s.request('/api/sessions/wizard_parity?view=detail')).json()
      assert.equal((detail.session ?? detail).title, 'Synthetic Vespa', 'switch on: the thread view shows the plain title')
      await admit(s, { input: 'Synthetic next ask' })
      assert.ok(sent(s).instructions.includes('This thread is currently titled “Synthetic Vespa”.'), 'switch on: the agent is reminded of the plain title')
      look(false)
      assert.match((await listed()).title, dated, 'switch off again: the dated title comes back')
    } else {
      // Routed agents never date a clashing title: Hermes refuses it and the chat keeps its title, switch or not.
      assert.equal(row.title, before, `${s.kind}: a refused clash leaves the title`)
      const shown = (await listed()).title
      look(true)
      assert.equal((await listed()).title, shown, `${s.kind}: switch on changes nothing here`)
    }
    // An owner who types a date keeps it, on every kind.
    look(true)
    const rename = await s.request('/api/sessions/wizard_parity', { ...post({ title: 'Synthetic trip (14 Nov)' }), method: 'PATCH' })
    assert.equal(rename.status, 200)
    assert.equal((await listed()).title, 'Synthetic trip (14 Nov)', `${s.kind}: an owner's own dated title keeps its date`)
  },
  'chat-source-list': async s => {
    const row = s.sessions.get('wizard_parity')
    Object.assign(row, { hidden: false, source: 'telegram' })
    row.messages.push({ role: 'user', content: 'Synthetic message from Telegram', timestamp: Date.now() / 1000 })
    for (const query of ['?limit=100', '?view=list', '?view=list&window=archive-50&limit=100']) {
      let item
      for (let n = 0; n < 40 && !item; n++) {
        const r = await s.request('/api/sessions' + query); assert.equal(r.status, 200)
        item = (await r.json()).data.find(x => x.id === 'wizard_parity')
        if (!item) await new Promise(done => setTimeout(done, 50))
      }
      assert.ok(item, `the Telegram chat lists (${query})`)
      assert.equal(item.source, 'telegram', `the list row keeps its source (${query})`)
    }
  },
  // Issue 612: after a /new in Telegram, stock Hermes starts a new session whose parent_session_id is the
  // old one (ended session_reset). It is its own conversation and lists; a sub-agent child never does.
  'chat-after-reset-list': async s => {
    const row = s.sessions.get('wizard_parity')
    const at = Date.now() / 1000
    Object.assign(row, { hidden: false, source: 'telegram', end_reason: 'session_reset', ended_at: at - 5 })
    row.messages.push({ role: 'user', content: 'Synthetic first Telegram conversation', timestamp: at - 10 })
    const child = (id, parent, content) => s.sessions.set(id, { id, source: 'telegram', title: content, created_at: at - 4, parent_session_id: parent,
      messages: [{ role: 'user', content, timestamp: at - 3 }, { role: 'assistant', content: 'Synthetic reply', timestamp: at - 2 }] })
    child('wizard_parity_live', null, 'Synthetic live conversation')
    child('wizard_parity_after_new', 'wizard_parity', 'Synthetic conversation after new')
    child('wizard_parity_helper', 'wizard_parity_live', 'Synthetic helper run')
    for (const query of ['?limit=100', '?view=list&limit=100']) {
      let ids = []
      for (let n = 0; n < 40 && !ids.includes('wizard_parity_after_new'); n++) {
        const r = await s.request('/api/sessions' + query); assert.equal(r.status, 200)
        ids = (await r.json()).data.map(x => x.id)
        if (!ids.includes('wizard_parity_after_new')) await new Promise(done => setTimeout(done, 50))
      }
      assert.ok(ids.includes('wizard_parity_after_new'), `${s.kind}: the conversation after /new lists (${query})`)
      assert.ok(ids.includes('wizard_parity'), `${s.kind}: the conversation before /new still lists (${query})`)
      // Main applies its own rule; a routed agent's list is its stock Hermes listing, which already leaves
      // sub-agent runs out (the fixture lists every session, so only main can show it here).
      if (s.kind === 'main') assert.ok(!ids.includes('wizard_parity_helper'), `${s.kind}: a sub-agent child stays out (${query})`)
    }
    const history = await s.request('/api/sessions/wizard_parity_after_new/messages?view=wizard'); assert.equal(history.status, 200)
    const text = JSON.stringify(await history.json())
    assert.ok(text.includes('Synthetic conversation after new') && !text.includes('Synthetic first Telegram conversation'), `${s.kind}: it opens with its own messages`)
  },
  // Issue 527 (Daily channel, with the channel store): one pinned channel per agent holding one real thread per day,
  // through each runtime's real Service routes and scheduler.
  // Issue 564: a scheduled run the agent's queue reports finished stops counting toward the scheduler's in-flight
  // cap, even when its result can't be read, so stuck rows never hold back other threads' watches.
  'scheduler-finished-runs': async s => {
    const scheduler = s.server.scheduler
    const made = await s.raw('/wizard/v1/schedules', post({ name: 'Parity · Synthetic work', prompt: 'Synthetic work.', agent: s.id, enabled: false, when: { every: 3600 } }))
    assert.equal(made.status, 201, await made.clone().text())
    const job = await made.json()
    assert.equal((await s.raw(`/wizard/v1/schedules/${job.id}/run`, post({}))).status, 202)
    await scheduler.tick(false)
    let row = scheduler.latest(job.id)
    assert.equal(row.admitted, 1, row.error || 'admitted')
    const occurrence = JSON.parse(row.data), receipt = JSON.parse(row.receipt)
    assert.equal(scheduler.inflightCount(), 1, `${s.kind}: the running scheduled run counts as in flight`)
    const lookup = scheduler.lookup
    try {
      // The run's result becomes unreadable (the box's failing run lookup); only the agent's own queue knows it ended.
      scheduler.lookup = async () => null
      for (const run of s.runs.values()) Object.assign(run, { status: 'completed', updated_at: Date.now() / 1000, output: 'Synthetic reply' })
      let status = null
      for (let i = 0; i < 40 && status !== 'completed'; i++) {
        await s.request(`/v1/runs/${encodeURIComponent(receipt.run_id)}`)
        status = await scheduler.runStatus(occurrence, receipt)
        if (status !== 'completed') await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.equal(status, 'completed', `${s.kind}: the agent's queue reports the scheduled run finished`)
      await scheduler.refreshRuns()
      row = scheduler.latest(job.id)
      assert.ok(row.run_done_at, `${s.kind}: the finished run is marked done although its result can't be read`)
      assert.equal(scheduler.inflightCount(), 0, `${s.kind}: a finished run no longer holds the in-flight cap`)
    } finally { scheduler.lookup = lookup }
  },
  'chats-daily-channel': async s => {
    const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const channels = async () => (await (await s.raw('/wizard/v1/channels')).json()).channels
    try {
      let daily = (await channels()).find(c => c.kind === 'daily')
      assert.ok(daily && daily.agent === 'hermes' && daily.pinned && daily.pinOrder === 0 && daily.dayStartsAt === '05:00', 'the main agent gets one Daily, pinned on top')
      assert.equal((await channels()).filter(c => c.kind === 'daily').length, 1, 'the seed runs once')
      if (s.id !== 'hermes') {
        const made = await (await s.raw('/wizard/v1/channels', json('POST', { name: 'Synthetic daily', agent: s.id }))).json()
        const patched = await s.raw('/wizard/v1/channels', json('PATCH', { id: made.id, kind: 'daily' }))
        assert.equal(patched.status, 200, 'PATCH kind turns a channel into this agent\u2019s daily channel')
        daily = await patched.json()
        assert.equal((await channels()).filter(c => c.kind === 'daily').length, 2, 'one daily channel per agent')
      }
      const today = () => s.raw(`/wizard/v1/channels/${daily.id}/today`, json('POST', {}))
      dailyClock.at = Date.parse('2026-11-15T04:59:00Z')
      const raced = await Promise.all([today(), today()])
      assert.deepEqual(raced.map(r => r.status).sort(), [200, 201], 'one of two racing first posts creates the thread')
      const [first, second] = await Promise.all(raced.map(r => r.json()))
      assert.equal(first.sessionId, second.sessionId, 'two racing first posts end up in the same thread')
      assert.equal(first.day, '2026-11-14', 'a post at 04:59 lands in yesterday\u2019s thread')
      assert.ok(s.sessions.has(first.sessionId), 'the day thread is a real session of this agent')
      const filed = await (await s.raw(`/wizard/v1/channels/membership?sessionId=${first.sessionId}&agent=${s.id}`)).json()
      assert.equal(filed.channel, daily.id, 'the day thread is filed into Daily')
      dailyClock.at = Date.parse('2026-11-15T05:00:00Z')
      assert.equal((await (await s.raw(`/wizard/v1/channels/${daily.id}/today`)).json()).sessionId, null, 'today is null until something is posted after the boundary')
      const started = await today(); assert.equal(started.status, 201)
      const now = await started.json()
      assert.equal(now.day, '2026-11-15', 'a post at 05:00 starts today\u2019s thread'); assert.notEqual(now.sessionId, first.sessionId)
      // A thread:'daily' job and an origin-less reminder post into today's thread.
      const job = async extra => { const r = await s.raw('/wizard/v1/schedules', post({ name: 'Parity · Synthetic daily', prompt: 'Synthetic brief.', agent: s.id, enabled: false, when: { every: 3600 }, ...extra })); assert.equal(r.status, 201, await r.clone().text()); return r.json() }
      const fire = async created => {
        const r = await s.raw(`/wizard/v1/schedules/${created.id}/run`, post({})); assert.equal(r.status, 202)
        const occurrence = await r.json(); await s.server.scheduler.tick(false)
        const latest = s.server.scheduler.latest(created.id); assert.equal(latest.admitted, 1, latest.error || 'admitted')
        return occurrence.thread ?? occurrence.session_id
      }
      assert.equal(await fire(await job({ kind: 'run', thread: 'daily' })), now.sessionId, 'a thread:daily job posts into today\u2019s Daily thread')
      assert.equal(await fire(await job({ kind: 'remind' })), now.sessionId, 'an origin-less reminder goes to today\u2019s Daily thread')
      // Issue 532: the main agent's own schedule tool (loopback route, heavy token) may name thread 'daily'; it stays main's.
      const agentCreate = (extra, token = dailyScheduleToken) => s.raw('/wizard/internal/schedules/create', { method: 'POST', headers: { Authorization: ['Bearer', token].join(' '), 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'wizard_parity_caller', name: 'Parity · Synthetic agent brief', when: { every: 1440 }, text: 'Synthetic brief.', ...extra }) })
      assert.equal((await agentCreate({ kind: 'run', thread: 'daily' }, crypto.randomUUID() + crypto.randomUUID())).status, 403, 'the loopback schedule route needs the main agent\u2019s token')
      const agentJob = await agentCreate({ kind: 'run', thread: 'daily' }); assert.equal(agentJob.status, 201, await agentJob.clone().text())
      const agentMade = await agentJob.json()
      assert.equal(agentMade.thread, 'daily', 'the main agent\u2019s schedule tool can name the Daily thread'); assert.equal(agentMade.agent, 'main', 'a loopback schedule is always the main agent\u2019s')
      assert.equal((await (await agentCreate({ kind: 'run', thread: 'wizard_parity_other' })).json()).thread, 'wizard_parity_caller', 'any other thread stays the calling session')
      assert.equal((await agentCreate({ kind: 'watch', thread: 'daily' })).status, 400, 'a watcher still can\u2019t name the Daily thread')
      if (s.id === 'hermes') assert.equal(await fire(agentMade), now.sessionId, 'the agent\u2019s thread:daily job posts into today\u2019s Daily thread')
      else assert.equal(s.server.scheduler.get(agentMade.id).agent, 'main', 'a routed agent\u2019s schedules are unchanged: the loopback job is main\u2019s')
      // Issue 529: a notification-only reminder with no thread keeps its hidden schedule chat, out of Daily.
      const sentTo = id => s.seen.filter(r => r.method === 'POST' && r.path.endsWith('/v1/runs') && r.body?.session_id === id).at(-1)?.body
      const notifier = s.server.scheduler.notifier
      s.server.scheduler.notifier = { available: () => true }
      try {
        const quiet = await fire(await job({ kind: 'remind', deliver: 'notification' }))
        assert.match(String(quiet), /^wizard_schedule_/u, 'a notification-only reminder stays out of the Daily thread')
      } finally { s.server.scheduler.notifier = notifier }
      // /days pages every day thread, newest first, with its opener and count.
      // (The fixture's POST /api/sessions resets an existing session, so the day's messages are added after the jobs.)
      s.sessions.get(now.sessionId).messages.push({ role: 'assistant', timestamp: Date.now() / 1000 - 2, content: 'Signal: synthetic daily update' })
      s.sessions.get(first.sessionId).messages.push({ role: 'user', timestamp: Date.now() / 1000 - 9, content: 'Synthetic owner evening note' }, { role: 'assistant', timestamp: Date.now() / 1000 - 8, content: 'Synthetic reply' })
      const days = async q => (await (await s.raw(`/wizard/v1/channels/${daily.id}/days${q}`)).json())
      const page1 = await days('?limit=1')
      assert.equal(page1.today, now.sessionId)
      assert.deepEqual(page1.days.map(d => [d.day, d.sessionId]), [['2026-11-15', now.sessionId]])
      assert.equal(page1.days[0].opener, 'Signal: synthetic daily update', 'the opener is the day\u2019s first shown message')
      assert.ok(page1.days[0].count >= 1 && page1.next === '2026-11-15')
      const page2 = await days(`?cursor=${page1.next}`)
      assert.deepEqual(page2.days.map(d => [d.day, d.opener, d.count]), [['2026-11-14', 'Synthetic owner evening note', 2]])
      assert.equal(page2.next, null)
      assert.equal((await s.raw(`/wizard/v1/channels/${daily.id}/days?cursor=bad`)).status, 400)
      // A run in today's thread carries yesterday's thread.
      const run = await s.request('/v1/runs', post({ session_id: now.sessionId, input: 'Synthetic owner daily send' })); assert.equal(run.status, 202, await run.clone().text())
      assert.ok(String(sentTo(now.sessionId)?.instructions).includes(`The previous Daily thread is ${first.sessionId} (2026-11-14)`), 'the carry-over run note names yesterday\u2019s thread')
      // An owner's archive sticks: no new day thread in an archived Daily.
      assert.equal((await s.raw('/wizard/v1/channels', json('PATCH', { id: daily.id, archived: true }))).status, 200)
      assert.equal((await today()).status, 409, 'an archived Daily starts no thread')
      const late = await s.request('/v1/runs', post({ session_id: first.sessionId, input: 'Synthetic owner late send' })); assert.equal(late.status, 202, await late.clone().text())
      let lateRun
      for (let i = 0; i < 80 && !(lateRun = sentTo(first.sessionId)); i++) await new Promise(r => setTimeout(r, 25))
      assert.ok(lateRun, 'the run in the archived Daily\u2019s old thread reached the runtime')
      assert.ok(!String(lateRun.instructions).includes('Daily channel:'), 'a run in an archived Daily\u2019s old thread gets no carry-over note')
      assert.equal((await channels()).filter(c => c.kind === 'daily' && !c.archived).length, s.id === 'hermes' ? 0 : 1, 'archiving never re-seeds')
      assert.equal((await s.raw('/wizard/v1/channels/alerts/days')).status, 404, 'only a daily channel has days')
    } finally { dailyClock.at = null }
  },
  // Issue 379: Hermes 0.22.7 stamps every /v1/runs admission's user row internal_notification, the owner's own
  // messages included. Every kind restores the owner's turn from its own queue (routed kinds behind
  // WIZARD_ROUTED_OWNER_TURNS); a machine wake with the same kind stays hidden; raw upstream rows are untouched.
  'routed-owner-turns': async s => {
    // Short on purpose: no opening-words match, so the appended [System:] part must be ignored (no state.db ids here).
    const words = 'Synthetic short owner turn.'
    await admit(s, { input: [{ role: 'user', content: [{ type: 'text', text: words }] }] })
    for (let i = 0; i < 40 && !s.sessions.get('wizard_parity').messages.length; i++) await new Promise(r => setTimeout(r, 25))
    const row = s.sessions.get('wizard_parity')
    const owner = row.messages.findLast(m => m.role === 'user')
    assert.ok(owner, 'the queued owner turn reached this kind\'s runtime')
    owner.display_kind = 'internal_notification'
    // Routed kinds match by words (a restricted home is unreadable); main matches this shape by Hermes' submission
    // id from its readable state.db (tests/owner-turns-submission.test.ts), which this fixture's state.db lacks.
    if (s.kind !== 'main') owner.content = [{ type: 'text', text: words }, { type: 'text', text: '[System: synthetic Hermes notice]' }]
    const at = Number(owner.timestamp)
    for (const run of s.runs.values()) Object.assign(run, { status: 'completed', output: 'Synthetic reply' })
    row.messages.push({ id: 'synthetic-reply', role: 'assistant', content: 'Synthetic reply', timestamp: at + 1 },
      { id: 'synthetic-wake', role: 'user', display_kind: 'internal_notification', content: '[Wizard follow-through] Synthetic machine wake', timestamp: at + 2 })
    const before = JSON.stringify(row.messages)
    const output = await history(s)
    const mine = output.filter(m => m.role === 'user' && JSON.stringify(m.content).includes(words))
    assert.equal(mine.length, 1, `${s.kind}: the owner's own message shows exactly once`)
    assert.notEqual(mine[0].display_kind, 'internal_notification', `${s.kind}: the owner's own message is a normal user row`)
    assert.ok(!JSON.stringify(mine[0].content).includes('[System:'), 'Hermes\' own notice is not shown as the owner\'s words')
    const wake = output.find(m => JSON.stringify(m.content ?? '').includes('Synthetic machine wake'))
    assert.ok(!wake || wake.display_kind === 'internal_notification', 'a machine wake is never turned into an owner turn')
    assert.equal(JSON.stringify(row.messages), before, 'upstream rows are unchanged')
    const raw = await (await s.request('/api/sessions/wizard_parity/messages?order=oldest')).json()
    assert.equal(raw.data.find(m => JSON.stringify(m.content).includes(words)).display_kind, 'internal_notification', 'raw (non-wizard) history is not projected')
  },
  // Issue 145: an owner turn with an inline screenshot is stored by Hermes' text-only projection as the words plus
  // "[screenshot]"; with WIZARD_OWNER_SCREENSHOT_TURNS it is still the owner's own message on every kind.
  'owner-screenshot-turns': async s => {
    const words = 'Synthetic screenshot owner turn.'
    await admit(s, { input: [{ role: 'user', content: [{ type: 'text', text: words }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }] }] })
    for (let i = 0; i < 40 && !s.sessions.get('wizard_parity').messages.length; i++) await new Promise(r => setTimeout(r, 25))
    const row = s.sessions.get('wizard_parity')
    const owner = row.messages.findLast(m => m.role === 'user')
    assert.ok(owner, 'the queued owner turn reached this kind\'s runtime')
    Object.assign(owner, { display_kind: 'internal_notification', content: `${words}\n[screenshot]` })
    const at = Number(owner.timestamp)
    for (const run of s.runs.values()) Object.assign(run, { status: 'completed', output: 'Synthetic reply' })
    row.messages.push({ id: 'synthetic-reply', role: 'assistant', content: 'Synthetic reply', timestamp: at + 1 },
      { id: 'synthetic-wake', role: 'user', display_kind: 'internal_notification', content: '[Wizard follow-through] Synthetic machine wake', timestamp: at + 2 })
    const before = JSON.stringify(row.messages)
    const output = await history(s)
    const mine = output.filter(m => m.role === 'user' && JSON.stringify(m.content).includes(words))
    assert.equal(mine.length, 1, `${s.kind}: the owner's screenshot message shows exactly once`)
    assert.notEqual(mine[0].display_kind, 'internal_notification', `${s.kind}: the owner's screenshot message is a normal user row`)
    const wake = output.find(m => JSON.stringify(m.content ?? '').includes('Synthetic machine wake'))
    assert.ok(!wake || wake.display_kind === 'internal_notification', 'a machine wake is never turned into an owner turn')
    assert.equal(JSON.stringify(row.messages), before, 'upstream rows are unchanged')
  },
  // Issue 145, point 2: with WIZARD_OWNER_TURN_RETRY (and routed kinds' WIZARD_ROUTED_OWNER_TURNS), Retry's
  // wizard_retry_input is the owner's own latest turn even though Hermes stamped it internal_notification.
  'owner-turn-retry': async s => {
    const words = 'Synthetic retry owner turn.'
    await admit(s, { input: [{ role: 'user', content: [{ type: 'text', text: words }] }] })
    for (let i = 0; i < 40 && !s.sessions.get('wizard_parity').messages.length; i++) await new Promise(r => setTimeout(r, 25))
    const row = s.sessions.get('wizard_parity')
    row.hidden = false
    const owner = row.messages.findLast(m => m.role === 'user')
    assert.ok(owner, 'the queued owner turn reached this kind\'s runtime')
    owner.display_kind = 'internal_notification'
    for (const run of s.runs.values()) Object.assign(run, { status: 'completed', output: 'Synthetic reply' })
    row.messages.push({ id: 'synthetic-reply', role: 'assistant', content: 'Synthetic reply', timestamp: Number(owner.timestamp) + 1 })
    const r = await s.request('/api/sessions/wizard_parity?view=detail')
    assert.equal(r.status, 200)
    const detail = await r.json()
    assert.equal((detail.session || detail).wizard_retry_input, words, `${s.kind}: Retry rebuilds the owner's own turn`)
  },
  // Issue 145, point 3: with WIZARD_OWNER_TURN_LEDGER, a finished owner send that queue retention pruned still keeps
  // its words, so the owner's internal_notification row is restored on every kind. The prune runs through the same
  // DurableRunQueue class on this kind's own queue file (a second handle, retention forced).
  'owner-turn-ledger': async s => {
    const words = 'Synthetic pruned owner turn.'
    await admit(s, { input: [{ role: 'user', content: [{ type: 'text', text: words }] }] })
    for (let i = 0; i < 40 && !s.sessions.get('wizard_parity').messages.length; i++) await new Promise(r => setTimeout(r, 25))
    const row = s.sessions.get('wizard_parity')
    const owner = row.messages.findLast(m => m.role === 'user')
    assert.ok(owner, 'the queued owner turn reached this kind\'s runtime')
    owner.display_kind = 'internal_notification'
    for (const run of s.runs.values()) Object.assign(run, { status: 'completed', output: 'Synthetic reply' })
    row.messages.push({ id: 'synthetic-reply', role: 'assistant', content: 'Synthetic reply', timestamp: Number(owner.timestamp) + 1 })
    const path = s.kind === 'main' ? join(s.root, 'queue.sqlite3') : join(s.root, 'os', 'agents', s.id, 'wizard-run-queue.sqlite3')
    const { DurableRunQueue } = await import('../../server/run-queue.mjs')
    const second = new DurableRunQueue({ statePath: path, agentId: s.id, keepOwnerTurns: true, launch: async () => ({}), lookup: async () => ({}), activeSessionIds: async () => [], canDispatch: async () => false })
    try {
      const old = Date.now() / 1000 - 30 * 86400
      second.database.prepare("UPDATE wizard_run_queue SET status = 'completed', terminal_at = ? WHERE session_id = 'wizard_parity'").run(old)
      const fill = second.database.prepare(`INSERT INTO wizard_run_queue (public_run_id, runtime, session_id, idempotency_key, request_hash, body,
        trusted_paths_json, status, upstream_run_id, payload_json, created_at, updated_at, terminal_at, agent_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      for (let i = 0; i < 130; i++) fill.run(`wizardq_parityfill${i}`, 'direct', `wizard_parity_fill${i}`, `parity-fill-${i}`, 'h', '{}', '[]', 'completed', `run_fill${i}`, '{}', old + 10 + i, old + 10 + i, old + 10 + i, s.id)
      second._pruneTerminal(true)
      assert.equal(second.database.prepare("SELECT COUNT(*) AS n FROM wizard_run_queue WHERE session_id = 'wizard_parity'").get().n, 0, 'retention pruned the owner send')
    } finally { await second.close() }
    const output = await history(s)
    const mine = output.filter(m => m.role === 'user' && JSON.stringify(m.content).includes(words))
    assert.equal(mine.length, 1, `${s.kind}: the pruned owner message shows exactly once`)
    assert.notEqual(mine[0].display_kind, 'internal_notification', `${s.kind}: the pruned owner message is a normal user row`)
  },
  // Issue 145, point 5: a send the Service wrote itself (heavy-work continuation key or continuation metadata) is never
  // claimed as the owner's turn on any kind, even list-shaped with the same words as its Hermes row.
  'owner-turn-service-sends': async s => {
    const words = 'Synthetic service continuation words.'
    await admit(s, { input: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic owner opener.' }] }] })
    for (let i = 0; i < 40 && !s.sessions.get('wizard_parity').messages.length; i++) await new Promise(r => setTimeout(r, 25))
    const row = s.sessions.get('wizard_parity')
    for (const run of s.runs.values()) Object.assign(run, { status: 'completed', output: 'Synthetic reply' })
    const at = Number(row.messages.at(-1)?.timestamp ?? Date.now() / 1000)
    const path = s.kind === 'main' ? join(s.root, 'queue.sqlite3') : join(s.root, 'os', 'agents', s.id, 'wizard-run-queue.sqlite3')
    const db = new DatabaseSync(path)
    try {
      const body = JSON.stringify({ session_id: 'wizard_parity', input: [{ role: 'user', content: [{ type: 'text', text: words }] }] })
      db.prepare(`INSERT INTO wizard_run_queue (public_run_id, runtime, session_id, idempotency_key, request_hash, body, trusted_paths_json,
        status, upstream_run_id, payload_json, created_at, updated_at, terminal_at, agent_id, continuation_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run('wizardq_parityheavy', 'direct', 'wizard_parity', 'wizard-heavy-parity', 'h', body, '[]', 'completed', 'run_parity_heavy',
          JSON.stringify({ created_at: at + 10 }), at + 10, at + 10, at + 10, s.id, JSON.stringify({ kind: 'heavy', job_id: 'parity', agent_id: s.id, session_id: 'wizard_parity' }))
    } finally { db.close() }
    row.messages.push({ id: 'synthetic-heavy', role: 'user', display_kind: 'internal_notification', content: words, timestamp: at + 11 },
      { id: 'synthetic-heavy-reply', role: 'assistant', content: 'Synthetic heavy reply', timestamp: at + 12 })
    const output = await history(s)
    const theirs = output.filter(m => JSON.stringify(m.content ?? '').includes(words))
    assert.ok(theirs.length <= 1, `${s.kind}: a service send is never added a second time`)
    assert.ok(!theirs.length || theirs[0].display_kind === 'internal_notification', `${s.kind}: a service-written send is not shown as the owner's message`)
    assert.ok(!output.some(m => String(m.id) === 'queue-wizardq_parityheavy'), `${s.kind}: no queue copy of a service send`)
  },
  'in-flight-notice': async outer => {
    const path = join(outer.root, 'in-flight-heavy.db')
    const s = await scene(outer.kind, { heavyStatePath: path, heavyToken: 'synthetic-in-flight-notice-token', heavyPollIntervalMs: 3_600_000,
      heavyTransport: async () => { throw Error('synthetic fixture never contacts workers') } })
    const db = new DatabaseSync(path), sid = 'wizard_parity', now = Date.now() / 1000
    try {
      s.sessions.set(sid, { id: sid, source: 'wizard-mobile', title: 'Synthetic · Notice', created_at: now - 3000, messages: [] })
      const admitted = await s.request('/v1/runs', post({ session_id: sid, input: 'Synthetic long tool request' }))
      assert.equal(admitted.status, 202)
      const id = (await admitted.json()).run_id
      db.prepare('INSERT INTO heavy_jobs(id,session,origin,key,hash,data,agent_id) VALUES(?,?,?,?,?,?,?)').run('notice_work', sid, 'synthetic', 'notice_key', 'hash', JSON.stringify({ job_id: 'notice_work', sessionId: sid, agent_id: s.id, state: 'running', created_at: Date.now() }), s.id)
      const row = s.sessions.get(sid)
      const notice = at => ({ role: 'assistant', timestamp: at, content: 'Synthetic update notice\n[WIZARD_STATUS_V1]{"state":"needs_you","ask":"Restart the update in Console","subject":"Parity QA"}[/WIZARD_STATUS_V1]' })
      row.messages.push(notice(now + 10))
      const check = async active => {
        for (const query of ['?limit=100', '?view=list&window=archive-50']) {
          const r = await s.request('/api/sessions' + query); assert.equal(r.status, 200)
          const listed = (await r.json()).data.find(x => x.id === sid)
          assert.equal(ACTIVE.has(listed.status), active, JSON.stringify(listed))
          if (active) { assert.ok(listed.runId || listed.wizard_run_id); assert.equal(listed.background ?? listed.wizard_background, undefined) }
        }
      }
      await check(true) // queued owner message has not landed in transcript yet
      row.messages.push({ role: 'user', content: 'Synthetic message during the live tool', display_kind: 'steer', timestamp: now + 20 })
      await check(true)
      row.messages.push(notice(now + 30)); await check(true)
      const run = [...s.runs.values()].at(-1)
      Object.assign(run, { status: 'completed', output: 'Synthetic finished reply', updated_at: now + 40 })
      const ended = await s.request('/v1/runs/' + id); assert.equal((await ended.json()).status, 'completed')
      await check(false)
    } finally { db.close(); await s.close() }
  },
  'detached-job-wait': async outer => {
    // A turn that handed off to a detached deploy is waiting on it: Working while the receipt is live,
    // settled on its own message once the deploy reports. Same through the full and slim lists, per kind.
    const dir = mkdtempSync(join(outer.root, 'deploys-')), sid = 'wizard_parity_deploy', now = Date.now() / 1000
    const receipt = status => writeFileSync(join(dir, 'deploy.json'), JSON.stringify({ id: 'deploy', requested_by_session: sid, status,
      created_at: new Date(now * 1000 - 240_000).toISOString(), timeout: 5400, verify_s: 300, what: 'Synthetic deploy' }))
    const s = await scene(outer.kind, { detachedJobDir: dir, detachedJobTtlMs: 0 })
    try {
      s.sessions.set(sid, { id: sid, source: 'wizard-mobile', title: 'Synthetic · Deploy', created_at: now - 600, messages: [
        { role: 'user', content: 'Ship the fix', timestamp: now - 500 },
        { role: 'assistant', timestamp: now - 300, content: 'Fix merged; the deploy is running.\n[WIZARD_STATUS_V1]{"state":"done","ask":"Deploy started; nothing needed from you","subject":"Parity QA"}[/WIZARD_STATUS_V1]' }] })
      const listed = async () => {
        const rows = []
        for (const query of ['?limit=100', '?view=list&window=archive-50']) {
          const r = await s.request('/api/sessions' + query); assert.equal(r.status, 200, `${s.kind} ${query}`)
          rows.push((await r.json()).data.find(x => x.id === sid))
        }
        return rows
      }
      receipt('running')
      for (const row of await listed()) { assert.ok(row, s.kind); assert.equal(ACTIVE.has(row.status), true, `${s.kind} running deploy keeps the thread Working: ${JSON.stringify(row)}`) }
      receipt('reported')
      for (const row of await listed()) assert.equal(ACTIVE.has(row.status), false, `${s.kind} a reported deploy no longer holds the thread: ${JSON.stringify(row)}`)
    } finally { await s.close(); rmSync(dir, { recursive: true, force: true }) }
  },
  'coalesced-owner-history': async s => {
    const row = s.sessions.get('wizard_parity')
    const human = 'Synthetic voice report: focus moved but the dialog stayed closed.'
    const helper = '[ASYNC DELEGATION BATCH COMPLETE — synthetic]\nPrivate helper instructions\n\n--- ✓ TASK 1/1: Synthetic private task (status=completed) ---\nPrivate result\nFull live transcript (complete tool/assistant trace): /private/synthetic.log'
    const chip = '[WIZARD_FILE_CHIPS_V1]\n[{"id":"drop_synthetic","filename":"voice.webm","mime":"audio/webm"}]\n[/WIZARD_FILE_CHIPS_V1]'
    const media = { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }
    row.messages = [
      { id: 'helper-only', role: 'user', content: helper, timestamp: 100 },
      { id: 'owner-voice', role: 'user', client_message_id: 'synthetic-client', content: [{ type: 'text', text: helper + '\n\n' + human + '\n\n' + chip }, media], timestamp: 101 },
      { id: 'reply', role: 'assistant', content: 'Synthetic answer', timestamp: 102 },
    ]
    const before = JSON.stringify(row.messages), requests = s.seen.length
    const output = await history(s)
    assert.deepEqual(output.map(r => r.id), ['owner-voice', 'reply'])
    assert.equal(output[0].client_message_id, 'synthetic-client')
    assert.equal(output[0].timestamp, 101)
    assert.equal(output[0].content[0].text, human + '\n\n' + chip)
    assert.deepEqual(output[0].content[1], media)
    assert.deepEqual(output[0].display_content, output[0].content)
    assert.ok(!JSON.stringify(output).includes('Private helper'))
    assert.ok(!JSON.stringify(output).includes('/private/'))
    assert.equal(JSON.stringify(row.messages), before)
    assert.ok(!s.seen.slice(requests).some(r => r.method === 'POST'), 'history reads admit no runs')
  },
  'reply-summary-preferences': async s => {
    // The shell uses one owner/box preference route even while a routed chat is open.
    // Read each kind's real transcript route too: no preference write may admit a run
    // or change the routed transcript. Restricted fixtures retain their Unix ingress.
    const file = join(s.root, 'os', 'ui-preferences.json')
    const stored = { compact: true, futureShellKey: { keep: true } }
    writeFileSync(file, JSON.stringify(stored) + '\n')
    const read = async () => { const r = await s.raw('/wizard/v1/ui-preferences'); assert.equal(r.status, 200); return r.json() }
    const put = value => s.raw('/wizard/v1/ui-preferences', { ...post(value), method: 'PUT' })
    const before = await history(s)
    const sends = () => s.seen.filter(r => r.method === 'POST' && /\/(?:v1\/runs|chat\/stream)$/.test(r.path)).length
    const admitted = sends()
    assert.equal(Object.hasOwn(await read(), 'replySummary'), false, 'absent stays absent on every kind')
    const replySummary = { on: true, start: 'expanded', length: 'paragraph' }
    assert.equal((await put({ replySummary })).status, 200)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ...stored, replySummary })
    await s.restart()
    assert.deepEqual((await read()).replySummary, replySummary, 'reopen reads the persisted choice')
    const saved = readFileSync(file, 'utf8')
    assert.equal((await put({ replySummary: { on: true, length: 'bad' }, compact: false })).status, 400)
    assert.equal(readFileSync(file, 'utf8'), saved, 'invalid preference cannot partially write')
    assert.deepEqual(await history(s), before, 'main and routed transcripts remain unchanged')
    assert.equal(sends(), admitted, 'reopening preferences never generates a reply')
  },
  'reply-summary-ask-length': async s => {
    // While the owner's short-answer view is on, its length sets the status ask budget in the instructions that
    // actually reach every runtime kind (main directBody, routed proxyToAgent); off or absent keeps 140.
    const file = join(s.root, 'os', 'ui-preferences.json')
    const cases = [
      [null, 140],
      [{ on: true, length: 'line' }, 80],
      [{ on: true, length: 'sentences' }, 140],
      [{ on: true, length: 'paragraph' }, 300],
      [{ on: false, length: 'paragraph' }, 140],
    ]
    for (const [replySummary, max] of cases) {
      writeFileSync(file, JSON.stringify(replySummary ? { replySummary } : {}) + '\n')
      const session_id = `wizard_parity_ask_${replySummary ? `${replySummary.on}_${replySummary.length}` : 'absent'}`
      await s.request('/api/sessions', post({ id: session_id }))
      await admit(s, { session_id, input: 'Synthetic short-answer length' })
      const text = sent(s).instructions
      assert.ok(text.includes(`at most ${max} characters`), `${s.kind}: ${JSON.stringify(replySummary)} sends the ${max}-character ask rule`)
      for (const other of [80, 140, 300].filter(n => n !== max)) assert.ok(!text.includes(`at most ${other} characters`), `${s.kind}: ${JSON.stringify(replySummary)} sends no ${other}-character ask rule`)
    }
  },
  'head-row-owner-write-parity': async s => {
    if (s.kind === 'main') {
      const db = new DatabaseSync(join(s.root, 'hermes-state.db'))
      try { db.exec("ALTER TABLE sessions ADD COLUMN last_activity_description TEXT DEFAULT ''") } finally { db.close() }
    }
    const row = s.sessions.get('wizard_parity')
    Object.assign(row, { hidden: false, title: 'Synthetic cache parity' })
    row.messages.push({ role: 'user', content: 'Synthetic cache request', timestamp: Date.now() / 1000 - 2 },
      { role: 'assistant', content: 'Synthetic result.\n[WIZARD_STATUS_V1]{"state":"done","ask":"Synthetic result"}[/WIZARD_STATUS_V1]', timestamp: Date.now() / 1000 - 1 })
    const listed = async title => {
      let last = []
      for (let attempt = 0; attempt < 40; attempt++) {
        // Refresh the fixture's HTTP canonical census before the window snapshot:
        // it was seeded in memory after startup's intentionally empty census.
        if (s.kind === 'main') await (await s.request('/api/sessions?limit=100')).json()
        const response = await s.request('/api/sessions?view=list&window=archive-50&limit=100')
        assert.equal(response.status, 200)
        const data = (await response.json()).data
        last = data
        const item = data.find(value => value.id === row.id)
        // Channel posts are on for everyone (wizard-ux issue 1258): a routed row's first post can arrive one read later.
        if (item?.title === title && 'firstRequest' in item) return data
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.fail(`${s.kind}: ${title} did not reach the projected list: ${JSON.stringify(last)}`)
    }
    const before = await listed(row.title)
    for (let i = 0; i < 8; i++) {
      const response = await fetch(`${s.origin()}/wizard/thread-seen`, { method: 'PUT',
        headers: { ...s.ownerHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ initializedAt: Date.now(), threads: {} }) })
      assert.equal(response.status, 200)
    }
    assert.deepEqual(await listed(row.title), before, 'unrelated owner writes preserve every row field on every runtime')
    if (s.kind === 'main') {
      const stats = await (await fetch(`${s.origin()}/wizard/list-cache`, { headers: s.ownerHeaders })).json()
      assert(stats.head_reused > 0, JSON.stringify(stats))
      assert.equal(stats.fallbacks, 0)
    }
    const renamed = await s.request(`/api/sessions/${row.id}`, { ...post({ title: 'Synthetic owner rename' }), method: 'PATCH' })
    assert.equal(renamed.status, 200)
    const after = (await listed('Synthetic owner rename')).find(value => value.id === row.id)
    assert.equal(after.title, 'Synthetic owner rename', 'row-affecting owner writes remain immediately visible')
  },
  'owned-open-work': async s => {
    await admit(s, { input: 'Synthetic approved backend fix' })
    assert.equal(sent(s).instructions.includes(OWNED_OPEN_WORK_INSTRUCTIONS), false, 'persona-owned follow-up style is never imposed at any runtime HTTP boundary')
    const status = { state: 'done', ask: 'The fix is verified.' }
    const evidence = { agentId: s.id, ownedCount: 1, handleCount: 0, continuation: false }
    if (s.kind === 'main') assert.equal(guardOwnedOpenWork(status, evidence).state, 'fyi')
    else assert.equal(guardOwnedOpenWork(status, evidence), status, 'routed status remains the same object')
    const row = s.sessions.get('wizard_parity'); row.hidden = false
    const text = `Verified fix.

**Still open:**
- Archimedes: run the next checks
[WIZARD_STATUS_V1]${JSON.stringify(status)}[/WIZARD_STATUS_V1]`
    Object.assign([...s.runs.values()].at(-1), { status: 'completed', output: text })
    row.messages.push({ role: 'assistant', timestamp: Date.now()/1000 + 1, content: text })
    const writes = () => s.seen.filter(r => r.method === 'POST' && /\/(?:v1\/runs|chat\/stream)$/.test(r.path))
    const before = writes().length
    for (let i = 0; i < 2; i++) {
      const response = await s.request('/api/sessions?view=list'); assert.equal(response.status, 200)
      const item = (await response.json()).data.find(x => x.id === row.id)
      assert.equal(item.attention.state, 'done', 'no main-only guard leaks into routed list projection')
      assert.notEqual(item.wizard_waiting_on, 'owned_work')
    }
    assert.equal(writes().length, before, 'listing routed work never dispatches an owned-work correction')
    assert.ok(!writes().some(r => JSON.stringify(r.body).includes('[Wizard follow-through] Your last reply lists')))
  },
  // wizard-ux issue 166: a failed run names why (ended plan, usage limit, network) on the thread row,
  // the same structured field on every kind's full and compact list rows.
  'run-failure-reason': async s => {
    const first = await admit(s, { input: 'Synthetic request for an ended plan', model: 'fixture-model' })
    s.sessions.get('wizard_parity').hidden = false
    const upstream = [...s.runs.values()].at(-1)
    Object.assign(upstream, { status: 'failed', updated_at: Date.now() / 1000, output: '',
      error: 'HTTP 402: Your ChatGPT subscription has ended. Renew your plan to keep using Codex.',
      runtime: { provider: 'openai-codex', model: 'fixture-model' } })
    const read = await s.request('/v1/runs/' + first.run_id)
    assert.equal(read.status, 200); assert.equal((await read.json()).status, 'failed')
    const find = async (view) => {
      for (let n = 0; n < 40; n++) {
        const item = (await (await s.request('/api/sessions' + view)).json()).data.find(x => x.id === 'wizard_parity')
        if (item?.status === 'failed') return item
        await new Promise(r => setTimeout(r, 25))
      }
      assert.fail(`${s.kind}: the failed run lists as failed (${view || 'full'})`)
    }
    const full = await find(''), list = await find('?view=list')
    const want = { code: 'provider_billing', provider: 'openai-codex' }
    assert.deepEqual({ code: full.wizard_last_run_error?.code, provider: full.wizard_last_run_error?.provider }, want, `${s.kind}: full row`)
    assert.deepEqual({ code: list.runError?.code, provider: list.runError?.provider }, want, `${s.kind}: compact row`)
    assert.match(list.runError.message, /subscription has ended/)
  },
  // wizard-ux issue 1488: Dismiss on a failed thread's Needs retry card works for every agent's thread (it was
  // main-only, so a routed agent's card stayed with "Couldn't dismiss"), and the list stops showing that failure.
  'failure-dismiss': async s => {
    const first = await admit(s, { input: 'Synthetic request whose run fails', model: 'fixture-model' })
    s.sessions.get('wizard_parity').hidden = false
    Object.assign([...s.runs.values()].at(-1), { status: 'failed', updated_at: Date.now() / 1000, output: '',
      error: 'HTTP 401: synthetic signed-out subscription', runtime: { provider: 'anthropic', model: 'fixture-model' } })
    assert.equal((await (await s.request('/v1/runs/' + first.run_id)).json()).status, 'failed')
    const row = async (view) => (await (await s.request('/api/sessions' + view)).json()).data.find(x => x.id === 'wizard_parity')
    for (let n = 0; n < 40 && (await row(''))?.status !== 'failed'; n++) await new Promise(r => setTimeout(r, 25))
    assert.equal((await row(''))?.status, 'failed', `${s.kind}: the failed run lists as failed before Dismiss`)
    const body = s.kind === 'main' ? '{}' : JSON.stringify({ agent: s.id })
    const dismissed = await s.raw('/wizard/session-failure/wizard_parity/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    assert.equal(dismissed.status, 200, `${s.kind}: Dismiss is accepted`)
    assert.equal((await dismissed.json()).dismissed, true)
    for (const view of ['', '?view=list']) {
      const item = await row(view)
      assert.ok(item, `${s.kind}: the thread stays listed after Dismiss (${view || 'full'})`)
      assert.notEqual(item.status, 'failed', `${s.kind}: the dismissed failure no longer shows (${view || 'full'})`)
      assert.equal(view ? item.runError : item.wizard_last_run_error, undefined, `${s.kind}: no failure reason after Dismiss`)
    }
    if (s.kind !== 'main') {
      // An old client posts '{}': the thread's own pin decides, never the main agent.
      const old = await s.raw('/wizard/session-failure/wizard_parity/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      assert.equal(old.status, 200, `${s.kind}: an old client's Dismiss reaches the thread's own agent`)
      assert.equal((await old.json()).agent_id, s.id)
    }
  },
  // 8-9 Nov 2026: a gateway restart drain failed every accepted-but-unstarted reply with runtime_draining and
  // each thread showed "Reply not sent" until James tapped Retry. The queue now sends it again by itself, once.
  'restart-refused-resend': async s => {
    const input = 'Synthetic owner words sent while the gateway restarted.'
    const first = await admit(s, { input })
    const sends = () => s.seen.filter(r => r.method === 'POST' && /\/(?:v1\/runs|chat\/stream)$/.test(r.path))
    const before = sends().length
    const upstream = [...s.runs.values()].at(-1)
    Object.assign(upstream, { status: 'failed', error: 'runtime_draining', updated_at: Date.now() / 1000, output: '' })
    for (let n = 0; n < 40 && sends().length === before; n++) {
      await s.request('/v1/runs/' + first.run_id)
      await new Promise(r => setTimeout(r, 25))
    }
    assert.equal(sends().length, before + 1, `${s.kind}: one automatic resend after the restart refusal`)
    const resent = sends().at(-1).body
    assert.ok(JSON.stringify(resent.input ?? resent.message).includes(input), `${s.kind}: the resend carries the owner's words`)
    for (let n = 0; n < 6; n++) { await s.request('/v1/runs/' + first.run_id); await new Promise(r => setTimeout(r, 25)) }
    assert.equal(sends().length, before + 1, `${s.kind}: no duplicate resend`)
  },
  'provider-signin-recovery': async s => {
    const input = 'Synthetic saved owner words: keep this exact message.'
    const first = await admit(s, { input, model: 'fixture-model', provider: 'anthropic' })
    const upstream = [...s.runs.values()].at(-1)
    Object.assign(upstream, { status: 'completed', output: "No Anthropic credentials found. Run 'hermes auth add anthropic' to sign in, or set ANTHROPIC_TOKEN / ANTHROPIC_API_KEY.", usage: { total_tokens: 0 } })
    const read = () => s.request('/v1/runs/' + first.run_id)
    const failed = await (await read()).json()
    assert.equal(failed.status, 'failed')
    assert.equal(failed.wizard_reconnect.provider, 'claude')
    await read() // observe the unavailable state after the failure, in this exact agent's queue
    const before = s.seen.filter(r => r.method === 'POST' && /\/(?:v1\/runs|chat\/stream)$/.test(r.path)).length
    s.signin.ready = true
    for (let i = 0; i < 4; i++) await read()
    const sends = s.seen.filter(r => r.method === 'POST' && /\/(?:v1\/runs|chat\/stream)$/.test(r.path))
    assert.equal(sends.length, before + 1, `${s.kind}: one automatic child after sign-in`)
    const retried = sends.at(-1).body
    assert.ok(JSON.stringify(retried.input ?? retried.message).includes(input))
    assert.equal(retried.model, 'fixture-model')
    if (s.kind !== 'main') assert.equal(retried.require_model_lock, true)
    if (s.kind !== 'main') assert.equal(retried.provider, undefined, 'display account id never overrides routed transport')
    for (let i = 0; i < 4; i++) await read()
    assert.equal(s.seen.filter(r => r.method === 'POST' && /\/(?:v1\/runs|chat\/stream)$/.test(r.path)).length, sends.length)
    // A model picker opened before recovery cannot acknowledge the existing
    // automatic child as a retry on the owner's newly selected route.
    const race = await s.request('/v1/runs', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({session_id:'wizard_parity',input:'untrusted preview',wizard_retry_run_id:first.run_id,model:'fixture-other',provider:'anthropic'}) })
    assert.equal(race.status, 412, `${s.kind}: mismatched recovered route must fail visibly`)
    if (s.kind === 'main') assert.equal((await race.json()).error.code, 'saved_retry_route_changed')
    assert.equal(s.seen.filter(r => r.method === 'POST' && /\/(?:v1\/runs|chat\/stream)$/.test(r.path)).length, sends.length, 'race never dispatches a second request')
  },
  // Issue 615: stock Hermes v0.23 fails a turn with no usable AI sign-in as status failed, no error, no runtime and
  // only its translated no_credentials copy as output. The thread must name the sign-in (Claude, from the send's
  // route) on the run, the full row and the compact row, not fall back to a plain Needs retry.
  'provider-no-credentials-copy': async s => {
    const first = await admit(s, { input: 'Synthetic owner words sent while signed out.', model: 'fixture-model', provider: 'anthropic' })
    s.sessions.get('wizard_parity').hidden = false
    const upstream = [...s.runs.values()].at(-1)
    delete upstream.runtime; delete upstream.error
    Object.assign(upstream, { status: 'failed', updated_at: Date.now() / 1000, usage: {},
      output: "\u26a0\ufe0f Ich konnte keine Verbindung zum KI-Modelldienst herstellen, daher wurde diese Nachricht nicht verarbeitet. Verwenden Sie /login, um sich erneut anzumelden, oder /model, um ein anderes Modell zu wählen. Falls es weiterhin fehlschlägt, führen Sie `hermes doctor` auf dem Host aus." })
    const read = await (await s.request('/v1/runs/' + first.run_id)).json()
    assert.equal(read.status, 'failed', `${s.kind}: the run reads failed`)
    const find = async (view) => {
      for (let n = 0; n < 40; n++) {
        const item = (await (await s.request('/api/sessions' + view)).json()).data.find(x => x.id === 'wizard_parity')
        if (item?.status === 'failed' && (view ? item.runError : item.wizard_last_run_error)) return item
        await new Promise(r => setTimeout(r, 25))
      }
      assert.fail(`${s.kind}: the failed run lists with a reason (${view || 'full'})`)
    }
    const full = await find(''), list = await find('?view=list')
    assert.deepEqual({ code: full.wizard_last_run_error.code, provider: full.wizard_last_run_error.provider }, { code: 'provider_auth', provider: 'anthropic' }, `${s.kind}: full row reason`)
    assert.deepEqual({ code: list.runError.code, provider: list.runError.provider }, { code: 'provider_auth', provider: 'anthropic' }, `${s.kind}: compact row reason`)
    if (s.kind === 'main') {
      assert.equal(full.wizard_reconnect?.app_id, 'wizard-claude', 'main: full row names the Claude app')
      assert.equal(list.reconnect?.appId ?? list.reconnect?.app_id, 'wizard-claude', 'main: compact row names the Claude app')
      // The open thread's detail read replaces the row's sign-in state in the shell: it must carry it too.
      const detail = await (await s.request('/api/sessions/wizard_parity?view=detail')).json()
      const row = detail.session || detail
      assert.equal(row.wizard_reconnect?.app_id, 'wizard-claude', 'main: the detail read names the Claude app')
      assert.equal(row.wizard_last_run_error?.code, 'provider_auth', 'main: the detail read names the reason')
    }
  },
  'claude-model-limit-saved-turn': async s => {
    const first = await admit(s, { input: 'Synthetic saved owner words for a capped Claude model.', model: 'fixture-model', provider: 'anthropic' })
    const upstream = [...s.runs.values()].at(-1)
    Object.assign(upstream, { status: 'completed', output: '⚠️ Provider authentication failed: Anthropic credentials are rate-limited for claude-sonnet-5-5; other Claude models remain available (see `hermes auth list`).', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } })
    const failed = await (await s.request('/v1/runs/' + first.run_id)).json()
    assert.equal(failed.status, 'failed', `${s.kind}: a refused send is not a completed answer`)
    assert.equal(failed.safe_error, CLAUDE_MODEL_LIMIT_SAFE_ERROR, `${s.kind}: says limit + Retry`)
    assert.equal(failed.wizard_reconnect, undefined, `${s.kind}: never a sign-in diagnosis`)
  },
  'supervisor-reporter': async s => {
    const tools = JSON.parse(readFileSync(join(s.agentHome, 'plugins/wizard-supervisor-tools/tools.json'), 'utf8'))
    assert.equal(tools.length, 6)
    assert.ok(tools.every(t => !('session_id' in t.parameters.properties) && !('agent_id' in t.parameters.properties)))
    for (const skill of ['reporter', 'supervisor']) assert.ok(readFileSync(join(s.agentHome, `skills/${skill}/SKILL.md`), 'utf8').includes(`name: ${skill}`))
    await admit(s, { input: 'Report this to supervisor and continue' })
    assert.ok(sent(s).instructions.includes(SUPERVISOR_SPELL))
    const args = { session_id: 'wizard_parity', client_report_id: 'fixture-report', title: 'Keep it plain', what_happened: 'The report used internal words.', feedback_verbatim: 'Say it plainly.', evidence: [{ type: 'thread', ref: 'wizard_parity' }], proposed_home: 'Reporter skill' }
    const refused = await s.supervisor('report', args, { Authorization: 'Bearer wrong' })
    assert.ok([401,403].includes(refused.status))
    const spoof = await s.supervisor('report', {...args, agent_id: 'other-agent'})
    assert.equal(spoof.status, 400)
    const r = await s.supervisor('report', args)
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()))
    const value = await r.json()
    assert.equal(value.report.agent_id, s.id)
    assert.equal(value.report.thread_id, 'wizard_parity')
    assert.match(value.report.run_id, /^wizardq_/)
    assert.equal(value.report.depth, 0)
    const again = await s.supervisor('report', args)
    assert.equal((await again.json()).suppressed, true)
    const unrelated = await s.supervisor('report', {...args, session_id: 'not-an-active-thread'})
    assert.equal(unrelated.status, 409)
    const workerLessons = await s.supervisor('lessons', {session_id: 'wizard_parity', query: ''})
    assert.equal(workerLessons.status, 403) // sending feedback does not grant a cross-agent reader
    if (s.kind !== 'main') {
      for (const [privacy, shared] of [['private', false], ['standard', false]]) {
        s.setSupervisorSeal(privacy, shared)
        const sealed = await s.supervisor('report', {...args, client_report_id: 'sealed'})
        assert.equal(sealed.status, 403)
        assert.match((await sealed.json()).error, /privacy-seal exemption/)
        const lessons = await s.supervisor('lessons', {session_id: 'wizard_parity', query: ''})
        assert.equal(lessons.status, 403)
      }
    }
  },
  'owner-thread-agent-write-guard': async s => {
    const before = s.seen.filter(r => r.method === 'POST').length
    for (const input of ['  [Agent-to-agent test] ping', '[Agent-to-agent follow-up] ping', 'Clearance request, NOT a James message']) {
      for (const path of ['/v1/runs', '/v1/runs/guard-test/steer', '/api/sessions/wizard_parity/chat', '/api/sessions/wizard_parity/chat/stream']) {
        const response = await s.request(path, post({ session_id: 'wizard_parity', input, message: input }))
        assert.equal(response.status, 409, path)
        assert.equal((await response.json()).error.code, 'agent_to_agent_thread_write')
      }
    }
    const noContentType = await s.request('/v1/runs', { method: 'POST', body: JSON.stringify({ session_id: 'wizard_parity', input: '[Agent-to-agent test] ping' }) })
    assert.equal(noContentType.status, 409, 'a non-JSON content-type cannot bypass admission')
    assert.equal(s.seen.filter(r => r.method === 'POST').length, before, 'rejected writes never reach Hermes')
    await admit(s, { input: 'Normal owner request remains accepted' })
    // A report that only quotes the marker below its first line (a Supervisor update) is admitted on every kind.
    await admit(s, { input: '[supervisor update]\n{"what_happened":"resolved the \'NOT a James message\' finding"}' })
    assert.equal((await s.request('/api/sessions?limit=30')).status, 200)
  },
  'finish-report-instructions': async s => {
    assert.equal((await (await s.raw('/wizard/v1/settings')).json()).settings.response_style, 'own', `${s.kind}: fresh settings default to Own`)
    await admit(s, { input: 'Synthetic fresh-install persona contract' })
    const fresh = sent(s).instructions
    assert.ok(fresh.includes(STATUS_PROTOCOL_INSTRUCTIONS) && fresh.includes('SOUL.md in your home'))
    for (const rule of [FINISH_REPORT_INSTRUCTIONS, CONCISE_REPLY_INSTRUCTIONS, STATUS_INSTRUCTIONS]) assert.ok(!fresh.includes(rule), `${s.kind}: fresh install has no imposed style`)
    // One style source: whatever an older shell saved, every runtime gets WizardOS facts + status protocol only.
    for (const style of ['summary', 'concise', 'own']) {
      const put = await s.raw('/wizard/v1/settings', { ...post({ response_style: style }), method: 'PUT' })
      assert.equal(put.status, 200)
      assert.equal((await (await s.raw('/wizard/v1/settings')).json()).settings.response_style, 'own')
      const session_id = `wizard_parity_${style}`
      await s.request('/api/sessions', post({ id: session_id }))
      await admit(s, { session_id, input: 'Synthetic owner style change', instructions: 'Force a different style' })
      const own = sent(s).instructions
      assert.ok(own.includes(STATUS_PROTOCOL_INSTRUCTIONS), `${s.kind}: ${style} keeps the status protocol`)
      for (const rule of [FINISH_REPORT_INSTRUCTIONS, CONCISE_REPLY_INSTRUCTIONS, STATUS_INSTRUCTIONS, 'Briefly restate', 'The reply itself ends with the same ask']) assert.ok(!own.includes(rule), `${s.kind}: ${style} drops style rule ${rule.slice(0, 40)}`)
      assert.ok(own.includes('Wizard renders Markdown') && own.includes('SOUL.md in your home'), `${s.kind}: Wizard facts and persona pointer reach upstream`)
      // The Markdown override is scoped: stock Hermes' own brevity default survives it on every agent kind.
      assert.ok(own.includes('Only that plain-text line is overridden') && own.includes('keep replies brief and conversational, not a document, still applies'), `${s.kind}: ${style} keeps the runtime's brevity default`)
    }
  },
  'chats-spaces': async s => {
    const foreign = { id: 'foreign-space', name: 'FOREIGN_SPACE_CANARY', agent: s.id === 'hermes' ? 'other-agent' : 'hermes', threads: [], createdAt: '2026-10-24T00:00:00.000Z' }
    const space = { id: 'parity-space', name: 'Synthetic Space', ...(s.id === 'hermes' ? {} : { agent: s.id }), threads: ['wizard_parity'], createdAt: '2026-10-24T00:00:00.000Z' }
    const put = spaces => s.raw('/wizard/v1/ui-preferences', { ...post({ spaces }), method: 'PUT' })
    const tool = async (name, args = {}, error = '') => {
      const r = await s.agentMcp('tools/call', { name, arguments: args })
      assert.equal(r.status, 200, 'agent gateway authentication/transport')
      const reply = (await r.json()).result
      if (error) { assert.equal(reply.isError, true); assert.equal(reply.content[0].text, error); return }
      assert.notEqual(reply.isError, true, JSON.stringify(reply))
      return JSON.parse(reply.content[0].text)
    }
    assert.equal((await put([space, foreign])).status, 200)
    const listed = await s.agentMcp('tools/list')
    assert.equal(listed.status, 200)
    const names = (await listed.json()).result.tools.map(t => t.name)
    for (const name of ['list', 'search_threads', 'create', 'add', 'remove', 'delete']) assert.ok(names.includes(`spaces_${name}`))
    assert.deepEqual((await tool('spaces_list')).spaces, [{ id: space.id, name: space.name, count: 1 }])
    const row = s.sessions.get('wizard_parity'); row.hidden = false; row.title = 'Synthetic metadata title'
    row.messages.push({ role: 'assistant', timestamp: Date.now() / 1000, content: 'CONTENT_CANARY\n[WIZARD_STATUS_V1]{"state":"done","ask":"Synthetic","subject":"ParitySubjectOnly"}[/WIZARD_STATUS_V1]' })
    const found = await tool('spaces_search_threads', { query: 'ParitySubjectOnly' })
    assert.deepEqual(found.threads.map(t => t.id), ['wizard_parity'])
    assert.equal(found.threads[0].subject, 'ParitySubjectOnly')
    assert.ok(!JSON.stringify(found).includes('CONTENT_CANARY'))
    const created = (await tool('spaces_create', { name: 'Gateway Space' })).space
    assert.equal((await tool('spaces_create', { name: 'Gateway Space' })).space.id, created.id)
    // wizard-ux issue 1580: with Channels forced off on the box (WIZARD_CHANNEL_STORE=0, classic Spaces) an agent's new
    // Space keeps its name exactly as given.
    const plain = (await tool('spaces_create', { name: 'Money' })).space
    assert.equal(plain.name, 'Money', `${s.kind}: no emoji added with Channels off`)
    await tool('spaces_delete', { space_id: plain.id })
    for (const name of ['spaces_add', 'spaces_remove', 'spaces_delete']) {
      const args = name === 'spaces_delete' ? {} : { thread_ids: ['wizard_parity'] }
      await tool(name, { space_id: foreign.id, ...args }, 'not_found')
      await tool(name, { space_id: 'missing-space', ...args }, 'not_found')
    }
    for (let i = 0; i < 2; i++) assert.equal((await tool('spaces_add', { space_id: created.id, thread_ids: ['wizard_parity', 'wizard_parity'] })).space.count, 1)
    // One Space per chat: adding moved it out of parity-space.
    assert.equal((await tool('spaces_list')).spaces.find(x => x.id === space.id).count, 0, 'spaces_add moves, never a second Space')
    // A full PUT (older shell) naming it in two of this agent's Spaces keeps one: the newly joined one.
    const full = (await (await s.raw('/wizard/v1/ui-preferences')).json()).spaces
    assert.equal((await put(full.map(x => x.id === space.id ? { ...x, threads: ['wizard_parity'] } : x))).status, 200)
    const counts = Object.fromEntries((await tool('spaces_list')).spaces.map(x => [x.id, x.count]))
    assert.deepEqual([counts[space.id], counts[created.id]], [1, 0], 'PUT cannot leave a chat in two Spaces')
    await tool('spaces_remove', { space_id: space.id, thread_ids: ['wizard_parity'] })
    for (let i = 0; i < 2; i++) assert.equal((await tool('spaces_remove', { space_id: created.id, thread_ids: ['wizard_parity'] })).space.count, 0)
    const run = await admit(s, { input: 'Synthetic Space fill' })
    assert.ok(sent(s).instructions.includes(`"id":"${created.id}"`), 'run note includes own Space catalogue')
    assert.ok(!sent(s).instructions.includes('FOREIGN_SPACE_CANARY'))
    Object.assign([...s.runs.values()].at(-1), { status: 'completed', updated_at: Date.now() / 1000, output: `Synthetic reply\n[WIZARD_STATUS_V1]${JSON.stringify({ state: 'done', ask: 'Filed', space: created.id })}[/WIZARD_STATUS_V1]` })
    assert.equal((await s.request(`/v1/runs/${run.run_id}`)).status, 200)
    assert.equal((await tool('spaces_list')).spaces.find(x => x.id === created.id).count, 1, 'status-line Space filing')
    await s.restart()
    assert.equal((await tool('spaces_list')).spaces.find(x => x.id === created.id).count, 1, 'durable agent-scoped membership')
    await tool('spaces_delete', { space_id: created.id })
    assert.deepEqual((await (await s.raw('/wizard/v1/ui-preferences')).json()).spaces, [{ ...space, threads: [] }, foreign])
    assert.equal((await put([])).status, 200)
    assert.ok(s.sessions.has('wizard_parity'), 'removing a Space does not delete its threads')
  },
  // Issue 471 (WIZARD_CHANNEL_READ_SYNC=1 with the store): each channel's read point, shared by the owner's devices.
  'chats-read-marks': async s => {
    const put = at => s.raw('/wizard/v1/channels/read', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at }) })
    const read = async () => (await (await s.raw('/wizard/v1/channels/read')).json()).at
    const channel = await (await s.raw('/wizard/v1/channels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Synthetic read channel', agent: s.id }) })).json()
    const own = `${s.id}|${channel.id}`, general = `general|${s.id}`, t = Date.now() - 60_000
    assert.deepEqual(await read(), {}, 'nothing read yet')
    assert.equal((await put({ [own]: t, [general]: t })).status, 200)
    assert.equal((await put({ [own]: t - 30_000, general: t - 1 })).status, 200, 'a device that read less writes an older mark')
    assert.deepEqual(await read(), { [own]: t, [general]: t, general: t - 1 }, 'an older mark never moves a channel back')
    assert.equal((await put({ [`${s.id}|Not-A-Channel`]: t })).status, 400)
    await s.restart()
    assert.equal((await read())[own], t, 'durable across a restart')
  },
  // Issue 549: the agent inbox. One record per background task, captured as running before its worker starts and
  // updated from every finished run on its thread (status line, no status line, a killed worker), through each
  // runtime's real Service routes; the record survives a restart.
  'agent-inbox': async s => {
    const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const record = async id => { const r = await s.raw(`/wizard/v1/agent-inbox/${id}`); assert.equal(r.status, 200); return (await r.json()).record }
    const settle = async (id, want, label) => {
      let last
      for (let n = 0; n < 40; n++) { last = await record(id); if (want(last)) return last; await new Promise(r => setTimeout(r, 25)) }
      assert.fail(`${label}: ${JSON.stringify(last)}`)
    }
    const finish = async (id, status, output) => {
      Object.assign([...s.runs.values()].at(-1), { status, updated_at: Date.now() / 1000, output })
      assert.equal((await s.request(`/v1/runs/${id}`)).status, 200)
    }
    const line = value => `Synthetic reply\n[WIZARD_STATUS_V1]${JSON.stringify(value)}[/WIZARD_STATUS_V1]`
    const listed = await s.raw('/wizard/v1/agent-inbox')
    assert.equal(listed.status, 200)
    assert.deepEqual((await listed.json()).records, [], 'a fresh inbox is empty')
    const captured = await s.raw('/wizard/v1/agent-inbox', json('POST', { agent: s.id, thread_id: 'wizard_parity', title: 'Synthetic task', ask: 'Synthetic background ask' }))
    assert.equal(captured.status, 201)
    const { record: made } = await captured.json()
    assert.equal(made.state, 'running', 'capture writes the record before the worker starts')
    const again = await s.raw('/wizard/v1/agent-inbox', json('POST', { agent: s.id, thread_id: 'wizard_parity', title: 'Synthetic task', ask: 'Synthetic background ask' }))
    assert.equal(again.status, 200)
    assert.equal((await again.json()).record.id, made.id, 'the same ask never makes a second record')
    let run = await admit(s, { input: 'Synthetic worker turn' })
    await finish(run.run_id, 'completed', line({ state: 'needs_you', ask: 'Two synthetic options. Reply a or b', recommendation: 'Pick a.', options: { a: 'Go with option a.', b: 'Go with option b.' }, default_option: 'a', confirm: true }))
    const needs = await settle(made.id, r => r.kind === 'needs_you', 'needs_you maps to new/needs_you')
    assert.deepEqual([needs.state, needs.last_update, needs.recommendation, needs.options.a, needs.default_option, needs.confirm], ['new', 'Two synthetic options. Reply a or b', 'Pick a.', 'Go with option a.', 'a', true])
    run = await admit(s, { input: 'Synthetic worker turn two' })
    await finish(run.run_id, 'completed', line({ state: 'done', ask: 'Synthetic task finished' }))
    await settle(made.id, r => r.kind === 'result' && r.last_update === 'Synthetic task finished', 'done maps to new/result')
    run = await admit(s, { input: 'Synthetic worker turn three' })
    await finish(run.run_id, 'completed', 'Synthetic reply with no status line')
    await settle(made.id, r => r.last_update === 'Finished without a summary. Open it to read.', 'no status line still finishes the record')
    run = await admit(s, { input: 'Synthetic worker turn four' })
    await finish(run.run_id, 'completed', line({ state: 'fyi', ask: 'Synthetic note for later' }))
    await settle(made.id, r => r.kind === 'fyi' && r.last_update === 'Synthetic note for later', 'a final fyi is an FYI record')
    run = await admit(s, { input: 'Synthetic worker turn five' })
    await finish(run.run_id, 'failed', '')
    await settle(made.id, r => r.kind === 'result' && r.last_update === 'Finished without a summary. Open it to read.', 'a killed worker still finishes the record')
    assert.equal((await (await s.raw('/wizard/v1/agent-inbox')).json()).records.length, 1, 'every update lands on the one record')
    assert.equal((await s.raw(`/wizard/v1/agent-inbox/${made.id}`, json('PATCH', { action: 'archive' }))).status, 200)
    await s.restart()
    assert.equal((await record(made.id)).state, 'archived', 'durable across a restart')
  },
  // Issue 552: alert rules. Through this kind's Service routes: owner rules, rule hits reach Alerts, non-urgent events
  // wait for the sweep, a borderline event goes to a private fake model on a local port (decision logged), the two
  // feedback taps each add one example, and the 4th alert of the day collapses and flags the rules on the next card.
  'agent-alerts': async s => {
    const { createServer } = await import('node:http')
    const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    let asked = 0
    const fake = createServer((req, res) => { req.resume(); req.on('end', () => { asked++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: '{"urgent": true, "reason": "Synthetic person waiting today"}' } }] })) }) })
    await new Promise(r => fake.listen(0, '127.0.0.1', r))
    try {
      const settingsPath = join(s.root, 'os', 'settings.json')
      const current = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {}
      mkdirSync(dirname(settingsPath), { recursive: true })
      writeFileSync(settingsPath, JSON.stringify({ ...current, fast_router: { endpoint: `http://127.0.0.1:${fake.address().port}/v1/chat/completions`, model: 'fixture-private' } }))
      const put = await s.raw('/wizard/v1/agent-inbox/rules', json('PUT', { senders: ['loud@example.test'] }))
      assert.equal(put.status, 200)
      assert.deepEqual((await put.json()).rules.senders, ['loud@example.test'])
      const event = async body => { const r = await s.raw('/wizard/v1/agent-inbox/events', json('POST', { agent: s.id, ...body })); assert.equal(r.status, 201, JSON.stringify(body)); return r.json() }
      let n = 0
      const mail = extra => ({ type: 'mail', source: { app: 'wizard-mail', item: `m${++n}` }, sender: `quiet${n}@example.test`, title: `Synthetic mail ${n}`, ask: `Synthetic body ${n}`, ...extra })
      const hit = await event(mail({ sender: 'Synthetic <loud@example.test>' }))
      assert.deepEqual([hit.record.kind, hit.record.state, hit.decision.rule], ['alert', 'new', 'sender'], 'a named sender reaches Alerts')
      const paid = await event({ type: 'payment_failed', source: { app: 'wizard-money', item: 'p1' }, title: 'Synthetic payment failed' })
      assert.equal(paid.record.kind, 'alert', 'payment failed reaches Alerts')
      const quiet = []
      for (let i = 0; i < 4; i++) quiet.push(await event(mail()))
      assert.ok(quiet.every(q => q.record.kind === 'fyi' && q.record.state === 'new'), 'non-urgent events wait for the sweep')
      assert.equal(asked, 0, 'no model call for clear cases')
      const border = await event(mail({ ask: 'Synthetic invoice due today', severity: 'high' }))
      assert.deepEqual([border.record.kind, border.decision.stage, border.decision.rule], ['alert', 'model', 'model'], 'a borderline event is decided by the private model')
      assert.equal(asked, 1)
      const log = (await (await s.raw('/wizard/v1/agent-inbox/alert-log')).json()).log
      assert.equal(log[0].record_id, border.record.id)
      assert.equal(log[0].reason, 'Synthetic person waiting today', 'the model decision is logged')
      const nu = await s.raw(`/wizard/v1/agent-inbox/${paid.record.id}`, json('PATCH', { action: 'not_urgent' }))
      assert.equal(nu.status, 200)
      const nuBody = await nu.json()
      assert.deepEqual([nuBody.record.kind, nuBody.examples.not_urgent], ['fyi', 1], 'Not urgent adds one example and moves the alert to the sweep')
      const sa = await (await s.raw(`/wizard/v1/agent-inbox/${quiet[0].record.id}`, json('PATCH', { action: 'should_alert' }))).json()
      assert.equal(sa.examples.should_alert, 1, 'Should have alerted adds one example')
      // A router that is not private (whatever its account label says) is never called, general events included.
      writeFileSync(settingsPath, JSON.stringify({ ...current, fast_router: { account: 'tinfoil', endpoint: 'https://api.openai.example/v1/chat/completions', model: 'fixture-cloud' } }))
      const cloud = await event(mail({ ask: 'Synthetic invoice due today', severity: 'high', privacy_class: 'general' }))
      assert.deepEqual([cloud.record.kind, cloud.decision.rule], ['fyi', 'no_private_model'], 'a non-private router never decides, general events included')
      assert.equal(asked, 1, 'no call to the non-private router')
      // Three alerts today so far (sender, payment, model): the 4th collapses.
      const fourth = await event(mail({ sender: 'loud@example.test' }))
      assert.equal(fourth.record.kind, 'fyi', 'the 4th alert of the day waits in the sweep')
      const alerts = (await (await s.raw('/wizard/v1/agent-inbox?kind=alert')).json()).records
      assert.equal(alerts.filter(r => r.alert_collapsed).length, 1, 'one collapsed alert')
      const swept = await s.raw('/wizard/v1/agent-inbox/sweep', json('POST', {}))
      if (swept.status === 201) assert.equal((await swept.json()).card.rules_flag.cap, 3, 'the next sweep flags the rules')
      else assert.equal(swept.status, 409, 'no Daily in this scene: the flag waits for the next sweep')
    } finally { await new Promise(r => fake.close(r)) }
  },
  // Issue 551: the orb's dump route. A new task said to the orb comes back as route dump with its record already
  // written (state running); the Service then makes a hidden worker thread on the main agent and admits its turn on
  // the durable queue (key wizard-inbox-<record id>). The thread never lists. A question, or a shell that does not ask
  // for dumps, routes exactly as before. On every other kind the orb's main agent is not in the scene, so the worker
  // cannot start: the record must then wait on the owner (never lost) and nothing reaches this kind's runtime.
  'orb-dump': async s => {
    const { createServer } = await import('node:http')
    let reply = { route: 'agent', summary: 'x' }
    const fake = createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] })) }) })
    await new Promise(r => fake.listen(0, '127.0.0.1', r))
    try {
      const settingsPath = join(s.root, 'os', 'settings.json')
      const current = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {}
      mkdirSync(dirname(settingsPath), { recursive: true })
      writeFileSync(settingsPath, JSON.stringify({ ...current, fast_router: { endpoint: `http://127.0.0.1:${fake.address().port}/v1/chat/completions`, model: 'fixture-router' } }))
      const say = (text, extra = {}) => s.raw('/wizard/v1/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, timezone: 'UTC', ...extra }) })
      const records = async () => (await (await s.raw('/wizard/v1/agent-inbox')).json()).records
      const runsBefore = s.seen.filter(r => r.method === 'POST' && r.path.endsWith('/v1/runs')).length
      // No accept_dump (today's shell): exactly today's routing, nothing captured.
      let r = await say('Research flights to Lisbon by Friday')
      assert.equal(r.status, 200)
      assert.deepEqual((await r.json()).cmd, { route: 'agent', summary: 'x' }, 'a shell that does not ask for dumps routes as before')
      assert.deepEqual(await records(), [], 'no record without the dump route')
      // A short direct question stays visible even when the model says dump.
      reply = { route: 'dump', title: 'Tokyo time' }
      r = await say('What time is it in Tokyo?', { accept_dump: true })
      assert.equal((await r.json()).cmd.route, 'agent', 'a short direct question keeps a visible thread')
      reply = { route: 'agent', summary: 'flights' }
      r = await say('Research flights to Lisbon by Friday', { accept_dump: true })
      assert.equal(r.status, 200)
      const { cmd } = await r.json()
      assert.equal(cmd.route, 'dump', 'a new task request routes to dump')
      assert.match(cmd.record_id, /^inbox_[a-f0-9]{24}$/u)
      assert.match(cmd.thread_id, /^wizard_\d{13}_[0-9a-f]{12}$/u)
      const record = async () => (await (await s.raw(`/wizard/v1/agent-inbox/${cmd.record_id}`)).json()).record
      const made = await record()
      assert.equal(made.thread_id, cmd.thread_id)
      assert.ok(made.deadline && made.deadline.endsWith('T23:59:00.000Z'), 'the deadline the words carry is on the record')
      assert.equal(made.privacy_class, 'private')
      const settle = async (ok, label) => {
        for (let n = 0; n < 80; n++) { const got = await ok(); if (got) return got; await new Promise(r => setTimeout(r, 25)) }
        assert.fail(label)
      }
      if (s.kind !== 'main') {
        const waiting = await settle(async () => { const got = await record(); return got.state === 'new' ? got : null }, 'a worker that cannot start leaves the record waiting')
        assert.deepEqual([waiting.kind, waiting.last_update], ['needs_you', 'Could not start this task. Open it or say it again.'])
        const retried = (await (await say('Research flights to Lisbon by Friday', { accept_dump: true })).json()).cmd
        assert.deepEqual([retried.record_id, retried.restarted], [cmd.record_id, true], 'saying it again starts the same task again')
        await settle(async () => { const got = await record(); return got.state === 'new' && got.kind === 'needs_you' ? got : null }, 'the retry that cannot start waits again')
        assert.equal(s.seen.filter(r => r.method === 'POST' && r.path.endsWith('/v1/runs')).length, runsBefore, `${s.kind}: nothing reaches this kind's runtime`)
        return
      }
      const worker = await settle(() => s.seen.find(r => r.method === 'POST' && r.path.endsWith('/v1/runs') && r.body?.session_id === cmd.thread_id), 'the worker turn is admitted')
      assert.equal(worker.headers['idempotency-key'], `wizard-inbox-${cmd.record_id}`, 'the worker run carries the inbox key the nightly check counts')
      assert.equal(s.sessions.get(cmd.thread_id)?.hidden, true, 'the worker thread is hidden')
      assert.ok(String(worker.body.instructions || '').includes('Background task: the owner handed you this by voice'), 'the worker is told nobody is watching')
      assert.equal((await record()).state, 'running', 'the record is running while the worker works')
      const listed = await (await s.request('/api/sessions?view=list&limit=100')).json()
      assert.ok(!(listed.data || []).some(x => x.id === cmd.thread_id), 'no new visible thread in the chat list')
      // The same words again the same day are one task: same record, no second worker.
      const again = (await (await say('Research flights to Lisbon by Friday', { accept_dump: true })).json()).cmd
      assert.deepEqual([again.record_id, again.created], [cmd.record_id, false])
      await new Promise(r => setTimeout(r, 100))
      assert.equal(s.seen.filter(r => r.method === 'POST' && r.path.endsWith('/v1/runs') && r.body?.session_id === cmd.thread_id).length, 1, 'no second worker')
      // The worker's finish lands on the record.
      const run = [...s.runs.values()].find(x => x.session_id === cmd.thread_id)
      Object.assign(run, { status: 'completed', updated_at: Date.now() / 1000, output: `Found three.\n[WIZARD_STATUS_V1]${JSON.stringify({ state: 'done', ask: 'Three Lisbon flights found' })}[/WIZARD_STATUS_V1]` })
      assert.equal((await s.request(`/v1/runs/${run.run_id}`)).status, 200)
      await settle(async () => { const got = await record(); return got.kind === 'result' && got.last_update === 'Three Lisbon flights found' ? got : null }, 'the finished worker updates the record')
      // Issue 1569: the hidden thread still opens from any link (read by id), and stays out of the list while read.
      const opened = await s.request(`/api/sessions/${encodeURIComponent(cmd.thread_id)}/messages?view=wizard`)
      assert.equal(opened.status, 200, 'a hidden worker thread reads by id')
      assert.ok(JSON.stringify(await opened.json()).includes('Research flights to Lisbon by Friday'), 'its messages come back')
      assert.equal(s.sessions.get(cmd.thread_id)?.hidden, true, 'reading it does not unhide it')
      // A thread the owner typed in is his chat: it lists again and is never hidden after that.
      const typed = await s.request('/v1/runs', post({ session_id: cmd.thread_id, input: 'Also check Porto' }))
      assert.equal(typed.status, 202, 'the owner can write in a hidden worker thread')
      await settle(() => s.sessions.get(cmd.thread_id)?.hidden === false, 'the owner typing in the worker thread shows it again')
      const shown = await settle(async () => { const l = await (await s.request('/api/sessions?view=list&limit=100')).json(); return (l.data || []).some(x => x.id === cmd.thread_id) ? l : null }, 'the thread lists once the owner typed in it')
      assert.ok(shown)
      assert.ok((await record()).owner_turn_at > 0, 'the record remembers the owner typed in it')
      // Typing while a hidden worker still runs (a steer of its turn) shows the thread again too.
      reply = { route: 'agent', summary: 'table' }
      const second = (await (await say('Book a table for Saturday night', { accept_dump: true })).json()).cmd
      assert.equal(second.route, 'dump')
      await settle(() => s.sessions.get(second.thread_id)?.hidden === true, 'the second worker thread is hidden')
      const queue = new DatabaseSync(join(s.root, 'queue.sqlite3'), { readOnly: true })
      let publicRun
      try { publicRun = await settle(() => queue.prepare('SELECT public_run_id FROM wizard_run_queue WHERE idempotency_key = ?').get(`wizard-inbox-${second.record_id}`)?.public_run_id, 'the worker turn is on the queue') }
      finally { queue.close() }
      // (a turn still launching answers 409 until it runs, as the shell's own steer retry sees)
      await settle(async () => [200, 202].includes((await s.request(`/v1/runs/${encodeURIComponent(publicRun)}/steer`, post({ input: 'Make it 8 pm' }))).status), 'the owner can steer the hidden worker')
      await settle(() => s.sessions.get(second.thread_id)?.hidden === false, 'the owner steering the worker shows its thread again')
    } finally { await new Promise(r => fake.close(r)) }
  },
  // Wizard-ux issue 1570: Open (a hidden worker thread moves into the chat list) and Send to inbox (a visible thread
  // moves into the background), each tap one route example for the orb router. Main agent only: a routed thread is
  // refused, never half moved.
  'agent-inbox-move': async s => {
    const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const examples = () => { const f = join(s.root, 'agent-inbox.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).route_examples || [] : [] }
    const routed = await s.raw('/wizard/v1/agent-inbox/send', json({ thread_id: 'wizard_parity', agent: s.id === 'hermes' ? 'research' : s.id }))
    assert.deepEqual([routed.status, (await routed.json()).error], [409, 'main_only'], `${s.kind}: a routed agent's thread is refused`)
    if (s.kind !== 'main') {
      // The orb's main agent is not in this scene: its thread cannot be found, and nothing is written.
      const none = await s.raw('/wizard/v1/agent-inbox/send', json({ thread_id: 'wizard_parity' }))
      assert.notEqual(none.status, 200, `${s.kind}: no main thread to move`)
      assert.deepEqual((await (await s.raw('/wizard/v1/agent-inbox')).json()).records, [], `${s.kind}: no record`)
      assert.deepEqual(examples(), [], `${s.kind}: no example`)
      return
    }
    const listed = async () => ((await (await s.request('/api/sessions?view=list&limit=100')).json()).data || []).some(x => x.id === 'wizard_parity')
    const settle = async (want, label) => { for (let n = 0; n < 80; n++) { if (await listed() === want) return; await new Promise(r => setTimeout(r, 50)) } assert.fail(label) }
    const thread = s.sessions.get('wizard_parity')
    thread.hidden = false
    // A row only lists with an owner message in it.
    if (!thread.messages.some(m => m.role === 'user')) thread.messages.push({ id: 'move-user-1', role: 'user', timestamp: Date.now() / 1000, content: 'Synthetic quarterly numbers' })
    await settle(true, 'the visible thread lists before it is sent')
    // A thread pinned through the box's ui-preferences stays in Chats.
    const prefs = (op) => s.raw('/wizard/v1/ui-preferences', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ops: [{ op, key: 'pinnedChats', item: 'wizard_parity' }] }) })
    assert.equal((await prefs('add')).status, 200)
    const pinned = await s.raw('/wizard/v1/agent-inbox/send', json({ thread_id: 'wizard_parity' }))
    assert.deepEqual([pinned.status, (await pinned.json()).error], [409, 'pinned'], 'a pinned thread cannot be sent')
    assert.equal(s.sessions.get('wizard_parity').hidden, false, 'a refused send hides nothing')
    assert.equal((await prefs('remove')).status, 200)
    // An Alerts (or Daily) thread stays in Chats too (issue 1569 review), read from the box's channel store.
    const channels = createChannelStore(join(s.root, 'os', 'channels.sqlite'))
    channels.seedAlerts()
    const alerts = channels.list({ agent: 'hermes' }).channels.find(c => c.kind === 'alerts')
    channels.move({ sessionId: 'wizard_parity', channelId: alerts.id })
    const alerted = await s.raw('/wizard/v1/agent-inbox/send', json({ thread_id: 'wizard_parity' }))
    assert.deepEqual([alerted.status, (await alerted.json()).error], [409, 'alerts_thread'], 'an Alerts thread cannot be sent')
    assert.equal(s.sessions.get('wizard_parity').hidden, false, 'a refused Alerts send hides nothing')
    channels.move({ sessionId: 'wizard_parity', channelId: null })
    const sent = await s.raw('/wizard/v1/agent-inbox/send', json({ thread_id: 'wizard_parity', utterance: 'Synthetic quarterly numbers' }))
    assert.equal(sent.status, 200, await sent.clone().text())
    const { record } = await sent.json()
    assert.equal(s.sessions.get('wizard_parity').hidden, true, 'Send to inbox hides the thread')
    assert.equal(record.worker, true, 'its record is a worker record')
    assert.ok(['running', 'new'].includes(record.state), 'its result waits for the sweep')
    await settle(false, 'a sent thread leaves the chat list')
    const opened = await s.raw('/wizard/v1/agent-inbox/open', json({ thread_id: 'wizard_parity' }))
    assert.equal(opened.status, 200, await opened.clone().text())
    assert.equal((await opened.json()).record.id, record.id)
    assert.equal(s.sessions.get('wizard_parity').hidden, false, 'Open shows the thread again')
    await settle(true, 'an opened thread lists in Chats')
    assert.deepEqual(examples().map(e => [e.utterance, e.chosen, e.wanted]), [['Synthetic quarterly numbers', 'dump', 'agent'], ['Synthetic quarterly numbers', 'agent', 'dump']], 'each tap stores one example')
  },
  // Issue 550: the signal sweep card. Built from the agent inbox, posted as the last row of today's Daily thread of
  // the main agent, and every tap posts that token's full resume message into the record's own thread (this kind's).
  // Issue 569: an app (Messenger's Agent chat) is a second door to the one agent inbox. Its own app token (the
  // delivery route's app-tokens/<id> file) opens capture, sweep, answer on its card and the door probe; a sweep from
  // the Daily and then from the app is one sweep event (same card, each item seen once).
  'app-wake-events': async s => {
    // wizard-os issue 634: an installed app's own token wakes this kind's agent with a small typed event.
    const osHome = join(s.root, 'os'), tokens = join(osHome, 'app-tokens')
    mkdirSync(tokens, { recursive: true })
    const MESSENGER = `parity-messenger-${'w'.repeat(32)}`, MAIL = `parity-mail-${'x'.repeat(32)}`
    writeFileSync(join(tokens, 'messenger'), `${MESSENGER}\n`)
    writeFileSync(join(tokens, 'wizard-mail'), `${MAIL}\n`)
    const parityQa = { id: 'parity-qa', name: 'Synthetic Parity App', view: '/parity/', agent_binding: true }
    const messenger = { id: 'messenger', name: 'Messenger', status: 'running', mcp: { url: 'http://127.0.0.1:9/mcp' } }
    const mail = { id: 'wizard-mail', name: 'Mail', status: 'running', mcp: { url: 'http://127.0.0.1:9/mcp' } }
    const grant = apps => {
      if (s.kind === 'main') return
      const file = join(osHome, 'agents', s.id, 'agent.json'), agent = JSON.parse(readFileSync(file, 'utf8'))
      agent.permissions.wizard_apps = apps
      writeFileSync(file, JSON.stringify(agent))
    }
    grant(['parity-qa', 'messenger'])
    writeFileSync(join(s.root, 'apps.json'), JSON.stringify({ schema: 1, apps: [parityQa, messenger, mail] }))
    await s.restart()
    const as = (token, method, body) => ({ method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const runs = () => s.seen.filter(r => r.method === 'POST' && r.path.endsWith('/v1/runs') && String(r.headers['idempotency-key'] || '').startsWith('wizard-wake-'))
    const until = async (read, label) => {
      let last
      for (let n = 0; n < 120; n++) { last = await read(); if (last) return last; await new Promise(r => setTimeout(r, 25)) }
      assert.fail(label)
    }
    // The probe: on, the contract, and this kind's agent among the agents Messenger may wake.
    const probe = await s.raw('/wizard/v1/agent-events', as(MESSENGER, 'GET'))
    assert.equal(probe.status, 200, await probe.clone().text())
    const probed = await probe.json()
    assert.deepEqual([probed.on, probed.contract, probed.app], [true, 'wizard.app-wake/1', 'messenger'])
    assert.ok(probed.agents.includes(s.id), `Messenger may wake ${s.id}: ${JSON.stringify(probed.agents)}`)
    // Only an app's own token: the owner's call is refused, and nothing runs.
    assert.equal((await s.raw('/wizard/v1/agent-events', { method: 'GET' })).status, 403, 'the owner is not an app')
    // The event is typed and small: no free text, no other app's name, no unknown agent.
    const event = { event: 'agent_chat', agent: s.id, data: { reason: 'note', waiting: { notes: 1, sweep_requests: 0, answers: 0 } } }
    for (const [body, status, code] of [
      [{ ...event, event: 'Agent chat!' }, 400, 'invalid_event'],
      [{ ...event, event: 'wizard-mail.inbox' }, 400, 'invalid_event'],
      [{ ...event, data: { text: 'x'.repeat(201) } }, 400, 'invalid_data'],
      [{ ...event, data: { a: { b: { c: 1 } } } }, 400, 'invalid_data'],
      [{ ...event, agent: 'nobody-here' }, 404, 'agent_not_found'],
    ]) {
      const refused = await s.raw('/wizard/v1/agent-events', as(MESSENGER, 'POST', body))
      assert.deepEqual([refused.status, (await refused.json()).error], [status, code], JSON.stringify(body))
    }
    assert.equal(runs().length, 0, 'a refused event wakes nobody')
    // A wake: one turn in a new hidden thread of this kind's agent, saying it is an app's signal.
    const woke = await s.raw('/wizard/v1/agent-events', as(MESSENGER, 'POST', event))
    assert.equal(woke.status, 202, await woke.clone().text())
    const first = await woke.json()
    assert.deepEqual([first.woken, first.event, first.agent], [true, 'messenger.agent_chat', s.id])
    const run = await until(() => runs().find(r => r.body?.session_id === first.thread_id), 'the wake turn is admitted')
    const input = String(run.body.input || '')
    assert.ok(input.startsWith('App wake: the Messenger (messenger) app sent event messenger.agent_chat {"reason":"note"'), input)
    assert.ok(input.includes('not the owner\'s words'), 'the turn says it is an app\'s signal')
    assert.equal(s.sessions.get(first.thread_id)?.hidden, true, 'the wake thread is hidden from Chats')
    // The same event again inside the window is merged, then woken once more when the window ends (never lost).
    const merged = await s.raw('/wizard/v1/agent-events', as(MESSENGER, 'POST', { ...event, data: { reason: 'sweep' } }))
    assert.deepEqual([merged.status, (await merged.json()).merged], [200, true])
    assert.equal(runs().length, 1, 'a merged event starts no second turn at once')
    const again = await until(() => runs().find(r => r.body?.session_id !== first.thread_id), 'the merged event is woken when the window ends')
    assert.ok(String(again.body.input).includes('{"reason":"sweep"}'), 'the follow-up carries the newest event')
    // An app the owner did not give this agent can't wake it (main sees every installed app).
    if (s.kind !== 'main') {
      const other = await s.raw('/wizard/v1/agent-events', as(MAIL, 'POST', { event: 'new_mail', agent: s.id }))
      assert.deepEqual([other.status, (await other.json()).error], [403, 'not_granted'])
      // A merged event waiting for its window is dropped when the app is taken away meanwhile.
      const answer = { ...event, event: 'agent_chat_answer' }
      assert.equal((await s.raw('/wizard/v1/agent-events', as(MESSENGER, 'POST', answer))).status, 202)
      assert.equal((await s.raw('/wizard/v1/agent-events', as(MESSENGER, 'POST', answer))).status, 200)
      grant(['parity-qa'])
      const revoked = await s.raw('/wizard/v1/agent-events', as(MESSENGER, 'POST', answer))
      assert.deepEqual([revoked.status, (await revoked.json()).error], [403, 'not_granted'], 'taking the app away stops its wakes at once')
      await new Promise(r => setTimeout(r, 700))
      assert.equal(runs().length, 3, 'no follow-up wake after the grant was taken away')
    } else assert.equal(runs().length, 2)
  },
  'agent-inbox-doors': async s => {
    const tokens = join(s.root, 'os', 'app-tokens')
    mkdirSync(tokens, { recursive: true })
    const MESSENGER = `parity-messenger-${'m'.repeat(32)}`
    writeFileSync(join(tokens, 'messenger'), `${MESSENGER}\n`)
    const app = (method, body) => ({ method, headers: { Authorization: `Bearer ${MESSENGER}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const line = value => `Synthetic reply\n[WIZARD_STATUS_V1]${JSON.stringify(value)}[/WIZARD_STATUS_V1]`
    const record = async id => (await (await s.raw(`/wizard/v1/agent-inbox/${id}`)).json()).record
    const until = async (read, want, label) => {
      let last
      for (let n = 0; n < 80; n++) { last = await read(); if (want(last)) return last; await new Promise(r => setTimeout(r, 25)) }
      assert.fail(`${label}: ${JSON.stringify(last)}`)
    }
    // The door probe: on, with the sweep caps.
    const probe = await s.raw('/wizard/v1/agent-inbox/doors', app('GET'))
    assert.equal(probe.status, 200, await probe.clone().text())
    assert.deepEqual(await probe.json(), { on: true, sweep_caps: { waiting: 7, done: 10 }, door: 'messenger', pings: false })
    // Pings (issue 325): a keep read consumes nothing; only the door's ack after its store does.
    assert.equal((await (await s.raw('/wizard/v1/agent-inbox/doors', app('POST', { pings: true }))).json()).pings, true)
    const paid = await s.raw('/wizard/v1/agent-inbox/events', json('POST', { agent: s.id, type: 'payment_failed', source: { app: 'wizard-money', item: 'p-door' }, title: 'Synthetic door payment failed' }))
    assert.equal(paid.status, 201, await paid.clone().text())
    const pingRead = async () => (await (await s.raw('/wizard/v1/agent-inbox/pings?keep=1', app('GET'))).json()).pings.map(p => p.id)
    const firstRead = await pingRead()
    assert.equal(firstRead.length, 1, 'the delivered alert is pending for the door')
    assert.deepEqual(await pingRead(), firstRead, 'a read without an ack hands the same ping out again')
    assert.equal((await s.raw('/wizard/v1/agent-inbox/pings', json('POST', { ack: firstRead }))).status, 403, 'only the door acks')
    const acked = await s.raw('/wizard/v1/agent-inbox/pings', app('POST', { ack: firstRead }))
    assert.deepEqual([acked.status, (await acked.json()).acked], [200, firstRead])
    assert.deepEqual(await pingRead(), [], 'an acked ping never comes again')
    // Owner-only routes stay closed to the app credential.
    for (const path of ['/wizard/v1/agent-inbox', '/wizard/v1/agent-inbox/rules', '/wizard/v1/agent-inbox/alert-log']) {
      const refused = await s.raw(path, app('GET'))
      assert.equal(refused.status, 403, `${path} refuses the app credential`)
    }
    assert.equal((await s.raw('/wizard/v1/agent-inbox', app('POST', { source: { app: 'wizard-mail', item_id: 'n1' }, text: 'Synthetic' }))).status, 403, 'an app captures only as itself')
    // A note is one record (source app messenger), deduped on the note id.
    const note = { source: { app: 'messenger', item_id: 'note_parity_1' }, text: 'Synthetic note: book the dentist next week' }
    const made = await s.raw('/wizard/v1/agent-inbox', app('POST', note))
    assert.equal(made.status, 201, await made.clone().text())
    const noted = (await made.json()).record
    assert.equal(noted.source, 'app:messenger/note_parity_1')
    assert.equal(noted.worker, true)
    const resent = await s.raw('/wizard/v1/agent-inbox', app('POST', { ...note, text: 'Synthetic note sent again' }))
    assert.deepEqual([resent.status, (await resent.json()).record.id], [200, noted.id], 'a resend returns the same record')
    if (s.kind === 'main') {
      const worker = await until(async () => s.seen.find(r => r.method === 'POST' && r.path.endsWith('/v1/runs') && r.body?.session_id === noted.thread_id), Boolean, 'the note worker is admitted')
      assert.equal(worker.headers['idempotency-key'], `wizard-inbox-${noted.id}`)
      assert.ok(String(worker.body.instructions || '').includes('as a note in the messenger app'), 'the worker is told it is a background note')
      assert.equal(s.sessions.get(noted.thread_id)?.hidden, true, 'the note worker thread is hidden')
      const run = [...s.runs.values()].find(x => x.session_id === noted.thread_id)
      Object.assign(run, { status: 'completed', updated_at: Date.now() / 1000, output: line({ state: 'done', ask: 'Synthetic dentist booked' }) })
      assert.equal((await s.request(`/v1/runs/${run.run_id}`)).status, 200)
      await until(() => record(noted.id), r => r.kind === 'result', 'the note worker finishes into the record')
    } else {
      // The main agent is not in this scene: the note waits on the owner, never lost (as the orb's dump).
      await until(() => record(noted.id), r => r.state === 'new' && r.kind === 'needs_you', 'a note whose worker cannot start waits')
    }
    // A worker on this kind's thread asks; Daily sweeps first, then Messenger: one card, seen once.
    const captured = await (await s.raw('/wizard/v1/agent-inbox', json('POST', { agent: s.id, thread_id: 'wizard_parity', title: 'Synthetic door ask', ask: 'Synthetic door ask' }))).json()
    const id = captured.record.id
    await admit(s, { input: 'Synthetic worker turn' })
    const latestRun = [...s.runs.values()].at(-1)
    Object.assign(latestRun, { status: 'completed', updated_at: Date.now() / 1000, output: line({ state: 'needs_you', ask: 'Synthetic door question. Reply yes or no',
      options: { yes: 'Yes: go ahead with the synthetic door question.', no: 'No: leave the synthetic door question.' }, default_option: 'yes' }) })
    assert.equal((await s.request(`/v1/runs/${latestRun.run_id}`)).status, 200)
    await until(() => record(id), r => r.kind === 'needs_you', 'the worker asks')
    assert.equal((await s.raw(`/wizard/v1/agent-inbox/${id}`, app('PATCH', { action: 'answer', option: 'yes' }))).status, 403, 'no answer before the door drew a card')
    const daily = await s.raw('/wizard/v1/agent-inbox/sweep', json('POST', {}))
    assert.equal(daily.status, 201, await daily.clone().text())
    const dailyCard = (await daily.json()).card
    const door = await s.raw('/wizard/v1/agent-inbox/sweep', app('POST', { door: 'messenger' }))
    assert.equal(door.status, 200, await door.clone().text())
    const doorBody = await door.json()
    assert.equal(doorBody.shared, true, 'the second door draws the same sweep event')
    const pick = c => ({ id: c.id, waiting: c.waiting.items.map(i => [i.id, i.seen]), done: c.done.items.map(i => i.id), running: c.running.count, later: c.later.count, parked: c.parked.count })
    assert.deepEqual(pick(doorBody.card), pick(dailyCard), 'the same items and counts in both doors')
    assert.ok(dailyCard.waiting.items.some(i => i.id === id && i.seen === 1))
    assert.equal((await record(id)).surfaced_count, 1, 'seen once per sweep event, not once per door')
    // An answer in Messenger resumes the same thread and shows answered on the Daily card.
    const before = s.seen.length
    const tapped = await s.raw(`/wizard/v1/agent-inbox/${id}`, app('PATCH', { action: 'answer', option: 'no' }))
    assert.equal(tapped.status, 200, await tapped.clone().text())
    const sent = await until(async () => s.seen.slice(before).filter(r => r.method === 'POST' && r.path.endsWith('/v1/runs') && r.body?.session_id === 'wizard_parity').at(-1), Boolean, 'the answer reaches the thread')
    assert.ok(JSON.stringify(sent.body.input).includes('No: leave the synthetic door question.'), 'the full resume message is posted')
    // The same tap again (a retry) answers as before and posts nothing; another answer to an answered item is refused.
    const retry = await s.raw(`/wizard/v1/agent-inbox/${id}`, app('PATCH', { action: 'answer', option: 'no' }))
    assert.equal(retry.status, 200)
    assert.equal((await retry.json()).run_id, undefined, 'a repeated tap posts nothing')
    assert.equal((await s.raw(`/wizard/v1/agent-inbox/${id}`, app('PATCH', { action: 'answer', option: 'yes' }))).status, 403, 'an answered item is not answered again from the door')
    const owner = (await (await s.raw('/wizard/v1/agent-inbox/sweep')).json()).card
    assert.deepEqual(owner.waiting.items.find(i => i.id === id), { ...owner.waiting.items.find(i => i.id === id), state: 'answered', answer: 'no' })
    for (const r of s.runs.values()) if (r.status === 'running') r.status = 'completed'
  },
  'agent-sweep': async s => {
    const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const line = value => `Synthetic reply\n[WIZARD_STATUS_V1]${JSON.stringify(value)}[/WIZARD_STATUS_V1]`
    const record = async id => (await (await s.raw(`/wizard/v1/agent-inbox/${id}`)).json()).record
    const until = async (read, want, label) => {
      let last
      for (let n = 0; n < 80; n++) { last = await read(); if (want(last)) return last; await new Promise(r => setTimeout(r, 25)) }
      assert.fail(`${label}: ${JSON.stringify(last)}`)
    }
    const finishLatest = async (status, output) => {
      const run = [...s.runs.values()].at(-1)
      Object.assign(run, { status, updated_at: Date.now() / 1000, output })
      return run
    }
    const ask = (n, extra = {}) => line({ state: 'needs_you', ask: `Synthetic question ${n}. Reply yes or no`, recommendation: `Say yes to synthetic question ${n}.`,
      options: { yes: `Yes: go ahead with synthetic question ${n} as recommended.`, no: `No: leave synthetic question ${n} alone.` }, default_option: 'yes', ...extra })
    const latestCard = async () => (await (await s.raw('/wizard/v1/agent-inbox/sweep')).json()).card
    assert.equal(await latestCard(), null, 'no card before the first sweep')
    // A task on this kind's thread that needs a sure yes (confirm): Yes to all must skip it.
    const captured = await (await s.raw('/wizard/v1/agent-inbox', json('POST', { agent: s.id, thread_id: 'wizard_parity', title: 'Synthetic send', ask: 'Synthetic send ask' }))).json()
    const id = captured.record.id
    let run = await admit(s, { input: 'Synthetic worker turn' })
    await finishLatest('completed', ask(1, { confirm: true }))
    assert.equal((await s.request(`/v1/runs/${run.run_id}`)).status, 200)
    await until(() => record(id), r => r.kind === 'needs_you' && r.confirm === true, 'the worker asks')
    const swept = await s.raw('/wizard/v1/agent-inbox/sweep', json('POST', {}))
    assert.equal(swept.status, 201, await swept.clone().text())
    const card = (await swept.json()).card
    assert.equal(card.waiting.items.length, 1)
    assert.deepEqual([card.waiting.items[0].id, card.waiting.items[0].confirm, card.waiting.items[0].options.map(o => o.token), card.waiting.items[0].seen], [id, true, ['yes', 'no'], 1])
    assert.deepEqual(card.yes_to_all, { count: 0, skipped: 1 }, 'a confirm item is never covered by Yes to all')
    assert.equal((await record(id)).state, 'surfaced')
    // The card is the last row of today's Daily thread of the main agent (main only: routed scenes run no main Hermes).
    if (s.id === 'hermes') {
      const history = async () => (await (await s.raw(`/wizard/hermes/api/sessions/${encodeURIComponent(card.thread_id)}/messages?order=oldest&limit=500&offset=0&include_compacted=true&view=wizard`)).json())
      s.sessions.get(card.thread_id)?.messages.push({ id: 'daily-synthetic-1', role: 'assistant', timestamp: Date.now() / 1000, content: 'Synthetic daily post' })
      const rows = (await history()).data
      assert.equal(rows.at(-1).id, card.id, 'the card is the last message of today\u2019s Daily thread')
      assert.equal(rows.at(-1).display_kind, 'agent_sweep')
      assert.equal(rows.at(-1).agent_sweep.waiting.items[0].id, id)
      assert.match(rows.at(-1).content, /\*\*Waiting on you\*\* \(1\)/u)
    }
    // This kind's own thread never carries the card.
    const own = await (await s.request('/api/sessions/wizard_parity/messages?order=oldest&limit=500&offset=0&view=wizard')).json()
    assert.ok(!(own.data || own.messages || []).some(r => r.display_kind === 'agent_sweep'), 'only the Daily thread shows the card')
    const yes = await s.raw(`/wizard/v1/agent-inbox/${card.id}/yes-to-all`, json('POST', {}))
    assert.equal(yes.status, 200)
    assert.deepEqual((await yes.json()).answered, [], 'Yes to all skipped the confirm item')
    // A tap posts the token's whole resume message (never a bare "yes") into this kind's thread, which resumes.
    const before = s.seen.length
    const tapped = await s.raw(`/wizard/v1/agent-inbox/${id}`, json('PATCH', { action: 'answer', option: 'yes' }))
    assert.equal(tapped.status, 200, await tapped.clone().text())
    const tap = await tapped.json()
    assert.ok(tap.run_id, 'the answer was admitted as a turn')
    assert.deepEqual([tap.record.state, tap.record.answer], ['answered', 'yes'])
    const sent = await until(async () => s.seen.slice(before).filter(r => r.method === 'POST' && r.path.endsWith('/v1/runs') && r.body?.session_id === 'wizard_parity').at(-1), Boolean, 'the answer reaches the thread')
    assert.ok(JSON.stringify(sent.body.input).includes('Yes: go ahead with synthetic question 1 as recommended.'), 'the full recommendation sentence is posted, never a bare yes')
    const again = await (await s.raw(`/wizard/v1/agent-inbox/${id}`, json('PATCH', { action: 'answer', option: 'yes' }))).json()
    assert.equal(again.run_id, undefined, 'a second tap on the same answer posts nothing')
    // The worker's next status line archives the answered record.
    await until(async () => [...s.runs.values()].at(-1)?.status === 'running' ? [...s.runs.values()].at(-1) : null, Boolean, 'the answer turn is running')
    run = await finishLatest('completed', line({ state: 'done', ask: 'Synthetic send done' }))
    assert.equal((await s.request(`/v1/runs/${tap.run_id}`)).status, 200)
    await until(() => record(id), r => r.state === 'archived', 'the answered record archives at the next status line')
    // Yes to all on a plain item: its default answer's full message goes into the thread.
    const second = await (await s.raw('/wizard/v1/agent-inbox', json('POST', { agent: s.id, thread_id: 'wizard_parity', title: 'Synthetic plain', ask: 'Synthetic plain ask' }))).json()
    run = await admit(s, { input: 'Synthetic worker turn two' })
    await finishLatest('completed', ask(2))
    assert.equal((await s.request(`/v1/runs/${run.run_id}`)).status, 200)
    await until(() => record(second.record.id), r => r.kind === 'needs_you', 'the second worker asks')
    const card2 = (await (await s.raw('/wizard/v1/agent-inbox/sweep', json('POST', {}))).json()).card
    assert.deepEqual(card2.waiting.items.map(i => i.id), [second.record.id])
    const before2 = s.seen.length
    const all = await (await s.raw(`/wizard/v1/agent-inbox/${card2.id}/yes-to-all`, json('POST', {}))).json()
    assert.deepEqual(all.answered.map(a => [a.id, a.option]), [[second.record.id, 'yes']])
    const sent2 = await until(async () => s.seen.slice(before2).filter(r => r.method === 'POST' && r.path.endsWith('/v1/runs') && r.body?.session_id === 'wizard_parity').at(-1), Boolean, 'Yes to all reaches the thread')
    assert.ok(JSON.stringify(sent2.body.input).includes('Yes: go ahead with synthetic question 2 as recommended.'))
    if (s.id === 'hermes') {
      await until(async () => [...s.runs.values()].at(-1)?.status === 'running' ? 1 : null, Boolean, 'the yes-to-all turn is running')
      await finishLatest('completed', 'Synthetic reply')
      for (const r of s.runs.values()) if (r.status === 'running') r.status = 'completed'
      // "signal sweep" typed to the main agent posts a new card and tells the turn so, once.
      const typed = await admit(s, { session_id: card2.thread_id, input: 'Signal sweep' })
      const fresh = await until(latestCard, c => c && c.id !== card2.id, 'typing signal sweep posts a card')
      assert.equal(fresh.thread_id, card2.thread_id)
      const dispatched = await until(async () => s.seen.filter(r => r.method === 'POST' && r.path.endsWith('/v1/runs') && r.body?.session_id === card2.thread_id).at(-1), Boolean, 'the turn is dispatched')
      assert.match(String(dispatched.body.instructions || ''), /Signal sweep: the owner asked for a signal sweep/u)
      assert.ok(typed.run_id || typed.id)
      // A sweep the owner scheduled (a thread:'daily' job whose prompt is the phrase) posts a card too, quietly.
      for (const r of s.runs.values()) if (r.status === 'running') r.status = 'completed'
      const job = await s.raw('/wizard/v1/schedules', post({ name: 'Parity · Synthetic sweep', prompt: 'signal sweep', agent: s.id, enabled: false, when: { every: 3600 }, kind: 'run', thread: 'daily' }))
      assert.equal(job.status, 201, await job.clone().text())
      const made = await job.json()
      assert.equal((await s.raw(`/wizard/v1/schedules/${made.id}/run`, post({}))).status, 202)
      await s.server.scheduler.tick(false)
      assert.equal(s.server.scheduler.latest(made.id).admitted, 1, s.server.scheduler.latest(made.id).error || 'admitted')
      await until(latestCard, c => c && c.id !== fresh.id, 'a scheduled sweep posts a card')
      const quiet = await until(async () => s.seen.filter(r => r.method === 'POST' && r.path.endsWith('/v1/runs') && r.body?.session_id === card2.thread_id && String(r.body?.input || '').startsWith('[Wizard schedule]')).at(-1), Boolean, 'the scheduled turn is dispatched')
      assert.match(String(quiet.body.instructions || ''), /Respond exactly \[SILENT\]/u)
      // No open Daily: the typed turn is told the card could not be posted, never that it was.
      for (const r of s.runs.values()) if (r.status === 'running') r.status = 'completed'
      const dailyId = (await (await s.raw('/wizard/v1/channels')).json()).channels.find(c => c.kind === 'daily').id
      assert.equal((await s.raw('/wizard/v1/channels', json('PATCH', { id: dailyId, archived: true }))).status, 200)
      const lastCard = (await latestCard()).id
      await admit(s, { session_id: card2.thread_id, input: 'signal sweep' })
      const refused = await until(async () => s.seen.filter(r => r.method === 'POST' && r.path.endsWith('/v1/runs') && r.body?.session_id === card2.thread_id && r.body?.input === 'signal sweep').at(-1), Boolean, 'the refused turn is dispatched')
      assert.match(String(refused.body.instructions || ''), /could not post the sweep card because there is no open Daily thread/u)
      assert.equal((await latestCard()).id, lastCard, 'no card without an open Daily')
    }
  },
  // wizard-ux issue 1258: Channels are on for everyone (the wizard/chat-channels switch is gone). With no Look file, and
  // with an old Look file that still says the switch is off, the channel store, read marks and list fields answer
  // through each runtime's real Service route.
  'chats-channels-switch': async s => {
    const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const look = on => { const dir = join(s.root, 'Pages', 'wizard-look'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'look.json'), JSON.stringify({ version: 1, skin: null, tweaks: { 'wizard/chat-channels': { on, at: Date.now() } } })) }
    const row = s.sessions.get('wizard_parity'); row.hidden = false
    row.preview = 'Synthetic switch request'
    row.messages.push({ role: 'user', timestamp: Date.now() / 1000 - 5, content: 'Synthetic switch request' })
    const item = async want => {
      let last
      for (let attempt = 0; attempt < 40; attempt++) {
        if (s.kind === 'main') await (await s.request('/api/sessions?limit=100')).json()
        last = (await (await s.request('/api/sessions?view=list')).json()).data.find(x => x.id === 'wizard_parity')
        if (last && want(last)) return last
        await new Promise(r => setTimeout(r, 25))
      }
      return last
    }
    assert.equal((await s.raw('/wizard/v1/channels')).status, 200, 'Channels are on with no Look file')
    look(false)
    const made = await s.raw('/wizard/v1/channels', json('POST', { name: 'Synthetic switch channel', agent: s.id })); assert.equal(made.status, 201, 'an old off value in the Look file is ignored')
    const own = await made.json()
    // wizard-ux issue 1580: a channel the agent creates through its own gateway gets a fitting
    // emoji in front ("Money" -> "💰 Money"), is reused rather than made twice, and a name matching nothing stays as given.
    const tool = async (name, args) => {
      const r = await s.agentMcp('tools/call', { name, arguments: args }); assert.equal(r.status, 200, 'agent gateway authentication/transport')
      const reply = (await r.json()).result; assert.notEqual(reply.isError, true, JSON.stringify(reply)); return JSON.parse(reply.content[0].text)
    }
    const money = (await tool('spaces_create', { name: 'Money' })).space
    assert.equal(money.name, '💰 Money', `${s.kind}: the agent's channel gets its emoji`)
    assert.equal((await tool('spaces_create', { name: 'Money' })).space.id, money.id, `${s.kind}: reused, never a second Money`)
    assert.equal((await tool('spaces_create', { name: 'Zzzqx' })).space.name, 'Zzzqx', `${s.kind}: no match keeps the name`)
    const stored = (await (await s.raw('/wizard/v1/channels')).json()).channels.find(c => c.id === money.id)
    assert.equal(stored?.agent, s.id, `${s.kind}: filed under the calling agent`)
    assert.equal((await s.raw('/wizard/v1/channels/membership', json('PUT', { sessionId: 'wizard_parity', channelId: own.id }))).status, 200)
    assert.equal((await s.raw('/wizard/v1/channels/read')).status, 200, 'read marks answer')
    assert.equal((await item(x => x.channel === own.id))?.channel, own.id, 'list rows carry the channel')
    // A deleted thread leaves the store too.
    assert.equal((await s.request('/api/sessions/wizard_parity', { method: 'DELETE' })).status, 200)
    const after = (await (await s.raw('/wizard/v1/channels')).json()).channels.find(c => c.id === own.id)
    assert.equal(after?.count, 0, 'the deleted thread is no longer a member')
  },
  // Issue 440 (WIZARD_CHANNEL_STORE=1): channels.sqlite through each runtime's real Service route.
  'chats-channels': async s => {
    const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const other = s.id === 'hermes' ? 'other-agent' : 'hermes'
    const row = s.sessions.get('wizard_parity'); row.hidden = false
    // Hermes' own list `preview` is the head of the first user message; main reads the whole one from state.db.
    row.preview = 'Synthetic first channel request'
    row.messages.push({ role: 'user', timestamp: Date.now() / 1000 - 5, content: 'Synthetic first channel request, in full' })
    const channels = async () => (await (await s.raw('/wizard/v1/channels')).json()).channels
    assert.deepEqual((await channels()).map(c => [c.name, c.kind, c.pinned]), [['Alerts', 'alerts', true]], 'a fresh install lists Alerts')
    const make = async (name, agent) => { const r = await s.raw('/wizard/v1/channels', json('POST', { name, agent })); assert.equal(r.status, 201); return r.json() }
    const own = await make('Synthetic channel', s.id), foreign = await make('FOREIGN_CHANNEL_CANARY', other)
    const move = async (channelId, agent) => s.raw('/wizard/v1/channels/membership', json('PUT', { sessionId: 'wizard_parity', channelId, ...(agent ? { agent } : {}) }))
    assert.equal((await move(own.id)).status, 200)
    assert.equal((await move(foreign.id, s.id)).status, 409, 'a thread files only into its own agent\'s channel')
    // Main's canonical census was seeded empty at startup: refresh it until the thread shows (as head-row-owner-write-parity).
    const listed = async (want = true) => {
      let last
      for (let attempt = 0; attempt < 40; attempt++) {
        if (s.kind === 'main') await (await s.request('/api/sessions?limit=100')).json()
        last = (await (await s.request('/api/sessions?view=list')).json()).data.find(x => x.id === 'wizard_parity')
        if (last && (!want || last.channel)) return last
        await new Promise(r => setTimeout(r, 25))
      }
      return last
    }
    const item = await listed()
    assert.equal(item.channel, own.id)
    assert.equal(item.firstRequest, s.kind === 'main' ? 'Synthetic first channel request, in full' : 'Synthetic first channel request', 'main reads state.db; routed kinds use Hermes\' first-message head')
    assert.ok(item.firstRequest.length <= 400)
    const feed = await s.request(`/api/sessions?view=list&channel=${own.id}`); assert.equal(feed.status, 200)
    const page = await feed.json()
    assert.deepEqual([page.window, page.order, page.data.map(x => x.id)], ['channel', 'oldest', ['wizard_parity']])
    // wizard-ux issue 1289: a feed keeps posts in posting order, so every row (list and feed) carries the thread's start
    // time, and a later reply moves its activity times but never its start time.
    const started = new Date(row.created_at * 1000).toISOString()
    assert.equal(item.startedAt, started, 'list rows carry the thread start time')
    assert.equal(page.data[0].startedAt, started, 'feed rows carry the thread start time')
    row.messages.push({ role: 'assistant', timestamp: Date.now() / 1000 + 60, content: 'Synthetic later reply' })
    let replied
    for (let attempt = 0; attempt < 40 && !(replied && replied.messageCount === row.messages.length); attempt++) {
      if (s.kind === 'main') await (await s.request('/api/sessions?limit=100')).json()
      replied = (await (await s.request('/api/sessions?view=list')).json()).data.find(x => x.id === 'wizard_parity')
      if (!(replied && replied.messageCount === row.messages.length)) await new Promise(r => setTimeout(r, 25))
    }
    assert.equal(replied.messageCount, row.messages.length, 'the reply reached the list')
    assert.equal(replied.startedAt, started, 'a reply never moves the start time')
    row.messages.pop()
    assert.equal(page.data[0].channel, own.id)
    assert.equal((await s.request(`/api/sessions?view=list&channel=${foreign.id}`)).status, 404, 'another agent\'s channel feed is not served here')
    assert.equal((await s.request('/api/sessions?view=list&channel=missing-channel')).status, 404)
    assert.ok(!JSON.stringify(page).includes('FOREIGN_CHANNEL_CANARY'))
    // Old shells read the projection, and a full PUT cannot erase the membership.
    assert.equal((await s.raw('/wizard/v1/ui-preferences', json('PUT', { spaces: [] }))).status, 200)
    const spaces = (await (await s.raw('/wizard/v1/ui-preferences')).json()).spaces
    assert.deepEqual(spaces.find(x => x.id === own.id).threads, ['wizard_parity'])
    await s.restart()
    assert.equal((await listed()).channel, own.id, 'durable membership')
    assert.equal((await channels()).filter(c => c.kind === 'alerts').length, 1, 'a restart adds no second Alerts')
    // Routed archived threads have no Hermes preview; their post text comes from the agent's own state.db.
    // (Main reads every row's first request from its state.db already.)
    if (s.kind !== 'main') {
      row.archived = true; row.preview = ''
      const archivedFeed = await (await s.request(`/api/sessions?view=list&channel=${own.id}`)).json()
      assert.deepEqual(archivedFeed.data.map(x => [x.id, x.archived]), [['wizard_parity', true]], 'the feed keeps archived posts')
      assert.equal(archivedFeed.data[0].firstRequest, 'Synthetic first channel request, in full', 'archived post text')
      row.archived = false; row.preview = 'Synthetic first channel request'
    }
    if (s.kind === 'main') {
      // The first request passes the same fail-closed credential scan as every other list field.
      row.messages.unshift({ role: 'user', timestamp: 1, content: 'Synthetic parity-main-secret request' })
      assert.equal((await s.request('/api/sessions?view=list')).status, 502)
      row.messages.shift()
    }
    assert.equal((await move(null, s.id)).status, 200)
    assert.equal((await listed(false)).channel, undefined)
  },
  // Issue 441 (WIZARD_CHANNEL_AGENT_FILING=1 on top of the channel store): agent filing and the Alerts channel.
  'chats-agent-filing': async s => {
    const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const make = async (name, agent) => { const r = await s.raw('/wizard/v1/channels', json('POST', { name, agent })); assert.equal(r.status, 201); return r.json() }
    const filed = async (sessionId) => (await (await s.raw(`/wizard/v1/channels/membership?sessionId=${sessionId}&agent=${s.id}`)).json()).channel
    const alerts = (await (await s.raw('/wizard/v1/channels')).json()).channels.find(c => c.kind === 'alerts')
    assert.ok(alerts, 'a fresh install has Alerts')
    const own = await make('Synthetic project', s.id), second = await make('Synthetic second', s.id)
    const other = s.id === 'hermes' ? 'other-agent' : 'hermes', foreign = await make('FOREIGN_CHANNEL_CANARY', other)
    // The run note: channel rules and this agent's channels, never Alerts or another agent's.
    const row = s.sessions.get('wizard_parity'); row.hidden = false
    const run = await admit(s, { input: 'Synthetic owner chat' })
    const note = sent(s).instructions
    assert.ok(note.includes('Channels are on for this owner') && note.includes('this chat\u2019s post name'), 'channel and post-title rules are injected')
    assert.ok(note.includes(`"id":"${own.id}"`), 'run note lists own channels')
    assert.ok(!note.includes(`"id":"${alerts.id}"`) && !note.includes('FOREIGN_CHANNEL_CANARY'), 'Alerts and other agents\u2019 channels are not offered')
    const finish = async (id, status) => {
      Object.assign([...s.runs.values()].at(-1), { status: 'completed', updated_at: Date.now() / 1000, output: `Synthetic reply\n[WIZARD_STATUS_V1]${JSON.stringify({ state: 'done', ask: 'Filed', ...status })}[/WIZARD_STATUS_V1]` })
      assert.equal((await s.request(`/v1/runs/${id}`)).status, 200)
    }
    // A foreign or Alerts channel is refused; then `channel` files the unfiled chat.
    await finish(run.run_id, { channel: foreign.id, subject: 'Synthetic' })
    assert.equal(await filed('wizard_parity'), null, 'another agent\u2019s channel is refused')
    const r2 = await admit(s, { input: 'Synthetic owner chat again' }); await finish(r2.run_id, { channel: alerts.id, subject: 'Synthetic' })
    assert.equal(await filed('wizard_parity'), null, 'agents never file an owner chat into Alerts')
    // Issue 520: a channel that does not cover the status subject (Hermes vs Content) files nothing.
    const content = await make('Content', s.id)
    const r2b = await admit(s, { input: 'Synthetic owner chat about agents' }); await finish(r2b.run_id, { channel: content.id, subject: 'Hermes' })
    assert.equal(await filed('wizard_parity'), null, 'a channel that does not match the status subject is refused')
    // Issue 520 review: a migration-filed chat (old Space filings, often the agent's own) teaches its channel nothing,
    // so its Hermes subject never opens Content to the next Hermes chat.
    const storePath = [join(s.root, 'os', 'channels.sqlite')].find(existsSync)
    assert.ok(storePath, 'the channel store is on disk')
    assert.equal((await s.request('/api/sessions', post({ id: 'wizard_parity_migrated', source: 'wizard-mobile' }))).status, 201)
    const mdb = new DatabaseSync(storePath)
    mdb.prepare("INSERT INTO membership(agent,session_id,channel_id,filed_at,filed_by) VALUES(?,?,?,?,'migration')").run(s.id, 'wizard_parity_migrated', content.id, new Date().toISOString())
    mdb.close()
    const rm = await s.request('/v1/runs', post({ session_id: 'wizard_parity_migrated', input: 'Synthetic migrated chat' })); assert.equal(rm.status, 202)
    await finish((await rm.json()).run_id, { subject: 'Hermes' })
    assert.equal(await filed('wizard_parity_migrated'), content.id, 'the migrated chat stays where it was')
    const r2c = await admit(s, { input: 'Synthetic owner chat about agents again' }); await finish(r2c.run_id, { channel: content.id, subject: 'Hermes' })
    assert.equal(await filed('wizard_parity'), null, 'a subject seen only on a migration-filed chat does not open the channel')
    const r3 = await admit(s, { input: 'Synthetic owner chat once more' }); await finish(r3.run_id, { channel: own.id, subject: 'Synthetic', title: 'Synthetic post name' })
    assert.equal(await filed('wizard_parity'), own.id, 'status-line channel files an unfiled chat')
    // Issue 520: the owner takes it out; the next status repeating the channel leaves it out.
    assert.equal((await s.raw('/wizard/v1/channels/membership', json('PUT', { sessionId: 'wizard_parity', channelId: null, agent: s.id }))).status, 200)
    const r3b = await admit(s, { input: 'Synthetic owner chat taken out' }); await finish(r3b.run_id, { channel: own.id, subject: 'Synthetic' })
    assert.equal(await filed('wizard_parity'), null, 'a chat the owner took out is never re-filed')
    // Never a move: the owner refiles it, and a later status naming another channel changes nothing.
    assert.equal((await s.raw('/wizard/v1/channels/membership', json('PUT', { sessionId: 'wizard_parity', channelId: second.id }))).status, 200)
    const r4 = await admit(s, { input: 'Synthetic owner chat moved' }); await finish(r4.run_id, { channel: own.id, subject: 'Synthetic' })
    assert.equal(await filed('wizard_parity'), second.id, 'an owner-filed chat is never moved')
    // `space` stays an alias for one release.
    assert.equal((await s.request('/api/sessions', post({ id: 'wizard_parity_alias', source: 'wizard-mobile' }))).status, 201)
    const r5 = await s.request('/v1/runs', post({ session_id: 'wizard_parity_alias', input: 'Synthetic alias chat' })); assert.equal(r5.status, 202)
    await finish((await r5.json()).run_id, { space: own.id, subject: 'Synthetic' })
    assert.equal(await filed('wizard_parity_alias'), own.id, 'space is an alias of channel')
    // Scheduled chats: a new chat goes to its job's channel, else Alerts (main) or stays unfiled (routed agents);
    // a job posting into an existing thread never files it; the status line cannot file a scheduled chat.
    const job = async extra => { const r = await s.raw('/wizard/v1/schedules', post({ name: 'Parity · Synthetic reminder', kind: 'remind', prompt: 'Synthetic reminder.', agent: s.id, enabled: false, when: { every: 60 }, ...extra })); assert.equal(r.status, 201, await r.clone().text()); return r.json() }
    const fire = async created => {
      const r = await s.raw(`/wizard/v1/schedules/${created.id}/run`, post({})); assert.equal(r.status, 202)
      const occurrence = await r.json(); await s.server.scheduler.tick(false)
      const latest = s.server.scheduler.latest(created.id); assert.equal(latest.admitted, 1, latest.error || 'admitted')
      return { thread: occurrence.thread, runId: JSON.parse(latest.receipt).run_id }
    }
    const plain = await fire(await job())
    assert.equal(await filed(plain.thread), s.kind === 'main' ? alerts.id : null, 'a new scheduled chat lands in Alerts (main) or stays unfiled')
    await finish(plain.runId, { channel: own.id, subject: 'Synthetic' })
    assert.equal(await filed(plain.thread), s.kind === 'main' ? alerts.id : null, 'the status line never files a scheduled chat')
    const routed = await fire(await job({ channel: own.id }))
    assert.equal(await filed(routed.thread), own.id, 'a job with a channel files its new chat there')
    assert.equal((await s.raw('/wizard/v1/schedules', post({ name: 'Bad', kind: 'remind', prompt: 'x', agent: s.id, enabled: false, when: { every: 60 }, channel: 'Not An Id' }))).status, 400)
    const existing = await fire(await job({ thread: 'wizard_parity_alias' }))
    assert.equal(existing.thread, 'wizard_parity_alias')
    assert.equal(await filed('wizard_parity_alias'), own.id, 'a run into an existing thread stays where it is')
    // Owner unfiles the Alerts post; the job's next occurrence does not put it back.
    if (s.kind === 'main') {
      assert.equal((await s.raw('/wizard/v1/channels/membership', json('PUT', { sessionId: plain.thread, channelId: null }))).status, 200)
      const again = await s.raw(`/wizard/v1/schedules/${s.server.scheduler.list().find(j => j.thread === plain.thread).id}/run`, post({})); assert.equal(again.status, 202)
      await s.server.scheduler.tick(false)
      assert.equal(await filed(plain.thread), null, 'a later occurrence never re-files the chat')
    }
    // A deleted job's chat is still a scheduler chat: its status line never files it.
    const plainJob = s.server.scheduler.list().find(j => j.thread === plain.thread)
    assert.equal((await s.raw(`/wizard/v1/schedules/${plainJob.id}`, { method: 'DELETE' })).status, 200)
    if (s.kind === 'main') assert.equal((await s.raw('/wizard/v1/channels/membership', json('PUT', { sessionId: plain.thread, channelId: null }))).status, 200)
    const late = await s.request('/v1/runs', post({ session_id: plain.thread, input: 'Synthetic owner reply to the reminder' })); assert.equal(late.status, 202)
    await finish((await late.json()).run_id, { channel: own.id, subject: 'Synthetic' })
    assert.equal(await filed(plain.thread), null, 'a deleted job\u2019s chat is still never filed by its status line')
    // An alert the owner replied to stays the agent's post: no firstRequest from the owner's reply (scene has channelFirstPosts).
    const at = Date.now() / 1000 - 60
    for (const [id, msgs] of [['wizard_parity_alert', [{ role: 'assistant', timestamp: at, content: 'Synthetic alert words' }, { role: 'user', timestamp: at + 1, content: 'Synthetic owner reply' }]],
      ['wizard_parity_owner', [{ role: 'user', timestamp: at, content: 'Synthetic owner opener' }, { role: 'assistant', timestamp: at + 1, content: 'Synthetic answer' }]]]) {
      assert.equal((await s.request('/api/sessions', post({ id, source: 'wizard-mobile' }))).status, 201)
      const made = s.sessions.get(id); made.hidden = false; made.preview = msgs.find(m => m.role === 'user').content; made.messages.push(...msgs)
    }
    const listed = async (id, want) => {
      let last
      for (let attempt = 0; attempt < 80; attempt++) {
        if (s.kind === 'main') await (await s.request('/api/sessions?limit=100')).json()
        last = (await (await s.request('/api/sessions?view=list&limit=100')).json()).data.find(x => x.id === id)
        if (last && want(last)) return last
        await new Promise(r => setTimeout(r, 25))
      }
      return last
    }
    assert.equal((await listed('wizard_parity_owner', x => Object.hasOwn(x, 'firstRequest')))?.firstRequest, 'Synthetic owner opener')
    const alertRow = await listed('wizard_parity_alert', x => Object.hasOwn(x, 'firstRequest'))
    assert.ok(alertRow && !Object.hasOwn(alertRow, 'firstRequest'), 'an agent-started thread with an owner reply carries no firstRequest')
  },
  'chats-first-posts': async s => {
    const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const at = Date.now() / 1000 - 30
    const photo = { id: 'parity-photo-1', filename: 'synthetic.png', mime: 'image/png', bytes: 4 }, doc = { id: 'parity-doc-1', filename: 'synthetic.pdf', mime: 'application/pdf', bytes: 4 }
    const message = words => `[Workspace::v1: /opt/data]\n**${words}**\n\n[WIZARD_FILES_V1]\n${JSON.stringify([photo, doc])}\n[/WIZARD_FILES_V1]\n[WizardOS context] Window in front: Synthetic Notes`
    const long = `Synthetic first post ${'word '.repeat(120)}`.trim()
    const row = s.sessions.get('wizard_parity'); row.hidden = false
    row.messages.push({ role: 'user', timestamp: at, content: '[ASYNC DELEGATION BATCH COMPLETE — deleg_parity]\nInternal worker transcript', display_kind: 'async_delegation_complete' },
      { role: 'user', timestamp: at + 1, content: message(long) }, { role: 'assistant', timestamp: at + 2, content: 'Synthetic reply' })
    const create = async id => { const r = await s.request('/api/sessions', json('POST', { id, source: 'wizard-mobile' })); assert.equal(r.status, 201); const made = s.sessions.get(id); made.hidden = false; return made }
    // A thread the agent started: no owner message, so neither field.
    ;(await create('wizard_parity_agent')).messages.push({ role: 'assistant', timestamp: at, content: 'Synthetic agent-started note' })
    // Main's canonical census was seeded at startup and routed posts not in a readable state.db are read in the background.
    const listed = async (id, want = true) => {
      let last
      for (let attempt = 0; attempt < 80; attempt++) {
        if (s.kind === 'main') await (await s.request('/api/sessions?limit=100')).json()
        last = (await (await s.request('/api/sessions?view=list&limit=100')).json()).data.find(x => x.id === id)
        if (last && (!want || Object.hasOwn(last, 'firstRequest'))) return last
        await new Promise(r => setTimeout(r, 25))
      }
      return last
    }
    const check = (item, label) => {
      assert.ok(item, `${label}: row listed`)
      assert.equal(typeof item.firstRequest, 'string', `${label}: firstRequest`)
      assert.ok(item.firstRequest.length <= 400 && item.firstRequest.length > 300, `${label}: cut at 400 code units`)
      assert.ok(item.firstRequest.startsWith('Synthetic first post word word'), `${label}: the owner's words, not the internal row`)
      assert.ok(!/Workspace|WIZARD_|Window in front|synthetic\.pdf|\*/u.test(item.firstRequest), `${label}: cleaned`)
      assert.deepEqual(item.firstAttachments, [{ id: 'parity-photo-1', name: 'synthetic.png', mime: 'image/png' }], `${label}: images only, as file refs`)
    }
    check(await listed('wizard_parity'), 'state.db read')
    // AI review kick-back: Hermes stamps the owner's own API turn internal_notification. The post is that turn, the one
    // view=wizard history restores from this kind's queue, never a later steering wrapper or nudge.
    const ownerTurn = async id => {
      const words = `Synthetic owner turn for ${id.replaceAll("_", " ")}.`
      const made = await create(id)
      await admit(s, { session_id: id, input: [{ role: 'user', content: [{ type: 'text', text: words }] }] })
      for (let i = 0; i < 80 && !made.messages.some(m => m.role === 'user'); i++) await new Promise(r => setTimeout(r, 25))
      const owner = made.messages.findLast(m => m.role === 'user')
      assert.ok(owner, `${id}: the queued owner turn reached this kind's runtime`)
      owner.display_kind = 'internal_notification'
      if (s.kind !== 'main') owner.content = [{ type: 'text', text: words }, { type: 'text', text: '[System: synthetic Hermes notice]' }]
      const t = Number(owner.timestamp)
      for (const run of s.runs.values()) Object.assign(run, { status: 'completed', output: 'Synthetic reply' })
      made.messages.push({ role: 'user', timestamp: t + 1, content: '[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position; not tool output] Synthetic steer [/OUT-OF-BAND USER MESSAGE]' },
        { role: 'user', timestamp: t + 2, content: '[reporter] Your last report does not meet the report format: synthetic.' },
        { role: 'assistant', timestamp: t + 3, content: 'Synthetic reply' })
      return words
    }
    const turnCheck = (item, words, label) => {
      assert.ok(item, `${label}: row listed`)
      assert.equal(item.firstRequest, words, `${label}: the owner's own (internal_notification) turn, not the steer or nudge after it`)
      assert.deepEqual(item.firstAttachments, [], `${label}: no photos`)
    }
    const turnWords = await ownerTurn('wizard_parity_turn')
    turnCheck(await listed('wizard_parity_turn'), turnWords, 'state.db read')
    // AI review round 2: the decided post is kept between polls, and a kept post is the same post.
    turnCheck(await listed('wizard_parity_turn'), turnWords, 'second poll (kept post)')
    const agentStarted = await listed('wizard_parity_agent', false)
    assert.ok(agentStarted && !Object.hasOwn(agentStarted, 'firstRequest') && !Object.hasOwn(agentStarted, 'firstAttachments'), 'an agent-started thread has neither field')
    if (s.kind !== 'main') {
      // A restricted agent's home is unreadable to the Service: without its state.db the post comes through the runtime.
      // (The fixture keeps writing through its open handle; root reads any file, so this half needs a normal user.)
      const db = join(s.agentHome, 'state.db')
      assert.ok(existsSync(db)); chmodSync(db, 0)
      try {
        const routed = await create('wizard_parity_runtime')
        routed.messages.push({ role: 'user', timestamp: at, content: message(long) }, { role: 'assistant', timestamp: at + 1, content: 'Synthetic reply' })
        check(await listed('wizard_parity_runtime'), 'runtime history read')
        assert.ok(s.seen.some(r => r.method === 'GET' && r.path.endsWith('/api/sessions/wizard_parity_runtime/messages')), 'read through the agent runtime')
        const runtimeWords = await ownerTurn('wizard_parity_runtime_turn')
        turnCheck(await listed('wizard_parity_runtime_turn'), runtimeWords, 'runtime history read')
      } finally { chmodSync(db, 0o600) }
    }
  },
  'nonimage-files': async s => {
    const bytes = Buffer.from('PARITY_DOCUMENT_UNDISCLOSED_TOKEN\n')
    const r = await s.upload(bytes, 'fixture.txt', 'text/plain'); assert.equal(r.status, 201)
    const file = (await r.json()).file
    await admit(s, { input: 'Read the attached document', wizard_file_ids: [file.id] })
    const body = sent(s), text = typeof body.input === 'string' ? body.input : body.input[0].content[0].text
    assert.ok(text.includes('trusted_path')); assert.ok(!text.includes('placement_error'))
    assert.equal(body.wizard_file_ids, undefined)
    if (['container', 'restricted'].includes(s.kind)) assert.deepEqual(Buffer.from(s.placed.at(-1).payload.data_base64, 'base64'), bytes)
    else {
      const index = JSON.parse(readFileSync(join(s.root, 'media.json')))
      assert.deepEqual(readFileSync(join(s.root, 'files', index.files.find(f => f.id === file.id).rel)), bytes)
    }
    assert.ok(JSON.stringify(await history(s)).includes('WIZARD_FILE_CHIPS_V1'))
  },
  'file-large-copy': async s => {
    // Issue 464: a recording over the 25 MB inline cap reaches container agents as a stream with a matching hash.
    const bytes = Buffer.alloc(26 * 1024 * 1024 + 7, 'parity-recording-')
    const r = await s.upload(bytes, 'retreat-day-2.mp3', 'audio/mpeg'); assert.equal(r.status, 201)
    const file = (await r.json()).file
    await admit(s, { input: 'Transcribe the attached recording', wizard_file_ids: [file.id] })
    const body = sent(s), text = typeof body.input === 'string' ? body.input : body.input[0].content[0].text
    assert.ok(text.includes('trusted_path')); assert.ok(!text.includes('placement_error'), 'a large file must reach the agent')
    const sha = createHash('sha256').update(bytes).digest('hex')
    if (['container', 'restricted'].includes(s.kind)) {
      const streamed = s.placedStreams.at(-1)
      assert.deepEqual({ size: streamed.size, digest: streamed.digest, bytes: streamed.bytes }, { size: bytes.length, digest: sha, bytes: bytes.length })
      assert.ok(!s.placed.some(p => p.payload.sha256 === sha), 'large files are never sent as base64 JSON')
    } else assert.equal(s.placedStreams.length, 0, 'main and host-profile read the shared file, nothing is copied')
  },
  'assistant-media': async s => {
    s.sessions.get('wizard_parity').messages.push({ id: 'media-reply', role: 'assistant', timestamp: Date.now() / 1000, content: `Synthetic output\nMEDIA:${s.media.png}\nImage explanation continues here.\nMEDIA:${s.media.text}` })
    const row = (await history(s)).find(m => m.id === 'media-reply')
    const items = envelope(row.content)
    assert.equal(items.length, 2, 'both image and document must be usable')
    assert.equal(new Set(items.map(item => item.id)).size, 2, 'attachments are not duplicated')
    const positioned = [...row.content.matchAll(/<helm_attachments>([\s\S]*?)<\/helm_attachments>/g)]
    assert.equal(JSON.parse(positioned[0][1]).inline, true)
    assert.ok(positioned[0].index < row.content.indexOf('Image explanation continues here.'), 'image keeps MEDIA line position on every runtime')
    assert.ok(!row.content.includes('unavailable')); assert.ok(!row.content.includes(s.agentHome)); assert.ok(!row.content.includes('/opt/data'))
    for (const [i, expected] of [png, Buffer.from('PARITY_SYNTHETIC_DOCUMENT\n')].entries()) {
      const r = await s.raw(`/wizard/attachments/${items[i].id}`)
      assert.equal(r.status, 200); assert.deepEqual(Buffer.from(await r.arrayBuffer()), expected)
    }
    s.mediaItems = items
  },
  'working-context': async s => {
    // The wizard-work-progress pre_llm_call hook, run for this runtime's own Wizard session, injects the Working
    // contract into the user turn. History on every kind shows only the human words (text and multimodal).
    const plugin = new URL('../../hermes-plugin/wizard-work-progress/__init__.py', import.meta.url).pathname
    const hook = (sid, parent = '') => execFileSync('python3', ['-c', "import json,runpy,sys; r=runpy.run_path(sys.argv[1])['turn_context'](session_id=sys.argv[2], platform='api_server', parent_session_id=sys.argv[3]); print(json.dumps(r))", plugin, sid, parent], { encoding: 'utf8' })
    const injected = JSON.parse(hook('wizard_parity'))
    assert.ok(injected?.context?.includes('Working progress contract'), 'the Wizard session receives the Working contract')
    assert.equal(JSON.parse(hook('wizard_parity_child', 'wizard_parity')), null, 'delegated children do not')
    const human = 'Synthetic: build the preview and verify playback.'
    const image = { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }
    const now = Date.now() / 1000, row = s.sessions.get('wizard_parity')
    row.messages.push({ id: 'working-text', role: 'user', timestamp: now, content: `${human}\n\n${injected.context}` })
    row.messages.push({ id: 'working-image', role: 'user', timestamp: now + 1, content: [{ type: 'text', text: human }, image, { type: 'text', text: injected.context }] })
    const rows = await history(s)
    const text = rows.find(m => m.id === 'working-text'), multi = rows.find(m => m.id === 'working-image')
    assert.equal(text.content, human, 'text history shows the human words only')
    assert.ok(!JSON.stringify(multi.content).includes('Working progress contract'), 'multimodal history hides the contract')
    assert.ok(JSON.stringify(multi.content).includes(human))
  },
  'sent-media-snapshot': async s => {
    // Run the real wizard-os media hook with this runtime's own home, then serve what it wrote through the Service.
    const scratch = join(s.agentHome, 'cache/scratch/run'); mkdirSync(scratch, { recursive: true })
    mkdirSync(join(s.agentHome, 'cache/images'), { recursive: true })
    writeFileSync(join(scratch, 'screenshot.png'), png)
    const visible = p => ['container', 'restricted'].includes(s.kind) ? p.replace(s.agentHome, '/opt/data') : p
    const hook = `import importlib.util,sys\nspec=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nprint(m.transform_llm_output(response_text=sys.argv[2],platform='api_server'))`
    const out = execFileSync('python3', ['-c', hook, join(pluginRoot, 'media.py'), `Synthetic screenshot\nMEDIA:${join(scratch, 'screenshot.png')}`],
      { encoding: 'utf8', env: { ...process.env, HERMES_HOME: s.agentHome, WIZARD_FILES_ROOT: join(s.root, 'no-files') } }).trimEnd()
    const line = out.split('\n').find(l => l.startsWith('MEDIA:'))
    assert.ok(line && line.includes('/cache/images/wizard-sent/'), 'hook copies the scratch file into a shown folder')
    s.sessions.get('wizard_parity').messages.push({ id: 'snapshot-reply', role: 'assistant', timestamp: Date.now() / 1000, content: visible(out) })
    // History re-projects the stored reply on every open, so serve what a fresh open shows.
    const served = async () => {
      const [item] = envelope((await history(s)).find(m => m.id === 'snapshot-reply').content)
      assert.ok(item, 'sent snapshot is attached on every runtime')
      const r = await s.raw(`/wizard/attachments/${item.id}`); assert.equal(r.status, 200)
      return Buffer.from(await r.arrayBuffer())
    }
    assert.deepEqual(await served(), png)
    writeFileSync(join(scratch, 'screenshot.png'), Buffer.concat([png.subarray(0, 8), Buffer.from('REWRITTEN')]), { flag: 'r+' })
    assert.deepEqual(await served(), png, 'rewriting the source in place never changes an earlier chat message')
  },
  'sent-media-pruned': async s => {
    // Issue 556: Hermes prunes cache/audio after 24 h. A file sent in a chat keeps playing from the Service's own copy.
    mkdirSync(join(s.agentHome, 'cache/audio'), { recursive: true })
    const source = join(s.agentHome, 'cache/audio/parity-voice.mp3'), bytes = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4096, 9)])
    writeFileSync(source, bytes)
    const visible = ['container', 'restricted'].includes(s.kind) ? '/opt/data/cache/audio/parity-voice.mp3' : source
    s.sessions.get('wizard_parity').messages.push({ id: 'pruned-reply', role: 'assistant', timestamp: Date.now() / 1000, content: `Synthetic voice sample\nMEDIA:${visible}` })
    const shown = async () => (await history(s)).find(m => m.id === 'pruned-reply').content
    const [first] = envelope(await shown())
    assert.ok(first && first.kind === 'audio', 'the voice sample is a file card on every runtime')
    rmSync(source)
    const later = await shown()
    assert.ok(!later.includes('unavailable'), 'a pruned source still shows the saved copy')
    assert.deepEqual(envelope(later), [first])
    const r = await s.raw(`/wizard/attachments/${first.id}`); assert.equal(r.status, 200)
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes)
  },
  'media-folder-rule': async s => {
    // Issue 580: each kind is told one folder rule; a file in each folder that rule names becomes a file card.
    // Routed kinds: anywhere in the agent's own home (restricted homes are read through the runtime mirror).
    // Main: its cache folders. A path only written in the text is never sent.
    const routed = s.kind !== 'main'
    const places = routed ? ['rule-root.md', 'work/ranked/rule-candidates.csv', 'cache/images/rule-chart.png'] : ['cache/images/rule-chart.png', 'cache/audio/rule-note.mp3']
    for (const rel of places) {
      mkdirSync(join(s.agentHome, dirname(rel)), { recursive: true })
      writeFileSync(join(s.agentHome, rel), rel.endsWith('.png') ? png : `synthetic ${rel}\n`)
    }
    const visible = rel => ['container', 'restricted'].includes(s.kind) ? `/opt/data/${rel}` : join(s.agentHome, rel)
    const row = s.sessions.get('wizard_parity')
    places.forEach((rel, i) => row.messages.push({ id: `rule-${i}`, role: 'assistant', timestamp: Date.now() / 1000 + i, content: `Synthetic file ${i}\nMEDIA:${visible(rel)}` }))
    row.messages.push({ id: 'rule-bare', role: 'assistant', timestamp: Date.now() / 1000 + 9, content: `Synthetic list at \`${visible(places[0])}\`` })
    let rows = await history(s)
    // A restricted home is mirrored in the background on the first read; the next open shows the cards.
    for (let n = 0; n < 20 && places.some((_, i) => !envelope(rows.find(m => m.id === `rule-${i}`).content).length); n++) {
      await new Promise(done => setTimeout(done, 100)); rows = await history(s)
    }
    places.forEach((rel, i) => {
      const content = rows.find(m => m.id === `rule-${i}`).content
      assert.ok(!content.includes('unavailable'), `${rel} is not unavailable on ${s.kind}`)
      assert.deepEqual(envelope(content).map(item => item.name), [basename(rel)], `${rel} is a file card on ${s.kind}`)
    })
    // Issue 581: on routed kinds a bare path into the agent's own home is shown as a card too; main is unchanged.
    assert.deepEqual(envelope(rows.find(m => m.id === 'rule-bare').content).map(item => item.name), routed ? [basename(places[0])] : [], 'a bare path is a card only for routed kinds')
  },
  'media-inline-path': async s => {
    // Issue 581: a routed agent's reply that names a file in its own home as a plain path (no MEDIA line) shows the
    // same card a MEDIA line gives; a folder, a missing or unsupported file, or an agent with files: none reads
    // "[file: <name> not sent: ask the agent to send it]". Never the raw path, never a bare "[private attachment]".
    if (s.kind === 'main') return
    const files = { 'cache/images/inline-report.png': png, 'work/ranked/inline-candidates.csv': 'rank,name\n1,a\n', 'work/ranked/inline-tool.exe': 'MZ' }
    for (const [rel, bytes] of Object.entries(files)) {
      mkdirSync(join(s.agentHome, dirname(rel)), { recursive: true })
      writeFileSync(join(s.agentHome, rel), bytes)
    }
    mkdirSync(join(s.agentHome, 'transcripts'), { recursive: true })
    const visible = rel => ['container', 'restricted'].includes(s.kind) ? `/opt/data/${rel}` : join(s.agentHome, rel)
    const row = s.sessions.get('wizard_parity')
    const said = {
      'inline-png': `Chart: \`${visible('cache/images/inline-report.png')}\``,
      'inline-csv': `All 232 ranked candidates at \`${visible('work/ranked/inline-candidates.csv')}\`, transcripts alongside.`,
      'inline-dir': `Transcripts in \`${visible('transcripts')}\``,
      'inline-gone': `Saved to \`${visible('work/ranked/inline-gone.csv')}\``,
      'inline-exe': `Built \`${visible('work/ranked/inline-tool.exe')}\``,
    }
    Object.entries(said).forEach(([id, content], i) => row.messages.push({ id, role: 'assistant', timestamp: Date.now() / 1000 + i, content }))
    const cards = { 'inline-png': ['inline-report.png'], 'inline-csv': ['inline-candidates.csv'] }
    let rows = await history(s)
    // A restricted home is mirrored in the background on the first read; the next open shows the cards.
    for (let n = 0; n < 20 && Object.keys(cards).some(id => !envelope(rows.find(m => m.id === id).content).length); n++) {
      await new Promise(done => setTimeout(done, 100)); rows = await history(s)
    }
    const raw = [s.agentHome, '/opt/data', '[private attachment]']
    for (const id of Object.keys(said)) {
      const content = rows.find(m => m.id === id).content
      for (const text of raw) assert.ok(!content.includes(text), `${id} on ${s.kind} shows no ${text}`)
      assert.deepEqual(envelope(content).map(item => item.name), cards[id] ?? [], `${id} cards on ${s.kind}`)
    }
    assert.ok(rows.find(m => m.id === 'inline-csv').content.startsWith('All 232 ranked candidates at `inline-candidates.csv`, transcripts alongside.'))
    assert.equal(rows.find(m => m.id === 'inline-dir').content, 'Transcripts in [file: transcripts not sent: ask the agent to send it]')
    assert.equal(rows.find(m => m.id === 'inline-gone').content, 'Saved to [file: inline-gone.csv not sent: ask the agent to send it]')
    assert.equal(rows.find(m => m.id === 'inline-exe').content, 'Built [file: inline-tool.exe not sent: ask the agent to send it]')
    // An agent with files: none sends nothing this way.
    const file = join(s.root, 'os', 'agents', s.id, 'agent.json'), agent = JSON.parse(readFileSync(file, 'utf8'))
    agent.permissions.files = 'none'; writeFileSync(file, JSON.stringify(agent)); await s.restart()
    row.messages.push({ id: 'inline-none', role: 'assistant', timestamp: Date.now() / 1000 + 9, content: `At \`${visible('work/ranked/inline-candidates.csv')}\`` })
    assert.equal((await history(s)).find(m => m.id === 'inline-none').content, 'At [file: inline-candidates.csv not sent: ask the agent to send it]')
  },
  'bring-my-data': async s => {
    // The owner drops exports into Files through the Service; the wizard-os bring_data tool, run with THIS runtime's
    // own home, archives chats into the owner's Files and installs picked skills only into this agent's home.
    const files = join(s.root, 'files')
    const make = `import io,json,sys,zipfile
b=io.BytesIO(); z=zipfile.ZipFile(b,'w')
if sys.argv[1]=='chatgpt':
  m={'r':{'id':'r','message':None,'parent':None,'children':['u']},'u':{'id':'u','parent':'r','children':['a'],'message':{'author':{'role':'user'},'create_time':1700000000,'content':{'content_type':'text','parts':['PARITY_IMPORT_QUESTION']}}},'a':{'id':'a','parent':'u','children':[],'message':{'author':{'role':'assistant'},'create_time':1700000001,'recipient':'all','content':{'content_type':'text','parts':['PARITY_IMPORT_ANSWER']}}}}
  z.writestr('conversations.json',json.dumps([{'title':'Parity import','create_time':1700000000,'update_time':1700000001,'mapping':m,'current_node':'a','conversation_id':'parity-conv'}]))
else:
  z.writestr('memories/USER.md','Parity owner fact.'); z.writestr('skills/parity-skill/SKILL.md','---\\nname: parity-skill\\ndescription: Synthetic.\\n---\\n'); z.writestr('.env','KEY=parity-runtime-secret')
z.close(); sys.stdout.buffer.write(b.getvalue())`
    const exportZip = kind => execFileSync('python3', ['-c', make, kind])
    const tool = args => JSON.parse(execFileSync('python3', ['-c', "import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('bd',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nprint(m.handle(json.loads(sys.argv[2])))", join(pluginRoot, 'bring_data.py'), JSON.stringify(args)],
      { encoding: 'utf8', env: { ...process.env, HERMES_HOME: s.agentHome, WIZARD_FILES_ROOT: files } }))
    const dropped = async (kind, name) => {
      const r = await s.upload(exportZip(kind), name, 'application/zip'); assert.equal(r.status, 201)
      const id = (await r.json()).file.id
      return JSON.parse(readFileSync(join(s.root, 'media.json'))).files.find(f => f.id === id).rel
    }
    const scan = tool({ action: 'scan', path: await dropped('chatgpt', 'chatgpt-export.zip') })
    assert.equal(scan.success, true, JSON.stringify(scan)); assert.equal(scan.kind, 'chatgpt'); assert.equal(scan.counts.chats, 1)
    assert.ok(existsSync(join(s.agentHome, 'cache/bring-data/imports.json')), 'scan record lives in this agent home')
    assert.equal(tool({ action: 'archive', import_id: scan.import_id }).chats_written, 1)
    const index = readFileSync(join(files, 'Imported/ChatGPT/Index.md'), 'utf8')
    const rel = index.match(/\(<(Chats\/[^>]+)>\)/)[1]
    const chat = readFileSync(join(files, 'Imported/ChatGPT', rel), 'utf8')
    assert.ok(chat.includes('PARITY_IMPORT_QUESTION') && chat.includes('PARITY_IMPORT_ANSWER'), 'archived chat is in the owner Files')
    const hermes = tool({ action: 'scan', path: await dropped('hermes', 'hermes-backup.zip') })
    assert.deepEqual(hermes.new_skills.map(x => x.name), ['parity-skill'])
    assert.deepEqual(tool({ action: 'skills', import_id: hermes.import_id, names: ['parity-skill'] }).installed.map(x => x.name), ['parity-skill'])
    assert.ok(existsSync(join(s.agentHome, 'skills/imported/parity-skill/SKILL.md')), 'skill lands in this agent home')
    assert.ok(!existsSync(join(files, 'skills')), 'nothing agent-side is written into Files')
    assert.ok(!JSON.stringify([scan, hermes]).includes('parity-runtime-secret'))
  },
  'download-links': async s => {
    await serverChecks['assistant-media'](s)
    const r = await s.upload(png, 'download.png', 'image/png'); assert.equal(r.status, 201)
    const file = (await r.json()).file
    const image = await s.raw(`/wizard/files/${file.id}/content`)
    assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png')
    assert.ok(image.headers.get('content-disposition').includes('download.png'))
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png)
    // Browser cache (every runtime): attachments are immutable; owner files revalidate and an edit shows at once.
    assert.equal(image.headers.get('cache-control'), 'private, no-cache')
    const etag = image.headers.get('etag'); assert.ok(etag, 'owner file carries a validator')
    assert.equal((await s.raw(`/wizard/files/${file.id}/content`, { headers: { 'If-None-Match': etag } })).status, 304)
    const index = JSON.parse(readFileSync(join(s.root, 'media.json')))
    const onDisk = join(s.root, 'files', index.files.find(f => f.id === file.id).rel), { mtime } = statSync(onDisk)
    const edited = Buffer.from(png); edited[edited.length - 1] ^= 1; writeFileSync(onDisk, edited); utimesSync(onDisk, mtime, mtime)
    const fresh = await s.raw(`/wizard/files/${file.id}/content`, { headers: { 'If-None-Match': etag } })
    assert.equal(fresh.status, 200, 'same-size edit with preserved mtime is not served as 304'); assert.deepEqual(Buffer.from(await fresh.arrayBuffer()), edited)
    for (const item of s.mediaItems) assert.equal((await s.raw(`/wizard/attachments/${item.id}`)).headers.get('cache-control'), 'private, max-age=31536000, immutable')
    const document = await s.raw(`/wizard/attachments/${s.mediaItems[1].id}`)
    assert.ok(document.headers.get('content-type').startsWith('text/plain'))
    assert.ok(document.headers.get('content-disposition').includes('synthetic.txt'))
    // Issue 586: a .md the agent sends from cache/images opens on a phone: the card names it Markdown with a bare
    // type, and the download is plain text (phones have an app for that), never `text/markdown; charset=utf-8`.
    mkdirSync(join(s.agentHome, 'cache', 'images'), { recursive: true })
    writeFileSync(join(s.agentHome, 'cache', 'images', 'parity-triage.md'), '# PARITY_MARKDOWN\n\n- one\n', { mode: 0o664 })
    const mdPath = s.media.png.startsWith('/opt/data/') ? '/opt/data/cache/images/parity-triage.md' : join(s.agentHome, 'cache', 'images', 'parity-triage.md')
    s.sessions.get('wizard_parity').messages.push({ id: 'markdown-reply', role: 'assistant', timestamp: Date.now() / 1000, content: `The triage list.\nMEDIA:${mdPath}\nDone.` })
    const mdRow = (await history(s)).find(m => m.id === 'markdown-reply')
    assert.ok(!mdRow.content.includes('unavailable'), 'the .md becomes a file card on every runtime')
    const [mdItem] = envelope(mdRow.content)
    assert.equal(mdItem.mime, 'text/markdown'); assert.equal(mdItem.kind, 'file'); assert.equal(mdItem.name, 'parity-triage.md')
    const md = await s.raw(`/wizard/attachments/${mdItem.id}`)
    assert.equal(md.status, 200); assert.equal(md.headers.get('content-type'), 'text/plain')
    assert.ok(md.headers.get('content-disposition').startsWith('attachment'))
    assert.equal(await md.text(), '# PARITY_MARKDOWN\n\n- one\n')
  },
  'messaging-chat-replies': async s => {
    // Issue 427: with the switch on, an owner reply into a chat a messaging app owns (Telegram here) never reaches
    // Hermes /v1/runs (a second writer there; newer Hermes refuses it). It waits in the outbox until the wizard-os plugin
    // in the gateway takes it with the main gateway key, injects it through the chat's own connection and reports
    // back; the run then reads the answer from state.db. An older chat (its app moved on) carries on through the
    // normal route with a one-off "continued" note. Routed agents own no messaging connection: their replies are
    // unchanged and the outbox stays empty.
    const gateway = { Authorization: 'Bearer parity-main-gateway', 'Content-Type': 'application/json' }
    const take = async () => { const r = await s.raw('/wizard/internal/messaging-replies/take', { method: 'POST', headers: gateway, body: '{}' }); assert.equal(r.status, 200); return r.json() }
    const done = async (id, body) => { const r = await s.raw('/wizard/internal/messaging-replies/done', { method: 'POST', headers: gateway, body: JSON.stringify({ id, ...body }) }); assert.equal(r.status, 200) }
    const sentFor = (from, id) => s.seen.slice(from).some(r => r.method === 'POST' && r.path.endsWith('/v1/runs') && r.body?.session_id === id)
    const poll = async (read, label) => { for (let n = 0; n < 80; n++) { const v = await read(); if (v) return v; await new Promise(r => setTimeout(r, 50)) } assert.fail(label) }
    const refused = await s.raw('/wizard/internal/messaging-replies/take', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(refused.status, 403, 'only the main gateway key takes replies')
    if (s.kind !== 'main') {
      const before = s.seen.length
      assert.equal((await s.request('/v1/runs', post({ session_id: 'wizard_parity', input: 'Synthetic routed reply' }))).status, 202)
      await poll(() => sentFor(before, 'wizard_parity'), 'a routed reply still goes to its Hermes')
      assert.deepEqual((await take()).items, [], 'routed replies never enter the outbox')
      return
    }
    assert.equal((await s.request('/api/sessions', post({ id: 'parity_tg', title: 'From Telegram' }))).status, 201)
    const key = 'agent:main:telegram:dm:7'
    const db = new DatabaseSync(join(s.root, 'hermes-state.db'))
    try {
      for (const column of ['session_key', 'chat_id', 'chat_type', 'thread_id']) { try { db.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`) } catch { /* already there */ } }
      db.exec('CREATE TABLE IF NOT EXISTS gateway_routing (scope TEXT, session_key TEXT, data TEXT, updated_at REAL)')
      db.prepare("UPDATE sessions SET source = 'telegram', session_key = ?, chat_id = '7', chat_type = 'dm' WHERE id = 'parity_tg'").run(key)
      db.prepare('INSERT INTO gateway_routing VALUES (?, ?, ?, ?)').run('/hermes/sessions', key, JSON.stringify({ session_id: 'parity_tg' }), 1)
    } finally { db.close() }
    const before = s.seen.length
    const admitted = await s.request('/v1/runs', post({ session_id: 'parity_tg', input: 'Synthetic WizardOS reply' }))
    assert.equal(admitted.status, 202)
    const runId = (await admitted.json()).run_id
    const item = await poll(async () => (await take()).items[0], 'the reply waits in the outbox for the gateway plugin')
    assert.deepEqual({ kind: item.kind, platform: item.platform, session_key: item.session_key, chat_id: item.chat_id, text: item.text },
      { kind: 'inject', platform: 'telegram', session_key: key, chat_id: '7', text: 'Synthetic WizardOS reply' })
    assert.ok(!sentFor(before, 'parity_tg'), 'the reply never reaches Hermes /v1/runs (the connection stays the only writer)')
    await done(item.id, { status: 'injected', at: Date.now() / 1000 })
    const now = Date.now() / 1000
    s.sessions.get('parity_tg').messages.push({ role: 'user', content: 'Synthetic WizardOS reply', display_kind: 'internal_notification', timestamp: now },
      { role: 'assistant', content: 'Synthetic answer, also in Telegram', timestamp: now + 1 })
    await s.request('/api/sessions/parity_tg/messages') // the fixture writes its rows to state.db on a Hermes read
    const run = await poll(async () => { const r = await (await s.request(`/v1/runs/${runId}`)).json(); return r.status === 'completed' && r }, 'the run completes with the answer')
    assert.equal(run.output, 'Synthetic answer, also in Telegram')
    // A repeated report changes nothing (the plugin's ledger keeps it to one inject).
    await done(item.id, { status: 'failed' })
    assert.equal((await (await s.request(`/v1/runs/${runId}`)).json()).status, 'completed')
    // The app moved on (a /new there): the older chat carries on here, and the app gets one note.
    const moved = new DatabaseSync(join(s.root, 'hermes-state.db'))
    try { moved.prepare('UPDATE gateway_routing SET data = ? WHERE session_key = ?').run(JSON.stringify({ session_id: 'parity_tg_new' }), key) } finally { moved.close() }
    const later = s.seen.length
    assert.equal((await s.request('/v1/runs', post({ session_id: 'parity_tg', input: 'Older chat reply' }))).status, 202)
    await poll(() => sentFor(later, 'parity_tg'), 'an older chat carries on through the normal route')
    const note = await poll(async () => (await take()).items.find(x => x.kind === 'note'), 'the app gets a continued note')
    assert.equal(note.session_id, 'parity_tg')
  },
  'main-provider-attach': async s => {
    // Issue 428: with the switch on, only the main agent's picker is narrowed to the providers attached to it, and
    // a model change onto an unattached provider never reaches Hermes. Routed kinds keep their own allowed models.
    const options = await (await s.request('/api/model/options')).json()
    const before = s.seen.length
    const refused = await s.request('/api/sessions/wizard_parity/model', post({ model: 'gpt-6.1-sol', provider: 'openai-codex' }))
    assert.equal(refused.status, 409)
    assert.ok(!s.seen.slice(before).some(r => r.path.endsWith('/model')), 'a refused provider switch never reaches any Hermes')
    if (s.kind === 'main') {
      assert.deepEqual(options.wizard_attached_providers, ['anthropic'], 'the configured provider is attached first')
      assert.deepEqual(options.providers.map(p => p.slug), ['anthropic'])
      assert.equal((await refused.json()).error, 'provider_not_attached')
      const state = await (await s.raw('/wizard/v1/main-providers', { headers: s.ownerHeaders })).json()
      assert.deepEqual(state.attached, ['anthropic'])
    } else {
      assert.equal(options.wizard_attached_providers, undefined, 'routed agents are untouched')
      assert.equal(options.providers.length, 1); assert.equal(options.providers[0].slug, options.provider)
      assert.equal((await refused.json()).error, 'model_not_allowed')
    }
    const allowed = s.kind === 'main' ? { model: 'fixture-other', provider: 'anthropic' } : { model: options.providers[0].models.at(-1) }
    const changed = await s.request('/api/sessions/wizard_parity/model', post(allowed))
    assert.ok(changed.status < 300, `attached provider still changes the model (${changed.status})`)
  },
  'private-first-setup': async s => {
    // Issue 545: with the private-first switch on (and no WIZARD_MAIN_PROVIDER_ATTACH), the owner's state route says
    // so, the main agent's provider attach protection is active, and routed agents keep their own allowed models.
    const state = await (await s.raw('/wizard/v1/private-first', { headers: s.ownerHeaders })).json()
    assert.equal(state.schema, 'wizard.private-first/1')
    assert.equal(state.on, true)
    assert.equal(state.standard_agent, 'hermes')
    const options = await (await s.request('/api/model/options')).json()
    const before = s.seen.length
    const refused = await s.request('/api/sessions/wizard_parity/model', post({ model: 'gpt-6.1-sol', provider: 'openai-codex' }))
    assert.equal(refused.status, 409)
    assert.ok(!s.seen.slice(before).some(r => r.path.endsWith('/model')), 'a refused provider switch never reaches any Hermes')
    if (s.kind === 'main') {
      assert.deepEqual(options.wizard_attached_providers, ['anthropic'], 'the protection is on without its own setting')
      assert.equal((await refused.json()).error, 'provider_not_attached')
      assert.equal((await s.raw('/wizard/v1/main-providers', { headers: s.ownerHeaders })).status, 200)
    } else {
      assert.equal(options.wizard_attached_providers, undefined, 'routed agents are untouched')
      assert.equal((await refused.json()).error, 'model_not_allowed')
    }
  },
  'graceful-restart-hold': async s => {
    // Issue 480: while a restart waits for running turns, a send is saved and held (never refused, never sent),
    // health says so without thread ids, and lifting the hold (or the next process) sends it once.
    const gate = (init = {}) => s.raw('/wizard/v1/restart', { ...init, headers: { ...s.ownerHeaders, ...(init.headers ?? {}) } })
    assert.deepEqual(await (await gate()).json(), { phase: 'idle', holding: false })
    // Another app's page on this box (same-site) can't start, renew or read the hold; a POST must be JSON (an
    // empty or text/plain body is a simple request a browser sends without a preflight).
    for (const init of [{ method: 'POST', body: '' }, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }]) {
      const r = await gate(init)
      assert.equal(r.status, 415, `${s.kind}: a non-JSON restart request is refused (${r.status})`)
    }
    for (const headers of [{ 'Sec-Fetch-Site': 'same-site' }, { Origin: 'http://127.0.0.1:1' }]) {
      for (const init of [{ method: 'GET' }, { ...post({ wait_s: 60 }), method: 'POST' }, { method: 'DELETE' }]) {
        const r = await gate({ ...init, headers: { ...(init.headers ?? {}), ...headers } })
        assert.equal(r.status, 403, `${s.kind}: ${init.method} from another site is refused (${JSON.stringify(headers)}: ${r.status})`)
      }
    }
    assert.equal((await (await s.raw('/wizard/health')).json()).restart, undefined, `${s.kind}: refused requests start no hold`)
    const asked = await gate(post({ reason: 'parity', wait_s: 60 }))
    assert.equal(asked.status, 200)
    assert.ok(['waiting', 'ready'].includes((await asked.json()).phase))
    const runs = () => s.seen.filter(r => r.method === 'POST' && r.path.endsWith('/runs') && JSON.stringify(r.body).includes('Held during a restart')).length
    const sent = await s.request('/v1/runs', post({ session_id: 'wizard_parity', input: 'Held during a restart' }))
    assert.ok(sent.status < 300, `${s.kind}: a send during the wait is accepted (${sent.status}), not refused`)
    await new Promise(r => setTimeout(r, 50))
    assert.equal(runs(), 0, `${s.kind}: the held send never reaches Hermes during the wait`)
    // A new chat started during the wait (wizard-ux issue 1362): its session has no messages yet, and its first
    // message is held. Every list (full, list view, archive-50 window) still names it, saved, with the owner's words.
    const heldNew = 'wizard_parity_held_new'
    assert.ok((await s.request('/api/sessions', post({ id: heldNew, source: 'wizard-mobile' }))).status < 300)
    const first = await s.request('/v1/runs', post({ session_id: heldNew, input: 'Held first message' }))
    assert.ok(first.status < 300, `${s.kind}: a new chat's first send during the wait is accepted (${first.status})`)
    for (const path of ['/api/sessions?limit=100', '/api/sessions?view=list', '/api/sessions?view=list&window=archive-50&limit=100']) {
      const listed = await (await s.request(path)).json()
      const row = (listed.data || listed.sessions || []).find(r => r.id === heldNew)
      assert.ok(row, `${s.kind}: ${path} lists the new chat whose first message is held`)
      assert.equal(row.status, 'queued', `${s.kind}: ${path} shows it saved (queued), not running`)
      assert.equal(row.title, 'Held first message', `${s.kind}: ${path} titles it with the owner's words`)
    }
    const status = await (await gate()).json()
    assert.equal(status.holding, true); assert.ok(status.held >= 2, `${s.kind}: the held sends are counted (${JSON.stringify(status)})`)
    const health = await (await s.raw('/wizard/health')).json()
    assert.equal(health.restart?.holding, true, 'health shows the restart wait for the shell')
    assert.equal(health.restart.turns, undefined, 'health carries no thread ids')
    // The owner's Restart now (wizard-ux issue 1362) reaches the restarter through the gate and health, and a later
    // wait clears it; without a hold it starts nothing.
    const now = await gate(post({ now: true }))
    assert.equal(now.status, 200, `${s.kind}: restart now is accepted while a hold waits (${now.status})`)
    assert.equal((await now.json()).restart_now, true)
    assert.equal((await (await gate()).json()).restart_now, true, `${s.kind}: the restarter sees restart_now`)
    assert.equal((await (await s.raw('/wizard/health')).json()).restart?.restart_now, true, `${s.kind}: the shell sees restart_now`)
    assert.equal((await (await gate(post({ wait_s: 60 }))).json()).restart_now, undefined, `${s.kind}: wait longer clears restart now`)
    const released = await gate({ method: 'DELETE' })
    assert.equal((await released.json()).released, true)
    for (let n = 0; n < 100 && !runs(); n++) await new Promise(r => setTimeout(r, 20))
    assert.equal(runs(), 1, `${s.kind}: the held send goes out once the hold lifts`)
    const firstRuns = () => s.seen.filter(r => r.method === 'POST' && r.path.endsWith('/runs') && JSON.stringify(r.body).includes('Held first message')).length
    for (let n = 0; n < 100 && !firstRuns(); n++) await new Promise(r => setTimeout(r, 20))
    assert.equal(firstRuns(), 1, `${s.kind}: the new chat's held first message goes out once`)
    assert.equal((await (await s.raw('/wizard/health')).json()).restart, undefined)
    const idle = await gate(post({ now: true }))
    assert.equal(idle.status, 409, `${s.kind}: restart now with no restart waiting is refused (${idle.status})`)
    assert.equal((await (await s.raw('/wizard/health')).json()).restart, undefined, `${s.kind}: restart now starts no hold`)
  },
  'stopped-helper-no-needs-you': async s => {
    // Issue 467: a helper the agent itself stopped, delivering after the agent's final done reply, never
    // raises the saved-result Needs you. A helper that finished on its own still offers Continue (main only:
    // the saved-result scan reads the main Hermes; routed kinds must stay without it).
    const at = Date.now() / 1000 - 3 * 3600
    const thread = (id, state) => s.sessions.set(id, { id, source: 'wizard-mobile', title: 'Synthetic helper', created_at: at - 200, messages: [
      { id: 1, role: 'user', content: 'Check the synthetic routing.', timestamp: at - 200 },
      { id: 2, role: 'assistant', finish_reason: 'stop', timestamp: at - 55, content: 'Routing checked.\n[WIZARD_STATUS_V1]{"state":"done","ask":"Routing is checked","subject":"Parity QA"}[/WIZARD_STATUS_V1]' },
      { id: 3, role: 'user', display_kind: 'async_delegation_complete', timestamp: at,
        content: `[ASYNC DELEGATION BATCH COMPLETE — deleg_${id}]\nA background fan-out unit you dispatched earlier has finished.\n\n--- ✗ TASK 1/1: Synthetic check (status=${state}, 9s) ---\nPartial output:\nsynthetic partial` }] })
    thread('wizard_parity_stopped', 'interrupted'); thread('wizard_parity_owed', 'completed')
    if (s.kind === 'main') {
      let listed
      for (let n = 0; n < 200; n++) {
        listed = await (await s.raw('/wizard/background-results', { headers: s.ownerHeaders })).json()
        if (!listed.scanning && listed.results?.length) break
        await new Promise(r => setTimeout(r, 25))
      }
      assert.deepEqual(listed.results.map(r => r.session_id), ['wizard_parity_owed'], 'only the helper that finished on its own offers Continue')
    }
    const rows = (await (await s.request('/api/sessions?limit=100')).json()).data
    const attention = id => rows.find(r => r.id === id)?.wizard_attention?.state
    assert.notEqual(attention('wizard_parity_stopped'), 'needs_you', `${s.kind}: a stopped helper after done is not Needs you`)
    if (s.kind !== 'main') assert.notEqual(attention('wizard_parity_owed'), 'needs_you', `${s.kind}: routed kinds keep no saved-result Needs you`)
    assert.ok(!s.seen.some(r => r.path.endsWith('/runs') && r.method === 'POST' && /wizard_parity_(stopped|owed)/.test(JSON.stringify(r.body))), 'discovery never starts work')
  },
  'background-continue': async s => {
    // Issue 14: one-tap Continue for a background result that finished while Wizard was down (over two hours ago).
    // Discovery starts nothing; one tap admits exactly one turn in the originating thread; a repeat tap replays it;
    // an owner message sent meanwhile is kept and its thread is not offered. Main only: the saved-result scan reads
    // the main Hermes, and routed kinds answer an explicit unsupported state instead of a silent nothing.
    const at = Date.now() / 1000 - 3 * 3600
    const batch = id => ({ id: 3, role: 'user', display_kind: 'async_delegation_complete', timestamp: at,
      content: `[ASYNC DELEGATION BATCH COMPLETE — deleg_${id}]\nA background fan-out unit you dispatched earlier has finished.\n\n--- ✓ TASK 1/1: Synthetic check (status=completed, 9s) ---\nsynthetic finding ${id}` })
    const thread = (id, extra = []) => s.sessions.set(id, { id, source: 'wizard-mobile', title: 'Synthetic helper', created_at: at - 200, messages: [
      { id: 1, role: 'user', content: 'Check the synthetic routing in the background.', timestamp: at - 200 },
      { id: 2, role: 'assistant', finish_reason: 'stop', timestamp: at - 190, content: 'Started a helper.\n[WIZARD_STATUS_V1]{"state":"working","ask":"Helper is checking","subject":"Parity QA"}[/WIZARD_STATUS_V1]' },
      batch(id), ...extra] })
    // The saved result sits past session 100 of the catalog, so discovery must walk every page.
    for (let n = 0; n < 100; n++) s.sessions.set(`wizard_parity_fill_${n}`, { id: `wizard_parity_fill_${n}`, source: 'wizard-mobile', title: 'Filler', created_at: at - 500, messages: [{ id: 1, role: 'user', content: 'Filler', timestamp: at - 500 }] })
    thread('wizard_parity_saved')
    thread('wizard_parity_moved', [{ id: 4, role: 'user', content: 'Owner wrote meanwhile.', timestamp: at + 600 }])
    const runsFor = id => s.seen.filter(r => r.method === 'POST' && r.path.endsWith('/v1/runs') && r.body?.session_id === id)
    const list = async (query = '') => {
      let listed
      for (let n = 0; n < 400; n++) {
        listed = await (await s.raw(`/wizard/background-results${query}`, { headers: s.ownerHeaders })).json()
        if (listed.error || (!listed.scanning && listed.scan_complete)) return listed
        await new Promise(r => setTimeout(r, 25))
      }
      return listed
    }
    const tap = (id, body) => s.raw(`/wizard/background-results/${id}/continue`, { method: 'POST', headers: { ...s.ownerHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (s.kind !== 'main') {
      const r = await s.raw(`/wizard/background-results?agent_id=${s.id}`, { headers: s.ownerHeaders })
      assert.deepEqual([r.status, (await r.json()).error], [409, 'unsupported_action'], `${s.kind}: saved-result listing is an explicit unsupported state`)
      const c = await tap(`bg_${'a'.repeat(32)}`, { session_id: 'wizard_parity_saved', agent_id: s.id })
      assert.deepEqual([c.status, (await c.json()).error], [409, 'unsupported_action'], `${s.kind}: Continue is an explicit unsupported state`)
      const rows = (await (await s.request('/api/sessions?limit=200')).json()).data
      assert.ok(!rows.some(r => r.wizard_background_result), `${s.kind}: routed lists carry no saved-result row`)
      assert.equal(runsFor('wizard_parity_saved').length, 0, `${s.kind}: nothing starts`)
      return
    }
    let listed
    for (let n = 0; n < 20; n++) {
      listed = await list()
      if (listed.results?.length) break
      await new Promise(r => setTimeout(r, 100))
    }
    assert.deepEqual(listed.results.map(r => r.session_id), ['wizard_parity_saved'], 'only the untouched thread offers Continue (the moved-on one keeps the owner message)')
    const [result] = listed.results
    assert.deepEqual([result.state, result.action, result.agent_id], ['ready', 'Continue', 'hermes'])
    assert.ok(listed.sessions.some(r => r.id === 'wizard_parity_saved' && r.wizard_attention?.state === 'needs_you'), 'the thread is discoverable even past the display window')
    assert.equal((await (await s.raw('/wizard/hermes/api/sessions/wizard_parity_moved/messages?order=oldest', { headers: s.ownerHeaders })).json()).data.at(-1).content, 'Owner wrote meanwhile.', 'the owner message is kept')
    await list(); await list()
    assert.equal(runsFor('wizard_parity_saved').length + runsFor('wizard_parity_moved').length, 0, 'discovery never starts a model')
    const wrong = await tap(result.id, { session_id: 'wizard_parity_moved' })
    assert.equal(wrong.status, 409, `a valid result tapped for another thread is refused (${wrong.status})`)
    assert.equal(runsFor('wizard_parity_moved').length + runsFor('wizard_parity_saved').length, 0, 'a refused tap starts nothing')
    const first = await tap(result.id, { session_id: 'wizard_parity_saved' })
    assert.equal(first.status, 202, `the tap is admitted (${first.status})`)
    const run = await first.json()
    const again = await tap(result.id, { session_id: 'wizard_parity_saved' })
    assert.equal(again.status, 202); assert.equal(again.headers.get('idempotency-replayed'), 'true', 'a repeat tap replays')
    assert.equal((await again.json()).run_id, run.run_id, 'a repeat tap is the same turn')
    for (let n = 0; n < 200 && !runsFor('wizard_parity_saved').length; n++) await new Promise(r => setTimeout(r, 25))
    await new Promise(r => setTimeout(r, 200))
    const sentRuns = runsFor('wizard_parity_saved')
    assert.equal(sentRuns.length, 1, 'exactly one turn in the originating thread')
    assert.ok(String(sentRuns[0].body.input).includes('The owner pressed Continue') && String(sentRuns[0].body.input).includes('synthetic finding wizard_parity_saved'), 'the turn carries the saved findings')
    assert.ok(!JSON.stringify(sentRuns[0].body).includes('_wizard_background_recovery'), 'the internal marker never reaches Hermes')
    assert.equal(runsFor('wizard_parity_moved').length, 0, 'the moved-on thread never resumes')
    const unknown = await tap(result.id.replace(/.$/, c => c === '0' ? '1' : '0'), { session_id: 'wizard_parity_saved' })
    assert.equal(unknown.status, 409, 'an unknown result is refused')
    assert.ok(!(await list()).results.some(r => r.session_id === 'wizard_parity_saved'), 'a continued result is no longer offered')
  },
  'needs-you-reason-dismiss': async s => {
    // Issue 469 (switch wizard/needs-you-reason, on in this scene): the saved-result Needs you the Service adds
    // itself carries its reason, and Dismiss (or Done / Archive through the thread-wide form) clears it on the box,
    // so every device's next read drops it. Main only, like the saved-result scan; routed kinds answer unsupported.
    const at = Date.now() / 1000 - 3 * 3600
    const thread = id => s.sessions.set(id, { id, source: 'wizard-mobile', title: 'Synthetic helper', created_at: at - 200, messages: [
      { id: 1, role: 'user', content: 'Check the synthetic routing in the background.', timestamp: at - 200 },
      { id: 2, role: 'assistant', finish_reason: 'stop', timestamp: at - 190, content: 'Started a helper.\n[WIZARD_STATUS_V1]{"state":"working","ask":"Helper is checking","subject":"Parity QA"}[/WIZARD_STATUS_V1]' },
      { id: 3, role: 'user', display_kind: 'async_delegation_complete', timestamp: at,
        content: `[ASYNC DELEGATION BATCH COMPLETE — deleg_${id}]\nA background fan-out unit you dispatched earlier has finished.\n\n--- ✓ TASK 1/1: Synthetic check (status=completed, 9s) ---\nsynthetic finding ${id}` }] })
    thread('wizard_parity_dismiss_a'); thread('wizard_parity_dismiss_b')
    const dismiss = (body, headers = {}) => s.raw('/wizard/background-results/dismiss', { method: 'POST', headers: { ...s.ownerHeaders, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
    const runsFor = id => s.seen.filter(r => r.method === 'POST' && r.path.endsWith('/v1/runs') && r.body?.session_id === id)
    if (s.kind !== 'main') {
      const r = await dismiss({ session_id: 'wizard_parity_dismiss_a', agent_id: s.id })
      assert.deepEqual([r.status, (await r.json()).error], [409, 'unsupported_action'], `${s.kind}: Dismiss is an explicit unsupported state`)
      const rows = (await (await s.request('/api/sessions?limit=200')).json()).data
      assert.ok(!rows.some(r => r.wizard_background_result), `${s.kind}: routed lists carry no saved-result row`)
      return
    }
    const list = async () => {
      let listed
      for (let n = 0; n < 400; n++) {
        listed = await (await s.raw('/wizard/background-results', { headers: s.ownerHeaders })).json()
        if (!listed.scanning && listed.scan_complete && listed.results?.length) return listed
        await new Promise(r => setTimeout(r, 25))
      }
      return listed
    }
    const listed = await list()
    const of = id => listed.results.find(r => r.session_id === id)
    const a = of('wizard_parity_dismiss_a'), b = of('wizard_parity_dismiss_b')
    assert.ok(a && b, 'both saved results are offered')
    assert.deepEqual([a.reason, a.actions], ['A helper finished after this chat closed', ['continue', 'dismiss']], 'the result carries its reason and its two actions')
    assert.equal(listed.sessions.find(r => r.id === 'wizard_parity_dismiss_a')?.wizard_attention?.ask, 'A helper finished after this chat closed', 'the Needs you says why')
    assert.equal((await dismiss({ session_id: 'wizard_parity_dismiss_a', id: a.id }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403, 'a cross-site page cannot dismiss')
    assert.equal((await dismiss({ session_id: 'wizard_parity_dismiss_b', id: a.id })).status, 409, 'a result of another thread is refused')
    const done = await dismiss({ session_id: 'wizard_parity_dismiss_a', id: a.id })
    assert.equal(done.status, 200, `Dismiss is accepted (${done.status})`)
    assert.deepEqual((await done.json()).ids, [a.id])
    const after = await list()
    assert.ok(!after.results.some(r => r.id === a.id) && !after.sessions.some(r => r.id === 'wizard_parity_dismiss_a'), 'a dismissed result is gone for every reader')
    const rows = (await (await s.request('/api/sessions?limit=200')).json()).data
    assert.ok(!rows.find(r => r.id === 'wizard_parity_dismiss_a')?.wizard_background_result, 'the thread row no longer carries it')
    const all = await (await dismiss({ session_id: 'wizard_parity_dismiss_b' })).json()
    assert.deepEqual(all.ids, [b.id], 'the thread-wide form (Done, Archive) clears that thread')
    // Archive sends it after the archive succeeded: the thread is out of the scan by then, and restoring it later
    // must not bring the stale Needs you back.
    thread('wizard_parity_dismiss_c'); s.sessions.get('wizard_parity_dismiss_c').archived = true
    assert.equal((await dismiss({ session_id: 'wizard_parity_dismiss_c' })).status, 200, 'an archived thread can be cleared')
    s.sessions.get('wizard_parity_dismiss_c').archived = false
    // Let at least two fresh scans run (the scene rescans every 100 ms) so the restored thread is read again.
    let restored
    for (let n = 0; n < 4; n++) { await new Promise(r => setTimeout(r, 250)); restored = await list() }
    assert.ok(!restored.results.some(r => r.session_id === 'wizard_parity_dismiss_c'), 'a restored archived thread does not bring the result back')
    const last = await (await s.raw('/wizard/background-results', { headers: s.ownerHeaders })).json()
    assert.ok(!last.results.some(r => /wizard_parity_dismiss_/.test(r.session_id)), 'nothing of either thread is offered any more')
    assert.equal(runsFor('wizard_parity_dismiss_a').length + runsFor('wizard_parity_dismiss_b').length, 0, 'Dismiss never starts work')
  },
  'new-chat-unreachable-agent': async s => {
    // Issue 448: one unreachable optional agent (no sealed catalog) must not stop new chats on this agent.
    // Registered after the scene's own session-create, as running, with an upstream that refuses connections.
    const quiet = join(s.root, 'os', 'agents', 'parity-quiet'); mkdirSync(quiet, { recursive: true })
    writeFileSync(join(quiet, 'agent.json'), JSON.stringify({ schema: 1, id: 'parity-quiet', label: 'Parity unreachable agent', harness: 'hermes', privacy: 'standard', appearance: { glyph: 'spark', hue: 200 }, model: { provider: 'anthropic', model: 'fixture-model', allowed_models: ['fixture-model'], fallback: false }, permissions: { preset: 'standard', ...PRESETS.find(p => p.id === 'standard').permissions }, runtime: { kind: 'container', app_id: 'agent-parity-quiet', port: 9 }, created_at: Date.now() / 1000 }))
    writeFileSync(join(quiet, 'runtime.key'), 'parity-quiet-secret', { mode: 0o600 })
    assert.ok((await (await s.raw('/wizard/v1/agents')).json()).agents.some(a => a.id === 'parity-quiet'), 'the unreachable agent is registered')
    const fresh = () => `wizard_${Date.now()}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
    const created = fresh(), r = await s.request('/api/sessions', post({ id: created, source: 'wizard-mobile' }))
    assert.equal(r.status, 201, `${s.kind}: new chat with a fresh client id while another agent is unreachable`)
    assert.ok(s.sessions.has(created), `${s.kind}: created on this agent's own runtime`)
    const sent = fresh(), run = await s.request('/v1/runs', post({ session_id: sent, input: 'First message of a new chat' }))
    assert.equal(run.status, 202, `${s.kind}: first send of a new chat is admitted`)
    // An id that is not a fresh client mint keeps the fail-closed anti-claim answer.
    const odd = await s.request('/api/sessions', post({ id: 'wizard_not_fresh', source: 'wizard-mobile' }))
    assert.deepEqual([odd.status, (await odd.json()).error], [503, 'agent_unavailable'], `${s.kind}: arbitrary ids still fail closed`)
    if (s.kind === 'main') {
      // A new chat that names no agent goes to the default agent the same way.
      const plain = fresh(), p = await s.raw('/wizard/hermes/api/sessions', post({ id: plain, source: 'wizard-mobile' }))
      assert.equal(p.status, 201); assert.ok(s.sessions.has(plain))
    }
  },
  'file-store-retention': async s => {
    // Issue 422: the built-in file store never forgets a file because more than 5,000 came after it.
    const firstBytes = Buffer.from('PARITY_FIRST_UPLOAD_BYTES\n')
    const r = await s.upload(firstBytes, 'first-upload.txt', 'text/plain'); assert.equal(r.status, 201)
    const first = (await r.json()).file
    const indexPath = join(s.root, 'media.json'), index = JSON.parse(readFileSync(indexPath))
    for (let n = 0; n < 5_001; n += 1) index.files.push({ id: `wf_${n.toString(16).padStart(32, '0')}`, rel: `Inbox/2026-10-10/filler-${n}.txt`, filename: `filler-${n}.txt`, mime: 'text/plain', bytes: 1, sha256: `filler-${n}`, created_at: '2026-10-10T12:00:00.000Z', duplicate_of: null })
    writeFileSync(indexPath, JSON.stringify(index))
    const later = await s.upload(Buffer.from('PARITY_LATER_UPLOAD\n'), 'later.txt', 'text/plain'); assert.equal(later.status, 201)
    assert.equal(JSON.parse(readFileSync(indexPath)).files.length, 5_003, 'no count limit drops records')
    const dup = await s.upload(firstBytes, 'first-again.txt', 'text/plain'); assert.equal(dup.status, 201)
    assert.equal((await dup.json()).file.duplicate_of, first.id, 'duplicate detection still sees the first file')
    const before = statSync(indexPath, { bigint: true })
    const opened = await s.raw(`/wizard/files/${first.id}/content`)
    assert.equal(opened.status, 200); assert.ok(opened.headers.get('content-type').startsWith('text/plain'))
    assert.deepEqual(Buffer.from(await opened.arrayBuffer()), firstBytes)
    const after = statSync(indexPath, { bigint: true })
    assert.deepEqual([after.ino, after.mtimeNs], [before.ino, before.mtimeNs], 'opening an attachment does not rewrite the list')
    await admit(s, { input: 'Read the first attached document again', wizard_file_ids: [first.id] })
    const body = sent(s), text = typeof body.input === 'string' ? body.input : body.input[0].content[0].text
    assert.ok(text.includes('trusted_path') && !text.includes('placement_error'), 'the agent still resolves the first file')
    if (['container', 'restricted'].includes(s.kind)) assert.deepEqual(Buffer.from(s.placed.at(-1).payload.data_base64, 'base64'), firstBytes)
  },
  // Issue 423: old Wizard Uploads files (drop_ ids) adopted by the one-time import open from their chat chips, ranges
  // included, and resolve for the agent on every kind; a dry run writes nothing and a second run adds nothing.
  'file-store-inbox-import': async s => {
    const data = join(s.root, 'old-wizard-inbox'), blobs = join(data, 'blobs', 'ab')
    mkdirSync(blobs, { recursive: true })
    const dbPath = join(data, 'inbox.sqlite3'), db = new DatabaseSync(dbPath)
    db.exec(`CREATE TABLE drops (id TEXT PRIMARY KEY, upload_id TEXT, device_id TEXT, filename TEXT, mime TEXT, bytes INTEGER,
      sha256 TEXT, note TEXT, duplicate_of TEXT, blob_path TEXT, created_at REAL)`)
    const image = png, voice = Buffer.from('PARITY_OLD_VOICE_NOTE_BYTES')
    const old = [[`drop_${'1'.repeat(32)}`, 'old-photo.png', 'image/png', image], [`drop_${'2'.repeat(32)}`, 'old-voice.m4a', 'audio/mp4', voice]]
    for (const [id, filename, mime, bytes] of old) {
      const hash = createHash('sha256').update(bytes).digest('hex'), blob = join(blobs, hash)
      writeFileSync(blob, bytes)
      db.prepare('INSERT INTO drops (id, filename, mime, bytes, sha256, blob_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, filename, mime, bytes.length, hash, `blobs/ab/${hash}`, 1_762_000_000)
    }
    db.close()
    const run = dryRun => importInboxUploads({ inboxDbPath: dbPath, mediaRoot: join(s.root, 'files'), indexPath: join(s.root, 'media.json'), dryRun })
    const listed = () => existsSync(join(s.root, 'media.json')) ? JSON.parse(readFileSync(join(s.root, 'media.json'))).files.length : 0
    const before = listed()
    assert.equal(run(true).counts.imported, 2); assert.equal(listed(), before, 'a dry run writes nothing')
    assert.deepEqual([run(false).counts.imported, run(false).counts.already_present], [2, 2], 'a second run adds nothing')
    assert.equal(listed(), before + 2)
    const photo = await s.raw(`/wizard/files/${old[0][0]}/content`)
    assert.equal(photo.status, 200); assert.ok(photo.headers.get('content-type').startsWith('image/png'))
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), image)
    const part = await s.raw(`/wizard/files/${old[1][0]}/content`, { headers: { Range: 'bytes=6-' } })
    assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), `bytes 6-${voice.length - 1}/${voice.length}`)
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), voice.subarray(6))
    await admit(s, { input: 'Look at the old photo again', wizard_file_ids: [old[0][0]] })
    const body = sent(s), text = typeof body.input === 'string' ? body.input : body.input[0].content[0].text
    assert.ok(text.includes('trusted_path') && !text.includes('placement_error'), 'the agent resolves the old photo')
    if (['container', 'restricted'].includes(s.kind)) assert.deepEqual(Buffer.from(s.placed.at(-1).payload.data_base64, 'base64'), image)
  },
  'read-receipts': async s => {
    const now = Date.now(), record = { agent_id: s.id, session_id: 'wizard_parity', updatedAt: new Date(now).toISOString(), previewFingerprint: 'synthetic', messageCount: 2, status: 'completed', seenAt: now }
    const retiredKey = 'agent/retired/direct:retired-thread'
    const r = await s.raw('/wizard/thread-seen', { ...post({ initializedAt: now, threads: {
      [retiredKey]: { ...record, agent_id: 'retired', session_id: 'retired-thread' },
      'direct:wizard_parity': record,
    } }), method: 'PUT' })
    assert.equal(r.status, 200)
    assert.equal((await r.json()).state.threads[retiredKey], undefined)
    const noop = await s.raw('/wizard/thread-seen', { ...post({ threads: { [retiredKey]: {
      agent_id: 'retired', session_id: 'retired-thread', seenAt: '2026-10-25T00:00:00Z',
    } } }), method: 'PUT' })
    assert.equal(noop.status, 200)
    const unreadAt = now + 1
    const unread = await s.raw('/wizard/thread-seen', { ...post({ initializedAt: now, threads: { 'direct:wizard_parity': { ...record, unreadAt } } }), method: 'PUT' })
    assert.equal(unread.status, 200)
    await s.restart()
    const state = await (await s.raw('/wizard/thread-seen')).json()
    const records = Object.values(state.state.threads)
    assert.equal(records.length, 1)
    assert.equal(records[0].agent_id, s.id); assert.equal(records[0].session_id, 'wizard_parity'); assert.equal(records[0].seenAt, now); assert.equal(records[0].unreadAt, unreadAt)
    // Mark done (wizard-ux issue 1317): the reply the thread was handled through survives a later read without it and a restart.
    const handledThrough = new Date(now).toISOString()
    assert.equal((await s.raw('/wizard/thread-seen', { ...post({ initializedAt: now, threads: { 'direct:wizard_parity': { ...record, seenAt: now + 2, handledThrough } } }), method: 'PUT' })).status, 200)
    assert.equal((await s.raw('/wizard/thread-seen', { ...post({ initializedAt: now, threads: { 'direct:wizard_parity': { ...record, seenAt: now + 3 } } }), method: 'PUT' })).status, 200)
    await s.restart()
    const handled = Object.values((await (await s.raw('/wizard/thread-seen')).json()).state.threads)
    assert.equal(handled.length, 1); assert.equal(handled[0].agent_id, s.id); assert.equal(handled[0].seenAt, now + 3); assert.equal(handled[0].handledThrough, handledThrough)
  },
  // Issue 513: one looping device only slows itself, on every kind. Its 61st identical seen write in a minute is a
  // 429 with Retry-After (never queued), its first write is saved for this kind's thread, and another device's
  // writes (seen state and this kind's own session) still go through. Health names the tripping lane.
  'client-storm-guard': async s => {
    const now = Date.now(), record = { agent_id: s.id, session_id: 'wizard_parity', updatedAt: new Date(now).toISOString(), previewFingerprint: 'synthetic', messageCount: 2, status: 'completed', seenAt: now }
    const body = post({ initializedAt: now, threads: { 'direct:wizard_parity': record } })
    const phone = { ...body, method: 'PUT', headers: { ...body.headers, 'User-Agent': 'SyntheticLoopingPhone/1' } }
    const statuses = []
    for (let i = 0; i < 61; i++) { const r = await s.raw('/wizard/thread-seen', phone); statuses.push(r.status); if (r.status === 429) assert.ok(Number(r.headers.get('retry-after')) >= 1); await r.arrayBuffer() }
    assert.deepEqual(statuses.slice(0, 60), Array(60).fill(200)); assert.equal(statuses[60], 429)
    const saved = Object.values((await (await s.raw('/wizard/thread-seen')).json()).state.threads)
    assert.equal(saved.length, 1); assert.equal(saved[0].agent_id, s.id); assert.equal(saved[0].session_id, 'wizard_parity')
    const mac = { 'User-Agent': 'SyntheticSecondDevice/1' }
    const other = post({ initializedAt: now, threads: { 'direct:wizard_parity': { ...record, seenAt: now + 1 } } })
    assert.equal((await s.raw('/wizard/thread-seen', { ...other, method: 'PUT', headers: { ...other.headers, ...mac } })).status, 200)
    const rename = post({ hidden: false, title: 'Parity · storm' })
    assert.equal((await s.request('/api/sessions/wizard_parity', { ...rename, method: 'PATCH', headers: { ...rename.headers, ...mac } })).status, 200)
    const health = await (await s.raw('/wizard/health')).json()
    assert.equal(health.client_storm.tripping.length, 1)
    assert.equal(health.client_storm.tripping[0].route, '/wizard/thread-seen'); assert.equal(health.client_storm.tripping[0].rate, 61)
  },
  'session-slim-index': async s => {
    const now=Date.now()/1000;
    for(let i=0;i<165;i++) s.sessions.set(`wizard_slim_${i}`,{id:`wizard_slim_${i}`,source:'wizard-mobile',title:`Slim archive ${i}`,created_at:now-20*86400-i,archived:true,hidden:false,messages:[{role:'user',content:'Slim visible preview',timestamp:now-20*86400-i}]});
    s.sessions.set('wizard_hidden_private',{id:'wizard_hidden_private',source:'wizard-mobile',title:'Private title sentinel',hidden:true,created_at:now,messages:[{role:'user',content:'Private hidden preview',timestamp:now}]});
    if(s.kind==='main') await s.restart();
    const r=await s.request('/api/sessions?view=list&window=archive-50&fields=slim&limit=500'); assert.equal(r.status,200);
    const page=await r.json(); assert.equal(page.fields,'slim'); assert(page.build); assert.equal(page.archive_total,165); assert.equal(page.data.length,50);
    assert(!JSON.stringify(page).includes('Private title sentinel')); assert(page.data.every(row=>row.agent===s.id&&row.preview.length<=160&&!('latest_message'in row)&&!('request'in row)));
    const tail=await (await s.request('/api/sessions?view=list&window=archive-50&fields=slim&limit=500&cursor='+page.archive_cursor)).json();
    assert.equal(tail.data.length,115); assert.equal(tail.archive_cursor,null); assert.equal(tail.build,page.build);
    if(s.kind!=='main') { const main=await (await s.raw('/wizard/hermes/api/sessions?view=list&window=archive-50&fields=slim')).json(); assert(!main.data.some(row=>row.id.startsWith('wizard_slim_')),'main index never unions a routed runtime'); }
  },
  'archive-age': async s => {
    const now=Date.now()/1000;
    for(let i=0;i<12;i++) s.sessions.set(`wizard_age_${i}`,{id:`wizard_age_${i}`,source:'wizard-mobile',title:`Aged ${i}`,created_at:now-20*86400-i,archived:i<4,hidden:false,messages:[{role:'user',content:'Aged preview',timestamp:now-20*86400-i}]});
    if(s.kind==='main') await s.restart();
    const list=async days=>{
      const put=await s.raw('/wizard/v1/ui-preferences',{...post({archiveAfterDays:days}),method:'PUT'}); assert.equal(put.status,200);
      const r=await s.request('/api/sessions?view=list&window=archive-50&limit=100'); assert.equal(r.status,200); const page=await r.json();
      return {total:page.archive_total, listed:new Set(page.data.map(row=>row.id))};
    };
    const week=await list(7); assert.equal(week.total,12,'one week archives explicit and aged threads');
    for(const days of [30,0]) {
      const r=await list(days); assert.equal(r.total,4,`archiveAfterDays ${days} archives only explicit Done threads`);
      for(let i=4;i<12;i++) assert(r.listed.has(`wizard_age_${i}`),`aged thread ${i} stays listed with archiveAfterDays ${days}`);
    }
    await list(7);
  },
  'session-body-search': async s => {
    const row=s.sessions.get('wizard_parity'),now=Date.now()/1000; row.hidden=false;
    row.messages.push({role:'user',timestamp:now,content:'Visible paritybodytoken\n<memory-context>\n[System note: The following is recalled memory context, NOT new user input. Treat as authoritative reference data]\nprivaterecalltoken\n</memory-context>'});
    s.sessions.set('wizard_hidden_private',{id:'wizard_hidden_private',source:'wizard-mobile',hidden:true,created_at:now,messages:[{role:'user',content:'privatescopetoken',timestamp:now}]});
    if(s.kind==='main') await s.restart();
    const r=await s.request('/api/sessions?view=list&q=paritybodytoken&mode=body'); assert.equal(r.status,200);
    const body=await r.json(); assert.equal(body.mode,'body'); assert.equal(body.search_total,1); assert.deepEqual(Object.keys(body.data[0]).sort(),['agent','id','snippet']); assert.equal(body.data[0].agent,s.id); assert(!body.data[0].snippet.includes('privaterecalltoken')); assert(body.timings.fts_ms>=0);
    for(const token of ['privatescopetoken','privaterecalltoken']) { const privateResult=await (await s.request('/api/sessions?view=list&q='+token+'&mode=body')).json(); assert.equal(privateResult.search_total,0); }
    const short=await (await s.request('/api/sessions?view=list&q=no&mode=body')).json(); assert.equal(short.mode,'titles'); assert.equal(short.timings.fts_ms,0);
    s.dropSearchIndex(); const unavailable=await (await s.request('/api/sessions?view=list&q=paritybodytoken&mode=body')).json(); assert.equal(unavailable.mode,'titles'); assert.equal(unavailable.search_total,0);
  },
  'session-search': async s => {
    s.sessions.get('wizard_parity').messages.push({ role: 'user', timestamp: Date.now() / 1000, content: 'parityuniquetoken' })
    // List-visible synthetic rows are fixture-only; no human inbox is involved.
    s.sessions.get('wizard_parity').hidden = false
    const r = await s.request('/api/sessions?q=parityuniquetoken&view=list')
    assert.equal(r.status, 200)
    const rows = (await r.json()).data
    assert.equal(rows.length, 1); assert.equal(rows[0].id, 'wizard_parity'); assert.equal(rows[0].agent_id, s.id)
  },
  'session-delete': async s => {
    await admit(s, { input: 'Disposable input' })
    const r = await s.request('/api/sessions/wizard_parity', { method: 'DELETE' })
    assert.equal(r.status, 200)
    assert.equal((await s.request('/api/sessions/wizard_parity')).status, 404)
    const list = await (await s.request('/api/sessions')).json()
    assert.ok(!list.data.some(row => row.id === 'wizard_parity'))
    await s.restart()
    assert.equal((await s.request('/api/sessions/wizard_parity')).status, 404)
  },
  'voice-notes': async s => {
    // Valid 100-ms mono PCM WAV. No pretend speech/transcript inference here.
    const audio = Buffer.alloc(44 + 3200)
    audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8)
    audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22)
    audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34)
    audio.write('data', 36); audio.writeUInt32LE(3200, 40)
    const upload = await s.upload(audio, 'wizard-voice-fixture.wav', 'audio/wav'); assert.equal(upload.status, 201)
    const file = (await upload.json()).file
    await admit(s, { input: 'Synthetic supplied transcript', model: 'fixture-other', provider: 'anthropic', wizard_file_ids: [file.id] })
    const body = sent(s)
    assert.equal(body.model, 'fixture-other'); assert.ok(JSON.stringify(body.input).includes('Synthetic supplied transcript'))
    assert.ok(JSON.stringify(body.input).includes('audio/wav'))
    if (['container', 'restricted'].includes(s.kind)) assert.deepEqual(Buffer.from(s.placed.at(-1).payload.data_base64, 'base64'), audio)
    const messages = JSON.stringify(await history(s))
    assert.ok(messages.includes('audio/wav')); assert.ok(!messages.includes('trusted_path'))
  },
  'transcription': async s => {
    // HTTP format/no-speech boundary only; a real recognizer is a separate live acceptance lane.
    for (const mime of ['audio/wav', 'audio/aac', 'audio/mp4', 'audio/webm;codecs=opus']) {
      const r = await s.raw('/wizard/voice/transcribe', { method: 'POST', headers: { 'Content-Type': mime }, body: Buffer.alloc(2048, 1) })
      assert.equal(r.status, 200); assert.equal((await r.json()).text, s.stt.text)
    }
    s.stt.text = ''
    const silent = await s.raw('/wizard/voice/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: Buffer.alloc(2048) })
    assert.deepEqual((({ text, no_speech }) => ({ text, no_speech }))(await silent.json()), { text: '', no_speech: true })
    const invalid = await s.raw('/wizard/voice/transcribe', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'not audio' })
    assert.equal(invalid.status, 415)
  },
  'history-pagination': async s => {
    const row = s.sessions.get('wizard_parity')
    row.messages = Array.from({ length: 7 }, (_, i) => ({ id: `history-${i}`, role: i % 2 ? 'assistant' : 'user', content: `Synthetic page ${i}`, timestamp: Date.now() / 1000 + i }))
    for (const order of ['oldest', 'latest']) {
      const ids = []
      for (let offset = 0; offset < 7; offset += 3) {
        const r = await s.request(`/api/sessions/wizard_parity/messages?view=wizard&order=${order}&limit=3&offset=${offset}`)
        assert.equal(r.status, 200); const page = await r.json()
        assert.equal(page.has_more, offset + 3 < 7); ids.push(...page.data.map(m => m.id))
      }
      let expected = row.messages.map(m => m.id); if (order === 'latest') { const descending = [...expected].reverse(); expected = []; for (let i = 0; i < descending.length; i += 3) expected.push(...descending.slice(i, i + 3).reverse()) }
      assert.deepEqual(ids, expected)
    }
  },
  'app-context': async s => {
    const changed = await s.raw('/wizard/v1/apps/parity-qa/binding', { ...post({agent:s.id}),method:'PUT' });assert.equal(changed.status,200)
    await s.restart()
    const binding = await (await s.raw('/wizard/v1/apps/parity-qa/binding')).json()
    assert.equal(binding.binding.agent,s.id)
    const r = await s.raw(`/wizard/hermes/v1/runs?agent=${binding.binding.agent}`,post({session_id:'wizard_parity',input:'Synthetic owner question about bound app',instructions:'[WizardOS context] Window in front: Synthetic Parity App. Visible on screen: Bound synthetic context '+ 'X'.repeat(12000)}))
    assert.equal(r.status,202);assert.equal((await r.json()).agent_id,s.id)
    const body=sent(s)
    assert.ok(body.instructions.includes('Synthetic Parity App'));assert.ok(body.instructions.includes('Background only:'))
    assert.ok(!body.instructions.includes('X'.repeat(6000)),'screen context stays bounded')
    assert.equal(body.wizard_file_ids,undefined)
    assert.ok(!JSON.stringify(body).includes(s.root));assert.ok(!JSON.stringify(body).includes('parity-runtime-secret'))
    const target=s.seen.filter(x=>x.method==='POST'&&x.path.endsWith('/v1/runs')).at(-1)
    assert.equal(target.path,s.kind==='host-profile'?'/p/parity-profile/v1/runs':'/v1/runs')
  },
  'app-job-routing': async s => {
    // A synthetic app with a job and a shipped skill, installed the App Manager way: apps.json + its skill beside it.
    // The Service's own skills folder (the one the agent reads) is a different folder, as on a standard install where
    // the Service runs as a container app, so the app's skill must be copied there for skill_view to find it.
    const osHome = join(s.root, 'os'), skills = join(osHome, 'skills')
    const source = join(s.root, 'skills', 'parity-video')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'SKILL.md'), '---\nname: parity-video\ndescription: Synthetic app workflow.\n---\nCall make_short.\n')
    const appSkill = join(skills, 'parity-video', 'SKILL.md')
    const app = { id: 'parity-video', name: 'Synthetic Video', status: 'running', provides: ['short-form-video'], skill: 'skills/parity-video/SKILL.md', mcp: { url: 'http://127.0.0.1:9/mcp' } }
    const install = apps => writeFileSync(join(s.root, 'apps.json'), JSON.stringify({ schema: 1, apps }))
    const kernel = async () => {
      const r = await s.agentMcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'parity' } })
      assert.equal(r.status, 200, 'gateway answers with this kind\'s own credential and transport')
      return (await r.json()).result.instructions
    }
    const pointer = join(skills, 'wizard-job-short-form-video', 'SKILL.md')
    const parityQa = { id: 'parity-qa', name: 'Synthetic Parity App', view: '/parity/', agent_binding: true }
    // wizard-os issue 800: "draft a message" must reach the messaging app (owner words in the pointer, first in the job map).
    const chat = { id: 'parity-chat', name: 'Synthetic Chat', status: 'running', provides: ['messaging'], mcp: { url: 'http://127.0.0.1:9/mcp' } }
    const chatPointer = join(skills, 'wizard-job-messaging', 'SKILL.md')
    if (s.kind !== 'main') {
      // The install picker ticks this standard agent for the new app (#58): its own list, nothing else.
      const file = join(osHome, 'agents', s.id, 'agent.json'), agent = JSON.parse(readFileSync(file, 'utf8'))
      agent.permissions.wizard_apps = [...new Set([...(agent.permissions.wizard_apps || []), 'parity-video', 'parity-chat'])]
      writeFileSync(file, JSON.stringify(agent))
    }
    install([parityQa, app, chat]); await s.restart()
    const text = await kernel()
    // Inspect the real gateway handler's initialize output on EACH runtime transport,
    // not renderKernel() or a source-text assertion. Upstream Hermes remains synthetic.
    const assertRules = value => {
      assert.equal(typeof value, 'string', `${s.kind}: gateway kernel instructions`)
      const lines = value.split('\n')
      for (const rule of [
        'Never ask the owner what an installed app can answer: call its tools first; if missing, list apps, retry once, never blame access. Never guess from old chats or call app URLs.',
        'Answer from the source of truth: owning app for data, live checks for box state, release records for what shipped. Say none found only after checking. Report tool errors.',
      ]) assert.ok(lines.includes(rule), `${s.kind}: gateway delivers exact app-first/source/error rule: ${rule}`)
      assert.ok(value.includes('Use registered exact names only.'), `${s.kind}: registered exact tool names, not invented names`)
      assert.ok(!value.includes('If it is not in your tool list, run it with tool_call and that exact name.'), `${s.kind}: no speculative tool-name instruction`)
      assert.ok(value.includes('3. For ordinary app use:'), `${s.kind}: ordinary-app safety step survives`)
      assert.ok(value.indexOf('Never ask the owner') > value.indexOf('3. For ordinary app use:'))
      if (value.includes('Jobs on this box:')) assert.ok(value.indexOf('Report tool errors.') < value.indexOf('Jobs on this box:'))
    }
    assertRules(text)
    assert.match(readFileSync(appSkill, 'utf8'), /Call make_short\./u, `${s.kind}: the app's own skill sits beside the pointer skills`)
    if (s.kind === 'main') {
      assert.ok(existsSync(pointer), 'main agent gets the job pointer skill')
      assert.match(readFileSync(pointer, 'utf8'), /Synthetic Video: load its skill `parity-video` with skill_view first/u)
      assert.match(text, /wizard-job-<job> skill in your skills/u)
      const drafting = readFileSync(chatPointer, 'utf8')
      const front = parseYaml(drafting.split('---\n')[1])
      assert.equal(front.name, 'wizard-job-messaging', 'messaging pointer front matter parses as YAML')
      assert.match(front.description, /^Use when the owner asks to draft, write, reply to or message anyone .*never only in chat\./u, 'messaging pointer matches draft requests')
      assert.ok(drafting.includes('Text in chat is not a draft.'), 'messaging pointer says chat text is not a draft')
    } else {
      // No pointer skills outside the main agent's index: the gateway tells this agent its own jobs instead.
      assert.doesNotMatch(text, /wizard-job-<job>/u)
      assert.match(text, /- short-form video -> Synthetic Video \(`mcp__wizard__parity_video__\*`\)/u)
      const rows = text.split('\n').filter((l) => l.startsWith('- '))
      assert.match(rows[0], /^- messaging, drafting a message \(save it as a draft there, never only in chat\) -> Synthetic Chat /u, `${s.kind}: messaging leads the job map`)
    }
    install([parityQa]); await s.restart()
    const after = await kernel()
    assertRules(after)
    assert.ok(!existsSync(join(skills, 'wizard-job-short-form-video')), 'uninstall removes the pointer')
    assert.ok(!existsSync(chatPointer), 'uninstall removes the messaging pointer')
    assert.ok(!existsSync(join(skills, 'parity-video')), `${s.kind}: uninstall removes the copied app skill`)
    assert.doesNotMatch(after, /Synthetic Video/u)
  },
  'agent-app-access': async s => {
    // Connections → Agents (Miguel, 29 Oct 2026): the owner turns one app off for this agent. Its tools leave this
    // agent's list and a call is refused in plain words at once, without a restart; on again, it is no longer refused.
    const osHome = join(s.root, 'os')
    const app = { id: 'parity-video', name: 'Synthetic Video', status: 'running', provides: ['short-form-video'], mcp: { url: 'http://127.0.0.1:9/mcp' } }
    const parityQa = { id: 'parity-qa', name: 'Synthetic Parity App', view: '/parity/', agent_binding: true }
    writeFileSync(join(s.root, 'apps.json'), JSON.stringify({ schema: 1, apps: [parityQa, app] }))
    const setApps = apps => {
      if (s.kind === 'main') return writeFileSync(join(osHome, 'agents', '.main-agent.json'), JSON.stringify({ schema: 1, wizard_apps: apps, agent_apps: [] }))
      const file = join(osHome, 'agents', s.id, 'agent.json'), agent = JSON.parse(readFileSync(file, 'utf8'))
      agent.permissions.wizard_apps = apps; agent.permissions.agent_apps = []
      writeFileSync(file, JSON.stringify(agent))
    }
    const call = async () => {
      const r = await s.agentMcp('tools/call', { name: 'parity_video__make_short', arguments: {} })
      assert.equal(r.status, 200, 'gateway answers with this kind\'s own credential and transport')
      return (await r.json()).result
    }
    setApps(['parity-qa', 'parity-video']); await s.restart()
    assert.doesNotMatch((await call()).content[0].text, /not allowed/u, 'an app that is on is never refused')
    setApps(['parity-qa'])
    const refused = await call()
    assert.equal(refused.isError, true)
    assert.match(refused.content[0].text, /^.+ is not allowed to use Synthetic Video\. The owner can turn it on in Connections\.$/u)
    const listed = await s.agentMcp('tools/list')
    assert.ok(!(await listed.json()).result.tools.some(t => t.name.startsWith('parity_video__')), 'turned-off app leaves the tool list')
    setApps(['parity-qa', 'parity-video'])
    assert.doesNotMatch((await call()).content[0].text, /not allowed/u, 'on again: no restart needed')
  },
  'capability-registry': async s => {
    // Issue 463: agents find what the box already does (built-ins, host voice service, app jobs) before installing
    // their own. One owner switch (wizard/capability-registry in the Look file): off = no tool, the old kernel line.
    const osHome = join(s.root, 'os')
    const look = on => { const dir = join(s.root, 'Pages', 'wizard-look'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'look.json'), JSON.stringify({ version: 1, skin: null, tweaks: { 'wizard/capability-registry': { on, at: Date.now() } } })) }
    const video = { id: 'parity-video', name: 'Synthetic Video', status: 'running', provides: ['short-form-video'], mcp: { url: 'http://127.0.0.1:9/mcp' } }
    const notes = { id: 'parity-notes', name: 'Synthetic Notes', status: 'running', provides: ['notes'], mcp: { url: 'http://127.0.0.1:9/mcp' } }
    const parityQa = { id: 'parity-qa', name: 'Synthetic Parity App', view: '/parity/', agent_binding: true }
    writeFileSync(join(s.root, 'apps.json'), JSON.stringify({ schema: 1, apps: [parityQa, video, notes] }))
    const setApps = apps => {
      if (s.kind === 'main') return writeFileSync(join(osHome, 'agents', '.main-agent.json'), JSON.stringify({ schema: 1, wizard_apps: apps, agent_apps: [] }))
      const file = join(osHome, 'agents', s.id, 'agent.json'), agent = JSON.parse(readFileSync(file, 'utf8'))
      agent.permissions.wizard_apps = apps; agent.permissions.agent_apps = []
      writeFileSync(file, JSON.stringify(agent))
    }
    // After the restart: a new apps.json joins the main agent's list on start (syncApps), so narrow it again.
    setApps(['parity-qa', 'parity-video']); await s.restart(); setApps(['parity-qa', 'parity-video'])
    const names = async () => { const r = await s.agentMcp('tools/list'); assert.equal(r.status, 200, 'own gateway credential and transport'); return (await r.json()).result.tools.map(t => t.name) }
    const call = async args => (await (await s.agentMcp('tools/call', { name: 'wizard_capabilities', arguments: args })).json()).result
    const kernel = async () => (await (await s.agentMcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'parity' } })).json()).result.instructions
    // Off: nothing changes.
    look(false)
    assert.ok(!(await names()).includes('wizard_capabilities'), 'switch off: no lookup tool')
    assert.match((await call({})).content[0].text, /^No installed app has a tool called wizard_capabilities/u)
    const off = await kernel()
    assert.ok(off.includes('never install speech models') && !off.includes('Built in:'), 'switch off: the old kernel')
    assert.equal((await s.raw('/wizard/v1/capabilities')).status, 404, 'switch off: no owner route')
    if (s.kind !== 'main') { await admit(s, { input: 'Synthetic: switch off' }); assert.ok(!sent(s).instructions.includes('wizard_capabilities'), 'switch off: no run note') }
    // On: an open MCP session is told its tool list changed (a cached list would miss the tool), then lists it.
    const init = await s.agentMcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'parity' } })
    const sid = init.headers.get('mcp-session-id')
    const stream = await s.agentMcpStream(sid)
    try {
      assert.equal(stream.status, 200, 'session event stream on this kind\'s transport')
      look(true)
      const changed = () => stream.frames.join('').includes('notifications/tools/list_changed')
      for (let n = 0; n < 100 && !changed(); n++) await new Promise(resolve => setTimeout(resolve, 50))
      assert.ok(changed(), 'switching on sends tools/list_changed to open sessions')
    } finally { stream.close() }
    assert.ok((await names()).includes('wizard_capabilities'), 'switch on: the lookup tool is served')
    const index = (await call({})).content[0].text
    assert.match(index, /- transcription: Wizard Voice Service \(host-service\), tool `wizard_transcribe`, ready/u)
    assert.match(index, /- short form video: Synthetic Video \(app\), tool `parity_video__\*`/u)
    assert.match(index, /- notes: Synthetic Notes \(app\), tool `parity_notes__\*`, not-granted\. Synthetic Notes does notes on this box but is not granted to .+\. Ask the owner to allow Synthetic Notes for .+ in Connections/u, 'an app it may not use: not-granted plus the exact ask')
    const detail = JSON.parse((await call({ job: 'can you transcribe audio?' })).content[0].text)
    assert.equal(detail.matches[0].tool, 'wizard_transcribe'); assert.equal(detail.matches[0].status, 'ready')
    assert.ok(detail.matches[0].inputs?.properties?.path, 'details carry the tool inputs')
    const data = JSON.parse((await call({ format: 'json' })).content[0].text)
    assert.equal(data.schema, 'wizard.capabilities/1'); assert.equal(data.guard, true)
    assert.ok(data.capabilities.find(r => r.job === 'transcription').equivalents.includes('faster-whisper'), 'the guard reads known duplicates')
    const on = await kernel()
    assert.ok(on.includes('Built in: transcription') && on.includes('wizard_capabilities') && !on.includes('never install speech models'), 'switch on: one generated index line')
    assert.ok(on.split('\nJobs on this box:')[0].length <= 1300, 'the kernel stays within its budget')
    // A gap is said plainly and recorded (words + agent id); the owner sees it and can turn the guard off per agent.
    assert.match((await call({ job: 'ocr a scanned pdf' })).content[0].text, /^Nothing on this box does "ocr a scanned pdf" yet\. Tell the owner plainly/u)
    const view = await (await s.raw('/wizard/v1/capabilities')).json()
    assert.ok(view.gaps.some(g => g.agent === s.id && g.words === 'ocr scanned pdf'), 'gap recorded for the owner')
    const patch = guard => s.raw('/wizard/v1/capabilities', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: s.id, guard }) })
    assert.equal((await patch(false)).status, 200)
    assert.equal(JSON.parse((await call({ format: 'json' })).content[0].text).guard, false, 'owner turned the guard off for this agent')
    assert.equal((await patch(true)).status, 200)
    if (s.kind !== 'main') {
      // A routed agent has no kernel: its run note carries the same index.
      await s.request('/api/sessions', post({ id: 'wizard_parity_capabilities' }))
      await admit(s, { session_id: 'wizard_parity_capabilities', input: 'Synthetic: can you transcribe audio?' })
      assert.match(sent(s).instructions, /Built into this box for you: transcription, .+ call wizard_capabilities\./u, 'routed run note names the lookup')
      // Privacy seal: a private agent is not offered the shared voice service or another agent's private app.
      s.setSupervisorSeal('private', false)
      try {
        const sealed = (await call({})).content[0].text
        assert.ok(!sealed.includes('transcription'), 'private agent: no transcription')
        assert.ok(!sealed.includes('Synthetic Notes'), 'private agent: no not-granted names')
      } finally { s.setSupervisorSeal('standard', true) }
    }
    look(false)
    assert.ok(!(await names()).includes('wizard_capabilities'), 'switched off again: gone')
  },
  'tools-list-cache-hints': async s => {
    // Issue 435: tools/list carries SEP-2549 cache hints so Hermes `lazy: true` can register app tools at chat start.
    // A complete discovery is cacheable for a day; an app that cannot answer makes the whole list ttlMs 0.
    const { createServer } = await import('node:http')
    const app = createServer((req, res) => {
      let body = ''; req.on('data', c => { body += c }); req.on('end', () => {
        const msg = JSON.parse(body || '{}')
        if (msg.id === undefined) { res.writeHead(202); return res.end() }
        const result = msg.method === 'tools/list' ? { tools: [{ name: 'make_short', description: 'Synthetic', inputSchema: { type: 'object', properties: {} } }] } : { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'parity-video', version: '1' } }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
      })
    })
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
    try {
      const osHome = join(s.root, 'os')
      const video = { id: 'parity-video', name: 'Synthetic Video', status: 'running', provides: ['short-form-video'], mcp: { url: `http://127.0.0.1:${app.address().port}/mcp` } }
      const down = { id: 'parity-down', name: 'Synthetic Down', status: 'running', provides: ['notes'], mcp: { url: 'http://127.0.0.1:9/mcp' } }
      const parityQa = { id: 'parity-qa', name: 'Synthetic Parity App', view: '/parity/', agent_binding: true }
      const install = (apps, ids) => {
        writeFileSync(join(s.root, 'apps.json'), JSON.stringify({ schema: 1, apps: [parityQa, ...apps] }))
        if (s.kind === 'main') return writeFileSync(join(osHome, 'agents', '.main-agent.json'), JSON.stringify({ schema: 1, wizard_apps: ['parity-qa', ...ids], agent_apps: [] }))
        const file = join(osHome, 'agents', s.id, 'agent.json'), agent = JSON.parse(readFileSync(file, 'utf8'))
        agent.permissions.wizard_apps = ['parity-qa', ...ids]; agent.permissions.agent_apps = []
        writeFileSync(file, JSON.stringify(agent))
      }
      const list = async () => {
        const r = await s.agentMcp('tools/list')
        assert.equal(r.status, 200, 'gateway answers with this kind\'s own credential and transport')
        return (await r.json()).result
      }
      install([video], ['parity-video']); await s.restart()
      const healthy = await list()
      assert.ok(healthy.tools.some(t => t.name === 'parity_video__make_short'), `${s.kind}: app tool listed`)
      assert.equal(healthy.ttlMs, 24 * 60 * 60 * 1000, `${s.kind}: complete discovery is cacheable for a day`)
      assert.equal(healthy.cacheScope, 'private')
      install([video, down], ['parity-video', 'parity-down']); await s.restart()
      const partial = await list()
      assert.ok(partial.tools.some(t => t.name === 'parity_video__make_short'), `${s.kind}: answering app still listed`)
      assert.equal(partial.ttlMs, 0, `${s.kind}: an app that did not answer makes the list uncacheable`)
      assert.equal(partial.cacheScope, 'private')
      // Issue 623: wizard_apps tells the agent plainly that the silent app's tools are temporarily unavailable.
      const appsCall = await s.agentMcp('tools/call', { name: 'wizard_apps', arguments: {} })
      assert.equal(appsCall.status, 200)
      const appsText = (await appsCall.json()).result.content[0].text
      assert.match(appsText, /Synthetic Down \(parity-down\), running: .*Tools: temporarily unavailable .*not an access setting/u, `${s.kind}: missing tools are named as temporary, not access`)
      assert.match(appsText, /Synthetic Video \(parity-video\), running: .*Tools: [^\n]*parity_video__make_short\./u, `${s.kind}: answering app's tools listed`)
      // Issue 623: a real MCP session (initialize + open GET event stream) served while an app is not answering is
      // told tools/list_changed once that app answers again (background recheck), and its next list carries the tools.
      let flaky = true
      const late = createServer((req, res) => {
        let body = ''; req.on('data', c => { body += c }); req.on('end', () => {
          const msg = JSON.parse(body || '{}')
          if (msg.id === undefined) { res.writeHead(202); return res.end() }
          if (flaky && msg.method === 'tools/list') { res.writeHead(503); return res.end() }
          const result = msg.method === 'tools/list' ? { tools: [{ name: 'late_tool', description: 'Synthetic', inputSchema: { type: 'object', properties: {} } }] } : { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'parity-late', version: '1' } }
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
        })
      })
      await new Promise(resolve => late.listen(0, '127.0.0.1', resolve))
      let stream
      try {
        const lateApp = { id: 'parity-late', name: 'Synthetic Late', status: 'running', provides: ['notes'], mcp: { url: `http://127.0.0.1:${late.address().port}/mcp` } }
        install([video, lateApp], ['parity-video', 'parity-late']); await s.restart()
        const init = await s.agentMcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'parity' } })
        assert.equal(init.status, 200)
        const sid = init.headers.get('mcp-session-id')
        assert.ok(sid, `${s.kind}: gateway opened an MCP session`)
        stream = await s.agentMcpStream(sid)
        assert.equal(stream.status, 200, `${s.kind}: session event stream opens on this kind's transport`)
        const sessionList = async () => { const r = await s.agentMcp('tools/list', {}, { sid }); assert.equal(r.status, 200); return (await r.json()).result }
        assert.ok(!(await sessionList()).tools.some(t => t.name === 'parity_late__late_tool'), `${s.kind}: app not answering yet`)
        flaky = false
        const changed = () => stream.frames.join('').includes('notifications/tools/list_changed')
        for (let n = 0; n < 150 && !changed(); n++) await new Promise(resolve => setTimeout(resolve, 100))
        assert.ok(changed(), `${s.kind}: tools/list_changed reaches the session once the app answers again`)
        assert.ok((await sessionList()).tools.some(t => t.name === 'parity_late__late_tool'), `${s.kind}: re-list carries the returned tools`)
      } finally { stream?.close(); await new Promise(resolve => late.close(resolve)) }
    } finally { await new Promise(resolve => app.close(resolve)) }
  },
  'finished-run-leaves-working': async s => {
    await finishedRunLeavesWorking(s)
    if (s.kind !== 'main') return
    // Main admits through the durable run queue too (this scene runs it direct): both leave at once.
    // Fresh-mode box: no state.db and no Wizard Inbox, so only the queue revision can tell the cached
    // listing that the queued run finished; the row must come from the finished listing.
    const queued = await scene('main', { canonicalSessionListing: true, fixtureSessionStatus: true, hermesStatePath: '' })
    try {
      assert.equal((await queued.request('/api/sessions', post({ id: 'wizard_parity', source: 'wizard-mobile' }))).status, 201)
      await finishedRunLeavesWorking(queued)
    } finally { await queued.close() }
  },
  'status-list-state': async s => {
    const row = s.sessions.get('wizard_parity'); row.hidden = false
    row.messages = [{ role: 'user', content: 'Synthetic request', timestamp: Date.now() / 1000 - 2 }]
    // An fyi never cancels an earlier ask (issue 525): after check, fyi keeps check; a later done clears it.
    for (const [state, shown] of [['needs_you', 'needs_you'], ['done', 'done'], ['check', 'check'], ['fyi', 'check'], ['done', 'done'], ['fyi', 'fyi']]) {
      row.messages.push({ role: 'assistant', content: `Synthetic answer\n[WIZARD_STATUS_V1] ${JSON.stringify({ state, ask: state === 'needs_you' ? 'Choose a synthetic option' : 'Synthetic outcome', subject: 'Parity QA', title: 'Parity · Status' })}[/WIZARD_STATUS_V1]`, timestamp: Date.now() / 1000 + row.messages.length })
      const r = await s.request('/api/sessions?view=list'); assert.equal(r.status, 200)
      const item = (await r.json()).data.find(x => x.id === row.id)
      assert.ok(item); assert.equal(item.attention.state, shown, `${s.kind}: ${state}`)
      assert.equal(item.attention.subject, 'Parity QA')
      if (state === 'needs_you') assert.equal(item.attention.ask, 'Choose a synthetic option')
      assert.ok(!JSON.stringify(item).includes('[WIZARD_STATUS_V1]'))
    }
  },
  'automatic-titles': async s => {
    const row = s.sessions.get('wizard_parity'); row.hidden = false
    const add = title => row.messages.push({ role: 'assistant', content: `Synthetic answer\n[WIZARD_STATUS_V1] ${JSON.stringify({ state: 'done', ask: 'Synthetic outcome', title, subject: 'Parity QA' })}[/WIZARD_STATUS_V1]`, timestamp: Date.now() / 1000 + row.messages.length })
    const project = async (proposal, expected) => {
      add(proposal)
      await s.request('/api/sessions?view=list')
      // Main applies canonical proposals asynchronously; routed PATCH completes during projection.
      for (let n = 0; n < 30 && row.title !== expected; n++) await new Promise(resolve => setTimeout(resolve, 20))
      // Also let an incorrectly accepted narrowing finish before asserting stability.
      await new Promise(resolve => setTimeout(resolve, 30))
      assert.equal(row.title, expected, `${s.kind}: ${proposal}`)
    }
    await project('Messenger · Composer paste', 'Messenger · Composer paste')
    await project('Messenger', 'Messenger') // one-time legacy broadening
    await project('Messenger · Settings buttons', 'Messenger') // not a project change
    await s.restart()
    assert.equal((await (await s.request('/api/sessions?view=list')).json()).data[0].title, 'Messenger')
    await admit(s, { input: 'Synthetic next feature in the same project' })
    assert.ok(sent(s).instructions.includes(TITLE_INSTRUCTIONS), `${s.kind}: actual upstream run gets the shared project rule`)
    assert.ok(sent(s).instructions.includes('This thread is currently titled “Messenger”.'))
    assert.ok(!sent(s).instructions.includes('or to a different feature'))
    assert.ok(sent(s).instructions.includes('no "WizardOS ·" prefix, no number'), `${s.kind}: app-name title rule reaches every runtime`)
    assert.ok(sent(s).instructions.includes('Never use the owner\'s own opening words'), `${s.kind}: opener words are not a title`)
    await project('Video Editor', 'Video Editor') // genuine project move
    const rename = await s.request('/api/sessions/wizard_parity', { ...post({ title: 'Owner chosen' }), method: 'PATCH' }); assert.equal(rename.status, 200)
    await project('Must Not Replace', 'Owner chosen')
  },
  'subjects': async s => {
    const row = s.sessions.get('wizard_parity'); row.hidden = false
    row.messages.push({ role: 'assistant', content: 'Synthetic answer\n[WIZARD_STATUS_V1] {"state":"done","ask":"Synthetic outcome","subject":"Parity QA","title":"Parity · Subjects"}[/WIZARD_STATUS_V1]', timestamp: Date.now() / 1000 })
    const listed = async () => (await (await s.request('/api/sessions?view=list')).json()).data[0]
    assert.equal((await listed()).attention.subject, 'Parity QA')
    await s.restart()
    assert.equal((await listed()).attention.subject, 'Parity QA')
    await admit(s, { input: 'Synthetic subject follow-up' })
    assert.ok(sent(s).instructions.includes('Parity QA'), 'current subject must reach follow-up instructions')
  },
  'tool-approval': async s => {
    const run = await admit(s, { input: 'Synthetic approval request' })
    for (const [action, value] of [['approval', { approval_id: 'synthetic-approval', approved: true }], ['clarify', { answer: 'Synthetic clarification' }]]) {
      const r = await s.request(`/v1/runs/${run.run_id}/${action}`, post(value)); assert.equal(r.status, 200)
      const target = s.seen.filter(x => x.path.endsWith(`/${action}`)).at(-1)
      assert.ok(target); assert.deepEqual(target.body, value)
      assert.ok(target.path.includes(s.kind === 'host-profile' ? '/p/parity-profile/v1/runs/' : '/v1/runs/'))
    }
  },
}
