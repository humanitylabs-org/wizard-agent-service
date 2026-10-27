// Run on forum against the actual private synthetic staging URL, never a real run.
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const require = createRequire(import.meta.url)
const { chromium, expect } = require(process.env.PLAYWRIGHT_MODULE || '@playwright/test')
const origin = process.env.PREVIEW_ORIGIN
if (!origin) throw Error('Set PREVIEW_ORIGIN to the synthetic-only preview origin')
const dir = resolve(process.env.QA_EVIDENCE || 'evidence/provider-signin'); mkdirSync(dir, { recursive: true })
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) })
const results = []
try {
  for (const skin of ['nebula', 'signal']) for (const phone of [true, false]) {
    const label = `${skin}-${phone ? 'phone' : 'desktop'}`
    const context = await browser.newContext({ viewport: phone ? { width: 393, height: 852 } : { width: 1280, height: 900 }, isMobile: phone, hasTouch: phone })
    const page = await context.newPage()
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(value => { localStorage.setItem('wos.skin', value); localStorage.setItem('wos.welcome-seen', '1'); localStorage.setItem('wos.coached', 'true') }, skin)
    const receipt = await (await context.request.get(origin + '/__preview/receipt')).json()
    expect(receipt).toMatchObject({ synthetic: true, readOnly: true, realCredentials: false })
    await page.goto(origin + `/wizard-os-home/?session=chat-recent&shell=${phone ? 'phone' : 'desktop'}`, { waitUntil: 'domcontentloaded' })
    const link = page.getByRole('link', { name: 'Fix it', exact: true }).first()
    await expect(link).toBeVisible({ timeout: 30000 })
    await expect(page.locator('html')).toHaveAttribute('data-skin', skin)
    await expect(link).toHaveAttribute('href', '/troubleshoot/')
    const assistant = link.locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," msg ")][1]')
    expect(await assistant.getAttribute('class')).not.toMatch(/(?:^|\s)u(?:\s|$)/)
    await expect(assistant).toContainText("Claude's sign-in on your Wizard has expired")
    const noticeText = "Claude's sign-in on your Wizard has expired"
    // Regression: assistant notice + Reply not sent + Needs retry used to repeat
    // the same explanation. Keep one notice and the existing recovery controls.
    expect((await page.locator('body').innerText()).split(noticeText).length - 1).toBe(1)
    await expect(page.getByRole('link', { name: 'Fix it', exact: true })).toHaveCount(1)
    await expect(page.locator('.appr').filter({ hasText: 'Reply not sent' })).toHaveCount(0)
    await expect(page.locator('body')).not.toContainText('hermes auth')
    await expect(page.locator('[data-chretry]').first()).toBeVisible()
    await expect(page.locator('[data-chretry]').first()).toBeEnabled()
    // The shell may auto-dock the linked app while opening this thread. Let its
    // placement toast/animation finish so evidence does not capture an overlap.
    await expect(page.locator('#toast.show')).toHaveCount(0, { timeout: 15000 })
    await page.screenshot({ path: `${dir}/${label}.png`, fullPage: true })
    await link.click()
    // Relative app links open beside the chat inside the shell, not in a tab.
    // Both shells host the destination in a .win iframe.
    const trouble = page.locator('.win iframe[src="/troubleshoot/"]')
    await expect(trouble).toHaveCount(1, { timeout: 30000 })
    const src = new URL(await trouble.getAttribute('src'), page.url())
    expect(src.origin).toBe(new URL(origin).origin)
    expect(src.pathname).toBe('/troubleshoot/')
    const troubleBody = trouble.contentFrame().locator('body')
    await expect(troubleBody).toContainText(/Troubleshoot|Wizard/i, { timeout: 30000 })
    const loaded = await trouble.contentFrame().locator('html').evaluate(el => ({ url: el.ownerDocument.location.href, state: el.ownerDocument.readyState }))
    expect(new URL(loaded.url).origin).toBe(new URL(origin).origin)
    expect(new URL(loaded.url).pathname).toBe('/troubleshoot/')
    expect(loaded.state).not.toBe('loading')
    expect(context.pages()).toHaveLength(1)
    await expect(page.locator('#toast.show')).toHaveCount(0, { timeout: 15000 })
    await page.screenshot({ path: `${dir}/${label}-fix-it.png`, fullPage: true })
    const denied = await context.request.post(origin + '/wizard/hermes/v1/runs', { data: {} })
    expect(denied.status()).toBe(403)
    const finalReceipt = await (await context.request.get(origin + '/__preview/receipt')).json()
    expect(finalReceipt).toEqual(receipt)
    expect(errors).toEqual([])
    results.push({ label, passed: true, sha: receipt.sha, errors, screenshot: `${dir}/${label}.png`, fixItScreenshot: `${dir}/${label}-fix-it.png`, noticeCount: 1, assistantAuthored: true, inShellFix: true, sameOriginFix: true, retryEnabled: true, writesDenied: true, receiptUnchanged: true })
    await context.close()
  }
  writeFileSync(`${dir}/browser-results.json`, JSON.stringify({ passed: results.length, failed: 0, origin, results }, null, 2))
  console.log(JSON.stringify({ browserPassed: results.length, origin, results }))
} catch (error) {
  writeFileSync(`${dir}/browser-results.json`, JSON.stringify({ passed: results.length, failed: 1, origin, results, error: String(error) }, null, 2)); throw error
} finally { await browser.close() }
