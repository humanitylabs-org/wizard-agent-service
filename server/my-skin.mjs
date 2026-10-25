// My skin: the owner's one personal stylesheet, layered by the shell on top of whichever skin they picked.
//
// It lives OUTSIDE the shell image, in the owner's Files root (Runtipi's media/ folder on a Wizard OS box):
//
//     <files root>/Skins/My skin/skin.css (legacy Skins/My skin.css still works)
//     <files root>/Skins/My skin/skin.js  (read-only here; device-local owner approval in the shell)
//
// so shell and skin updates never touch it, the owner sees it in Files, and their agent edits it with the
// Files app tools like any other text file. An empty file (or one holding only comments) means the base skin
// exactly as its author made it.
//
// The shell reads it through GET /wizard/v1/my-skin (text/css). What is served is sanitised, defence in
// depth behind the shell's CSP (default-src 'self'): CSS only, at most MAX_BYTES, no @import or other
// non-styling at-rules, and no url()/string that points at another origin. Writes (PUT/DELETE) are the
// owner's only, same-origin, and atomic. Nothing here can stop the shell from rendering: a missing,
// unreadable, oversized or unwritable file reads as an empty My skin.
// /script serves the separate, bounded module verbatim with its SHA-256. Approval belongs only to the
// owner's device; this service never approves scripts and exposes no script write endpoint.
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

export const MY_SKIN_RELATIVE = 'Skins/My skin/skin.css'
export const MY_SKIN_LEGACY = 'Skins/My skin.css'
export const MY_SKIN_SCRIPT = 'Skins/My skin/skin.js'
export const MY_SKIN_MAX_BYTES = 64 * 1024

export const validSkinId = id => typeof id === 'string' && [...id].length >= 1 && [...id].length <= 64 && !/^[.]|[/\\\\\u0000-\u001f\u007f-\u009f]/u.test(id)

export const MY_SKIN_TEMPLATE = `/* My skin
 *
 * Your own look, on top of whichever skin you picked in Settings > Look.
 * Wizard OS and skin updates never change this file. Leave it empty to see
 * the skin exactly as its author made it.
 *
 * Write plain CSS, or ask your agent: "change my skin so ...".
 * Optional behaviour: sibling skin.js uses the skin hook API. After every script edit,
 * only you can turn that exact version on in Settings > Look (on this device).
 * Target every skin, or one of them:
 *   html[data-skin] body { letter-spacing: .01em; }
 *   html[data-skin="nebula"] .dock { opacity: .9; }
 *
 * Skins: nebula, grove, tide, ember, signal, obsidian (Dark),
 * obsidian-light (Light), landscapes.
 * Broken page? Open Wizard with ?myskin=off, then fix or reset this file.
 */
`

// At-rules that only style. Everything else (@import, @namespace, @charset, unknown) is neutralised.
const AT_ALLOWED = new Set(['media', 'supports', 'keyframes', '-webkit-keyframes', 'container', 'layer', 'font-face', 'property', 'scope', 'starting-style', 'font-feature-values', 'counter-style', 'page'])
// A value that names another origin (scheme or protocol-relative). data:image/... and plain relative paths stay.
const FOREIGN = /^\s*(?:\/\/|\\|[a-z][a-z0-9+.-]*:)/i
const IMAGE_DATA = /^\s*data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i

// Strings are only fetched inside url()/image-set()/@font-face src; there, refuse anything that names a
// fetchable scheme or another host. Plain text such as content: "Note: hi" is left alone.
const FETCHABLE = /^\s*(?:\/\/|\\|(?:https?|ftp|wss?|file|blob|javascript|vbscript|filesystem|data):)/i

const safeTarget = (value) => !FOREIGN.test(value) || IMAGE_DATA.test(value)
const safeString = (value) => !FETCHABLE.test(value) || IMAGE_DATA.test(value)

