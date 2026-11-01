// Pages (wizard-os spec/PAGES.md, DECISIONS #35): what the agent makes for its owner to look at.
//
// A page is a folder in the owner's Files, `<files root>/Pages/<slug>/`, holding a `page.json` and an
// `index.html` and/or `doc.md` (plus optional `data.json` and `assets/`). This module:
//
//   - serves `/pages/<slug>/...` read-only, behind the sandbox Content-Security-Policy, so a page runs in
//     an opaque origin and can never act as the owner (the service also refuses `Origin: null` on
//     `/wizard/...`; see service.mjs);
//   - lists pages from their `page.json`;
//   - reads and saves one file with the version the editor started from (a stale version is a 409 with
//     both texts, and the refused text is kept in history, so nothing is lost);
//   - keeps every change as a git commit: owner saves and restores as the owner, files the agent wrote
//     with its ordinary file tools as the agent (picked up on the next Pages call and by a folder watch);
//   - lists a page's history newest first and restores an older version as a new commit.
//
// The history repository lives in the Agent Service's own state, with the Pages folder as its work tree,
// rather than in `Pages/.git`. The agent can write anywhere in the Pages folder, and git runs hooks,
// filters and other commands named in its repository config, so a `.git` the agent can edit would let a
// page plant code that this service then runs. Every git call also ignores system and global config.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'

export const PAGES_FOLDER = 'Pages'
export const PAGES_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-downloads'
export const PAGE_KINDS = ['report', 'doc', 'dashboard', 'preview', 'storyboard', 'other']
export const PAGE_STATUSES = ['draft', 'ready', 'archived']
export const PAGE_TEXT_MAX_BYTES = 2 * 1024 * 1024
const SLUG = /^[a-z0-9][a-z0-9._-]{0,79}$/u
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,127}$/u
const COMMIT = /^[0-9a-f]{7,64}$/u
const CONFLICT_REF = 'refs/wizard-pages/refused'
const EDITABLE = new Set(['.md', '.markdown', '.html', '.htm', '.json', '.css', '.js', '.mjs', '.txt', '.svg', '.csv', '.xml', '.yaml', '.yml'])
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  // Markdown shows as text in a plain tab; the shell renders doc.md in its editor.
  '.md': 'text/plain; charset=utf-8', '.markdown': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.pdf': 'application/pdf', '.wasm': 'application/wasm',
}

export class PagesError extends Error {
  constructor(status, code, extra = {}) { super(code); this.status = status; this.code = code; this.extra = extra }
}

/** The git blob id of a text: the version a client hands back when it saves. */
export function pageVersion(content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex')
}

export function pageSlugValid(slug) { return SLUG.test(String(slug || '')) }

/** `<slug>/<file>` path parts, each a plain name: no dot files, no `..`, no separators. */
export function pageFileParts(file) {
  const parts = String(file || '').split('/')
  if (!parts.length || parts.length > 8 || parts.some(part => !SEGMENT.test(part))) return null
  return parts
}

const iso = (value) => { const date = value ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? date.toISOString() : null }
const str = (value, max = 300) => typeof value === 'string' ? value.slice(0, max) : ''

