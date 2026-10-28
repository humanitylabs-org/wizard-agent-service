import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createWizardServer, runInstructions, WIZARD_RUN_INSTRUCTIONS } from '../server/service.mjs'
import { agentRunInstructions } from '../server/agents-http.mjs'
import { SUMMARY_REPLY_INSTRUCTIONS, CONCISE_REPLY_INSTRUCTIONS, OWNED_OPEN_WORK_INSTRUCTIONS, STATUS_INSTRUCTIONS, STATUS_PROTOCOL_INSTRUCTIONS, SUPERVISOR_SPELL } from '../server/thread-status.mjs'
import { initializeResponseStyle, normalizeSettings, readSettings } from '../server/wizard-os-settings.mjs'
const dirs: string[] = []
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'style-')); dirs.push(dir); return join(dir, 'settings.json') }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
it('new installs get either persisted assignment, upgrades keep Summary, reads never randomize', () => {
  for (const [coin, style] of [[0, 'summary'], [1, 'concise']] as const) {
    const path = fresh()
    initializeResponseStyle(path, { existingInstall: false, choose: () => coin })
    initializeResponseStyle(path, { existingInstall: true, choose: () => { throw Error('rerolled') } })
    expect(readSettings(path).settings.response_style).toBe(style)
    expect(JSON.parse(readFileSync(path, 'utf8')).response_style_experiment).toEqual({ assigned: style, source: 'new_install', switches: { summary: 0, concise: 0 } })
  }
  const path = fresh()
  writeFileSync(path, JSON.stringify({ owner: { name: 'Synthetic owner' }, future: 'kept' }))
  initializeResponseStyle(path, { existingInstall: false, choose: () => { throw Error('upgrade rerolled') } })
  expect(readSettings(path).settings.response_style).toBe('summary')
  expect(JSON.parse(readFileSync(path, 'utf8')).future).toBe('kept')
  expect(normalizeSettings({ response_style: 'bad' }).response_style).toBe('summary')
})
it('response style migration keeps damaged-settings startup fallback and never rewrites an assigned file', () => {
  for (const bytes of ['{invalid', 'x'.repeat(256 * 1024 + 1), '[]', 'null']) {
    const path = fresh()
    writeFileSync(path, bytes)
    expect(initializeResponseStyle(path, { choose: () => { throw Error('rerolled') } })?.response_style).toBe('summary')
    expect(readFileSync(path, 'utf8')).toBe(bytes)
    expect(readSettings(path).settings.response_style).toBe('summary')
  }
  const path = fresh(), bytes = '{"response_style":"concise"}'
  writeFileSync(path, bytes)
  expect(initializeResponseStyle(path)?.response_style).toBe('concise')
  expect(readFileSync(path, 'utf8')).toBe(bytes)
})
it('Concise keeps the live owned-work follow-through rule without forcing Summary labels', () => {
  for (const join of [true, false]) {
    const instructions = runInstructions({ join, response_style: 'concise' })
    expect(instructions).not.toContain('Under **Still open:**')
    expect(instructions).toContain('For any unfinished work you own, name its live handle and when it lands')
    expect(instructions).toContain('Dispatch agent-owned follow-ups within existing authority in this same turn')
    expect(instructions).toContain('Only owner decisions, money, external sends, or wider authority may be asked of the owner')
  }
  expect(runInstructions({ join: true, response_style: 'summary' })).toContain('Under **Still open:**')
})
it('response style is an owner setting', async () => {
  const path = fresh(), proof = 'synthetic-owner-proof-'.repeat(3)
  initializeResponseStyle(path)
  const server = createWizardServer({ requireAccess: false, ownerProof: proof, settingsPath: path, followThrough: false })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as any).port}`
  const req = (body?: object, owner = true) => fetch(origin + '/wizard/v1/settings', { method: body ? 'PUT' : 'GET', headers: { ...(owner ? { 'x-wizard-owner-proof': proof } : {}), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  try {
    expect((await req({ response_style: 'concise' }, false)).status).toBe(403)
    expect((await req({ response_style: 'other' })).status).toBe(400)
    for (const style of ['concise', 'concise', 'summary']) {
      expect((await req({ response_style: style, response_style_experiment: { assigned: 'FORGED_CONTENT' } })).status).toBe(200)
      expect((await (await req()).json()).settings.response_style).toBe(style)
    }
    expect((await req({ clock: { timezone: 'UTC' } })).status).toBe(200)
    expect((await (await req()).json()).settings.response_style).toBe('summary')
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    expect(raw.response_style_experiment).toEqual({ assigned: 'summary', source: 'existing_install', switches: { summary: 1, concise: 1 } })
    expect(JSON.stringify(raw)).not.toContain('FORGED_CONTENT')
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

it('Own style sends Wizard OS facts and protocol only, never reply-style rules', () => {
  const style = ['Apply the same intelligence', 'Scale the response to the request', 'owns the requested outcome', 'Finish with one self-contained', 'Briefly restate', 'The reply itself ends with the same ask', 'A background handoff is still agent-owned work', 'Answer with the same care']
  const facts = ['Wizard renders Markdown', 'MEDIA:/absolute/path', 'Skins/My skin/', '[WIZARD_STATUS_V1]', 'Leave the line out of interim progress messages']
  for (const join of [true, false]) {
    const own = runInstructions({ join, response_style: 'own' })
    for (const text of [SUMMARY_REPLY_INSTRUCTIONS, CONCISE_REPLY_INSTRUCTIONS, OWNED_OPEN_WORK_INSTRUCTIONS, STATUS_INSTRUCTIONS, ...style]) expect(own).not.toContain(text)
    for (const text of [STATUS_PROTOCOL_INSTRUCTIONS, SUPERVISOR_SPELL, ...facts]) expect(own).toContain(text)
    expect(own.includes('Wizard brings their results back to you as a follow-up turn')).toBe(!join)
    expect(own.endsWith(STATUS_PROTOCOL_INSTRUCTIONS)).toBe(true)
  }
  const agent = agentRunInstructions('own')
  for (const text of [SUMMARY_REPLY_INSTRUCTIONS, STATUS_INSTRUCTIONS, ...style]) expect(agent).not.toContain(text)
  for (const text of [STATUS_PROTOCOL_INSTRUCTIONS, SUPERVISOR_SPELL, 'private agents are not readable by standard agents', ...facts.filter(text => text !== 'Skins/My skin/')]) expect(agent).toContain(text)
  // Existing styles are byte-for-byte unchanged.
  expect(runInstructions({ join: true, response_style: 'summary' })).toBe(WIZARD_RUN_INSTRUCTIONS)
  expect(STATUS_INSTRUCTIONS.startsWith(STATUS_PROTOCOL_INSTRUCTIONS.slice(0, 200))).toBe(true)
})
it('Own is a saved owner choice that survives restart and normalization', async () => {
  const path = fresh(), proof = 'synthetic-owner-proof-'.repeat(3)
  initializeResponseStyle(path)
  const server = createWizardServer({ requireAccess: false, ownerProof: proof, settingsPath: path, followThrough: false })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as any).port}`
  try {
    const put = await fetch(origin + '/wizard/v1/settings', { method: 'PUT', headers: { 'x-wizard-owner-proof': proof, 'content-type': 'application/json' }, body: JSON.stringify({ response_style: 'own' }) })
    expect(put.status).toBe(200)
    expect(readSettings(path).settings.response_style).toBe('own')
    expect(JSON.parse(readFileSync(path, 'utf8')).response_style_experiment.switches).toEqual({ summary: 0, concise: 0, own: 1 })
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  expect(initializeResponseStyle(path, { choose: () => { throw Error('rerolled') } })?.response_style).toBe('own')
  expect(normalizeSettings({ response_style: 'own' }).response_style).toBe('own')
})
