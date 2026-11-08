import assert from 'node:assert/strict'
import { post, scene } from './fixture.mjs'
import { ITEMS_INSTRUCTIONS } from '../../server/thread-items.mjs'

// Thread tracker (owner tweak, off by default), proved on every runtime kind: the reply's asks reach the
// ledger, the reply row never shows them, a quote reply tells the agent what it answers, and with the tweak
// off the ledger is empty/untouched and the owner's quote reaches the agent exactly as sent.
const status = '[WIZARD_STATUS_V1]{"state":"needs_you","ask":"Pick one","items":[{"id":"logo","title":"Pick a logo","state":"needs_you"},{"id":"copy","title":"Review copy","state":"running"}]}[/WIZARD_STATUS_V1]'
const quote = id => `Go with the first\n[WIZARD_REPLY_TO_V1]${JSON.stringify({ message_id: id, item: 'logo', excerpt: 'Which logo?' })}[/WIZARD_REPLY_TO_V1]`
const key = s => `${s.id || 'hermes'}/wizard_parity`
const prime = async s => {
  const r = await s.request('/api/sessions', post({ id: 'wizard_parity', source: 'wizard-mobile', hidden: true }))
  assert.equal(r.status, 201)
  s.sessions.get('wizard_parity').messages.push(
    { id: 'q1', role: 'user', content: 'Which logo?', timestamp: Date.now() / 1000 - 3 },
    { id: 'a1', role: 'assistant', content: `Two options.\n${status}`, timestamp: Date.now() / 1000 - 2 })
}
const read = async s => {
  const r = await s.request('/api/sessions/wizard_parity/messages?view=wizard&order=oldest'); assert.equal(r.status, 200)
  return r.json()
}
const counts = async s => (await (await s.raw('/wizard/v1/thread-items/counts')).json()).threads
const items = async s => (await s.raw(`/wizard/v1/thread-items?thread=wizard_parity&agent=${s.id || 'hermes'}`)).json()
const sentInput = s => JSON.stringify(s.seen.filter(r => r.method === 'POST' && r.path.endsWith('/v1/runs')).at(-1).body.input)
const sentInstructions = s => s.seen.filter(r => r.method === 'POST' && r.path.endsWith('/v1/runs')).at(-1).body.instructions || ''

// The tracker is the main builder agent's only (James, 9 Nov 2026: "these should not be displaying in the
// philosopher chat ... This is for our builder agent, which wouldn't apply to all agents"). Every other runtime
// kind gets no tracker instructions, records nothing and is served nothing, even with the tweak on.
const otherAgentScopedOut = async s => {
  await prime(s)
  assert.ok(!JSON.stringify(await read(s)).includes('"items"'), `${s.kind}: the status line still never shows in the transcript`)
  assert.equal((await counts(s))[key(s)], undefined, `${s.kind}: no Chats dots for another agent's thread`)
  assert.deepEqual((await items(s)).items, [], `${s.kind}: no strip for another agent's thread`)
  const seenOther = await s.raw('/wizard/v1/thread-items/seen', post({ thread: 'wizard_parity', agent: s.id, ids: ['logo'], items: [{ id: 'logo', updated_at: 1 }] }))
  assert.equal(seenOther.status, 200); assert.deepEqual((await seenOther.json()).items, [])
  const sent = await s.request('/v1/runs', post({ session_id: 'wizard_parity', input: 'hello' })); assert.equal(sent.status, 202)
  assert.ok(!sentInstructions(s).includes('Thread tracker'), `${s.kind}: no tracker instructions reach another agent`)
  assert.ok(!sentInstructions(s).includes(ITEMS_INSTRUCTIONS), `${s.kind}: no items contract reaches another agent`)
  assert.equal((await s.request('/api/sessions', post({ id: 'wizard_quote', source: 'wizard-mobile', hidden: true }))).status, 201)
  const quoted = await s.request('/v1/runs', post({ session_id: 'wizard_quote', input: quote('a1') })); assert.equal(quoted.status, 202)
  assert.ok(sentInput(s).includes('WIZARD_REPLY_TO_V1') && !sentInput(s).includes('Replying to an earlier message'), `${s.kind}: a quote reaches another agent exactly as sent (tweak-off behaviour)`)
  const other = await s.request('/api/sessions', post({ id: 'wizard_done', source: 'wizard-mobile', hidden: true })); assert.equal(other.status, 201)
  s.sessions.get('wizard_done').messages.push({ id: 'd1', role: 'assistant', content: `Finished.\n${status}`, timestamp: Date.now() / 1000 - 1 })
  const run = await (await s.request('/v1/runs', post({ session_id: 'wizard_done', input: 'Do it' }))).json()
  Object.assign([...s.runs.values()].at(-1), { status: 'completed', session_id: 'wizard_done', output: `Finished.\n${status}`, updated_at: Date.now() / 1000 })
  assert.equal((await s.request(`/v1/runs/${run.run_id}`)).status, 200)
  await new Promise(r => setTimeout(r, 100))
  assert.deepEqual(await counts(s), {}, `${s.kind}: a finished run of another agent records nothing`)
}

