import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { servePhoneFeed } from '../server/phone-feed.mjs'
import { createWizardServer, createTailnetIngress, listen } from '../server/service.mjs'

const prefix = '/reports/wizard-os/'
const apkName = 'wizard-os-0.10.14.apk'
const apk = Buffer.from('fixture APK bytes')
const feed = JSON.stringify({ app: 'ai.wizards.os', versionCode: 78, versionName: '0.10.14', url: apkName })
async function fixture(t, populated = true) {
  const dir = mkdtempSync(join(tmpdir(), 'phone-feed-'))
  if (populated) { writeFileSync(join(dir, 'latest.json'), feed); writeFileSync(join(dir, apkName), apk) }
  const server = createServer(async (req, res) => {
    if (!await servePhoneFeed(req, res, dir)) { res.writeHead(403); res.end('private route') }
  })
  const address = await listen(server)
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(dir, { recursive: true, force: true }) })
  const get = (path, method = 'GET') => new Promise((resolve, reject) => {
    // Raw request target: fetch normalizes literal ../ and cannot test that case.
    const req = request({ host: '127.0.0.1', port: address.port, path, method, headers: { Origin: 'https://fixture.test', Accept: 'application/json' } }, res => {
      const parts = []; res.on('data', chunk => parts.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }))
    }); req.on('error', reject); req.end()
  })
  return { get, dir }
}

test('GET feed is unauthenticated JSON and no-cache', async t => {
  const f = await fixture(t), r = await f.get(prefix + 'latest.json')
  assert.equal(r.status, 200); assert.equal(r.body.toString(), feed)
  assert.match(r.headers['content-type'], /application\/json/); assert.equal(r.headers['cache-control'], 'no-cache')
})
test('GET APK streams exact bytes with Content-Length and no redirect', async t => {
  const f = await fixture(t), r = await f.get(prefix + apkName)
  assert.equal(r.status, 200); assert.deepEqual(r.body, apk)
  assert.equal(Number(r.headers['content-length']), apk.length); assert.equal(r.headers.location, undefined)
})
test('HEAD feed and APK have GET headers, no body', async t => {
  const f = await fixture(t)
  for (const name of ['latest.json', apkName]) {
    const get = await f.get(prefix + name), head = await f.get(prefix + name, 'HEAD')
    assert.equal(head.status, 200); assert.equal(head.body.length, 0)
    assert.equal(head.headers['content-length'], get.headers['content-length'])
    assert.equal(head.headers['content-type'], get.headers['content-type'])
  }
})
test('empty directory returns JSON 404, never HTML (GET and HEAD)', async t => {
  const f = await fixture(t, false)
  const r = await f.get(prefix + 'latest.json')
  assert.equal(r.status, 404); assert.deepEqual(JSON.parse(r.body), { error: 'no_phone_release' })
  const head = await f.get(prefix + 'latest.json', 'HEAD')
  assert.equal(head.status, 404); assert.equal(head.body.length, 0)
})
test('POST is 405 with Allow, even before a release is mirrored', async t => {
  const f = await fixture(t, false), r = await f.get(prefix + 'latest.json', 'POST')
  assert.equal(r.status, 405); assert.equal(r.headers.allow, 'GET, HEAD')
})
test('raw and encoded traversal is refused', async t => {
  const f = await fixture(t)
  for (const path of ['../latest.json', '%2e%2e/latest.json', '..%2flatest.json', 'wizard-os-0.10.14.apk/../../secret', '%2Fetc%2Fpasswd']) {
    const r = await f.get(prefix + path)
    assert.equal(r.status, 404, path); assert.deepEqual(JSON.parse(r.body), { error: 'no_phone_release' })
  }
})
test('wrong filenames and nested files are refused', async t => {
  const f = await fixture(t)
  for (const name of ['secret.json', 'latest.json.bak', 'wizard-os-latest.apk', 'wizard-os-01.2.3.apk', 'nested/' + apkName, apkName + '.bak']) {
    writeFileSync(join(f.dir, name.replaceAll('/', '-')), 'not public')
    assert.equal((await f.get(prefix + name)).status, 404, name)
  }
})
test('symlink cannot expose files outside the mirror', async t => {
  const f = await fixture(t, false)
  writeFileSync(join(f.dir, 'private'), 'secret')
  symlinkSync(join(f.dir, 'private'), join(f.dir, 'latest.json'))
  assert.equal((await f.get(prefix + 'latest.json')).status, 404)
})
test('feed query strings still resolve to the exact allowed file', async t => {
  const f = await fixture(t)
  assert.equal((await f.get(prefix + 'latest.json?check=1')).body.toString(), feed)
})
test('unrelated routes do not become public', async t => {
  const f = await fixture(t)
  assert.equal((await f.get('/wizard/v1/settings')).status, 403)
})
test('full WAS and tailnet ingress serve feed before auth, keep all other gates', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-feed-ingress-'))
  writeFileSync(join(dir, 'latest.json'), feed); writeFileSync(join(dir, apkName), apk)
  const service = createWizardServer({ requireAccess: true, accessVerifier: async () => false, agents: false, followThrough: false, phoneFeedDir: dir })
  const tailnet = createTailnetIngress(service)
  t.after(async () => {
    for (const s of [tailnet, service]) { s.closeAllConnections(); await new Promise(r => s.close(r)) }
    await service.drained; rmSync(dir, { recursive: true, force: true })
  })
  for (const s of [service, tailnet]) {
    const { port } = await listen(s)
    const base = `http://127.0.0.1:${port}`
    const headers = { Origin: base, Accept: 'application/json' }
    const r = await fetch(base + prefix + 'latest.json', { headers })
    assert.equal(r.status, 200); assert.equal(await r.text(), feed)
    const download = await fetch(base + prefix + apkName, { headers, redirect: 'manual' })
    assert.equal(download.status, 200); assert.equal(Number(download.headers.get('content-length')), apk.length)
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), apk)
    const privateRoute = await fetch(base + '/wizard/v1/settings', { headers })
    assert.equal(privateRoute.status, 403)
  }
})
