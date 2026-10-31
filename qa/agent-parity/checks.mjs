import assert from 'node:assert/strict'
import { scene, image, png, post } from './fixture.mjs'
import { serverChecks } from './server-checks.mjs'
import { queueChecks } from './queue-checks.mjs'
import { STATUS_PROTOCOL_INSTRUCTIONS } from '../../server/thread-status.mjs'
import { notificationScene, checkBoundNotification } from './scheduler-notify.mjs'

const featureScenes = { 'scheduler-notifications': kind => notificationScene(kind, true),
  // Main's cached Hermes listing with the stock running status; main admits direct here (the
  // check runs main's durable-queue path in a second scene) and without state.db, whose live
  // truth would otherwise hide a stale cached listing.
  'finished-run-leaves-working': kind => scene(kind, { canonicalSessionListing: true, fixtureSessionStatus: true, ...(kind === 'main' ? { runQueueStatePath: '', hermesStatePath: '' } : {}) }) }

export const checks = {
  ...serverChecks,
  ...queueChecks,
  'private-incognito-policy': async s => {
    const init = post({})
    const response = await fetch(`${s.origin()}/wizard/v1/agents/${s.id || 'main'}/incognito`, { ...init, headers: { ...init.headers, ...s.ownerHeaders } })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error, 'incognito_private_only')
    assert.ok(!s.seen.some(r => r.path.includes('/incognito')), 'private-only refusal must happen before any upstream request')
  },
  'scheduler-notifications': checkBoundNotification,
  'session-create': async s => {
    const r = await s.request('/api/sessions', post({ id: 'wizard_parity', source: 'wizard-mobile', hidden: true }))
    assert.equal(r.status, 201); assert.equal((await r.json()).session.id, 'wizard_parity')
    const hidden = await s.request('/api/sessions/wizard_parity', { ...post({ hidden: true }), method: 'PATCH' })
    assert.equal(hidden.status, 200)
    assert.equal((await (await s.request('/api/sessions/wizard_parity')).json()).session.hidden, true)
  },
  'native-images': async s => {
    const r = await s.request('/v1/runs', post({ session_id: 'wizard_parity', input: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic screenshot' }, { type: 'image_url', image_url: { url: image } }] }] }))
    assert.equal(r.status, 202); s.runId = (await r.json()).run_id
    const sent = s.seen.filter(r => r.method === 'POST' && r.path.endsWith('/v1/runs')).at(-1)
    assert.equal(sent.body.input[0].content[1].image_url.url, image)
  },
  'image-history-reload': async s => {
    await s.restart()
    const r = await s.request('/api/sessions/wizard_parity/messages?view=wizard&order=oldest'); assert.equal(r.status, 200)
    const parts = (await r.json()).data.find(m => m.id === 'user-1').content
    assert.ok(Array.isArray(parts), 'flattened [screenshot] must be restored after service restart')
    assert.equal(parts.find(p => p.type === 'image_url').image_url.url, image)
    assert.ok(!parts.some(p => p.text?.includes('[screenshot]')))
    const raw = await (await s.request('/api/sessions/wizard_parity/messages?order=oldest')).json()
    assert.equal(typeof raw.data.find(m => m.id === 'user-1').content, 'string', 'raw upstream history remains unchanged')
  },
  'file-upload': async s => {
    const r = await s.upload(png, 'fixture.png', 'image/png'); assert.equal(r.status, 201); s.file = (await r.json()).file
    assert.ok(s.file.id)
    const send = await s.request('/v1/runs', post({ session_id: 'wizard_parity', input: 'Inspect attachment', wizard_file_ids: [s.file.id] }))
    assert.equal(send.status, 202)
    s.fileBody = s.seen.filter(r => r.method === 'POST' && r.path.endsWith('/v1/runs')).at(-1).body
    assert.equal(s.fileBody.wizard_file_ids, undefined)
    assert.equal(s.fileBody.input[0].content.find(p => p.type === 'image_url').image_url.url, image)
  },
  'file-durable-copy': async s => {
    const text = s.fileBody.input[0].content[0].text
    assert.ok(!text.includes('placement_error'), 'a native image alone is not a durable tool-readable copy')
    assert.ok(text.includes('trusted_path'))
    if (s.kind === 'host-profile') {
      assert.equal(s.placed.length, 0, 'host-profile uses its shared API-host file view, never container placement')
      assert.ok(text.includes('/fixture-owner-files/'), 'use configured Hermes-visible path, not Service localPath')
      assert.ok(!text.includes(s.root))
    } else if (s.kind !== 'main') {
      assert.equal(s.placed.length, 1)
      assert.deepEqual(Buffer.from(s.placed[0].payload.data_base64, 'base64'), png)
      assert.ok(!text.includes('/fixture-owner-files'))
    }
  },
  'file-history': async s => {
    const r = await s.request('/api/sessions/wizard_parity/messages?view=wizard'); assert.equal(r.status, 200)
    const body = JSON.stringify(await r.json())
    assert.ok(body.includes('WIZARD_FILE_CHIPS_V1'), 'history must contain safe chips, not stripped trusted markers')
    assert.ok(!body.includes('WIZARD_FILES_V1')); assert.ok(!body.includes('trusted_path'))
  },
  'idempotent-resend': async s => {
    const init = post({ session_id: 'wizard_parity', input: 'One synthetic send' }); init.headers['Idempotency-Key'] = 'parity-one-send'
    const a = await s.request('/v1/runs', init), b = await s.request('/v1/runs', init)
    assert.equal(a.status, 202); assert.equal(b.status, 202)
    s.runId = (await a.json()).run_id
    assert.equal(s.runId, (await b.json()).run_id)
    assert.equal(b.headers.get('idempotency-replayed'), 'true')
  },
  'steer': async s => {
    const r = await s.request(`/v1/runs/${s.runId}/steer`, post({ input: 'Synthetic steering note' })); assert.equal(r.status, 200)
    assert.equal(s.seen.filter(r => r.path.endsWith('/steer')).at(-1).body.input, 'Synthetic steering note')
  },
  'stop': async s => {
    const r = await s.request(`/v1/runs/${s.runId}/stop`, post({})); assert.equal(r.status, 200)
    const last = s.seen.filter(x => x.path.endsWith('/stop')).at(-1); assert.ok(last)
  },
  'tool-progress': async s => {
    const r = await s.request(`/v1/runs/${s.runId}/events`); assert.equal(r.status, 200)
    assert.ok(r.headers.get('content-type').includes('text/event-stream'))
    const stream = await r.text(); assert.ok(stream.includes('event: tool.progress')); assert.ok(stream.includes('event: run.completed'))
  },
  'model-picker': async s => {
    const r = await s.request('/api/model/options'); assert.equal(r.status, 200)
    const options = await r.json(); assert.ok(options.providers.some(p => p.models.includes('fixture-other')))
    if (s.kind !== 'main') {
      const denied = await s.request('/api/sessions/wizard_parity/model', post({ model: 'unlisted-model' })); assert.equal(denied.status, 409)
    }
    const changed = await s.request('/api/sessions/wizard_parity/model', post({ model: 'fixture-other', provider: 'anthropic' })); assert.equal(changed.status, 200)
  },
  'status-hidden': async s => {
    const row = s.sessions.get('wizard_parity')
    row.messages.push({ role: 'assistant', timestamp: Date.now() / 1000, content: 'Synthetic reply\n[WIZARD_STATUS_V1]{"state":"needs_you","subject":"Synthetic subject","ask":"Choose"}[/WIZARD_STATUS_V1]' })
    const r = await s.request('/api/sessions/wizard_parity/messages?view=wizard'); assert.equal(r.status, 200)
    assert.ok(!JSON.stringify(await r.json()).includes('[WIZARD_STATUS_V1]'))
  },
  'retry-input': async s => {
    const r = await s.request('/api/sessions/wizard_parity?view=detail'); assert.equal(r.status, 200)
    assert.equal((await r.json()).session.wizard_retry_input, 'One synthetic send')
    // Real service + authorized profile/container/restricted transport; no runtime-history fallback.
    for (const run of s.runs.values()) Object.assign(run, { status: 'completed', output: '⚠️ Provider authentication failed: synthetic expired sign-in', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } })
    s.sessions.get('wizard_parity').messages = []
    await s.restart()
    const detail = await (await s.request('/api/sessions/wizard_parity?view=detail')).json()
    const saved = detail.session || detail
    assert.equal(saved.status, 'failed'); assert.equal(saved.wizard_retry_run_id, s.runId)
    assert.equal(saved.wizard_retry_input, 'One synthetic send')
    const retry = () => s.request('/v1/runs', post({ session_id: 'wizard_parity', input: 'not authoritative', wizard_retry_run_id: saved.wizard_retry_run_id, model: 'fixture-model', provider: 'anthropic', require_model_lock: true }))
    const responses = await Promise.all([retry(), retry()])
    for (const response of responses) assert.equal(response.status, 202, await response.clone().text())
    const [a, b] = await Promise.all(responses.map(r => r.json())); assert.equal(a.run_id, b.run_id)
    const writes = s.seen.filter(r => r.method === 'POST' && (r.path.endsWith('/v1/runs') || r.path.endsWith('/chat/stream')))
    assert.equal(writes.length, 2); assert.equal(writes.at(-1).body.input || writes.at(-1).body.message, 'One synthetic send')
    assert.equal(writes.at(-1).body.wizard_retry_run_id, undefined)
  },
  'session-archive': async s => {
    for (const archived of [true, false]) {
      const r = await s.request('/api/sessions/wizard_parity', { ...post({ archived }), method: 'PATCH' }); assert.equal(r.status, 200)
      assert.equal((await (await s.request('/api/sessions/wizard_parity')).json()).session.archived, archived)
    }
  },
  'thread-follow-up-watchers': async s => {
    const visible = await s.request('/api/sessions/wizard_parity', { ...post({ hidden: false }), method: 'PATCH' })
    assert.equal(visible.status, 200)
    const seeded = await s.request('/v1/runs', post({ session_id: 'wizard_parity', input: 'Synthetic watcher seed' }))
    assert.equal(seeded.status, 202)
    // The runtime's own gateway credential on its own transport (restricted: its socket). No owner proof.
    let id = 0
    const call = async (args) => {
      const r = await s.gatewayRpc({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'wizard_follow_up', arguments: { session_id: 'wizard_parity', ...args } } })
      assert.equal(r.status, 200)
      const result = (await r.json()).result
      return { error: result.isError === true, value: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) }
    }
    const created = await call({ action: 'create', name: 'Parity dependency', instructions: 'Check the synthetic dependency.', every_minutes: 7 })
    assert.equal(created.error, false, String(created.value))
    const watcher = created.value; assert.equal(watcher.kind, 'watch'); assert.equal(watcher.thread, 'wizard_parity')
    assert.equal(watcher.agent, s.kind === 'main' ? 'main' : s.id)
    if (s.kind !== 'main') {
      const foreign = await call({ action: 'create', session_id: 'wizard_not_this_agents', name: 'Foreign', instructions: 'x' })
      assert.equal(foreign.error, true, 'a routed agent may watch only a thread it owns')
    }
    const listed = await call({ action: 'list' }); assert.equal(listed.error, false)
    assert.deepEqual(listed.value.follow_ups.map(item => item.id), [watcher.id])
    const sessions = await (await s.request('/api/sessions')).json()
    const row = (sessions.data || sessions.sessions).find(item => item.id === 'wizard_parity')
    assert.deepEqual({ active: row.wizard_follow_up.active, count: row.wizard_follow_up.count, names: row.wizard_follow_up.names },
      { active: true, count: 1, names: ['Parity dependency'] })
    assert.equal(typeof row.wizard_follow_up.nextRun, 'string')
    const stopped = await call({ action: 'stop', watcher_id: watcher.id }); assert.equal(stopped.error, false)
    assert.deepEqual(stopped.value, { stopped: 1 })
    assert.deepEqual((await call({ action: 'list' })).value.follow_ups, [])
  },
  'session-rename': async s => {
    const r = await s.request('/api/sessions/wizard_parity', { ...post({ title: 'Synthetic renamed thread' }), method: 'PATCH' }); assert.equal(r.status, 200)
    assert.equal((await (await s.request('/api/sessions/wizard_parity')).json()).session.title, 'Synthetic renamed thread')
  },
  'screen-context': async s => {
    const r = await s.request('/v1/runs', post({ session_id: 'wizard_parity', input: 'About this view', instructions: '[Wizard OS context] Window in front: Fixture. Visible on screen: synthetic label' })); assert.equal(r.status, 202)
    const sent = s.seen.filter(r => r.method === 'POST' && r.path.endsWith('/v1/runs')).at(-1).body
    assert.ok(sent.instructions.includes('Background only:'))
    assert.ok(sent.instructions.includes('Visible on screen: synthetic label'))
  },
  'ready-ask-contract': async s => {
    const r = await s.request('/v1/runs', post({ session_id: 'wizard_parity', input: 'Two desk layouts are ready for the owner to choose.' }))
    assert.equal(r.status, 202)
    const sent = s.seen.filter(r => r.method === 'POST' && r.path.endsWith('/v1/runs')).at(-1)
    assert.ok(sent.body.instructions.includes(STATUS_PROTOCOL_INSTRUCTIONS), 'the shared status protocol reaches the runtime')
    for (const rule of ['read cold', '140 characters', 'first say what is waiting in everyday words, then the exact thing to do', 'if the action is a reply word, the sentence says what that word does', 'no PR']) {
      assert.ok(sent.body.instructions.includes(rule), `missing Ready ask rule: ${rule}`)
    }
    assert.ok(!sent.body.instructions.includes('under 90 characters'))
    assert.equal(sent.path, s.kind === 'host-profile' ? '/p/parity-profile/v1/runs' : '/v1/runs')

    // Synthetic reply: verify projection, not a claim that a live model followed the prompt.
    const ask = 'Two desk layouts to choose from. Pick A or B'
    const run = [...s.runs.values()].at(-1)
    Object.assign(run, { status: 'completed', updated_at: Date.now() / 1000, output: `${ask}\n[WIZARD_STATUS_V1]${JSON.stringify({ state: 'needs_you', ask })}[/WIZARD_STATUS_V1]` })
    assert.equal((await s.request(`/v1/runs/${(await r.json()).run_id}`)).status, 200)
    const row = s.sessions.get('wizard_parity'); row.hidden = false
    row.messages.push({ role: 'assistant', timestamp: Date.now() / 1000 + 1, content: `${ask}\n[WIZARD_STATUS_V1]${JSON.stringify({ state: 'needs_you', ask })}[/WIZARD_STATUS_V1]` })
    const list = await s.request('/api/sessions?view=list'); assert.equal(list.status, 200)
    const item = (await list.json()).data.find(x => x.id === row.id)
    assert.equal(item.attention.state, 'needs_you'); assert.equal(item.attention.ask, ask)
    const history = await s.request('/api/sessions/wizard_parity/messages?view=wizard'); assert.equal(history.status, 200)
    const visible = JSON.stringify(await history.json())
    assert.ok(visible.includes(ask)); assert.ok(!visible.includes('[WIZARD_STATUS_V1]'))
  },
  'media-contract': async s => {
    const r = await s.request('/v1/runs', post({ session_id: 'wizard_parity', input: 'Synthetic media request' })); assert.equal(r.status, 202)
    const sent = s.seen.filter(r => r.method === 'POST' && r.path.endsWith('/v1/runs')).at(-1).body
    assert.ok(sent.instructions.includes('MEDIA:/absolute/path'), 'every agent must know how Wizard renders delivery media')
    for (const piece of ['PDF', 'up to 256 MB', 'the 5 MB limit is for images only', 'copy it into your own cache/images first', 'non-image files are not intercepted'])
      assert.ok(sent.instructions.includes(piece), `every agent kind is told the file-card contract: ${piece}`)
    assert.ok(sent.instructions.includes('WIZARD_STATUS_V1'))
  },
}

