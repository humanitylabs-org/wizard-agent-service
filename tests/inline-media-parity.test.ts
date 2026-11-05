import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

it('inline-image parity cannot pass before the viewer and Back assertions', () => {
  const source = readFileSync(new URL('../qa/agent-parity/browser.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('const inlineOrder=')
  const pass = source.indexOf("record('inline-agent-images'", start)
  const viewer = source.indexOf("await page.locator('.mviewer').waitFor()", start)
  const back = source.indexOf("await page.locator('.mviewer').waitFor({state:'hidden'})", viewer)
  const thread = source.indexOf("'Back keeps the same thread'", back)
  expect(start).toBeGreaterThan(-1)
  expect(viewer).toBeGreaterThan(start)
  expect(back).toBeGreaterThan(viewer)
  expect(thread).toBeGreaterThan(back)
  expect(pass).toBeGreaterThan(thread)
  expect(source).toContain("assert.equal(inlineThread,'wizard_parity')")
  expect(source).toContain("assert.equal(await page.evaluate(win=>__wos.wins[win]?.thread,inlineWindow),inlineThread,'Back keeps the same thread')")
})

it('media parity executes each real shell API without a phone alias on desktop', async () => {
  const source = readFileSync(new URL('../qa/agent-parity/browser.mjs', import.meta.url), 'utf8')
  const media = source.slice(source.indexOf('async function mediaChecks'), source.indexOf('async function staticChecks'))
  const ready = media.match(/await p\.waitForFunction\(([^\n]+),\{timeout:30000\}\)/)![1]
  const selected = media.match(/const selected=([^\n]+)/)![1]
  for (const phone of [true, false]) {
    const shell = phone ? 'phone' : 'desktop'
    const key = phone ? '__wos' : '__wux'
    const win = { id: 'actual-window', app: 'chats', focus: { kind: 'agent', key: 'scoped-agent' }, thread: 'wizard_parity' }
    const sandbox = { window: { [key]: { live: { ok: true }, wins: { [win.id]: win } } }, document: { documentElement: { dataset: { shell } } }, s: { id: 'scoped-agent' }, phone }
    // Execute the exact Playwright callback AND argument, not a copied resolver.
    expect(runInNewContext(`((fn,arg)=>fn(arg))(${ready})`, sandbox)).toBe(true)
    const select = runInNewContext(`(${selected})`, sandbox)
    const actual = await select({ evaluate: (fn: Function, arg: string) => fn(arg) })
    expect(JSON.parse(JSON.stringify(actual))).toEqual({ id: win.id, agent: 'scoped-agent', thread: 'wizard_parity' })
    sandbox.window[key].live.ok = false
    expect(runInNewContext(`((fn,arg)=>fn(arg))(${ready})`, sandbox)).toBe(false)
    sandbox.s.id = 'other-agent'
    expect(await select({ evaluate: (fn: Function, arg: string) => fn(arg) })).toBe(null)
  }
  const selection = source.match(/const mediaShells=([^\n]+)/)![1]
  for (const [value, expected] of [[undefined, ['phone', 'desktop']], ['desktop', ['desktop']], ['phone', ['phone']]] as const) {
    const actual = runInNewContext(`const mediaShells=${selection};mediaShells`, { process: { env: { QA_MEDIA_SHELLS: value } }, selectedGroup: 'media', assert: { ok: (v: boolean) => { if (!v) throw Error('invalid shells') } } })
    expect(JSON.parse(JSON.stringify(actual))).toEqual(expected)
  }
  expect(media.match(/__wos/g)).toHaveLength(3) // readiness, selection, phone-only native Back
  expect(media).not.toContain('__wos.wins')
})