export const trackerChecks = {
  'thread-tracker': async s => {
    if (s.kind !== 'main') return otherAgentScopedOut(s)
    await prime(s)
    const history = await read(s)
    assert.ok(!JSON.stringify(history).includes('"items"'), 'the asks never show in the transcript')
    assert.deepEqual((await counts(s))[key(s)], { needs_you: 1, running: 0, done_unseen: 0, blocked: 0, acknowledged: 0, total: 1 })
    const listed = await items(s)
    assert.deepEqual(listed.items.map(i => i.id).sort(), ['copy', 'logo'])
    const logo = listed.items.find(i => i.id === 'logo')
    assert.ok(logo.message_id, 'each ask anchors on its reply row')
    const marked = await s.raw('/wizard/v1/thread-items/seen', { ...post({ thread: 'wizard_parity', agent: s.id || 'hermes', ids: ['logo'] }) })
    assert.equal(marked.status, 200)
    assert.equal((await items(s)).items.find(i => i.id === 'logo').seen, true)
    assert.equal((await counts(s))[key(s)].acknowledged, 0, 'a partially seen reply stays actionable')
    const groupSeen = await s.raw('/wizard/v1/thread-items/seen', post({ thread: 'wizard_parity', agent: s.id || 'hermes', ids: ['logo', 'copy'] }))
    assert.equal(groupSeen.status, 200)
    assert.deepEqual((await counts(s))[key(s)], { needs_you: 0, running: 0, done_unseen: 0, blocked: 0, acknowledged: 1, total: 1 })
    // Two independent clients read the same ledger. One version changes on the
    // service without the older client polling; its delayed Seen must be stale.
    const versionSession = await s.request('/api/sessions', post({ id: 'wizard_version', source: 'wizard-mobile', hidden: true })); assert.equal(versionSession.status, 201)
    const at = Date.now() / 1000
    const updateVersion = async (n, ask) => {
      s.sessions.get('wizard_version').messages.push({ id: `version-${n}`, role: 'assistant', timestamp: at + n * 100, content: `[WIZARD_STATUS_V1]${JSON.stringify({state:'needs_you',ask,items:[{id:'resend',title:'Resend the reply',state:'needs_you',ask}]})}[/WIZARD_STATUS_V1]` })
      assert.equal((await s.request('/api/sessions/wizard_version/messages?view=wizard&order=oldest')).status, 200)
      return (await (await s.raw(`/wizard/v1/thread-items?thread=wizard_version&agent=${s.id || 'hermes'}`)).json()).items[0]
    }
    const olderClient = await updateVersion(1, 'Reply resend to send it')
    const newerClient = await updateVersion(2, 'Approve the second send')
    assert.equal(newerClient.ask, 'Approve the second send', `${s.kind}: bounded action text reaches the ledger`)
    const seenVersion = async item => (await (await s.raw('/wizard/v1/thread-items/seen', post({thread:'wizard_version',agent:s.id || 'hermes',ids:[item.id],items:[{id:item.id,updated_at:item.updated_at}]}))).json())
    const stale = await seenVersion(olderClient)
    assert.deepEqual(stale.results, [{id:'resend',status:'stale'}]); assert.equal(stale.items[0].seen, false)
    const matching = await seenVersion(newerClient)
    assert.deepEqual(matching.results, [{id:'resend',status:'acknowledged'}]); assert.equal(matching.items[0].seen, true)
    assert.equal(matching.counts.needs_you, 0); assert.equal(matching.counts.acknowledged, 1)
    assert.equal((await updateVersion(3, 'Try the updated reply')).seen, false, `${s.kind}: a newer dismissed amber returns unseen`)
    const sent = await s.request('/v1/runs', post({ session_id: 'wizard_parity', input: quote(logo.message_id) })); assert.equal(sent.status, 202)
    const instructions = sentInstructions(s)
    assert.ok(instructions.includes(ITEMS_INSTRUCTIONS), `${s.kind}: the actual upstream run receives the full tracker contract`)
    for (const rule of ['Every reply that answers, starts, finishes or changes an ask must list it, even a quick answer', 'a question you answer is an ask in state done', 'mid-turn additions', 'at most 16', 'list the open asks first', 'asks answered earlier need not be repeated', 'one specific thing for the owner to do', 'optional follow-ups are done', 'is needs_you, never blocked', 'Reply resend to send it']) {
      assert.ok(instructions.includes(rule), `${s.kind}: missing mandatory rule: ${rule}`)
    }
    assert.ok(!instructions.includes('Optionally add'), 'listing asks is mandatory')
    assert.match(sentInput(s), /Replying to an earlier message about “Pick a logo”: \\"Which logo\?\\"/)
    // A run that finishes while its thread is closed still lists its asks (no history read opens the thread)
    const other = await s.request('/api/sessions', post({ id: 'wizard_done', source: 'wizard-mobile', hidden: true })); assert.equal(other.status, 201)
    s.sessions.get('wizard_done').messages.push({ id: 'd1', role: 'assistant', content: `Finished.\n${status}`, timestamp: Date.now() / 1000 - 1 })
    const run = await (await s.request('/v1/runs', post({ session_id: 'wizard_done', input: 'Do it' }))).json()
    const upstream = [...s.runs.values()].at(-1)
    Object.assign(upstream, { status: 'completed', session_id: 'wizard_done', output: `Finished.\n${status}`, updated_at: Date.now() / 1000 })
    assert.equal((await s.request(`/v1/runs/${run.run_id}`)).status, 200)
    let doneCounts
    for (let i = 0; i < 40; i++) { doneCounts = (await counts(s))[`${s.id || 'hermes'}/wizard_done`]; if (doneCounts) break; await new Promise(r => setTimeout(r, 25)) }
    assert.equal(doneCounts?.total, 1, 'a completed reply counts once without opening its thread')
    for (const setting of [false, undefined]) {
      const off = await scene(s.kind, setting === undefined ? {} : { threadTracker: setting })
      try {
        await prime(off)
        await read(off)
        assert.deepEqual(await counts(off), {}, 'off: nothing is recorded or shown')
        assert.deepEqual((await items(off)).items, [])
        const seenOff = await off.raw('/wizard/v1/thread-items/seen', { ...post({ thread: 'wizard_parity', agent: off.id || 'hermes', ids: ['logo'], items: [{ id: 'logo', updated_at: 1 }] }) })
        assert.equal(seenOff.status, 200); assert.deepEqual((await seenOff.json()).items, [])
        const plain = await off.request('/v1/runs', post({ session_id: 'wizard_parity', input: quote('a1') })); assert.equal(plain.status, 202)
        assert.ok(!sentInstructions(off).includes('Thread tracker'), 'off or absent: no tracker instructions reach the runtime')
        assert.ok(!sentInstructions(off).includes('"items"'), 'off or absent: no items contract reaches the runtime')
        assert.ok(!sentInput(off).includes('Replying to an earlier message'), 'off: the quote reaches the agent exactly as the owner sent it')
      } finally { await off.close() }
    }
  },
}
