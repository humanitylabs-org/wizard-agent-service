// Invoked by Agent Service-owned systemd user timers. No registry writes here.
import { request } from 'node:http'
export function triggerSystemJob(socketPath, id) {
  return new Promise((resolve, reject) => {
    if (typeof socketPath !== 'string' || !socketPath.startsWith('/') || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return reject(new Error('Invalid host trigger'))
    const req = request({ socketPath, path: `/run/${id}`, method: 'POST', timeout: 15000, headers: { 'Content-Length': '0' } }, res => {
      res.resume(); res.once('end', () => res.statusCode === 202 ? resolve() : reject(new Error('Host trigger refused')))
    })
    req.once('timeout', () => req.destroy(new Error('Host trigger timed out')))
    req.once('error', reject); req.end()
  })
}
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  triggerSystemJob(process.argv[2], process.argv[3]).catch(() => { console.error('Scheduled maintenance could not be started. Check the Agent Service.'); process.exitCode = 1 })
}
