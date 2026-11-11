import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { TITLE_INSTRUCTIONS } from '../../server/thread-titles.mjs'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { post, png, scene } from './fixture.mjs'
import { PRESETS } from '../../server/agents.mjs'
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

export const serverChecks = {
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
        if (item?.title === title) return data
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
    await finish(run.run_id, { channel: foreign.id })
    assert.equal(await filed('wizard_parity'), null, 'another agent\u2019s channel is refused')
    const r2 = await admit(s, { input: 'Synthetic owner chat again' }); await finish(r2.run_id, { channel: alerts.id })
    assert.equal(await filed('wizard_parity'), null, 'agents never file an owner chat into Alerts')
    const r3 = await admit(s, { input: 'Synthetic owner chat once more' }); await finish(r3.run_id, { channel: own.id, title: 'Synthetic post name' })
    assert.equal(await filed('wizard_parity'), own.id, 'status-line channel files an unfiled chat')
    // Never a move: the owner refiles it, and a later status naming another channel changes nothing.
    assert.equal((await s.raw('/wizard/v1/channels/membership', json('PUT', { sessionId: 'wizard_parity', channelId: second.id }))).status, 200)
    const r4 = await admit(s, { input: 'Synthetic owner chat moved' }); await finish(r4.run_id, { channel: own.id })
    assert.equal(await filed('wizard_parity'), second.id, 'an owner-filed chat is never moved')
    // `space` stays an alias for one release.
    assert.equal((await s.request('/api/sessions', post({ id: 'wizard_parity_alias', source: 'wizard-mobile' }))).status, 201)
    const r5 = await s.request('/v1/runs', post({ session_id: 'wizard_parity_alias', input: 'Synthetic alias chat' })); assert.equal(r5.status, 202)
    await finish((await r5.json()).run_id, { space: own.id })
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
    await finish(plain.runId, { channel: own.id })
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
    await finish((await late.json()).run_id, { channel: own.id })
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
    // A synthetic app with a job and a shipped skill, installed the App Manager way (apps.json + skill under the OS home).
    const osHome = join(s.root, 'os'), skills = join(osHome, 'skills')
    mkdirSync(join(skills, 'parity-video'), { recursive: true })
    writeFileSync(join(skills, 'parity-video', 'SKILL.md'), '---\nname: parity-video\ndescription: Synthetic app workflow.\n---\nCall make_short.\n')
    const app = { id: 'parity-video', name: 'Synthetic Video', status: 'running', provides: ['short-form-video'], skill: 'skills/parity-video/SKILL.md', mcp: { url: 'http://127.0.0.1:9/mcp' } }
    const install = apps => writeFileSync(join(s.root, 'apps.json'), JSON.stringify({ schema: 1, apps }))
    const kernel = async () => {
      const r = await s.agentMcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'parity' } })
      assert.equal(r.status, 200, 'gateway answers with this kind\'s own credential and transport')
      return (await r.json()).result.instructions
    }
    const pointer = join(skills, 'wizard-job-short-form-video', 'SKILL.md')
    const parityQa = { id: 'parity-qa', name: 'Synthetic Parity App', view: '/parity/', agent_binding: true }
    if (s.kind !== 'main') {
      // The install picker ticks this standard agent for the new app (#58): its own list, nothing else.
      const file = join(osHome, 'agents', s.id, 'agent.json'), agent = JSON.parse(readFileSync(file, 'utf8'))
      agent.permissions.wizard_apps = [...new Set([...(agent.permissions.wizard_apps || []), 'parity-video'])]
      writeFileSync(file, JSON.stringify(agent))
    }
    install([parityQa, app]); await s.restart()
    const text = await kernel()
    // Inspect the real gateway handler's initialize output on EACH runtime transport,
    // not renderKernel() or a source-text assertion. Upstream Hermes remains synthetic.
    const assertRules = value => {
      assert.equal(typeof value, 'string', `${s.kind}: gateway kernel instructions`)
      const lines = value.split('\n')
      for (const rule of [
        'Never ask the owner what an installed app can answer: call its tools first; if missing, search tools again or retry once. Never guess from old chats or call app URLs.',
        'Answer from the source of truth: owning app for data, live checks for box state, release records for what shipped. Say none found only after checking. Report tool errors.',
      ]) assert.ok(lines.includes(rule), `${s.kind}: gateway delivers exact app-first/source/error rule: ${rule}`)
      assert.ok(value.includes('Use registered exact names only.'), `${s.kind}: registered exact tool names, not invented names`)
      assert.ok(!value.includes('If it is not in your tool list, run it with tool_call and that exact name.'), `${s.kind}: no speculative tool-name instruction`)
      assert.ok(value.includes('3. For ordinary app use:'), `${s.kind}: ordinary-app safety step survives`)
      assert.ok(value.indexOf('Never ask the owner') > value.indexOf('3. For ordinary app use:'))
      if (value.includes('Jobs on this box:')) assert.ok(value.indexOf('Report tool errors.') < value.indexOf('Jobs on this box:'))
    }
    assertRules(text)
    if (s.kind === 'main') {
      assert.ok(existsSync(pointer), 'main agent gets the job pointer skill')
      assert.match(readFileSync(pointer, 'utf8'), /Synthetic Video: load its skill `parity-video` with skill_view first/u)
      assert.match(text, /wizard-job-<job> skill in your skills/u)
    } else {
      // No pointer skills outside the main agent's index: the gateway tells this agent its own jobs instead.
      assert.doesNotMatch(text, /wizard-job-<job>/u)
      assert.match(text, /- short-form video -> Synthetic Video \(`mcp__wizard__parity_video__\*`\)/u)
    }
    install([parityQa]); await s.restart()
    const after = await kernel()
    assertRules(after)
    assert.ok(!existsSync(join(skills, 'wizard-job-short-form-video')), 'uninstall removes the pointer')
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
    for (const state of ['needs_you', 'done', 'check', 'fyi']) {
      row.messages.push({ role: 'assistant', content: `Synthetic answer\n[WIZARD_STATUS_V1] ${JSON.stringify({ state, ask: state === 'needs_you' ? 'Choose a synthetic option' : 'Synthetic outcome', subject: 'Parity QA', title: 'Parity · Status' })}[/WIZARD_STATUS_V1]`, timestamp: Date.now() / 1000 + row.messages.length })
      const r = await s.request('/api/sessions?view=list'); assert.equal(r.status, 200)
      const item = (await r.json()).data.find(x => x.id === row.id)
      assert.ok(item); assert.equal(item.attention.state, state)
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
