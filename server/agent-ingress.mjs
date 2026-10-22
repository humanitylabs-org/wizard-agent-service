import { lstatSync } from 'node:fs'
import { request } from 'node:http'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'

/** Fetch-shaped streaming client for the trusted per-agent ingress relay. Never follows redirects or
 * falls back to TCP. The caller derives socketPath from the agent id, not a stored arbitrary path. */
export function fetchAgentIngress(socketPath, path, init = {}) {
  if (!path.startsWith('/') || path.startsWith('//') || /[\r\n]/u.test(path)) throw new Error('invalid agent API path')
  const directory = lstatSync(dirname(socketPath)), socket = lstatSync(socketPath)
  const uid = process.getuid()
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o777) !== 0o700
      || !socket.isSocket() || socket.uid !== uid || (socket.mode & 0o777) !== 0o600) throw new Error('unsafe agent ingress socket')
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers)), signal: init.signal, agent: false }, res => {
      const headers = new Headers()
      for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i], res.rawHeaders[i + 1])
      const status = res.statusCode
      if (init.redirect === 'error' && [301, 302, 303, 307, 308].includes(status)) {
        res.destroy(); reject(new Error('agent ingress redirect refused')); return
      }
      const noBody = init.method === 'HEAD' || [204, 205, 304].includes(status)
      if (noBody) res.resume()
      resolve(new Response(noBody ? null : Readable.toWeb(res), { status, statusText: res.statusMessage, headers }))
    })
    req.on('error', reject)
    req.end(init.body)
  })
}
