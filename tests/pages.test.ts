// Pages (server/pages.mjs, wizard-os spec/PAGES.md): sandboxed serving at /pages/, the owner's Pages API,
// git history with owner/agent authorship, stale-version conflicts and restore.
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'
import { PAGES_CSP, createPages, pageVersion } from '../server/pages.mjs'

const roots: string[] = []
const servers: ReturnType<typeof createServer>[] = []
const tmp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); roots.push(dir); return dir }
afterAll(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }) })
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))) })

function seed(files: string, slug = 'q3-report', extra: Record<string, string> = {}) {
  const dir = join(files, 'Pages', slug)
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'page.json'), JSON.stringify({ title: 'Q3 report', kind: 'report', status: 'ready', thread: 'wizard_1_abc', created: '2026-10-01T00:00:00Z' }))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><h1>Q3</h1><script>fetch("/wizard/v1/settings")</script>')
  writeFileSync(join(dir, 'doc.md'), '# Q3\n\nFirst draft.\n')
  writeFileSync(join(dir, 'assets', 'chart.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  for (const [name, body] of Object.entries(extra)) writeFileSync(join(dir, name), body)
  return dir
}

async function box(prep?: (files: string) => void, extra: Record<string, unknown> = {}) {
  const dir = tmp('wizard-pages-')
  const files = join(dir, 'media')
  mkdirSync(files, { recursive: true })
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
    ...extra,
  })
  servers.push(server)
  const address = await listen(server)
  return { base: `http://127.0.0.1:${address.port}`, dir, files, pages: join(files, 'Pages'), gitDir: join(dir, 'state', 'pages-history.git') }
}
const json = (base: string, path: string, method: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

describe('serving /pages/<slug>/', () => {
  it('serves the page and its assets with the sandbox policy on every response', async () => {
    const b = await box((files) => seed(files))
    const page = await fetch(`${b.base}/pages/q3-report/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toBe(PAGES_CSP)
    expect(PAGES_CSP).toContain('sandbox allow-scripts')
    expect(PAGES_CSP).not.toContain('allow-same-origin')
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toContain('<h1>Q3</h1>')
    const asset = await fetch(`${b.base}/pages/q3-report/assets/chart.svg`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toBe('image/svg+xml')
    expect(asset.headers.get('content-security-policy')).toBe(PAGES_CSP)
    const missing = await fetch(`${b.base}/pages/q3-report/nope.html`)
    expect(missing.status).toBe(404)
    expect(missing.headers.get('content-security-policy')).toBe(PAGES_CSP)
    const bare = await fetch(`${b.base}/pages/q3-report`, { redirect: 'manual' })
    expect(bare.status).toBe(308)
    expect(bare.headers.get('location')).toBe('/pages/q3-report/')
  })

  it('falls back to doc.md, and refuses traversal, dot files, symlinks out and writes', async () => {
    const outside = tmp('wizard-pages-outside-')
    writeFileSync(join(outside, 'secret.txt'), 'owner secret')
    const b = await box((files) => {
      const dir = join(files, 'Pages', 'notes')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'doc.md'), '# Notes')
      writeFileSync(join(dir, '.env'), 'TOKEN=x')
      symlinkSync(join(outside, 'secret.txt'), join(dir, 'leak.txt'))
      writeFileSync(join(files, 'private.txt'), 'not a page')
    })
    const doc = await fetch(`${b.base}/pages/notes/`)
    expect(doc.status).toBe(200)
    expect(doc.headers.get('content-type')).toContain('text/plain')
    expect(await doc.text()).toBe('# Notes')
    for (const path of ['/pages/notes/.env', '/pages/notes/leak.txt', '/pages/notes/%2e%2e/%2e%2e/private.txt', '/pages/..%2fprivate.txt', '/pages/Notes/', '/pages/notes//doc.md']) {
      const res = await fetch(`${b.base}${path}`)
      expect(res.status, path).toBe(404)
      expect(await res.text(), path).not.toMatch(/owner secret|TOKEN|not a page/)
    }
    const post = await fetch(`${b.base}/pages/notes/doc.md`, { method: 'PUT', body: 'x' })
    expect(post.status).toBe(405)
  })

  it('never lets an opaque-origin page reach the owner API', async () => {
    const b = await box((files) => seed(files))
    for (const [method, path] of [['GET', '/wizard/v1/settings'], ['GET', '/wizard/v1/pages'], ['PUT', '/wizard/v1/pages/q3-report/doc.md'], ['GET', '/wizard/health']]) {
      const res = await fetch(`${b.base}${path}`, { method, headers: { Origin: 'null', 'Content-Type': 'application/json' }, ...(method === 'PUT' ? { body: '{"text":"x"}' } : {}) })
      expect(res.status, path).toBe(403)
      expect((await res.json()).error).toBe('opaque_origin')
    }
    expect(readFileSync(join(b.pages, 'q3-report', 'doc.md'), 'utf8')).toBe('# Q3\n\nFirst draft.\n')
    // A page fetching its own files is fine: /pages/ is not the owner API.
    expect((await fetch(`${b.base}/pages/q3-report/doc.md`, { headers: { Origin: 'null' } })).status).toBe(200)
  })
})

describe('the Pages API', () => {
  it('lists pages from page.json, newest first, hiding archived unless asked', async () => {
    const b = await box((files) => {
      seed(files)
      const old = join(files, 'Pages', 'old-one')
      mkdirSync(old, { recursive: true })
      writeFileSync(join(old, 'page.json'), JSON.stringify({ title: 'Old', kind: 'doc', status: 'archived', updated: '2020-01-01T00:00:00Z' }))
      writeFileSync(join(old, 'doc.md'), 'old')
      mkdirSync(join(files, 'Pages', 'empty-folder'))
    })
    const list = await (await fetch(`${b.base}/wizard/v1/pages`)).json()
    expect(list.pages.map((p: any) => p.slug)).toEqual(['q3-report'])
    expect(list.pages[0]).toMatchObject({ title: 'Q3 report', kind: 'report', status: 'ready', thread: 'wizard_1_abc', entry: 'index.html', has_doc: true, url: '/pages/q3-report/' })
    const all = await (await fetch(`${b.base}/wizard/v1/pages?all=1`)).json()
    expect(all.pages.map((p: any) => p.slug)).toEqual(['q3-report', 'old-one'])
  })

  it('saves with the version the editor started from, commits as the owner, and 409s a stale save keeping both', async () => {
    const b = await box((files) => seed(files))
    const read = await (await fetch(`${b.base}/wizard/v1/pages/q3-report/doc.md`)).json()
    expect(read.version).toBe(pageVersion('# Q3\n\nFirst draft.\n'))
    const saved = await json(b.base, '/wizard/v1/pages/q3-report/doc.md', 'PUT', { text: '# Q3\n\nOwner edit.\n', version: read.version })
    expect(saved.status).toBe(200)
    const body = await saved.json()
    expect(body).toMatchObject({ changed: true, version: pageVersion('# Q3\n\nOwner edit.\n') })
    expect(readFileSync(join(b.pages, 'q3-report', 'doc.md'), 'utf8')).toBe('# Q3\n\nOwner edit.\n')
    expect(JSON.parse(readFileSync(join(b.pages, 'q3-report', 'page.json'), 'utf8')).updated).toBeTruthy()

    // The agent writes the same file with its own tools while the owner still has the old version open.
    writeFileSync(join(b.pages, 'q3-report', 'doc.md'), '# Q3\n\nAgent rewrite.\n')
    const stale = await json(b.base, '/wizard/v1/pages/q3-report/doc.md', 'PUT', { text: '# Q3\n\nSecond owner edit.\n', version: body.version })
    expect(stale.status).toBe(409)
    const conflict = await stale.json()
    expect(conflict.error).toBe('stale_version')
    expect(conflict.current).toMatchObject({ text: '# Q3\n\nAgent rewrite.\n', version: pageVersion('# Q3\n\nAgent rewrite.\n') })
    expect(conflict.yours.text).toBe('# Q3\n\nSecond owner edit.\n')
    expect(conflict.yours.kept_as).toMatch(/^[0-9a-f]{40}$/)
    expect(readFileSync(join(b.pages, 'q3-report', 'doc.md'), 'utf8')).toBe('# Q3\n\nAgent rewrite.\n')

    const history = await (await fetch(`${b.base}/wizard/v1/pages/q3-report/history?file=doc.md`)).json()
    const authors = history.versions.map((v: any) => `${v.author}${v.refused ? ':refused' : ''}`)
    expect(authors).toEqual(['owner:refused', 'agent', 'owner', 'agent'])
    expect(history.versions[1].message).toContain('Agent wrote')
    expect(history.versions[2].message).toContain('Owner saved q3-report/doc.md')

    // The refused text can be brought back, as a new owner commit.
    const back = await json(b.base, '/wizard/v1/pages/q3-report/restore', 'POST', { commit: conflict.yours.kept_as, file: 'doc.md' })
    expect(back.status).toBe(200)
    expect(readFileSync(join(b.pages, 'q3-report', 'doc.md'), 'utf8')).toBe('# Q3\n\nSecond owner edit.\n')
  })

  it('creates a new file only when no version is claimed, and refuses bad input', async () => {
    const b = await box((files) => seed(files))
    expect((await json(b.base, '/wizard/v1/pages/q3-report/data.json', 'PUT', { text: '{"a":1}', version: null })).status).toBe(200)
    expect((await json(b.base, '/wizard/v1/pages/q3-report/data.json', 'PUT', { text: '{"a":2}', version: null })).status).toBe(409)
    expect((await json(b.base, '/wizard/v1/pages/q3-report/assets/new.svg', 'PUT', { text: '<svg/>' })).status).toBe(200)
    expect((await json(b.base, '/wizard/v1/pages/q3-report/photo.png', 'PUT', { text: 'x' })).status).toBe(415)
    expect((await json(b.base, '/wizard/v1/pages/q3-report/.git', 'PUT', { text: 'x' })).status).toBe(400)
    expect((await json(b.base, '/wizard/v1/pages/q3-report/..%2F..%2Fx.md', 'PUT', { text: 'x' })).status).toBe(400)
    expect((await json(b.base, '/wizard/v1/pages/Bad Slug/doc.md', 'PUT', { text: 'x' })).status).toBe(404)
    expect((await fetch(`${b.base}/wizard/v1/pages/q3-report/doc.md`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status).toBe(415)
    expect((await json(b.base, '/wizard/v1/pages/q3-report/doc.md', 'PUT', { text: 'x' }, { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await json(b.base, '/wizard/v1/pages/q3-report/doc.md', 'PUT', { text: 'x' }, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
    expect((await fetch(`${b.base}/wizard/v1/pages/q3-report/missing.md`)).status).toBe(404)
  })

  it('restores a whole page as a new commit and lists its history newest first', async () => {
    const b = await box((files) => seed(files))
    const first = (await (await fetch(`${b.base}/wizard/v1/pages/q3-report/history`)).json()).versions
    expect(first).toHaveLength(1)
    const v1 = first[0].commit
    writeFileSync(join(b.pages, 'q3-report', 'index.html'), '<h1>v2</h1>')
    writeFileSync(join(b.pages, 'q3-report', 'extra.md'), 'added later')
    const second = (await (await fetch(`${b.base}/wizard/v1/pages/q3-report/history`)).json()).versions
    expect(second).toHaveLength(2)
    expect(second[0].files.sort()).toEqual(['extra.md', 'index.html'])
    const restored = await json(b.base, '/wizard/v1/pages/q3-report/restore', 'POST', { commit: v1 })
    expect(restored.status).toBe(200)
    const out = await restored.json()
    expect(out.restored_from).toBe(v1)
    expect(readFileSync(join(b.pages, 'q3-report', 'index.html'), 'utf8')).toContain('<h1>Q3</h1>')
    expect(existsSync(join(b.pages, 'q3-report', 'extra.md'))).toBe(false)
    const third = (await (await fetch(`${b.base}/wizard/v1/pages/q3-report/history`)).json()).versions
    expect(third).toHaveLength(3)
    expect(third[0]).toMatchObject({ author: 'owner', commit: out.commit })
    expect(third[0].message).toContain('Owner restored')
    expect((await json(b.base, '/wizard/v1/pages/q3-report/restore', 'POST', { commit: 'f'.repeat(40) })).status).toBe(404)
    expect((await json(b.base, '/wizard/v1/pages/q3-report/restore', 'POST', { commit: 'HEAD~1' })).status).toBe(400)
  })

  it('keeps history out of the Pages folder, so a page cannot plant git config or hooks', async () => {
    const b = await box((files) => {
      const dir = seed(files)
      // A planted repository inside the page folder (hooks, config) must be ignored and never run.
      mkdirSync(join(dir, '.git', 'hooks'), { recursive: true })
      writeFileSync(join(dir, '.git', 'config'), '[core]\n\tfsmonitor = touch PWNED\n')
      writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ntouch PWNED\n', { mode: 0o755 })
      mkdirSync(join(files, 'Pages', '.git', 'hooks'), { recursive: true })
      writeFileSync(join(files, 'Pages', '.git', 'HEAD'), 'ref: refs/heads/main\n')
    })
    const read = await (await fetch(`${b.base}/wizard/v1/pages/q3-report/doc.md`)).json()
    expect((await json(b.base, '/wizard/v1/pages/q3-report/doc.md', 'PUT', { text: 'safe', version: read.version })).status).toBe(200)
    expect(existsSync(join(b.gitDir, 'HEAD'))).toBe(true)
    const tracked = execFileSync('git', ['--git-dir', b.gitDir, 'ls-tree', '-r', '--name-only', 'HEAD']).toString()
    expect(tracked).not.toContain('.git')
    expect(tracked).toContain('q3-report/doc.md')
    for (const dir of [b.pages, join(b.pages, 'q3-report'), b.dir]) expect(existsSync(join(dir, 'PWNED'))).toBe(false)
  })

  it('reports Pages unavailable on a box without a Files root', async () => {
    const b = await box(undefined, { mediaRoot: '', userFilesRoot: '' })
    expect((await fetch(`${b.base}/wizard/v1/pages`)).status).toBe(503)
    expect((await fetch(`${b.base}/pages/anything/`)).status).toBe(404)
  })

  it('creates no Pages folder until a page is written, then starts history with the first save', async () => {
    const b = await box()
    expect((await (await fetch(`${b.base}/wizard/v1/pages`)).json()).pages).toEqual([])
    expect((await fetch(`${b.base}/wizard/v1/pages/new-doc/history`)).status).toBe(404)
    expect(existsSync(b.pages)).toBe(false)
    const saved = await json(b.base, '/wizard/v1/pages/new-doc/doc.md', 'PUT', { text: '# New', version: null })
    expect(saved.status).toBe(200)
    expect(readFileSync(join(b.pages, 'new-doc', 'doc.md'), 'utf8')).toBe('# New')
    const versions = (await (await fetch(`${b.base}/wizard/v1/pages/new-doc/history`)).json()).versions
    expect(versions.map((v: any) => v.author)).toEqual(['owner'])
  })
})

describe('review fixes (Codex P1s on #134)', () => {
  it('refuses a save through a symlinked folder and writes nothing outside Pages', async () => {
    const outside = tmp('wizard-pages-escape-')
    const b = await box((files) => {
      const dir = seed(files)
      symlinkSync(outside, join(dir, 'linked'))
      mkdirSync(join(dir, 'real'), { recursive: true })
      symlinkSync(outside, join(dir, 'real', 'deeper'))
    })
    for (const file of ['linked/new.md', 'linked/sub/new.md', 'real/deeper/new.md']) {
      const res = await json(b.base, `/wizard/v1/pages/q3-report/${file}`, 'PUT', { text: 'escaped', version: null })
      expect([400, 404], file).toContain(res.status)
    }
    expect(readdirSync(outside)).toEqual([])
    // A whole page folder that is a symlink is refused the same way.
    symlinkSync(outside, join(b.pages, 'evil'))
    expect([400, 404]).toContain((await json(b.base, '/wizard/v1/pages/evil/doc.md', 'PUT', { text: 'escaped', version: null })).status)
    expect(readdirSync(outside)).toEqual([])
    // Ordinary nested folders still work.
    expect((await json(b.base, '/wizard/v1/pages/q3-report/real/notes.md', 'PUT', { text: 'fine', version: null })).status).toBe(200)
  })

  it('versions files a page .gitignore would hide, and restores them', async () => {
    const b = await box((files) => seed(files, 'q3-report', { '.gitignore': '*.md\n*.html\n' }))
    const read = await (await fetch(`${b.base}/wizard/v1/pages/q3-report/doc.md`)).json()
    const saved = await json(b.base, '/wizard/v1/pages/q3-report/doc.md', 'PUT', { text: '# Q3\n\nv2\n', version: read.version })
    expect(saved.status).toBe(200)
    const versions = (await (await fetch(`${b.base}/wizard/v1/pages/q3-report/history?file=doc.md`)).json()).versions
    expect(versions.map((v: any) => v.author)).toEqual(['owner', 'agent'])
    const tracked = execFileSync('git', ['--git-dir', b.gitDir, 'ls-tree', '-r', '--name-only', 'HEAD']).toString()
    expect(tracked).toContain('q3-report/index.html')
    expect(tracked).not.toContain('.gitignore')
    const back = await json(b.base, '/wizard/v1/pages/q3-report/restore', 'POST', { commit: versions[1].commit, file: 'doc.md' })
    expect(back.status).toBe(200)
    expect(readFileSync(join(b.pages, 'q3-report', 'doc.md'), 'utf8')).toBe('# Q3\n\nFirst draft.\n')
  })

  it('streams assets: HEAD never reads the body, GET returns exact bytes, ranges work', async () => {
    const b = await box((files) => seed(files))
    const big = join(b.pages, 'q3-report', 'assets', 'movie.mp4')
    const chunk = Buffer.alloc(1024 * 1024)
    for (let i = 0; i < chunk.length; i++) chunk[i] = i % 251
    writeFileSync(big, Buffer.concat(Array(24).fill(chunk)))
    const size = 24 * chunk.length
    const sha = createHash('sha256').update(readFileSync(big)).digest('hex')
    const get = await fetch(`${b.base}/pages/q3-report/assets/movie.mp4`)
    expect(get.status).toBe(200)
    expect(get.headers.get('content-length')).toBe(String(size))
    expect(get.headers.get('content-type')).toBe('video/mp4')
    expect(get.headers.get('accept-ranges')).toBe('bytes')
    expect(createHash('sha256').update(Buffer.from(await get.arrayBuffer())).digest('hex')).toBe(sha)
    const tag = get.headers.get('etag')!
    expect((await fetch(`${b.base}/pages/q3-report/assets/movie.mp4`, { headers: { 'If-None-Match': tag } })).status).toBe(304)
    const part = await fetch(`${b.base}/pages/q3-report/assets/movie.mp4`, { headers: { Range: 'bytes=10-19' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 10-19/${size}`)
    expect([...Buffer.from(await part.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
    expect((await fetch(`${b.base}/pages/q3-report/assets/movie.mp4`, { headers: { Range: `bytes=${size}-` } })).status).toBe(416)
    // An unreadable file proves HEAD answers from stat alone (root can read anything, so skip there).
    if (process.getuid?.() !== 0) {
      chmodSync(big, 0o000)
      try {
        const head = await fetch(`${b.base}/pages/q3-report/assets/movie.mp4`, { method: 'HEAD' })
        expect(head.status).toBe(200)
        expect(head.headers.get('content-length')).toBe(String(size))
        expect(head.headers.get('content-security-policy')).toBe(PAGES_CSP)
      } finally { chmodSync(big, 0o644) }
    }
  })
})

describe('createPages (module)', () => {
  it('commits agent writes it finds, with the page thread in the message, and the watcher picks them up', async () => {
    const dir = tmp('wizard-pages-mod-')
    const root = join(dir, 'Pages')
    const pages = createPages({ root, gitDir: join(dir, 'history.git'), watchDelayMs: 50 })
    seed(dir, 'storyboard') // writes <dir>/Pages/storyboard
    expect(pages.sync()).toMatch(/^[0-9a-f]{40}$/)
    const log = execFileSync('git', ['--git-dir', join(dir, 'history.git'), 'log', '-1', '--format=%an%n%B']).toString()
    expect(log).toContain('Agent')
    expect(log).toContain('Thread: wizard_1_abc')
    expect(pages.sync()).toBeNull()
    pages.watch()
    writeFileSync(join(root, 'storyboard', 'doc.md'), 'watched change')
    await new Promise((r) => setTimeout(r, 800))
    pages.close()
    const versions = pages.history('storyboard', 'doc.md').versions
    expect(versions).toHaveLength(2)
    expect(versions[0].author).toBe('agent')
  })

  it('refuses a history directory inside the Pages folder', () => {
    const dir = tmp('wizard-pages-bad-')
    expect(() => createPages({ root: join(dir, 'Pages'), gitDir: join(dir, 'Pages', '.git') })).toThrow(/outside/)
  })
})
