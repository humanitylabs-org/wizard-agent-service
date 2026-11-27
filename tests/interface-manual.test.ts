// The shell's interface manual (wizard-ux issue 1437): the wizard-ux app's skill (its generated Wizard interface
// manual) reaches every agent's skills, on for everyone (switch wizard/interface-manual removed); an old switch value
// in the Look file changes nothing. WIZARD_INTERFACE_MANUAL=0 keeps it out. Runs the real service.
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
    ...extra,
  })
  servers.push(s); return s
}
const skills = (state: string) => readdirSync(join(state, 'skills')).filter((n: string) => !n.startsWith('.') && !n.startsWith('wizard-job-')).sort()
const until = async (f: () => boolean) => { for (let i = 0; i < 150 && !f(); i += 1) await new Promise((r) => setTimeout(r, 20)); return f() }

describe('interface manual on for everyone (wizard-ux issue 1437)', () => {
  it('the manual is in the agent skills with no Look file, and an old switch value (off or on) changes nothing', async () => {
    const b = box(); start(b)
    const c = box(); setLook(c.root, false); start(c)
    const d = box(); setLook(d.root, true); start(d)
    for (const x of [b, c, d]) expect(await until(() => existsSync(join(x.state, 'skills', 'wizard-ux', 'SKILL.md')))).toBe(true)
    await new Promise((r) => setTimeout(r, 200)) // the manual stays put
    for (const x of [b, c, d]) {
      expect(skills(x.state)).toEqual(['hello-wizard', 'wizard-ux'])
      expect(readFileSync(join(x.state, 'skills', 'wizard-ux', 'SKILL.md'), 'utf8')).toBe(MANUAL)
    }
  })

  it('WIZARD_INTERFACE_MANUAL=0 keeps the manual out; the other app skills stay', () => {
    const b = box(); start(b, { interfaceManual: false })
    expect(skills(b.state)).toEqual(['hello-wizard'])
  })
})
