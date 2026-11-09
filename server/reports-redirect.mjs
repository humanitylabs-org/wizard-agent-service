// Old report links (wizard-os spec/PAGES.md, Migration). Before Pages, an agent's reports lived at
// `/reports/<slug>/`. Pages replaced them, so a link saved in an old thread, note or brief must still land
// somewhere useful:
//
//   /reports/<slug>/<rest>?<query>  ->  308  /pages/<slug>/<rest>?<query>   when `Pages/<slug>/` exists
//   anything else under /reports/    ->  a plain "this page moved" page that links to the Pages list
//
// A page that was renamed when it moved is listed in `<Pages>/.reports-moved.json` as {"old-slug": "new-slug"}
// (dot files in the Pages folder are never served and never shown as a page).
//
// Machine feeds are not reports and never pass through here. `/reports/wizard-os/` (the phone app's updater
// feed, phone-feed.mjs) is answered earlier in the request path; the bare `/reports/wizard-os` is left alone
// here too, so every byte the updater and the release mirror see stays exactly as it was.
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve, sep } from 'node:path'
import { pageSlugValid } from './pages.mjs'

// Canonical Appearance v1 tokens (wizard-os style/tokens.css, byte-identical copy): the dark standalone fallback.
const TOKENS_CSS = readFileSync(fileURLToPath(new URL('./reports-moved/tokens.css', import.meta.url)), 'utf8')

export const REPORTS_RESERVED_SLUGS = new Set(['wizard-os'])
export const REPORTS_MOVED_FILE = '.reports-moved.json'

const escapeHtml = (text) => String(text).replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const MOVED_MAP_MAX_BYTES = 64 * 1024

