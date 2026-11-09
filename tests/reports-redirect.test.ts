// Old report links (server/reports-redirect.mjs, wizard-os spec/PAGES.md Migration): /reports/<slug>/ lands on
// the same page under /pages/, an unknown address shows a plain "this page moved" page, and the phone
// updater feed under /reports/wizard-os/ keeps answering byte for byte.
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'

const roots: string[] = []
const servers: ReturnType<typeof createServer>[] = []
const tmp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); roots.push(dir); return dir }
afterAll(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }) })
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))) })

const FEED = JSON.stringify({ app: 'ai.wizards.os', versionCode: 78, versionName: '0.10.14', url: 'wizard-os-0.10.14.apk' })
const APK = Buffer.from('fixture APK bytes')

function seedPage(files: string, slug: string) {
  const dir = join(files, 'Pages', slug)
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'page.json'), JSON.stringify({ title: slug, kind: 'report', status: 'ready' }))
  writeFileSync(join(dir, 'index.html'), `<!doctype html><h1>${slug}</h1>`)
  writeFileSync(join(dir, 'assets', 'chart.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
}

async function box(prep?: (files: string) => void) {
  const dir = tmp('wizard-reports-')
  const files = join(dir, 'media')
  const feed = join(dir, 'phone-feed')
  mkdirSync(files, { recursive: true })
  mkdirSync(feed, { recursive: true })
  writeFileSync(join(feed, 'latest.json'), FEED)
  writeFileSync(join(feed, 'wizard-os-0.10.14.apk'), APK)
  prep?.(files)
  const server = createWizardServer({
    requireJoinedDelegationCapability: false,
    upstreamOrigin: 'http://127.0.0.1:9',
    hermesKey: 'fixture-key',
    requireAccess: false,
    followThrough: false,
    settingsPath: join(dir, 'settings.json'),
    mediaRoot: files,
    mediaIndexPath: join(dir, 'state', 'media-files.json'),
    runQueueStatePath: join(dir, 'state', 'queue.sqlite3'),
    runQueuePollIntervalMs: 0,
    activeSessionReader: async () => [],
    dispatchHealthReader: () => true,
    pagesWatch: false,
    phoneFeedDir: feed,
  })
  servers.push(server)
  const address = await listen(server)
  const port = address.port
  // Raw request target: fetch would normalise ../ before it reaches the service.
  const raw = (path: string, method = 'GET', headers: Record<string, string> = {}) => new Promise<{ status: number, headers: Record<string, any>, body: Buffer }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (c) => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(parts) }))
    }); req.on('error', reject); req.end()
  })
  return { raw, files, dir, pages: join(files, 'Pages') }
}

