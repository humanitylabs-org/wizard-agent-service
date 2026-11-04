// Public release bytes only. The host App Manager owns and verifies this read-only mirror.
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

const PREFIX = '/reports/wizard-os/'
const APK = /^wizard-os-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\.apk$/u

export async function servePhoneFeed(request, response, directory) {
  const raw = (request.url || '').split('?')[0]
  // Check the raw target too: URL parsing normalizes dot segments before the main router sees them.
  if (!raw.startsWith(PREFIX) && !new URL(request.url || '/', 'http://wizard.local').pathname.startsWith(PREFIX)) return false
  const missing = () => {
    const body = JSON.stringify({ error: 'no_phone_release' })
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-cache' })
    response.end(request.method === 'HEAD' ? undefined : body)
  }
  if (!['GET', 'HEAD'].includes(request.method)) {
    const body = JSON.stringify({ error: 'method_not_allowed' })
    response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
    response.end(body)
    return true
  }
  const name = raw.slice(PREFIX.length)
  if (!directory || !raw.startsWith(PREFIX) || (name !== 'latest.json' && !APK.test(name))) { missing(); return true }
  let file
  try {
    // No symlinks, directories or special files, even if the host mirror is misconfigured.
    file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await file.stat()
    if (!stat.isFile()) { await file.close(); missing(); return true }
    response.writeHead(200, {
      'Content-Type': name === 'latest.json' ? 'application/json; charset=utf-8' : 'application/vnd.android.package-archive',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    })
    if (request.method === 'HEAD') { await file.close(); response.end() }
    else await pipeline(file.createReadStream(), response)
  } catch (error) {
    await file?.close().catch(() => {})
    if (response.headersSent) response.destroy(error)
    else missing()
  }
  return true
}
