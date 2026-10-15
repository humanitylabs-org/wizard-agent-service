// Share routing with an agents registry (wizard-os spec/AGENTS.md; AGENT_SERVICE_API.md "Shares").
//
// Without a registry only the main agent exists and service.mjs routes every share there. With one:
//   - `agent` omitted → the default agent (the main agent, `hermes`); any other id must exist and be
//     running (or starting) at share time, else 409 agent_unavailable. Never a fallback to another agent.
//   - The main agent's files go to Wizard Files (media/Inbox on a Wizard OS box) as before.
//   - Every other agent's files go to that agent's own home, `<agentsDir>/<id>/home/inbox/<date>/<name>`,
//     staged beside its home (outside the container's view) on the same filesystem. They are never
//     written to `media/` or the main Wizard Files index, and are named in the run as paths inside the
//     agent's container (its home is mounted at /opt/data), not as wizard_file_ids.
//   - A given thread must belong to the agent (a pin to another agent → 409 thread_agent_pinned).
import { randomBytes } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join, posix } from 'node:path'
import { MAIN_AGENT_ID } from './agents.mjs'
import { UploadError } from './uploads.mjs'

const AGENT_TARGET = /^agent:([a-z][a-z0-9-]{0,30})$/u
const LIVE = new Set(['running', 'starting'])

function cleanName(value) {
  const name = basename(String(value || 'file')).replace(/[\u0000-\u001f\u007f/\\]/gu, '_').replace(/^\.+/u, '_').trim()
  return (name || 'file').slice(0, 200)
}

export function createShareAgentRouting({ registry, homeMount = '/opt/data', now = () => new Date(), mainThreadExists }) {
  const agentDir = (id) => join(registry.agentsDir, id)
  const inboxRoot = (id) => join(agentDir(id), 'home', 'inbox')
  const stagingDir = (id) => join(agentDir(id), 'upload-staging')
  // Upload id → stored file, so a completion retried after a crash finds what was already stored.
  const ledgerPath = (id) => join(stagingDir(id), 'stored.json')
  const readLedger = (id) => { try { return JSON.parse(readFileSync(ledgerPath(id), 'utf8')) } catch { return {} } }
  const writeLedger = (id, value) => {
    const tmp = `${ledgerPath(id)}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
    renameSync(tmp, ledgerPath(id))
  }

  function agentTarget(id) {
    return {
      kind: 'local',
      stagingDir: stagingDir(id),
      async finalize(path, meta) {
        const day = now().toISOString().slice(0, 10)
        const name = cleanName(meta.filename)
        const dir = join(inboxRoot(id), day)
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        const stem = name.slice(0, name.length - extname(name).length) || 'file'
        let rel = ''
        for (let n = 1; !rel; n += 1) {
          const candidate = n === 1 ? name : `${stem} (${n})${extname(name)}`
          const target = join(dir, candidate)
          try { linkSync(path, target); unlinkSync(path); rel = posix.join('inbox', day, candidate) } catch (error) {
            if (error?.code === 'EEXIST') continue
            if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK', 'EXDEV'].includes(error?.code)) throw error
            if (existsSync(target)) continue
            renameSync(path, target)
            rel = posix.join('inbox', day, candidate)
          }
        }
        const file = {
          id: `af_${randomBytes(16).toString('hex')}`, filename: name, mime: meta.mime, bytes: meta.bytes, sha256: meta.sha256,
          note: '', duplicate_of: null, created_at: now().toISOString(), source: 'Wizard share', status: 'ready', path: rel,
        }
        writeLedger(id, { ...readLedger(id), [meta.key]: file })
        return file
      },
      async recover(key) {
        const file = readLedger(id)[key]
        return file && existsSync(join(agentDir(id), 'home', file.path)) ? file : null
      },
    }
  }

  async function liveAgent(agentId, { delivering = false } = {}) {
    const agent = registry.read(agentId)
    if (!agent) throw new UploadError(409, 'agent_unavailable', { agent: agentId })
    if (agent.id === MAIN_AGENT_ID) return agent
    const status = await registry.status(agent, { fresh: delivering })
    if (!LIVE.has(status.status) || (delivering && status.status !== 'running')) {
      // At delivery a stopped agent is a transient failure (retried), never a reason to deliver elsewhere.
      if (delivering) throw Object.assign(new Error('agent not running'), { status: 503 })
      throw new UploadError(409, 'agent_unavailable', { agent: agentId })
    }
    return agent
  }

  return {
    uploadTarget(key) {
      const match = AGENT_TARGET.exec(String(key))
      if (!match || match[1] === MAIN_AGENT_ID || !registry.read(match[1])) return null
      return agentTarget(match[1])
    },

    async resolveShareAgent(agentId, { delivering = false } = {}) {
      const agent = await liveAgent(agentId || MAIN_AGENT_ID, { delivering })
      const label = registry.threadAgent(agent)?.label ?? agent.label ?? ''
      if (agent.id === MAIN_AGENT_ID) return { agent: MAIN_AGENT_ID, agent_label: label, target: 'files', query: '' }
      return {
        agent: agent.id,
        agent_label: label,
        target: `agent:${agent.id}`,
        query: `?agent=${encodeURIComponent(agent.id)}`,
        // The agent's own Hermes knows nothing of wizard_file_ids: name the files by their path in its home.
        runFields: (text, files) => {
          const listed = files.map(({ file }) => ({
            id: file.id, filename: file.filename, mime: file.mime, bytes: file.bytes, sha256: file.sha256,
            trusted_path: posix.join(homeMount, file.path),
          }))
          return { input: `${text}\n\n[WIZARD_FILES_V1]\n${JSON.stringify(listed)}\n[/WIZARD_FILES_V1]` }
        },
      }
    },

    async threadExists(threadId, routed) {
      const pinned = registry.pinnedAgent(threadId)
      if (pinned && pinned !== routed.agent) throw new UploadError(409, 'thread_agent_pinned')
      if (routed.agent === MAIN_AGENT_ID) return mainThreadExists(threadId, routed)
      return pinned === routed.agent
    },
  }
}
