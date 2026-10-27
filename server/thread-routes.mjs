// Service-owned answer selection; Hermes state is never written.
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicStoreWrite, withStoreLock, threadKey } from './thread-reference.mjs'

export class ThreadRouteStore {
  constructor(path = '') { this.path = path; this.rows = {}; this.load() }
  load() {
    if (this.path && existsSync(this.path)) this.rows = JSON.parse(readFileSync(this.path, 'utf8'))
  }
  get(agent, session) { this.load(); return this.rows[threadKey(agent, session)] ?? { route: 'hermes' } }
  set(agent, session, route) {
    if (!['hermes', 'opus-direct'].includes(route)) throw Object.assign(new Error('Invalid answer route'), { status: 400 })
    const write = () => {
      this.load()
      const row = { agent_id: agent, session_id: session, route, updated_at: new Date().toISOString() }
      const next = { ...this.rows, [threadKey(agent, session)]: row }
      if (this.path) atomicStoreWrite(this.path, JSON.stringify(next))
      this.rows = next
      return row
    }
    if (!this.path) return write()
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    return withStoreLock(this.path, write)
  }
}

export const refusesDirect = agent => agent?.privacy === 'private' || agent?.privacy === 'confidential'
  || agent?.role === 'recovery' || agent?.runtime?.isolation === 'restricted'
  || ['tinfoil', 'custom:tinfoil'].includes(agent?.model?.provider)