export function createPages({ root, gitDir, watchDelayMs = 1500, now = () => new Date(), log = () => {} }) {
  const pagesRoot = resolve(String(root || ''))
  const historyDir = resolve(String(gitDir || ''))
  if (!root || pagesRoot === sep) throw new Error('pages root must be narrower than /')
  if (!gitDir || historyDir === sep) throw new Error('pages history needs its own git directory')
  if (historyDir === pagesRoot || historyDir.startsWith(`${pagesRoot}${sep}`)) throw new Error('pages history must live outside the Pages folder')

  // Only this service's own settings reach git: no system or global config, no hooks, no fsmonitor, and a
  // fixed identity per write. GIT_CEILING_DIRECTORIES stops discovery of any other repository.
  const gitEnv = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: historyDir,
    LANG: 'C', LC_ALL: 'C',
    GIT_DIR: historyDir,
    GIT_WORK_TREE: pagesRoot,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  }
  const gitFlags = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'commit.gpgSign=false',
    '-c', 'core.quotePath=false', '-c', 'core.autocrlf=false', '-c', `safe.directory=${pagesRoot}`, '-c', `safe.directory=${historyDir}`]
  const git = (args, { input, env = {}, allowFail = false } = {}) => {
    try {
      return execFileSync('git', [...gitFlags, ...args], { env: { ...gitEnv, ...env }, input, cwd: pagesRoot, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      if (allowFail) return null
      throw new PagesError(500, 'pages_history_failed', { detail: String(error?.stderr || error?.message || '').trim().split('\n').slice(-1)[0].slice(0, 200) })
    }
  }
  const gitText = (args, options) => { const out = git(args, options); return out === null ? null : out.toString('utf8') }

  let ready = false
  const ensure = () => {
    if (ready && existsSync(join(historyDir, 'HEAD'))) return
    // The Pages folder itself appears only when a page is written; the Files root is never created here.
    if (!existsSync(join(historyDir, 'HEAD'))) {
      mkdirSync(dirname(historyDir), { recursive: true })
      git(['init', '-q', '--initial-branch=main'])
    }
    // Ignore dot files (an agent's stray .git, .DS_Store) and the scratch files editors leave behind.
    mkdirSync(join(historyDir, 'info'), { recursive: true })
    writeFileSync(join(historyDir, 'info', 'exclude'), '.*\n*~\n*.tmp\n*.swp\n')
    ready = true
  }

  const identities = {
    owner: { name: 'Owner', email: 'owner@wizard.local' },
    agent: { name: 'Agent', email: 'agent@wizard.local' },
  }
  const identityEnv = (who) => {
    const id = identities[who] || identities.agent
    const at = now().toISOString()
    return { GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: 'Wizard', GIT_COMMITTER_EMAIL: 'wizard@wizard.local', GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }
  }
  const headCommit = () => gitText(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { allowFail: true })?.trim() || null

  const pagePath = (slug, file = '') => {
    if (!pageSlugValid(slug)) throw new PagesError(404, 'page_not_found')
    const parts = file ? pageFileParts(file) : []
    if (!parts) throw new PagesError(400, 'invalid_file')
    const path = resolve(pagesRoot, slug, ...parts)
    if (!path.startsWith(`${pagesRoot}${sep}${slug}`)) throw new PagesError(400, 'invalid_file')
    return path
  }
  // Refuse anything that resolves outside the Pages folder through a symlink.
  const inside = (path) => {
    try {
      const real = realpathSync(path)
      const base = realpathSync(pagesRoot)
      return real === base || real.startsWith(`${base}${sep}`)
    } catch { return false }
  }

  // A write target is safe only when every folder from the Pages folder down to its parent is a real
  // directory (or not there yet) and the file itself, if present, is a plain file. A symlink anywhere on
  // the way is refused, so `mkdir`/`rename` can never follow the agent's link out of the Pages folder.
  const writable = (slug, file) => {
    const target = pagePath(slug, file)
    const parts = [slug, ...pageFileParts(file)]
    let at = pagesRoot
    if (existsSync(pagesRoot) && !statSync(pagesRoot).isDirectory()) throw new PagesError(404, 'page_not_found')
    for (const [i, part] of parts.entries()) {
      at = join(at, part)
      let info
      try { info = lstatSync(at) } catch (error) { if (error?.code === 'ENOENT') break; throw new PagesError(404, 'page_not_found') }
      const last = i === parts.length - 1
      if (info.isSymbolicLink() || (last ? !info.isFile() : !info.isDirectory())) throw new PagesError(404, 'page_not_found')
    }
    return target
  }

  const threadOf = (slug) => {
    try { return str(JSON.parse(readFileSync(pagePath(slug, 'page.json'), 'utf8'))?.thread, 120) } catch { return '' }
  }
  const message = (verb, files, thread, extra = '') => {
    const names = [...new Set(files)].sort()
    const head = `${verb} ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` and ${names.length - 4} more` : ''}`
    const lines = [head.slice(0, 200)]
    if (thread) lines.push('', `Thread: ${thread}`)
    if (extra) lines.push(...(thread ? [extra] : ['', extra]))
    return `${lines.join('\n')}\n`
  }

  // Stage every change under `spec` with only this service's own exclude list (dot files, editor scratch).
  // Plain `git add` also honours a page's own `.gitignore`, so a page shipping `*.md` would silently drop
  // doc.md from every commit; listing the paths without `--exclude-standard` and force-adding them skips
  // in-tree ignore files while keeping our exclusions.
  const stage = (spec) => {
    const listed = gitText(['ls-files', '-z', '--others', '--modified', '--deleted', `--exclude-from=${join(historyDir, 'info', 'exclude')}`, '--', spec])
    const paths = [...new Set(listed.split('\0').filter(Boolean))]
    if (!paths.length) return
    git(['--literal-pathspecs', 'add', '-A', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: `${paths.join('\0')}\0` })
  }

  /** Commit whatever changed in the folder since the last commit (the agent's own file writes). */
  const sync = () => {
    if (!existsSync(pagesRoot)) return null
    ensure()
    if (watching) api.watch()
    stage('.')
    const changed = gitText(['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean)
    if (!changed.length) return null
    const slugs = [...new Set(changed.map(path => path.split('/')[0]))]
    const thread = slugs.length === 1 ? threadOf(slugs[0]) : ''
    git(['commit', '-q', '--no-verify', '-F', '-'], { input: message('Agent wrote', changed, thread), env: identityEnv('agent') })
    return headCommit()
  }

  const commitPaths = (who, verb, slug, files, extra = '') => {
    stage(slug)
    const staged = gitText(['diff', '--cached', '--name-only', '-z', '--', slug]).split('\0').filter(Boolean)
    if (!staged.length) return headCommit()
    git(['commit', '-q', '--no-verify', '-F', '-', '--', slug], { input: message(verb, files.length ? files : staged, threadOf(slug), extra), env: identityEnv(who) })
    return headCommit()
  }

  const writeAtomic = (path, text) => {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.tmp`)
    writeFileSync(tmp, text)
    renameSync(tmp, path)
  }

  const readPageJson = (slug) => {
    try {
      const value = JSON.parse(readFileSync(pagePath(slug, 'page.json'), 'utf8'))
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch { return null }
  }
  const touchPageJson = (slug) => {
    const meta = readPageJson(slug)
    if (!meta) return
    try { writable(slug, 'page.json') } catch { return }
    meta.updated = now().toISOString()
    writeAtomic(pagePath(slug, 'page.json'), `${JSON.stringify(meta, null, 2)}\n`)
  }

  const summary = (slug) => {
    const dir = pagePath(slug)
    const has = (name) => { try { return statSync(join(dir, name)).isFile() } catch { return false } }
    const meta = readPageJson(slug)
    const entry = has('index.html') ? 'index.html' : has('doc.md') ? 'doc.md' : null
    if (!meta && !entry) return null
    const m = meta || {}
    let modified = null
    try { modified = statSync(meta ? join(dir, 'page.json') : join(dir, entry)).mtime.toISOString() } catch {}
    return {
      slug,
      title: str(m.title) || slug,
      kind: PAGE_KINDS.includes(m.kind) ? m.kind : 'other',
      status: PAGE_STATUSES.includes(m.status) ? m.status : 'ready',
      project: str(m.project),
      thread: str(m.thread, 120),
      created: iso(m.created),
      updated: iso(m.updated) || modified,
      entry,
      has_doc: has('doc.md'),
      has_index: has('index.html'),
      url: `/pages/${slug}/`,
      page_json: Boolean(meta),
    }
  }

  const fileHistory = (slug, file = '') => {
    if (!existsSync(join(historyDir, 'HEAD'))) return []
    const spec = file ? `${slug}/${file}` : slug
    const refs = gitText(['for-each-ref', '--format=%(objectname)', `${CONFLICT_REF}/${slug}/`]).split('\n').filter(Boolean)
    const head = headCommit()
    if (!head && !refs.length) return []
    // Newest first: git's date order keeps a version after the one it was made from.
    const out = gitText(['log', '--date-order', '--format=%H%x1f%an%x1f%aI%x1f%s%x1f%(trailers:key=Refused,valueonly,separator=)%x1e', '--no-renames',
      ...(head ? ['HEAD'] : []), ...refs, '--', spec])
    const conflicts = new Set(refs)
    return out.split('\x1e').map(row => row.trim()).filter(Boolean).map((row) => {
      const [commit, author, date, subject, refused] = row.split('\x1f')
      const who = author === identities.owner.name ? 'owner' : 'agent'
      const files = gitText(['show', '--format=', '--name-only', '-z', '--no-renames', commit, '--', spec]).split('\0').filter(Boolean).map(path => path.slice(slug.length + 1))
      return { commit, author: who, date, message: subject, files, refused: conflicts.has(commit) || Boolean((refused || '').trim()) }
    })
  }

  const commitKnown = (slug, commit) => fileHistory(slug).find(entry => entry.commit === commit || entry.commit.startsWith(commit)) || null

  let timer = null
  let watcher = null
  let watching = false
  const api = {
    root: pagesRoot,
    gitDir: historyDir,
    sync,
    list({ includeArchived = false } = {}) {
      sync()
      let names = []
      try { names = readdirSync(pagesRoot, { withFileTypes: true }).filter(d => d.isDirectory() && pageSlugValid(d.name)).map(d => d.name) } catch {}
      const pages = names.map(summary).filter(Boolean).filter(page => includeArchived || page.status !== 'archived')
      pages.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')) || a.slug.localeCompare(b.slug))
      return { pages }
    },
    read(slug, file) {
      const path = pagePath(slug, file)
      if (!EDITABLE.has(extname(path).toLowerCase())) throw new PagesError(415, 'not_a_text_file')
      if (!existsSync(path)) return { slug, file, exists: false, text: '', version: null }
      if (!inside(path) || !lstatSync(path).isFile()) throw new PagesError(404, 'page_not_found')
      const body = readFileSync(path)
      if (body.length > PAGE_TEXT_MAX_BYTES) throw new PagesError(413, 'page_file_too_large')
      return { slug, file, exists: true, text: body.toString('utf8'), version: pageVersion(body) }
    },
    /** Save one text file. `version` is what the editor started from (null for a new file). */
    save(slug, file, { text, version }, who = 'owner') {
      if (typeof text !== 'string') throw new PagesError(400, 'text_required')
      const body = Buffer.from(text, 'utf8')
      if (body.length > PAGE_TEXT_MAX_BYTES) throw new PagesError(413, 'page_file_too_large')
      const path = pagePath(slug, file)
      if (!EDITABLE.has(extname(path).toLowerCase())) throw new PagesError(415, 'not_a_text_file')
      writable(slug, file)
      sync()
      const current = existsSync(path) ? readFileSync(path) : null
      if (current && (!inside(path) || !lstatSync(path).isFile())) throw new PagesError(404, 'page_not_found')
      const currentVersion = current ? pageVersion(current) : null
      const expected = version === undefined || version === '' ? null : version
      if (expected !== currentVersion) {
        // Keep the refused text as its own commit (off the main line) so it shows in history and can be
        // restored; the file itself keeps the newer text.
        const refused = keepRefused(slug, file, body, who)
        throw new PagesError(409, 'stale_version', {
          current: { text: current ? current.toString('utf8') : '', version: currentVersion, exists: Boolean(current) },
          yours: { text, version: expected, kept_as: refused },
        })
      }
      if (current && currentVersion === pageVersion(body)) return { slug, file, version: currentVersion, commit: headCommit(), changed: false }
      writable(slug, file) // again, right before writing: sync() and the version check took time
      writeAtomic(path, body)
      ensure()
      if (file !== 'page.json') touchPageJson(slug)
      const commit = commitPaths(who, who === 'owner' ? 'Owner saved' : 'Agent saved', slug, [`${slug}/${file}`])
      return { slug, file, version: pageVersion(body), commit, changed: true }
    },
    history(slug, file = '') {
      sync()
      if (file && !pageFileParts(file)) throw new PagesError(400, 'invalid_file')
      pagePath(slug)
      const versions = fileHistory(slug, file)
      if (!versions.length && !existsSync(pagePath(slug))) throw new PagesError(404, 'page_not_found')
      return { slug, ...(file ? { file } : {}), versions }
    },
    /** Bring back a page (or one file of it) as it was at `commit`, as a new commit on top. */
    restore(slug, { commit, file = '' } = {}, who = 'owner') {
      if (!COMMIT.test(String(commit || ''))) throw new PagesError(400, 'invalid_commit')
      if (file && !pageFileParts(file)) throw new PagesError(400, 'invalid_file')
      sync()
      const known = commitKnown(slug, commit)
      if (!known) throw new PagesError(404, 'version_not_found')
      const spec = file ? `${slug}/${file}` : slug
      const present = gitText(['ls-tree', '-r', '--name-only', '-z', known.commit, '--', spec]).split('\0').filter(Boolean)
      if (!present.length) throw new PagesError(404, 'version_not_found')
      // Whole page: files added after that version go too (they stay in history). One file: only that file.
      if (!file) git(['rm', '-r', '-q', '--ignore-unmatch', '--', slug])
      git(['checkout', known.commit, '--', spec])
      const short = known.commit.slice(0, 12)
      const result = commitPaths(who, who === 'owner' ? 'Owner restored' : 'Agent restored', slug, present, `Restored-From: ${known.commit}`)
      return { slug, ...(file ? { file } : {}), restored_from: known.commit, short, commit: result, page: summary(slug) }
    },
    /** Watch the folder so the agent's writes become commits without any call from it. A folder that does
     *  not exist yet is watched from the first Pages call after it appears. */
    watch() {
      watching = true
      if (watcher || !watchDelayMs || !watching || !existsSync(pagesRoot)) return
      try {
        watcher = watch(pagesRoot, { recursive: true }, (event, name) => {
          if (name && String(name).split(sep).some(part => part.startsWith('.'))) return
          clearTimeout(timer)
          timer = setTimeout(() => { try { sync() } catch (error) { log(`[pages] commit failed: ${error?.code || error?.message}`) } }, watchDelayMs)
          timer.unref?.()
        })
        watcher.unref?.()
        watcher.on('error', () => { try { watcher?.close() } catch {} watcher = null })
      } catch { watcher = null }
    },
    close() { watching = false; clearTimeout(timer); try { watcher?.close() } catch {} watcher = null },
  }

  function keepRefused(slug, file, body, who) {
    ensure()
    const index = join(historyDir, `refused-index-${process.pid}`)
    try {
      const head = headCommit()
      const env = { GIT_INDEX_FILE: index, ...identityEnv(who) }
      if (head) git(['read-tree', head], { env })
      else git(['read-tree', '--empty'], { env })
      const blob = gitText(['hash-object', '-w', '--stdin'], { input: body }).trim()
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${slug}/${file}`], { env })
      const tree = gitText(['write-tree'], { env }).trim()
      const msg = message(who === 'owner' ? 'Owner edit kept (newer version on file)' : 'Agent edit kept (newer version on file)', [`${slug}/${file}`], threadOf(slug), 'Refused: stale version')
      const commit = gitText(['commit-tree', tree, ...(head ? ['-p', head] : []), '-F', '-'], { input: msg, env }).trim()
      git(['update-ref', `${CONFLICT_REF}/${slug}/${commit}`, commit])
      return commit
    } finally { rmSync(index, { force: true }) }
  }

  return api
}

