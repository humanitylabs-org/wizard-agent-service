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
const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' })
const page = await context.newPage(), errors = [], forbidden = [], requests = []
page.on('pageerror', e => errors.push(e.message))
page.on('response', r => { if (r.status() === 403) forbidden.push(r.url()) })
page.on('request', r => { if (r.method() === 'POST') requests.push({ url: r.url(), body: r.postData() }) })
const screenshots = []
async function shot(n) { const path = `${dir}/signin-flow-${n}.png`; await page.screenshot({ path, fullPage: true }); screenshots.push(path) }
async function swipeDeskLeft() {
  const cdp = await context.newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 310, y: 815, id: 1 }] })
  for (const x of [240, 150, 65]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 815, id: 1 }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
  await page.waitForTimeout(700)
}
try {
  const receipt = async () => (await context.request.get(origin + '/__preview/receipt')).json()
  expect(await receipt()).toMatchObject({ synthetic: true, realCredentials: false, signedIn: false, admissions: [], modelRuns: [] })
  await page.addInitScript(value => { localStorage.setItem('wos.skin', value); localStorage.setItem('wos.welcome-seen', '1'); localStorage.setItem('wos.coached', 'true') }, skin)
  await page.goto(origin + '/wizard-os-home/?session=chat-recent&shell=phone', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('html')).toHaveAttribute('data-skin', skin)
  const composer = page.locator('.ch-compose textarea:visible')
  await expect(composer).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.ch-msgs')).toContainText('This is a simulated Claude Opus chat')
  await page.waitForTimeout(1500) // let initial in-shell placement settle before typing
  await composer.fill('Help me plan a quiet weekend.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  // Preserve Wizard's phone Send-and-go behaviour; open its failed thread.
  await expect(page.locator('[data-chopen="chat-recent"]').first()).toBeVisible({ timeout: 30000 })
  await page.locator('[data-chopen="chat-recent"]').first().click()
  const fix = page.getByRole('link', { name: 'Fix it', exact: true })
  await expect(fix).toHaveCount(1, { timeout: 30000 }); await expect(fix).toBeVisible()
  const notice = "Claude's sign-in has expired, so this message wasn't sent to Opus."
  await expect(page.locator('[data-chretry]')).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.ch-msgs')).toContainText(notice, { timeout: 30000 })
  expect((await page.locator('body').innerText()).split(notice)).toHaveLength(2)
  await expect(page.locator('.appr').filter({ hasText: 'Reply not sent' })).toHaveCount(0)
  expect((await receipt()).modelRuns).toEqual([])
  expect((await receipt()).admissions).toHaveLength(1)
  await shot(1)
  await fix.click()
  const coach = page.getByRole('button', { name: 'Got it', exact: true })
  if (await coach.isVisible()) await coach.click()
  await expect.poll(() => page.frames().filter(f => f.url() === origin + '/troubleshoot/').length, { timeout: 30000 }).toBe(1)
  const trouble = page.frame({ url: origin + '/troubleshoot/' })
  const frameBox = await (await trouble.frameElement()).boundingBox()
  if (frameBox.x > 4 || frameBox.x + frameBox.width > 397) await swipeDeskLeft()
  await expect.poll(async () => { const b = await (await trouble.frameElement()).boundingBox(); return b.x >= -1 && b.x + b.width <= 394 }, { timeout: 10000 }).toBe(true)
  await expect(trouble.locator('#pill')).toHaveText('Claude sign-in expired', { timeout: 30000 })
  const reconnect = trouble.getByRole('link', { name: 'Sign in to Claude again', exact: true })
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
  await expect.poll(() => page.frames().filter(f => f.url() === origin + '/wizard-claude/').length, { timeout: 30000 }).toBe(1)
  const connect = page.frame({ url: origin + '/wizard-claude/' })
  await expect(connect.locator('body')).toContainText('STAGING · Simulated sign-in')
  await expect(connect.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  await shot(4)
  await connect.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(connect.locator('#status')).toContainText('Signed in (simulated)')
  expect((await receipt()).signedIn).toBe(true)
  await shot(5)
  // Exercise browser Back from the nested Connect app, then repair window.
  const retry = page.locator('[data-chretry]'), backStates = []
  for (let i = 0; i < 4; i++) {
    // A joint iframe/same-document history step has no top-level load event.
    try { await page.goBack({ waitUntil: 'commit', timeout: 1200 }) } catch (e) { if (e.name !== 'TimeoutError') throw e }
    await page.waitForTimeout(400)
    expect(new URL(page.url()).origin).toBe(new URL(origin).origin)
    await expect(page.locator('.ch-thread')).toBeAttached()
    backStates.push(page.frames().map(f => f.url()))
    const b = await retry.boundingBox()
    if (b && b.x >= 0 && b.x + b.width <= 394) break
  }
  await expect.poll(async () => { const b = await retry.boundingBox(); return !!b && b.x >= 0 && b.x + b.width <= 394 }, { timeout: 10000 }).toBe(true)
  await expect(retry).toBeVisible({ timeout: 10000 })
  await retry.click()
  await expect(page.locator('body')).toContainText('STAGING · Claude Opus (simulated)', { timeout: 30000 })
  await expect(page.locator('[data-chretry]')).toHaveCount(0)
  await expect(page.locator('[data-chstop]')).toHaveCount(0, { timeout: 30000 })
  await expect(page.locator('.ch-compose textarea')).toHaveAttribute('placeholder', 'Message Wizard', { timeout: 30000 })
  await expect(page.locator('#toast.show')).toHaveCount(0, { timeout: 15000 })
  const final = await receipt()
  expect(final.admissions).toHaveLength(2)
  expect(final.admissions[0].input).toEqual(final.admissions[1].input)
  expect(final.admissions.every(a => a.provider === 'anthropic' && a.model === 'claude-opus-5-5')).toBe(true)
  expect(final.modelRuns).toEqual([{ run_id: final.admissions[1].id, provider: 'anthropic', model: 'claude-opus-5-5', synthetic: true }])
  expect(forbidden).toEqual([]); expect(errors).toEqual([]); expect(context.pages()).toHaveLength(1)
  await shot(6)
  const result = { passed: true, skin, phone: '393x852', origin, noticeCount: 1, noFallback: true, repairChat: true, reconnectVisibleOnArrival: true, simulatedSignin: true, retryOriginalSucceeded: true, backStayedInShell: true, backStates, forbidden, errors, final, requests, screenshots }
  writeFileSync(`${dir}/browser-results.json`, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result))
} catch (error) {
  await page.screenshot({ path: `${dir}/failed.png`, fullPage: true }).catch(() => {})
  console.log('IFRAMES', await page.locator('iframe').evaluateAll(es => es.map(e => e.outerHTML)))
  console.log('BODY', await page.locator('body').innerText()); console.log('FRAMES', page.frames().map(f => f.url()))
  for (const f of page.frames().slice(1)) console.log('FRAME_BODY', f.url(), await f.locator('body').innerText().catch(() => ''))
  writeFileSync(`${dir}/browser-results.json`, JSON.stringify({ passed: false, skin, error: String(error), errors, forbidden, requests }, null, 2)); throw error
} finally { await browser.close() }
