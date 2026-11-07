import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectWizardMessageHistory } from '../server/service.mjs'
import { scene, kinds } from '../qa/agent-parity/fixture.mjs'
import { serverChecks } from '../qa/agent-parity/server-checks.mjs'

const words = 'No dialogue. I double clicked it. It changed the focus and absolutely nothing happened.'
const chips = '[WIZARD_FILE_CHIPS_V1]\n[{"id":"drop_voice_fixture","filename":"voice.webm","mime":"audio/webm"}]\n[/WIZARD_FILE_CHIPS_V1]'
const helper = '[ASYNC DELEGATION BATCH COMPLETE — deleg_fixture]\nPrivate helper instructions\n\n--- ✓ TASK 1/1: Private goal  (status=completed, api_calls=14) ---\nSaved result\nFull live transcript (complete tool/assistant trace): /private/fixture.log'
const row = content => ({ id: 91, role: 'user', timestamp: 1793856846.181625, display_kind: null, content })
const project = data => JSON.parse(projectWizardMessageHistory(Buffer.from(JSON.stringify({ data }))).toString()).data

test('coalesced voice transcript and recording survive before the answer, without helper text', () => {
  const original = row(helper + '\n\n' + words + '\n\n' + chips)
  const before = JSON.stringify(original)
  const output = project([original, { id: 92, role: 'assistant', timestamp: 1793857159, content: 'That exposed no visible error.' }])
  assert.equal(output.length, 2)
  assert.equal(output[0].role, 'user')
  assert.equal(output[0].content, words + '\n\n' + chips)
  assert.equal(output[0].id, 91)
  assert.equal(output[0].timestamp, original.timestamp)
  assert.ok(!JSON.stringify(output).includes('Private helper'))
  assert.ok(!JSON.stringify(output).includes('/private/'))
  assert.equal(JSON.stringify(original), before)
})
test('structured text coalescing is projected identically', () => {
  assert.deepEqual(project([row([{ type: 'text', text: helper + '\n\n' + words + '\n\n' + chips }])])[0].content, [{ type: 'text', text: words + '\n\n' + chips }])
})
test('helper-only, incomplete, and multi-task reports never become owner bubbles', () => {
  for (const content of [helper, helper + '\n\n', helper.replace('1/1', '1/2') + '\n\nMore private work', helper.replace('Full live transcript', 'No footer') + '\n\nPrivate tail', helper + '\n\n[CONTEXT SUMMARY]: private summary']) assert.deepEqual(project([row(content)]), [])
})
test('multi-task completion takes only the tail after the final task footer', () => {
  const batch = helper.replace('1/1', '1/2') + '\n\n--- ✓ TASK 2/2: Second private goal (status=completed) ---\nSecond result\nFull live transcript (complete tool/assistant trace): /private/second.log'
  assert.equal(project([row(batch + '\n\n' + words)])[0].content, words)
})
for (const kind of kinds) test(`coalesced voice/multipart history through ${kind} route`, async () => {
  const s = await scene(kind)
  try {
    const r = await s.request('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'wizard_parity', source: 'wizard-mobile' }) })
    assert.equal(r.status, 201)
    await serverChecks['coalesced-owner-history'](s)
  } finally { await s.close() }
})
test('ordinary user text quoting a footer and assistant messages are untouched', () => {
  const ordinary = row('Here is a quote:\n' + helper + '\n\n' + words)
  assert.equal(project([ordinary])[0].content, ordinary.content)
  assert.deepEqual(project([{ ...row(helper + '\n\n' + words), role: 'assistant' }]), [])
})
