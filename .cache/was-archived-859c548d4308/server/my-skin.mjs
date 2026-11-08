// My skin: the owner's one personal stylesheet, layered by the shell on top of whichever skin they picked.
//
// It lives OUTSIDE the shell image, in the owner's Files root (Runtipi's media/ folder on a Wizard OS box):
//
//     <files root>/Skins/My skin.css
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
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'

export const MY_SKIN_RELATIVE = 'Skins/My skin.css'
export const MY_SKIN_MAX_BYTES = 64 * 1024

export const MY_SKIN_TEMPLATE = `/* My skin
 *
 * Your own look, on top of whichever skin you picked in Settings > Skins.
 * Wizard OS and skin updates never change this file. Leave it empty to see
 * the skin exactly as its author made it.
 *
 * Write plain CSS, or ask your agent: "change my skin so ...".
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
 * (WIZARD_MY_SKIN_PATH) for boxes without a Files root.
 */
export function createMySkin({ root = '', path = '' } = {}) {
  const base = root ? resolve(String(root)) : ''
  const file = path ? resolve(String(path)) : base ? join(base, ...MY_SKIN_RELATIVE.split('/')) : ''
  if (!file) return null
  const top = base || dirname(file)

  // Confined to the root after resolving symlinks; the file itself must be a regular file, never a link.
  function confined() {
    let realTop
    try { realTop = realpathSync(top) } catch { return null }
    let dir
    try { dir = realpathSync(dirname(file)) } catch { return { realTop, dirMissing: true } }
    if (dir !== realTop && !dir.startsWith(realTop + sep)) return null
    return { realTop, dirMissing: false }
  }

  function readRaw() {
    const where = confined(); if (!where || where.dirMissing) return { exists: false, text: '' }
    let st
    try { st = lstatSync(file) } catch { return { exists: false, text: '' } }
    if (!st.isFile()) return { exists: false, text: '' }
    if (st.size > MY_SKIN_MAX_BYTES) return { exists: true, text: '', tooLarge: true, bytes: st.size }
    try { return { exists: true, text: readFileSync(file, 'utf8'), bytes: st.size } } catch { return { exists: false, text: '' } }
  }

  function write(text) {
    const body = String(text ?? '')
    if (Buffer.byteLength(body, 'utf8') > MY_SKIN_MAX_BYTES) throw new MySkinError(413, 'my_skin_too_large')
    if (/[\u0000]/u.test(body)) throw new MySkinError(400, 'my_skin_invalid')
    // Never create the Files root itself: no root = no My skin (it reads as empty).
    try { lstatSync(top) } catch { throw new MySkinError(503, 'my_skin_unwritable') }
    try {
      const made = mkdirSync(dirname(file), { recursive: true })
      // Group-writable, so the Files app (same group on a box) can save the owner's edits.
      if (made) chmodSync(dirname(file), 0o775)
    } catch { throw new MySkinError(503, 'my_skin_unwritable') }
    const where = confined(); if (!where || where.dirMissing) throw new MySkinError(503, 'my_skin_unwritable')
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

  return {
    file,
    relative: base && !path ? MY_SKIN_RELATIVE : '',
    /** What the shell applies: sanitised CSS ('' = base skin exactly). */
    css() { const raw = readRaw(); return raw.tooLarge ? '' : sanitizeMySkin(raw.text) },
    info() {
      const raw = readRaw()
      return { path: base && !path ? MY_SKIN_RELATIVE : '', exists: raw.exists, bytes: raw.bytes ?? 0, max_bytes: MY_SKIN_MAX_BYTES,
        empty: raw.tooLarge ? true : mySkinEmpty(sanitizeMySkin(raw.text)), too_large: Boolean(raw.tooLarge) }
    },
    write,
    reset() { write(MY_SKIN_TEMPLATE) },
    /** Best effort at start: an owner opening Files finds the (empty, commented) file to edit. */
    ensure() { try { if (!readRaw().exists) write(MY_SKIN_TEMPLATE); return true } catch { return false } },
  }
}