describe('old /reports/<slug>/ links', () => {
  it('redirect permanently to the same page under /pages/, keeping the path and the query', async () => {
    const b = await box((files) => seedPage(files, 'q3-report'))
    for (const [from, to] of [
      ['/reports/q3-report/', '/pages/q3-report/'],
      ['/reports/q3-report', '/pages/q3-report/'],
      ['/reports/q3-report/index.html', '/pages/q3-report/index.html'],
      ['/reports/q3-report/assets/chart.svg?v=2&x=a%20b', '/pages/q3-report/assets/chart.svg?v=2&x=a%20b'],
      ['/reports/q3-report/?tab=notes#ignored-by-servers', '/pages/q3-report/?tab=notes'],
    ]) {
      const r = await b.raw(from)
      expect([r.status, from]).toEqual([308, from])
      expect(r.headers.location).toBe(to)
    }
    expect((await b.raw('/reports/q3-report/', 'HEAD')).status).toBe(308)
  })

  it('end to end: the redirect target opens the page', async () => {
    const b = await box((files) => seedPage(files, 'q3-report'))
    const hop = await b.raw('/reports/q3-report/')
    const page = await b.raw(hop.headers.location)
    expect(page.status).toBe(200)
    expect(page.body.toString()).toContain('<h1>q3-report</h1>')
  })

  it('an address with no page shows a plain "moved" page that links to Pages, not a raw 404', async () => {
    const b = await box((files) => seedPage(files, 'q3-report'))
    for (const path of ['/reports/does-not-exist/', '/reports/does-not-exist', '/reports/', '/reports', '/reports/q3-report-old/index.html', '/reports/Q3-Report/']) {
      const r = await b.raw(path, 'GET', { Accept: 'text/html' })
      expect([r.status, path]).toEqual([404, path])
      expect(r.headers['content-type']).toContain('text/html')
      const html = r.body.toString()
      expect(html).toContain('This page moved')
      expect(html).toContain('href="/wizard-os-home/?open=pages"')
      expect(html).toContain('var(--wz-canvas)'); expect(html).toContain('--wz-base: #05030c')
      expect(html).toContain('wizard:appearance')
      expect(r.headers.location).toBeUndefined()
    }
    const head = await b.raw('/reports/does-not-exist/', 'HEAD')
    expect(head.status).toBe(404); expect(head.body.length).toBe(0)
    const json = await b.raw('/reports/does-not-exist/x.json', 'GET', { Accept: 'application/json' })
    expect(json.status).toBe(404); expect(JSON.parse(json.body.toString())).toMatchObject({ error: 'moved', pages: '/wizard-os-home/?open=pages' })
    expect((await b.raw('/reports/does-not-exist/', 'POST')).status).toBe(405)
  })

  it('never redirects a path trick out of the Pages folder', async () => {
    const b = await box((files) => seedPage(files, 'q3-report'))
    for (const path of ['/reports/..%2fq3-report/', '/reports/%2e%2e/', '/reports/.hidden/', '/reports/%zz/']) {
      const r = await b.raw(path)
      // (%2e%2e/ is normalised to the site root by the URL parser, whose own redirect is not ours.)
      expect(String(r.headers.location || ''), path).not.toMatch(/^\/pages\//)
    }
  })

  it('follows a rename listed in Pages/.reports-moved.json, and ignores a bad target', async () => {
    const b = await box((files) => {
      seedPage(files, 'q3-report-final')
      writeFileSync(join(files, 'Pages', '.reports-moved.json'), JSON.stringify({ 'q3-report': 'q3-report-final', 'bad': '../etc', 'gone': 'no-such-page' }))
    })
    expect((await b.raw('/reports/q3-report/assets/chart.svg')).headers.location).toBe('/pages/q3-report-final/assets/chart.svg')
    expect((await b.raw('/reports/bad/')).status).toBe(404)
    expect((await b.raw('/reports/gone/')).status).toBe(404)
    // The mapping file itself is never served.
    expect((await b.raw('/pages/.reports-moved.json')).status).toBe(404)
  })
})

describe('the rename map is agent-writable and never trusted blindly', () => {
  it('a FIFO, a symlink or an oversized file in its place is ignored without blocking the service', async () => {
    for (const make of [
      (file: string) => execFileSync('mkfifo', [file]),
      (file: string) => { writeFileSync(`${file}.target`, JSON.stringify({ old: 'q3-report' })); symlinkSync(`${file}.target`, file) },
      (file: string) => writeFileSync(file, JSON.stringify({ old: 'q3-report', pad: 'x'.repeat(70 * 1024) })),
    ]) {
      const b = await box((files) => { seedPage(files, 'q3-report'); make(join(files, 'Pages', '.reports-moved.json')) })
      const r = await Promise.race([b.raw('/reports/old/'), new Promise<never>((_, no) => setTimeout(() => no(new Error('service blocked')), 4000))])
      expect(r.status).toBe(404)
      expect((await b.raw('/reports/q3-report/')).status).toBe(308)
    }
  })
})

describe('the phone updater feed under /reports/wizard-os/ is untouched', () => {
  it('serves latest.json and the APK with the same bytes, type and headers as before, with or without a page of that name', async () => {
    for (const withPage of [false, true]) {
      const b = await box((files) => { if (withPage) seedPage(files, 'wizard-os') })
      const feed = await b.raw('/reports/wizard-os/latest.json')
      expect(feed.status).toBe(200)
      expect(feed.body.toString()).toBe(FEED)
      expect(feed.headers['content-type']).toBe('application/json; charset=utf-8')
      expect(feed.headers['cache-control']).toBe('no-cache')
      expect(feed.headers.location).toBeUndefined()
      const head = await b.raw('/reports/wizard-os/latest.json', 'HEAD')
      expect(head.status).toBe(200); expect(head.headers['content-length']).toBe(String(Buffer.byteLength(FEED)))
      const apk = await b.raw('/reports/wizard-os/wizard-os-0.10.14.apk')
      expect(apk.status).toBe(200); expect(apk.body.equals(APK)).toBe(true)
      expect(apk.headers['content-type']).toBe('application/vnd.android.package-archive')
      // A missing release file is still the feed's own JSON 404 and the bare folder is never redirected.
      const missing = await b.raw('/reports/wizard-os/nope.json')
      expect(missing.status).toBe(404); expect(JSON.parse(missing.body.toString())).toEqual({ error: 'no_phone_release' })
      expect((await b.raw('/reports/wizard-os')).headers.location).toBeUndefined()
      expect((await b.raw('/reports/wizard-os/latest.json', 'POST')).status).toBe(405)
    }
  })
})
