import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
const root = process.argv[2], phase = process.argv[3]
if (!root?.startsWith('/srv/work/')) throw Error('forum_staging_only')
const { origin } = JSON.parse(readFileSync(root + '/proxy-ready.json'))
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ ignoreHTTPSErrors: true })
const url = origin + '/wizard/views/shared-vault/'
try {
  const page = await context.newPage()
  assert.equal((await page.goto(url)).status(), 403)
  await context.addCookies([{ name: '__Host-sv-owner', value: 'non-owner-viewer', url: origin, secure: true, httpOnly: true, sameSite: 'Strict' }])
  assert.equal((await page.goto(url)).status(), 403)
  await context.addCookies([{ name: '__Host-sv-owner', value: readFileSync(root + '/service-private/session', 'utf8').trim(), url: origin, secure: true, httpOnly: true, sameSite: 'Strict' }])
  assert.equal((await page.goto(url)).status(), 200)
  await page.waitForFunction(() => document.getElementById('message')?.textContent === '')
  const call = (path, value) => page.evaluate(async ({path, value}) => {
    const reply = await fetch('/wizard/apps/shared-vault/api/' + path, value === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
    return { status: reply.status, body: await reply.json() }
  }, { path, value })
  let handles
  if (phase === 'initial') {
    const status = await call('status'); assert.equal(status.status, 200); assert.equal(status.body.synthetic, true)
    assert.equal((await call('connect', { organization_id: status.body.scope.organization_id, collection_id: status.body.scope.collection_id })).status, 200)
    handles = {}
    for (const principal of ['agent-a', 'agent-b']) {
      const reply = await call('grant', { principal, item_id: '44444444-4444-4444-8444-444444444444', endpoint_id: 'health' })
      assert.equal(reply.status, 200); assert.match(reply.body.handle, /^shared_/u); handles[principal] = reply.body.handle
    }
    writeFileSync(root + '/handles.json', JSON.stringify(handles), { mode: 0o600 })
  } else {
    handles = JSON.parse(readFileSync(root + '/handles.json'))
    const status = await call('status'); assert.equal(status.status, 200)
    assert.equal(status.body.grants.length, phase === 'revoked' ? 1 : 2)
  }
  const csrf = await page.request.post(origin + '/wizard/apps/shared-vault/api/disconnect', { headers: { origin: 'https://evil.fixture.test', 'content-type': 'application/json' }, data: '{}' })
  assert.equal(csrf.status(), 403)
  for (const suffix of ['status?owner=true', '%73tatus', 'status/', 'unknown']) assert.equal((await page.request.get(origin + '/wizard/apps/shared-vault/api/' + suffix)).status(), 403)
  // A real browser can render only credential-free metadata; no token is in JS/DOM.
  await page.screenshot({ path: `${root}/${phase}-owner.png`, fullPage: true })
  const dom = await page.content()
  for (const canary of ['synthetic-owner-token-only-for-tests-000', 'SYNTHETIC_SHARED_PASSWORD_DO_NOT_RETURN_98']) assert(!dom.includes(canary))
  if (phase === 'revoke') assert.equal((await call('revoke', { handle: handles['agent-a'] })).status, 200)
  writeFileSync(`${root}/${phase}-owner.json`, JSON.stringify({ passed: true, real_service: true, synthetic_provider: true, dedicated_owner_session: true, production_activation: false }))
} finally { await context.close(); await browser.close() }