/**
 * Serve GET/HEAD /pages/<slug>/... from the Pages folder. Returns false when the path is not a page path.
 * Every response, errors included, carries the sandbox policy.
 */
export function servePage(request, response, url, pagesRoot) {
  if (url.pathname !== '/pages' && !url.pathname.startsWith('/pages/')) return false
  const base = { 'Content-Security-Policy': PAGES_CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache' }
  const fail = (status, error, extra = {}) => {
    const body = JSON.stringify({ error })
    response.writeHead(status, { ...base, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extra })
    response.end(request.method === 'HEAD' ? undefined : body)
    return true
  }
  if (!['GET', 'HEAD'].includes(request.method)) return fail(405, 'method_not_allowed', { Allow: 'GET, HEAD' })
  if (!pagesRoot) return fail(404, 'not_found')
  let rel
  try { rel = decodeURIComponent(url.pathname.slice('/pages/'.length)) } catch { return fail(400, 'invalid_path') }
  const [slug, ...rest] = rel.split('/')
  if (!pageSlugValid(slug)) return fail(404, 'not_found')
  if (url.pathname === `/pages/${slug}`) {
    response.writeHead(308, { ...base, Location: `/pages/${slug}/${url.search}` })
    response.end()
    return true
  }
  if (rest.slice(0, -1).some(part => part === '')) return fail(404, 'not_found')
  const fileParts = rest.filter(Boolean)
  if (fileParts.length && !pageFileParts(fileParts.join('/'))) return fail(404, 'not_found')
  let path = resolve(pagesRoot, slug, ...fileParts)
  let real
  try {
    real = realpathSync(path)
    const root = realpathSync(pagesRoot)
    if (!real.startsWith(`${root}${sep}`)) return fail(404, 'not_found')
    let info = statSync(real)
    if (info.isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        response.writeHead(308, { ...base, Location: `${url.pathname}/${url.search}` })
        response.end()
        return true
      }
      const pick = ['index.html', 'doc.md'].map(name => join(real, name)).find(candidate => { try { return statSync(candidate).isFile() } catch { return false } })
      if (!pick) return fail(404, 'not_found')
      real = realpathSync(pick)
      if (!real.startsWith(`${root}${sep}`)) return fail(404, 'not_found')
      info = statSync(real)
      path = pick
    }
    if (!info.isFile()) return fail(404, 'not_found')
    // Answer from stat and stream the body, so a large video or PDF never sits whole in memory and HEAD
    // never opens the file. The ETag names this exact file state (inode, size, modification time).
    const size = info.size
    const tag = `"${info.ino.toString(16)}-${size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
    const headers = { ...base, 'Content-Type': TYPES[extname(path).toLowerCase()] || 'application/octet-stream', ETag: tag, 'Accept-Ranges': 'bytes', 'Last-Modified': info.mtime.toUTCString() }
    if (String(request.headers['if-none-match'] ?? '') === tag) { response.writeHead(304, headers); response.end(); return true }
    let start = 0
    let end = size - 1
    let status = 200
    const range = String(request.headers.range ?? '')
    const ifRange = request.headers['if-range']
    if (range && (!ifRange || String(ifRange) === tag)) {
      const match = /^bytes=(\d*)-(\d*)$/u.exec(range.trim())
      if (match && (match[1] || match[2])) {
        if (match[1]) { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1 }
        else { start = Math.max(0, size - Number(match[2])); end = size - 1 }
        if (start > end || start >= size) {
          response.writeHead(416, { ...base, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' })
          response.end()
          return true
        }
        status = 206
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`
      }
    }
    const length = size === 0 ? 0 : end - start + 1
    if (request.method === 'HEAD' || length === 0) {
      response.writeHead(status, { ...headers, 'Content-Length': String(length) })
      response.end()
      return true
    }
    const stream = createReadStream(real, { start, end })
    stream.once('open', () => {
      response.writeHead(status, { ...headers, 'Content-Length': String(length) })
      stream.pipe(response)
    })
    stream.once('error', () => {
      if (!response.headersSent) fail(404, 'not_found')
      else response.destroy()
    })
    response.once('close', () => stream.destroy())
    return true
  } catch { return fail(404, 'not_found') }
}
