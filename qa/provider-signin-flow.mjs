// Run on forum against the actual private, synthetic-only staging origin.
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const require = createRequire(import.meta.url)
const { chromium, expect } = require(process.env.PLAYWRIGHT_MODULE || '@playwright/test')
const origin = process.env.PREVIEW_ORIGIN, skin = process.env.QA_SKIN || 'nebula'
if (!origin) throw Error('Set PREVIEW_ORIGIN to the isolated synthetic staging URL')
const dir = resolve(process.env.QA_EVIDENCE || 'evidence/signin-flow'); mkdirSync(dir, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true })
const page = await context.newPage(), errors = [], forbidden = [], requests = []
page.on('pageerror', e => errors.push(e.message))
page.on('response', r => { if (r.status() === 403) forbidden.push(r.url()) })
page.on('request', r => { if (r.method() === 'POST') requests.push({ url: r.url(), body: r.postData() }) })
const screenshots = []
async function shot(n) { const path = `${dir}/signin-flow-${n}.png`; await page.screenshot({ path, fullPage: true }); screenshots.push(path) }
try {
  const receipt = async () => (await context.request.get(origin + '/__preview/receipt')).json()
  expect(await receipt()).toMatchObject({ synthetic: true, realCredentials: false, signedIn: false, admissions: [], modelRuns: [] })
  await page.addInitScript(value => { localStorage.setItem('wos.skin', value); localStorage.setItem('wos.welcome-seen', '1'); localStorage.setItem('wos.coached', 'true') }, skin)
  await page.goto(origin + '/wizard-os-home/?session=chat-recent&shell=phone', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('html')).toHaveAttribute('data-skin', skin)
  const composer = page.locator('.ch-compose textarea:visible')
  await expect(composer).toBeVisible({ timeout: 30000 })
  await composer.fill('Help me plan a quiet weekend.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const fix = page.getByRole('link', { name: 'Fix it', exact: true })
  await expect(fix).toHaveCount(1, { timeout: 30000 }); await expect(fix).toBeVisible()
  const notice = "Claude's sign-in has expired, so this message wasn't sent to Opus."
  expect((await page.locator('body').innerText()).split(notice)).toHaveLength(2)
  await expect(page.locator('[data-chretry]')).toBeVisible()
  await expect(page.locator('.appr').filter({ hasText: 'Reply not sent' })).toHaveCount(0)
  expect((await receipt()).modelRuns).toEqual([])
  expect((await receipt()).admissions).toHaveLength(1)
  await shot(1)
  await fix.click()
  const troubleEl = page.locator('.win iframe[src="/troubleshoot/"]')
  await expect(troubleEl).toHaveCount(1, { timeout: 30000 })
  const trouble = troubleEl.contentFrame()
  await expect(trouble.locator('#pill')).toHaveText('Claude sign-in expired', { timeout: 30000 })
  const reconnect = trouble.getByRole('button', { name: 'Sign in to Claude again', exact: true })
  await expect(reconnect).toBeVisible(); await expect(trouble.locator('#sheet')).not.toHaveClass(/open/)
  expect(context.pages()).toHaveLength(1)
  await expect(page.locator('#toast.show')).toHaveCount(0, { timeout: 15000 })
  await shot(2)
  await trouble.locator('#input').fill('My Wizard is down, please fix it.')
  await trouble.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(trouble.locator('body')).toContainText('STAGING · ChatGPT (simulated)', { timeout: 30000 })
  await expect(trouble.locator('body')).not.toContainText('HTTP 403')
  expect((await receipt()).modelRuns).toEqual([])
  await shot(3)
  await reconnect.click()
  const connectEl = page.locator('.win iframe[src="/wizard-claude/"]')
  await expect(connectEl).toHaveCount(1, { timeout: 30000 })
  const connect = connectEl.contentFrame()
  await expect(connect.locator('body')).toContainText('STAGING · Simulated sign-in')
  await expect(connect.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  await shot(4)
  await connect.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(connect.locator('#status')).toContainText('Signed in (simulated)')
  expect((await receipt()).signedIn).toBe(true)
  await shot(5)
  // Exercise browser Back from the nested Connect app, then repair window.
  await page.goBack()
  expect(new URL(page.url()).origin).toBe(new URL(origin).origin)
  await expect(page.locator('#phone, .ph-shell, #desk').first()).toBeAttached()
  // The thread can remain beside the app but be offscreen on a phone. Activate it
  // through the shell's own window registry (equivalent to its overview card).
  console.log('AFTER_BACK', await page.locator('body').innerText())
  const retry = page.locator('[data-chretry]')
  if (!(await retry.isVisible())) {
    const back = page.locator('.win.active [data-wclose], .win.active [data-close], .win.active .win-close').first()
    if (await back.count()) await back.click()
  }
  await expect(retry).toBeVisible({ timeout: 10000 })
  await retry.click()
  await expect(page.locator('body')).toContainText('STAGING · Claude Opus (simulated)', { timeout: 30000 })
  await expect(page.locator('[data-chretry]')).toHaveCount(0)
  const final = await receipt()
  expect(final.admissions).toHaveLength(2)
  expect(final.admissions[0].input).toEqual(final.admissions[1].input)
  expect(final.admissions.every(a => a.provider === 'anthropic' && a.model === 'claude-opus-5-5')).toBe(true)
  expect(final.modelRuns).toEqual([{ run_id: final.admissions[1].id, provider: 'anthropic', model: 'claude-opus-5-5', synthetic: true }])
  expect(forbidden).toEqual([]); expect(errors).toEqual([]); expect(context.pages()).toHaveLength(1)
  await shot(6)
  const result = { passed: true, skin, phone: '393x852', origin, noticeCount: 1, noFallback: true, repairChat: true, reconnectVisibleOnArrival: true, simulatedSignin: true, retryOriginalSucceeded: true, backStayedInShell: true, forbidden, errors, final, requests, screenshots }
  writeFileSync(`${dir}/browser-results.json`, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result))
} catch (error) {
  await page.screenshot({ path: `${dir}/failed.png`, fullPage: true }).catch(() => {})
  console.log('BODY', await page.locator('body').innerText()); console.log('FRAMES', page.frames().map(f => f.url()))
  for (const f of page.frames().slice(1)) console.log('FRAME_BODY', f.url(), await f.locator('body').innerText().catch(() => ''))
  writeFileSync(`${dir}/browser-results.json`, JSON.stringify({ passed: false, skin, error: String(error), errors, forbidden, requests }, null, 2)); throw error
} finally { await browser.close() }
