// Provider-side identity for PERMISSIONS.md layer 2. This is not agent authority:
// each resource must separately check its owner-approved per-app capability.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { createHash, timingSafeEqual } from 'node:crypto'

const APP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u
const HASH = /^[a-f0-9]{64}$/u
const MAX = 64 * 1024
export function createAppGrantReader(file) {
  return {
    caller(request) {
      const key = request.headers?.['x-wizard-grant']
      if (!file || typeof key !== 'string' || !HASH.test(key)) return ''
      let fd
      try {
        // Re-open on every call: revocation, rotation and atomic replacement are immediate.
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const st = fstatSync(fd)
        if (!st.isFile() || st.nlink !== 1 || st.size > MAX || (st.mode & 0o022)) return ''
        const buf = Buffer.alloc(MAX + 1)
        let n = 0
        for (let read; n <= MAX && (read = readSync(fd, buf, n, MAX + 1 - n, null)) > 0;) n += read
        if (n > MAX) return ''
        const doc = JSON.parse(buf.toString('utf8', 0, n))
        if (!Array.isArray(doc?.incoming)) return ''
        const hash = createHash('sha256').update(key).digest()
        const callers = new Set(doc.incoming.filter(row => typeof row?.from === 'string' && APP_ID.test(row.from)
          && typeof row.sha256 === 'string' && HASH.test(row.sha256)
          && timingSafeEqual(hash, Buffer.from(row.sha256, 'hex'))).map(row => row.from))
        // Never trust X-Wizard-App, Origin, owner cookies or a caller name supplied in a URL.
        // An ambiguous adopted alias fails closed rather than impersonating another app.
        return callers.size === 1 ? [...callers][0] : ''
      } catch { return '' } finally { if (fd !== undefined) closeSync(fd) }
    },
  }
}