// Code (outside comments and strings): at-rules, escaped identifiers, url(), legacy script hooks.
function cleanCode(code) {
  // Escapes could spell @import or url( in disguise: an at-keyword or function name holding a backslash is
  // never one we allow.
  code = code.replace(/@((?:[-a-z0-9_]|\\[0-9a-f]{1,6}\s?|\\[^\n0-9a-f])+)/giu, (m, name) => {
    const plain = name.toLowerCase()
    return !plain.includes('\\') && AT_ALLOWED.has(plain) ? m : '@x-blocked-' + name.replace(/\\/gu, '')
  })
  // A function spelled with escapes (u\72l(…)) is never a styling need: drop the whole call.
  code = code.replace(/[-a-z0-9_]*\\[-a-z0-9_\\]*\s?[-a-z0-9_\\]*\([^)]*\)?/giu, 'none')
  code = code.replace(/\burl\(\s*([^)"'\s]*)\s*\)/giu, (m, target) => (safeTarget(target) ? m : 'none'))
  code = code.replace(/\bexpression\s*\([^)]*\)?/giu, 'none').replace(/-moz-binding\s*:/giu, 'x-blocked:').replace(/\bbehavior\s*:/giu, 'x-blocked:')
  return code
}

/** Plain-CSS sanitiser. Returns the text the shell may apply (possibly ''). Comments are dropped. */
export function sanitizeMySkin(input) {
  let css = typeof input === 'string' ? input : Buffer.isBuffer(input) ? input.toString('utf8') : ''
  if (Buffer.byteLength(css, 'utf8') > MY_SKIN_MAX_BYTES) return ''
  // Control characters (except tab/newline/CR/form feed) never belong in a stylesheet; '<' is not needed in
  // CSS outside strings, and dropping '</style' keeps the text inert even inside a <style> element.
  css = css.replace(/^\uFEFF/u, '').replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/gu, '').replace(/<\/?style/giu, '')
  // Tokenise into comments, strings and code, so text inside a string is never mistaken for a rule.
  let out = ''
  let code = ''
  const flush = () => { out += cleanCode(code); code = '' }
  for (let i = 0; i < css.length;) {
    const c = css[i]
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end < 0 ? css.length : end + 2
      code += ' '
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      let value = ''
      while (j < css.length && css[j] !== c && css[j] !== '\n') { if (css[j] === '\\' && j + 1 < css.length) { value += css[j] + css[j + 1]; j += 2 } else value += css[j++] }
      const closed = css[j] === c
      flush()
      // An unterminated string would swallow the rest of the sheet: drop it.
      out += closed && safeString(value) ? c + value + c : '""'
      i = closed ? j + 1 : j
      continue
    }
    if (c === '\\' && i + 1 < css.length) { code += c + css[i + 1]; i += 2; continue }
    code += c
    i++
  }
  flush()
  return out
}

/** True when the stylesheet styles nothing (empty, whitespace or comments only). */
export function mySkinEmpty(css) {
  return !String(css || '').replace(/\/\*[\s\S]*?(?:\*\/|$)/gu, '').trim()
}

export class MySkinError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code }
}

/**
 * root: the owner's Files root (WIZARD_USER_FILES_ROOT or WIZARD_MEDIA_ROOT); path: an explicit file
 * (WIZARD_MY_SKIN_PATH) for boxes without a Files root (its optional module is sibling skin.js).
 */