export const dependencies = {
  'image-history-reload': ['native-images'],
  'file-durable-copy': ['file-upload'], 'file-history': ['file-upload'],
  'steer': ['native-images'], 'stop': ['native-images'], 'tool-progress': ['native-images'],
  'retry-input': ['idempotent-resend'],
}
export async function runCheck(kind, feature) {
  const s = featureScenes[feature] ? await featureScenes[feature](kind) : await scene(kind, feature === 'supervisor-reporter' ? { supervisorParity: true } : feature === 'thread-follow-up-watchers' ? { followUpParity: true } : ['session-slim-index','session-body-search','archive-age'].includes(feature) ? {fixtureSearchIndex:true,canonicalSessionListing:true} : feature === 'chats-spaces' ? { agentBridge: true, bridgeWriteSkills: false, mcpToken: 'parity-main-gateway', agentGatewayUrl: 'http://gateway/wizard/mcp' } : ['app-job-routing', 'agent-app-access'].includes(feature) ? { agentBridge: true, mcpToken: 'parity-main-gateway', agentGatewayUrl: 'http://gateway/wizard/mcp', bridgeWatchMs: 0 } : {})
  try {
    if (feature !== 'session-create') await checks['session-create'](s)
    for (const dependency of dependencies[feature] || []) await checks[dependency](s)
    await checks[feature](s)
    return { feature, kind, status: 'pass', evidence: 'fixture HTTP boundary' }
  } catch (error) { return { feature, kind, status: 'fail', reason: error.message, evidence: 'fixture HTTP boundary' } }
  finally { await s.close() }
}
export async function runKind(kind, record) {
  for (const feature of Object.keys(checks)) record(await runCheck(kind, feature))
}
