import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

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