export function createMySkin({ root = '', path = '' } = {}) {
  const base = root ? resolve(String(root)) : ''
  const preferred = path ? resolve(String(path)) : base ? join(base, ...MY_SKIN_RELATIVE.split('/')) : ''
  if (!preferred) return null
  const legacy = base && !path ? join(base, ...MY_SKIN_LEGACY.split('/')) : ''
  const scriptFile = base && !path ? join(base, ...MY_SKIN_SCRIPT.split('/')) : join(dirname(preferred), 'skin.js')
  const top = base || dirname(preferred)
  // Only absence selects the legacy file: a present but invalid folder file never reveals older CSS.
  const active = () => {
    if (!base || path) return undefined
    try {
      const pointer = join(base, 'Skins', 'active')
      if (!confined(pointer) || !lstatSync(pointer).isFile() || lstatSync(pointer).size > 512) return null
      const id = readFileSync(pointer, 'utf8').replace(/\r?\n$/, '')
      return validSkinId(id) ? id : null
    } catch (error) { return error.code === 'ENOENT' ? undefined : null }
  }
  const selected = () => {
    const id = active()
    if (id !== undefined) return id ? join(base, 'Skins', id, 'skin.css') : ''
    try { lstatSync(preferred); return preferred } catch (e) { if (e.code !== 'ENOENT') return preferred }
    if (legacy) { try { lstatSync(legacy); return legacy } catch { /* a new box uses the folder form */ } }
    return preferred
  }
  const relative = () => base && !path ? !selected() ? '' : selected() === legacy ? MY_SKIN_LEGACY : `Skins/${active() || 'My skin'}/skin.css` : ''

  // Confined to the root after resolving symlinks; the file itself must be a regular file, never a link.
  function confined(file) {
    let realTop
    try { realTop = realpathSync(top) } catch { return null }
    let dir, parent = dirname(file), dirMissing = false
    // Check the nearest existing ancestor before mkdir too: a Skins symlink must not create folders outside Files.
    for (;;) {
      try { dir = realpathSync(parent); break } catch {
        if (parent === dirname(parent)) return null
        parent = dirname(parent); dirMissing = true
      }
    }
    if (dir !== realTop && !dir.startsWith(realTop + sep)) return null
    return { realTop, dirMissing }
  }

  function readRaw(file = selected()) {
    if (!file) return { exists: false, text: '' }
    const where = confined(file); if (!where || where.dirMissing) return { exists: false, text: '' }
    let st
    try { st = lstatSync(file) } catch { return { exists: false, text: '' } }
    if (!st.isFile()) return { exists: false, text: '' }
    if (st.size > MY_SKIN_MAX_BYTES) return { exists: true, text: '', tooLarge: true, bytes: st.size }
    try {
      const body = readFileSync(file)
      if (body.length > MY_SKIN_MAX_BYTES) return { exists: true, text: '', tooLarge: true, bytes: body.length }
      return { exists: true, text: body.toString('utf8'), body, bytes: body.length }
    } catch { return { exists: false, text: '' } }
  }

  function write(text) {
    const file = selected()
    if (!file) throw new MySkinError(409, 'no_active_skin')
    const body = String(text ?? '')
    if (Buffer.byteLength(body, 'utf8') > MY_SKIN_MAX_BYTES) throw new MySkinError(413, 'my_skin_too_large')
    if (/[\u0000]/u.test(body)) throw new MySkinError(400, 'my_skin_invalid')
    if (!confined(file)) throw new MySkinError(503, 'my_skin_unwritable')
    // Never create the Files root itself: no root = no My skin (it reads as empty).
    try { lstatSync(top) } catch { throw new MySkinError(503, 'my_skin_unwritable') }
    try {
      const made = mkdirSync(dirname(file), { recursive: true })
      // Group-writable, so the Files app (same group on a box) can save the owner's edits.
      if (made) chmodSync(dirname(file), 0o775)
    } catch { throw new MySkinError(503, 'my_skin_unwritable') }
    const where = confined(file); if (!where || where.dirMissing) throw new MySkinError(503, 'my_skin_unwritable')
    try { const st = lstatSync(file); if (!st.isFile()) throw new MySkinError(409, 'my_skin_not_a_file') } catch (error) { if (error instanceof MySkinError) throw error }
    const tmp = join(dirname(file), `.my-skin-${randomBytes(6).toString('hex')}.tmp`)
    try {
      writeFileSync(tmp, body, { mode: 0o664 })
      chmodSync(tmp, 0o664) // past the umask: the Files app (same group) edits this file too
      renameSync(tmp, file)
    } catch {
      try { rmSync(tmp, { force: true }) } catch { /* nothing to clean */ }
      throw new MySkinError(503, 'my_skin_unwritable')
    }
  }

  function script() {
    const id = active()
    const raw = readRaw(id === undefined ? scriptFile : id ? join(base, 'Skins', id, 'skin.js') : '')
    return { exists: raw.exists, sha256: raw.body ? createHash('sha256').update(raw.body).digest('hex') : null,
      bytes: raw.bytes ?? 0, body: raw.body ?? null }
  }
  return {
    get file() { return selected() },
    get relative() { return relative() },
    script,
    /** What the shell applies: sanitised CSS ('' = base skin exactly). */
    css() { const raw = readRaw(); return raw.tooLarge ? '' : sanitizeMySkin(raw.text) },
    info() {
      const raw = readRaw()
      const { body, ...scriptInfo } = script()
      return { path: relative(), exists: raw.exists, bytes: raw.bytes ?? 0, max_bytes: MY_SKIN_MAX_BYTES, script: scriptInfo,
        empty: raw.tooLarge ? true : mySkinEmpty(sanitizeMySkin(raw.text)), too_large: Boolean(raw.tooLarge) }
    },
    write,
    reset() { write(MY_SKIN_TEMPLATE) },
    /** Best effort at start: an owner opening Files finds the (empty, commented) file to edit. */
    ensure() { try { if (!selected()) return true; if (!readRaw().exists) write(MY_SKIN_TEMPLATE); return true } catch { return false } },
  }
}
