import assert from 'node:assert/strict'
import { post, scene } from './fixture.mjs'

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

export const trackerChecks = {
  'thread-tracker': async s => {
    await prime(s)
    const history = await read(s)
    assert.ok(!JSON.stringify(history).includes('"items"'), 'the asks never show in the transcript')
    assert.deepEqual((await counts(s))[key(s)], { needs_you: 1, running: 1, done_unseen: 0, blocked: 0, acknowledged: 0, total: 2 })
    const listed = await items(s)
    assert.deepEqual(listed.items.map(i => i.id).sort(), ['copy', 'logo'])
    const logo = listed.items.find(i => i.id === 'logo')
    assert.ok(logo.message_id, 'each ask anchors on its reply row')
    const marked = await s.raw('/wizard/v1/thread-items/seen', { ...post({ thread: 'wizard_parity', agent: s.id || 'hermes', ids: ['logo'] }) })
    assert.equal(marked.status, 200)
    assert.equal((await items(s)).items.find(i => i.id === 'logo').seen, true)
    const sent = await s.request('/v1/runs', post({ session_id: 'wizard_parity', input: quote(logo.message_id) })); assert.equal(sent.status, 202)
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
    assert.equal(doneCounts?.total, 2, 'a completed run is counted without opening its thread')
    const off = await scene(s.kind, { threadTracker: false })
    try {
      await prime(off)
      await read(off)
      assert.deepEqual(await counts(off), {}, 'off: nothing is recorded or shown')
      assert.deepEqual((await items(off)).items, [])
      const seenOff = await off.raw('/wizard/v1/thread-items/seen', { ...post({ thread: 'wizard_parity', agent: off.id || 'hermes', ids: ['logo'] }) })
      assert.equal(seenOff.status, 200); assert.deepEqual((await seenOff.json()).items, [])
      const plain = await off.request('/v1/runs', post({ session_id: 'wizard_parity', input: quote('a1') })); assert.equal(plain.status, 202)
      assert.ok(!sentInput(off).includes('Replying to an earlier message'), 'off: the quote reaches the agent exactly as the owner sent it')
    } finally { await off.close() }
  },
}
