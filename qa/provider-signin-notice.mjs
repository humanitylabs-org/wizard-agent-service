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
    await page.addInitScript(value => { localStorage.setItem('wos.skin', value); localStorage.setItem('wos.welcome-seen', '1') }, skin)
    const receipt = await (await context.request.get(origin + '/__preview/receipt')).json()
    expect(receipt).toMatchObject({ synthetic: true, readOnly: true, realCredentials: false })
    await page.goto(origin + `/wizard-os-home/?session=chat-recent&shell=${phone ? 'phone' : 'desktop'}`, { waitUntil: 'domcontentloaded' })
    const link = page.getByRole('link', { name: 'Fix it', exact: true }).first()
    await expect(link).toBeVisible({ timeout: 30000 })
    await expect(link).toHaveAttribute('href', '/troubleshoot/')
    const assistant = link.locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," msg ")][1]')
    expect(await assistant.getAttribute('class')).not.toMatch(/(?:^|\s)u(?:\s|$)/)
    await expect(assistant).toContainText("Claude's sign-in on your Wizard has expired")
    await expect(page.locator('body')).not.toContainText('hermes auth')
    await expect(page.locator('[data-chretry]').first()).toBeVisible()
    await expect(page.locator('[data-chretry]').first()).toBeEnabled()
    await page.screenshot({ path: `${dir}/${label}.png`, fullPage: true })
    const [trouble] = await Promise.all([context.waitForEvent('page'), link.click()])
    await trouble.waitForLoadState('domcontentloaded')
    expect(new URL(trouble.url()).origin).toBe(new URL(origin).origin)
    expect(new URL(trouble.url()).pathname).toBe('/troubleshoot/')
    await expect(trouble.locator('body')).toContainText(/Troubleshoot|Wizard/i)
    const denied = await context.request.post(origin + '/wizard/hermes/v1/runs', { data: {} })
    expect(denied.status()).toBe(403)
    const finalReceipt = await (await context.request.get(origin + '/__preview/receipt')).json()
    expect(finalReceipt.run_id).toBe(receipt.run_id)
    results.push({ label, passed: true, sha: receipt.sha, errors, screenshot: `${dir}/${label}.png`, sameOriginFix: true, retryEnabled: true, writesDenied: true })
    await context.close()
  }
  writeFileSync(`${dir}/browser-results.json`, JSON.stringify({ passed: results.length, failed: 0, origin, results }, null, 2))
  console.log(JSON.stringify({ browserPassed: results.length, origin, results }))
} catch (error) {
  writeFileSync(`${dir}/browser-results.json`, JSON.stringify({ passed: results.length, failed: 1, origin, results, error: String(error) }, null, 2)); throw error
} finally { await browser.close() }
