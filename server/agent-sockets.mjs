// Per-agent capability transport. Only the dedicated gateway directory goes into that agent's edge.
import { connect } from 'node:net'
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export const agentSocketPath = (agentsDir, id) => join(agentsDir, id, 'gateway', 'gateway.sock')

const inspect = path => { try { return lstatSync(path) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
const identity = stat => `${stat.dev}:${stat.ino}`

async function removeStale(path) {
  const before = inspect(path)
  if (!before) return
  if (!before.isSocket()) throw new Error('agent_socket_not_socket')
  // Never unlink a live listener belonging to another service instance.
  await new Promise((resolve, reject) => {
    const socket = connect(path)
    socket.setTimeout(1000)
    socket.once('connect', () => { socket.destroy(); reject(new Error('agent_socket_in_use')) })
    socket.once('timeout', () => { socket.destroy(); reject(new Error('agent_socket_probe_timeout')) })
    socket.once('error', error => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve()
      else reject(error)
    })
  })
  const after = inspect(path)
  if (after && identity(after) !== identity(before)) throw new Error('agent_socket_changed')
  if (after) unlinkSync(path)
}

export function createAgentSocketGateway({ agentsDir, ingress }) {
  const entries = new Map()
  let closing = false
  async function ensure(id) {
    if (closing) throw new Error('agent_socket_closing')
    if (!/^[a-z][a-z0-9-]{0,30}$/u.test(id) || id === 'hermes') throw new Error('agent_socket_invalid_id')
    if (entries.has(id)) {
      const previous = entries.get(id)
      const entry = await previous
      if (entries.get(id) !== previous) return ensure(id)
      if (inspect(entry.path)) return entry
      // An owner import undo removed its whole directory. A later rehearsal of
      // the same id must not reuse an unreachable, unlinked listener.
      const replacing = (async () => {
        entry.server.closeIdleConnections?.()
        entry.server.closeAllConnections?.()
        await new Promise(resolve => entry.server.close(resolve))
        entries.delete(id)
        return ensure(id)
      })()
      entries.set(id, replacing)
      return replacing
    }
    const pending = (async () => {
      const path = agentSocketPath(agentsDir, id)
      // Linux sockaddr_un is 108 bytes including NUL (macOS is shorter). Refuse truncation/aliasing.
      if (Buffer.byteLength(path) > 103) throw new Error('agent_socket_path_too_long')
      const dir = join(agentsDir, id, 'gateway')
      try { mkdirSync(dir, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
      return path
    })().then(async path => {
      const dir = join(agentsDir, id, 'gateway')
      const stat = lstatSync(dir)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('agent_socket_directory_unsafe')
      chmodSync(dir, 0o700)
      await removeStale(path)
      if (closing) throw new Error('agent_socket_closing')
      const server = ingress(id)
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        // Bind privately from the first instant. Do not chmod(path) after binding: the edge can
        // write this directory, so a replaced symlink must never make the Service chmod a host file.
        // Node binds Unix paths synchronously; restore the process umask before yielding to JS.
        const previous = process.umask(0o177)
        try { server.listen(path, resolve) } finally { process.umask(previous) }
      })
      return { server, path }
    })
    entries.set(id, pending)
    try { return await pending } catch (error) { entries.delete(id); throw error }
  }
  async function close() {
    closing = true
    await Promise.all([...entries.values()].map(async pending => {
      let entry
      try { entry = await pending } catch { return }
      entry.server.closeIdleConnections?.()
      entry.server.closeAllConnections?.()
      await new Promise(resolve => entry.server.close(resolve))
    }))
    entries.clear()
  }
  return { ensure, close }
}
