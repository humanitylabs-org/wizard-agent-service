// My skin: the owner's own stylesheet in their Files root (server/my-skin.mjs), served to the shell at
// GET /wizard/v1/my-skin and layered on top of whichever skin they picked.
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'
import { MY_SKIN_MAX_BYTES, MY_SKIN_RELATIVE, MY_SKIN_TEMPLATE, mySkinEmpty, sanitizeMySkin } from '../server/my-skin.mjs'

const roots: string[] = []
const servers: ReturnType<typeof createServer>[] = []
const tmp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); roots.push(dir); return dir }
afterAll(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }) })
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))) })

async function box(dir = tmp('wizard-my-skin-'), extra: Record<string, unknown> = {}) {
  const files = join(dir, 'media')
  mkdirSync(files, { recursive: true })
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
    ...extra,
  })
  servers.push(server)
  const address = await listen(server)
  return { base: `http://127.0.0.1:${address.port}`, dir, files, file: join(files, ...MY_SKIN_RELATIVE.split('/')) }
}
const put = (base: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/wizard/v1/my-skin`, { method: 'PUT', headers: { 'Content-Type': 'text/css', ...headers }, body })

describe('My skin route', () => {
  it('starts as an empty, commented file in Files and serves an empty stylesheet', async () => {
    const b = await box()
    expect(readFileSync(b.file, 'utf8')).toBe(MY_SKIN_TEMPLATE)
    expect(statSync(b.file).mode & 0o777).toBe(0o664)
    const r = await fetch(`${b.base}/wizard/v1/my-skin`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect((await r.text()).trim()).toBe('')
    const info = await (await fetch(`${b.base}/wizard/v1/my-skin?format=json`)).json()
    expect(info).toMatchObject({ path: 'Skins/My skin.css', exists: true, empty: true, too_large: false, max_bytes: MY_SKIN_MAX_BYTES })
  })

  it('serves what the owner (or their agent through Files) wrote, and persists it across a restart', async () => {
    const b = await box()
    writeFileSync(b.file, 'html[data-skin] body { letter-spacing: .02em; }\n')
    expect(await (await fetch(`${b.base}/wizard/v1/my-skin`)).text()).toContain('letter-spacing: .02em')
    const saved = await put(b.base, 'html[data-skin="nebula"] .dock { opacity: .5 }')
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ empty: false, exists: true })
    await new Promise<void>((r) => servers.pop()!.close(() => r()))
    const again = await box(b.dir)
    const css = await (await fetch(`${again.base}/wizard/v1/my-skin`)).text()
    expect(css).toContain('html[data-skin="nebula"] .dock { opacity: .5 }')
    expect(readFileSync(again.file, 'utf8')).toBe('html[data-skin="nebula"] .dock { opacity: .5 }') // ensure() never overwrote it
  })

  it('answers 304 for an unchanged sheet (ETag) so reloads stay cheap', async () => {
    const b = await box()
    const first = await fetch(`${b.base}/wizard/v1/my-skin`)
    const tag = first.headers.get('etag')!
    expect(tag).toMatch(/^".+"$/)
    expect((await fetch(`${b.base}/wizard/v1/my-skin`, { headers: { 'If-None-Match': tag } })).status).toBe(304)
  })

  it('sanitises: no @import, no outside URLs, no script hooks', async () => {
    const b = await box()
    writeFileSync(b.file, [
      '@import url("https://evil.example/x.css");',
      '@\\69mport "https://evil.example/y.css";',
      '@namespace svg url(http://www.w3.org/2000/svg);',
      'body { background: url(https://evil.example/track.png) }',
      '.a { background-image: url("//evil.example/p.gif") }',
      ".b { background: image-set('https://evil.example/1x.png' 1x) }",
      '.c { background: u\\72l(https://evil.example/esc.png) }',
      '.d { width: expression(alert(1)); -moz-binding: url(x.xml#y) }',
      '@font-face { font-family: X; src: url(https://evil.example/f.woff2) }',
      '.ok { background: url(data:image/png;base64,iVBORw0KGgo=) ; content: "Note: fine" }',
      '.rel { background: url(/wizard-os-home/brand/wizard-mark-white.png) }',
      '@media (max-width: 500px) { .m { color: red } }',
      '</style><script>alert(1)</script>',
    ].join('\n'))
    const css = await (await fetch(`${b.base}/wizard/v1/my-skin`)).text()
    expect(css).not.toMatch(/@import/i)
    expect(css).not.toMatch(/@namespace/i)
    expect(css).not.toContain('evil.example')
    expect(css).not.toMatch(/expression\(/i)
    expect(css).not.toMatch(/-moz-binding/i)
    expect(css).not.toMatch(/<\/style/i)
    expect(css).toContain('url(data:image/png;base64,iVBORw0KGgo=)')
    expect(css).toContain('"Note: fine"')
    expect(css).toContain('url(/wizard-os-home/brand/wizard-mark-white.png)')
    expect(css).toContain('@media (max-width: 500px) { .m { color: red } }')
  })

  it('caps the size: an oversized file reads as empty, an oversized PUT is refused', async () => {
    const b = await box()
    writeFileSync(b.file, `body{color:red}/*${'x'.repeat(MY_SKIN_MAX_BYTES)}*/`)
    expect(await (await fetch(`${b.base}/wizard/v1/my-skin`)).text()).toBe('')
    expect(await (await fetch(`${b.base}/wizard/v1/my-skin?format=json`)).json()).toMatchObject({ too_large: true, empty: true })
    const r = await put(b.base, 'a{}' + ' '.repeat(MY_SKIN_MAX_BYTES))
    expect(r.status).toBe(413)
  })

  it('writes need text/css from the same origin; DELETE resets to the empty template', async () => {
    const b = await box()
    expect((await fetch(`${b.base}/wizard/v1/my-skin`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'a{}' })).status).toBe(415)
    expect((await put(b.base, 'a{}', { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await put(b.base, 'a{}', { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
    expect((await fetch(`${b.base}/wizard/v1/my-skin`, { method: 'POST', headers: { 'Content-Type': 'text/css' }, body: 'a{}' })).status).toBe(405)
    expect((await put(b.base, 'a{color:red}', { Origin: b.base })).status).toBe(200)
    const reset = await fetch(`${b.base}/wizard/v1/my-skin`, { method: 'DELETE' })
    expect(reset.status).toBe(200)
    expect(await reset.json()).toMatchObject({ empty: true })
    expect(readFileSync(b.file, 'utf8')).toBe(MY_SKIN_TEMPLATE)
  })

  it('never follows a symlink out of the Files root and never fails the shell', async () => {
    const b = await box()
    const outside = join(b.dir, 'outside.css')
    writeFileSync(outside, 'body{color:red}')
    rmSync(b.file)
    symlinkSync(outside, b.file)
    expect(await (await fetch(`${b.base}/wizard/v1/my-skin`)).text()).toBe('')
    expect((await put(b.base, 'a{}')).status).toBe(409)
    expect(readFileSync(outside, 'utf8')).toBe('body{color:red}')
  })

  it('a box without a Files root still answers: empty sheet, writes unavailable', async () => {
    const dir = tmp('wizard-my-skin-none-')
    const b = await box(dir, { mediaRoot: '', userFilesRoot: '' })
    const r = await fetch(`${b.base}/wizard/v1/my-skin`)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('')
    expect((await put(b.base, 'a{}')).status).toBe(503)
    expect(existsSync(join(dir, 'Skins'))).toBe(false)
  })

  it('a missing Files root is never created', async () => {
    const dir = tmp('wizard-my-skin-gone-')
    const b = await box(dir, { mediaRoot: join(dir, 'not-mounted') })
    expect(await (await fetch(`${b.base}/wizard/v1/my-skin`)).text()).toBe('')
    expect(existsSync(join(dir, 'not-mounted'))).toBe(false)
  })
})

describe('sanitizeMySkin', () => {
  it('keeps ordinary CSS byte-for-byte', () => {
    const css = 'html[data-skin="grove"] .dock { border-radius: 24px; }\n@supports (backdrop-filter: blur(2px)) { .x { backdrop-filter: blur(2px) } }\n@keyframes k { from { opacity: 0 } to { opacity: 1 } }\n'
    expect(sanitizeMySkin(css)).toBe(css)
  })
  it('drops an unterminated string instead of letting it swallow later rules', () => {
    expect(sanitizeMySkin('.a{content:"oops\n}.b{color:red}')).toContain('.b{color:red}')
  })
  it('treats comments-only as empty', () => {
    expect(mySkinEmpty(sanitizeMySkin(MY_SKIN_TEMPLATE))).toBe(true)
    expect(mySkinEmpty(' \n')).toBe(true)
    expect(mySkinEmpty('a{}')).toBe(false)
  })
})
