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
it('the saved style is retired: startup and reads use Own without rewriting owner settings', () => {
  for (const bytes of ['{invalid', 'x'.repeat(256 * 1024 + 1), '[]', 'null', '{"response_style":"concise"}', '{"response_style":"summary","future":"kept"}']) {
    const path = fresh()
    writeFileSync(path, bytes)
    expect(initializeResponseStyle(path, { existingInstall: false, choose: () => { throw Error('retired randomizer') } })?.response_style).toBe('own')
    expect(readSettings(path).settings.response_style).toBe('own')
    expect(readFileSync(path, 'utf8')).toBe(bytes)
  }
  const path = fresh()
  expect(initializeResponseStyle(path, { existingInstall: false, choose: () => { throw Error('retired randomizer') } })?.response_style).toBe('own')
  expect(() => readFileSync(path)).toThrow()
  expect(normalizeSettings({ response_style: 'summary' }).response_style).toBe('own')
})
it('legacy style writes retain owner authorization and always read back Own', async () => {
  const path = fresh(), proof = 'synthetic-owner-proof-'.repeat(3)
  const server = createWizardServer({ requireAccess: false, ownerProof: proof, settingsPath: path, followThrough: false })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as any).port}`
  const req = (body?: object, owner = true) => fetch(origin + '/wizard/v1/settings', { method: body ? 'PUT' : 'GET', headers: { ...(owner ? { 'x-wizard-owner-proof': proof } : {}), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  try {
    expect((await req({ response_style: 'concise' }, false)).status).toBe(403)
    expect((await req({ response_style: 'other' })).status).toBe(400)
    for (const style of ['concise', 'summary', 'own']) {
      expect((await req({ response_style: style })).status).toBe(200)
      expect((await (await req()).json()).settings.response_style).toBe('own')
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
it('every saved style, main and separate agents, gets the same Own contract', () => {
  for (const response_style of ['summary', 'concise', 'own', undefined] as const) {
    for (const join of [true, false]) expect(runInstructions({ join, response_style })).toBe(runInstructions({ join, response_style: 'own' }))
    expect(agentRunInstructions(response_style)).toBe(agentRunInstructions('own'))
  }
})
it('Own style sends Wizard OS facts and protocol only, never reply-style rules', () => {
  const style = ['Apply the same intelligence', 'Scale the response to the request', 'owns the requested outcome', 'Finish with one self-contained', 'Briefly restate', 'The reply itself ends with the same ask', 'A background handoff is still agent-owned work', 'Answer with the same care']
  const facts = ['record it in your own persona file (SOUL.md in your home', 'Wizard renders Markdown', 'MEDIA:/absolute/path', 'Skins/My skin/', '[WIZARD_STATUS_V1]', 'Leave the line out of interim progress messages']
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
  expect(STATUS_INSTRUCTIONS.startsWith(STATUS_PROTOCOL_INSTRUCTIONS.slice(0, 200))).toBe(true)
})
