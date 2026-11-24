// The shell's interface manual (wizard-ux issue 1437, switch wizard/interface-manual): the wizard-ux app's skill
// (its generated Wizard interface manual) reaches the agent's skills only while the owner's switch in the Look file is
// on, and leaves again when it goes off. Off, the agent's skills are what they were. Runs the real service.
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer } from '../server/service.mjs'

const dirs: string[] = [], servers: any[] = []
afterEach(() => {
  servers.splice(0).forEach((s) => { try { s.close() } catch { /* not listening */ } s.emit?.('close') })
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})
const MANUAL = '---\nname: wizard-interface\ndescription: "Wizard setting or screen"\n---\nSettings › Appearance\n'
const HELLO = '---\nname: hello-wizard\ndescription: hello\n---\nhello\n'

function box() {
  const root = mkdtempSync(join(tmpdir(), 'interface-manual-')); dirs.push(root)
  const reg = join(root, 'registry'), state = join(root, 'state')
  for (const [id, text] of [['wizard-ux', MANUAL], ['hello-wizard', HELLO]]) {
    mkdirSync(join(reg, 'skills', id), { recursive: true }); writeFileSync(join(reg, 'skills', id, 'SKILL.md'), text)
  }
  writeFileSync(join(reg, 'apps.json'), JSON.stringify({ schema: 1, apps: [
    { id: 'wizard-ux', name: 'Wizard Shell', status: 'running', provides: ['shell'], mcp: null, skill: 'skills/wizard-ux/SKILL.md' },
    { id: 'hello-wizard', name: 'Hello', status: 'running', provides: ['hello'], mcp: { url: 'http://127.0.0.1:9/mcp' }, skill: 'skills/hello-wizard/SKILL.md' },
  ] }))
  mkdirSync(state, { recursive: true })
  return { root, reg, state }
}
const setLook = (root: string, on: boolean, at = 1) => {
  mkdirSync(join(root, 'Pages', 'wizard-look'), { recursive: true })
  writeFileSync(join(root, 'Pages', 'wizard-look', 'look.json'), JSON.stringify({ version: 1, skin: null, tweaks: { 'wizard/interface-manual': { on, at } } }))
}
function start(b: ReturnType<typeof box>, extra: Record<string, unknown> = {}) {
  const s = createWizardServer({
    wizardOsHome: b.reg, bridgeSkillsHome: b.state, appsJsonPath: join(b.reg, 'apps.json'), requireAccess: false, hermesKey: 'test',
    followThrough: false, runQueueStatePath: join(b.root, 'q.db'), runQueuePollIntervalMs: 0, bridgeWatchMs: 0, bridgeLog: () => {},
    mcpToken: 'fixture-gateway', pagesRoot: join(b.root, 'Pages'), pagesGitDir: join(b.root, 'pages-history.git'), pagesWatch: false,
    interfaceManualTtlMs: 0, interfaceManualWatchMs: 20, ...extra,
  })
  servers.push(s); return s
}
const skills = (state: string) => readdirSync(join(state, 'skills')).filter((n: string) => !n.startsWith('.') && !n.startsWith('wizard-job-')).sort()
const until = async (f: () => boolean) => { for (let i = 0; i < 150 && !f(); i += 1) await new Promise((r) => setTimeout(r, 20)); return f() }

describe('interface manual switch (wizard-ux issue 1437)', () => {
  it('off (no Look file, or the switch off): the agent gets every other app skill and no manual', async () => {
    const b = box(); start(b)
    const c = box(); setLook(c.root, false); start(c)
    await new Promise((r) => setTimeout(r, 200)) // several switch checks
    expect(skills(b.state)).toEqual(['hello-wizard'])
    expect(skills(c.state)).toEqual(['hello-wizard'])
  })

  it('on: the manual is in the agent skills; turning the switch off later removes it, on again brings it back, no restart', async () => {
    const b = box(); setLook(b.root, true); start(b)
    // the service reads the Look file once its Pages store is up: the first switch check (every 20 ms here, 3 s on a box)
    expect(await until(() => existsSync(join(b.state, 'skills', 'wizard-ux', 'SKILL.md')))).toBe(true)
    expect(skills(b.state)).toEqual(['hello-wizard', 'wizard-ux'])
    expect(readFileSync(join(b.state, 'skills', 'wizard-ux', 'SKILL.md'), 'utf8')).toBe(MANUAL)
    setLook(b.root, false, 2)
    expect(await until(() => !existsSync(join(b.state, 'skills', 'wizard-ux')))).toBe(true)
    expect(skills(b.state)).toEqual(['hello-wizard'])
    setLook(b.root, true, 3)
    expect(await until(() => existsSync(join(b.state, 'skills', 'wizard-ux', 'SKILL.md')))).toBe(true)
  })

  it('WIZARD_INTERFACE_MANUAL wins over the switch: 1 always on, 0 always off', () => {
    const b = box(); start(b, { interfaceManual: true })
    expect(skills(b.state)).toEqual(['hello-wizard', 'wizard-ux'])
    const c = box(); setLook(c.root, true); start(c, { interfaceManual: false })
    expect(skills(c.state)).toEqual(['hello-wizard'])
  })
})
