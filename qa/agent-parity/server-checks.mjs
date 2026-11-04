import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { post, png, scene } from './fixture.mjs'
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
    // One style source: whatever an older shell saved, every runtime gets Wizard OS facts + status protocol only.
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
    const r = await s.raw(`/wizard/hermes/v1/runs?agent=${binding.binding.agent}`,post({session_id:'wizard_parity',input:'Synthetic owner question about bound app',instructions:'[Wizard OS context] Window in front: Synthetic Parity App. Visible on screen: Bound synthetic context '+ 'X'.repeat(12000)}))
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
    add('Parity · Titles')
    await s.request('/api/sessions?view=list')
    // Main applies canonical title proposals asynchronously; routed PATCH completes during projection.
    for (let n = 0; n < 30 && row.title !== 'Parity · Titles'; n++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(row.title, 'Parity · Titles')
    await s.restart()
    assert.equal((await (await s.request('/api/sessions?view=list')).json()).data[0].title, 'Parity · Titles')
    const rename = await s.request('/api/sessions/wizard_parity', { ...post({ title: 'Owner · Chosen' }), method: 'PATCH' }); assert.equal(rename.status, 200)
    add('Must Not Replace')
    await s.request('/api/sessions?view=list'); await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(row.title, 'Owner · Chosen')
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