// The Pages folder is agent-writable: never block on a FIFO, follow a symlink or read an unbounded file.
function readMovedMap(pagesRoot) {
  let fd
  try {
    fd = openSync(join(pagesRoot, REPORTS_MOVED_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > MOVED_MAP_MAX_BYTES) return null
    const buffer = Buffer.alloc(info.size)
    let offset = 0
    while (offset < buffer.length) { const n = readSync(fd, buffer, offset, buffer.length - offset, offset); if (!n) break; offset += n }
    return JSON.parse(buffer.subarray(0, offset).toString('utf8'))
  } catch { return null } finally { if (fd !== undefined) try { closeSync(fd) } catch {} }
}

function renamedSlug(pagesRoot, slug) {
  const map = readMovedMap(pagesRoot)
  const target = map && typeof map === 'object' && !Array.isArray(map) && Object.hasOwn(map, slug) ? map[slug] : null
  return typeof target === 'string' && pageSlugValid(target) ? target : slug
}

function pageExists(pagesRoot, slug) {
  if (!pagesRoot || !pageSlugValid(slug)) return false
  try {
    const root = realpathSync(resolve(pagesRoot))
    const real = realpathSync(resolve(pagesRoot, slug))
    return real.startsWith(`${root}${sep}`) && statSync(real).isDirectory()
  } catch { return false }
}

// Same Appearance v1 roles as the shell (`--wz-*`), with a dark standalone fallback; the small client below
// is the shared one, colours only, same-origin parent only.
const APPEARANCE_CLIENT = `(()=>{'use strict';const N=['canvas','base','chrome','overlay','surface','surface-raised','text','text-secondary','text-muted','border','accent','accent-soft','on-accent','reader-surface'];const r=document.documentElement;let rev=-1;const ok=v=>typeof v==='string'&&v.length>0&&v.length<96&&!/[;{}]|\\b(?:url|var|env|attr)\\s*\\(/i.test(v)&&!!(window.CSS&&CSS.supports('color',v));addEventListener('message',e=>{if(parent===window||e.source!==parent||e.origin!==location.origin||!e.data||e.data.type!=='wizard:appearance')return;const a=e.data.appearance;if(!a||a.version!==1||!Number.isSafeInteger(a.revision)||a.revision<=rev||!a.tokens||!['dark','light'].includes(a.colorScheme)||!N.every(k=>ok(a.tokens[k])))return;rev=a.revision;for(const k of N)r.style.setProperty('--wz-'+k,a.tokens[k]);r.style.colorScheme=a.colorScheme;r.setAttribute('data-wz-hosted','');parent.postMessage({type:'wizard:appearance:ack',version:1,revision:rev},location.origin)});if(parent!==window)parent.postMessage({type:'wizard:appearance:ready',version:1,app:'reports-moved'},location.origin)})()`

export const REPORTS_MOVED_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"

export function movedPageHtml({ pagesUrl, path = '' } = {}) {
  const where = path ? `<p class="path">${escapeHtml(path)}</p>` : ''
  return `<!doctype html>
<html lang="en"><head><script>try{if(window.parent!==window)document.documentElement.classList.add('wz-hosted')}catch(e){document.documentElement.classList.add('wz-hosted')}</script><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>This page moved · WizardOS</title>
<style>
${TOKENS_CSS}
html,body{margin:0;min-height:100%;background:var(--wz-canvas);color:var(--wz-text);font-family:var(--wz-font-ui);font-size:var(--wz-text-lg);line-height:var(--wz-line-height)}
html.wz-hosted,html[data-wz-hosted]{background:transparent}
html.wz-hosted body,html[data-wz-hosted] body{background:transparent}
main{max-width:34rem;margin:0 auto;padding:12vh var(--wz-space-4) var(--wz-space-5)}
h1{font-size:var(--wz-text-title);margin:0 0 var(--wz-space-2)}
p{margin:var(--wz-space-2) 0;color:var(--wz-text-secondary)}
.path{font-family:var(--wz-font-mono);font-size:var(--wz-text-md);color:var(--wz-text-muted);overflow-wrap:anywhere;padding:var(--wz-space-2) var(--wz-space-3);background:var(--wz-surface);border:1px solid var(--wz-border);border-radius:var(--wz-radius-tile)}
a.go{display:inline-flex;align-items:center;min-height:var(--wz-target);margin-top:var(--wz-space-4);padding:0 var(--wz-space-5);border-radius:var(--wz-radius-pill);background:var(--wz-accent);color:var(--wz-on-accent);font-weight:600;text-decoration:none}
</style></head>
<body><main>
<h1>This page moved</h1>
<p>Reports now live in Pages. This old address has no matching page, so it was probably renamed or removed.</p>
${where}
<a class="go" target="_top" href="${escapeHtml(pagesUrl || '/')}">Open Pages</a>
</main>
<script>${APPEARANCE_CLIENT}</script>
</body></html>
`
}

/**
 * Answer GET/HEAD for `/reports...`. Returns false when the path is not an old report path, or is a reserved
 * machine-feed slug (those stay with their own server, unchanged).
 */
export function serveOldReport(request, response, url, { pagesRoot = '', uxPrefix = 'wizard-os-home' } = {}) {
  if (url.pathname !== '/reports' && !url.pathname.startsWith('/reports/')) return false
  const rest = url.pathname.slice('/reports/'.length)
  let slug = rest.split('/')[0]
  try { slug = decodeURIComponent(slug) } catch { slug = '' }
  if (REPORTS_RESERVED_SLUGS.has(slug)) return false
  const base = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache' }
  if (!['GET', 'HEAD'].includes(request.method)) {
    const body = JSON.stringify({ error: 'method_not_allowed' })
    response.writeHead(405, { ...base, Allow: 'GET, HEAD', 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
    response.end(body)
    return true
  }
  const target = slug ? renamedSlug(pagesRoot, slug) : ''
  if (slug && pageExists(pagesRoot, target)) {
    const tail = rest.slice(rest.indexOf('/') < 0 ? rest.length : rest.indexOf('/') + 1)
    response.writeHead(308, { ...base, Location: `/pages/${encodeURIComponent(target)}/${tail}${url.search}` })
    response.end()
    return true
  }
  const pagesUrl = `/${String(uxPrefix || 'wizard-os-home').replace(/^\/+|\/+$/gu, '')}/?open=pages`
  const wantsJson = /application\/json/iu.test(String(request.headers.accept || '')) && !/text\/html/iu.test(String(request.headers.accept || ''))
  if (wantsJson) {
    const body = JSON.stringify({ error: 'moved', message: 'Reports now live in Pages.', pages: pagesUrl })
    response.writeHead(404, { ...base, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
    response.end(request.method === 'HEAD' ? undefined : body)
    return true
  }
  const body = movedPageHtml({ pagesUrl, path: url.pathname })
  response.writeHead(404, { ...base, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Content-Security-Policy': REPORTS_MOVED_CSP })
  response.end(request.method === 'HEAD' ? undefined : body)
  return true
}
