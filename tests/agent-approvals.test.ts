// Issue 597: command approvals for container agents (on for everyone; the wizard/agent-approvals switch is gone).
import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAgentRegistry, hermesConfigYaml, approvalWindowSeconds, APPROVAL_WINDOW_S, PRESETS } from '../server/agents.mjs'
import { withApprovalWindow } from '../server/routed-run-queue.mjs'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })))
const container = (permissions: any = {}, runtime: any = {}) => ({
  schema: 1, id: 'priv', label: 'Private', harness: 'hermes', privacy: 'private',
  model: { provider: 'tinfoil', model: 'glm-5-3', allowed_models: ['glm-5-3'], fallback: false },
  permissions: { preset: 'private', ...PRESETS[0].permissions, read_standard_chats: false, ...permissions },
  runtime: { kind: 'container', app_id: 'agent-priv', port: 18650, ...runtime },
})

it('hermesConfigYaml: every managed container agent gets the approvals block', () => {
  // approve (default): execute_code runs, the guardian checks flagged commands, nothing ever waits on a prompt.
  const on = hermesConfigYaml(container())
  expect(on).toContain(`approvals:\n  mode: "smart"\n  timeout: ${APPROVAL_WINDOW_S}\n  unattended_mode: "approve"\n  smart_policy: `)
  expect(on).toContain('security:\n  approval:\n    transport: "wizard-no-prompt"\n')
  // deny: no guardian, nothing runs that is flagged, nothing waits.
  const deny = hermesConfigYaml(container({ unattended_approvals: 'deny' }))
  expect(deny).toContain('approvals:\n  mode: "manual"\n  timeout: 3600\n  unattended_mode: "deny"\n')
  expect(deny).toContain('transport: "wizard-no-prompt"')
  expect(deny).not.toContain('smart_policy')
  // ask: prompts go to the owner (stock transport), open for an hour.
  const ask = hermesConfigYaml(container({ unattended_approvals: 'ask' }))
  expect(ask).toContain('approvals:\n  mode: "smart"\n  timeout: 3600\n  unattended_mode: "deny"\n')
  expect(ask).not.toContain('security:')
  expect(ask).not.toContain('smart_policy')
  // A restricted standard agent on Claude keeps its redact_secrets line inside the one security block.
  const claude = { ...container({}, { isolation: 'restricted' }), privacy: 'standard', model: { provider: 'anthropic', model: 'claude', allowed_models: ['claude'], fallback: false } }
  expect(hermesConfigYaml(claude)).toContain('security:\n  redact_secrets: true\n  approval:\n    transport: "wizard-no-prompt"\n')
  expect(hermesConfigYaml(claude).match(/^security:/gmu)).toHaveLength(1)
  // Restricted containers too; profile, external and imported agents keep Hermes's own window.
  expect(hermesConfigYaml(container({}, { isolation: 'restricted' }))).toContain('unattended_mode: "approve"')
  expect(approvalWindowSeconds(container())).toBe(3600)
  expect(approvalWindowSeconds({ ...container(), runtime: { kind: 'profile', profile: 'p' } })).toBe(0)
  expect(approvalWindowSeconds({ ...container(), imported: { schema: 1, format: 'hermes' } })).toBe(0)
})

function scene() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-approvals-')); dirs.push(dir)
  const calls: string[] = []
  const runtime = { apply: async (id: string) => { calls.push(id); return { ok: true } }, start: async () => ({ ok: true }), stop: async () => ({ ok: true }) }
  const registry = createAgentRegistry({ agentsDir: dir, runtime })
  return { dir, calls, registry, config: (id: string) => readFileSync(join(dir, id, 'home', 'config.yaml'), 'utf8'), stored: (id: string) => JSON.parse(readFileSync(join(dir, id, 'agent.json'), 'utf8')) }
}
const privateBody = (extra: any = {}) => ({ label: 'Private', permissions: { preset: 'private', ...extra }, model: { provider: 'tinfoil', model: 'glm-5-3' } })

it('approve by default, and the owner can set ask or deny per agent', async () => {
  const s = scene()
  const { agent } = await s.registry.create(privateBody())
  expect(s.config(agent.id)).toContain('  timeout: 3600\n  unattended_mode: "approve"')
  expect((await s.registry.publicAgent(agent)).permissions.unattended_approvals).toBe('approve')
  expect((await s.registry.agentOptions()).approvals).toEqual({ unattended: ['approve', 'ask', 'deny'], default: 'approve', window_s: 3600 })
  expect(s.registry.approvalWindow(agent.id)).toBe(3600)
  await expect(s.registry.update(agent.id, { permissions: { unattended_approvals: 'maybe' } })).rejects.toMatchObject({ status: 400 })
  const applied = s.calls.length
  const updated = await s.registry.update(agent.id, { permissions: { unattended_approvals: 'deny' } })
  expect(s.calls.length).toBe(applied + 1) // the agent restarts with its new config
  expect(s.stored(agent.id).permissions.unattended_approvals).toBe('deny')
  expect(s.config(agent.id)).toContain('unattended_mode: "deny"')
  expect((await s.registry.publicAgent(updated)).permissions.unattended_approvals).toBe('deny')
  await s.registry.update(agent.id, { permissions: { unattended_approvals: 'ask' } })
  expect(s.config(agent.id)).toContain('  mode: "smart"\n  timeout: 3600\n  unattended_mode: "deny"')
  expect(s.config(agent.id)).not.toContain('wizard-no-prompt')
  // A setting given at creation is stored too.
  const { agent: denied } = await s.registry.create({ ...privateBody({ unattended_approvals: 'deny' }), label: 'Private two' })
  expect(s.stored(denied.id).permissions.unattended_approvals).toBe('deny')
  expect(s.config(denied.id)).toContain('unattended_mode: "deny"')
  // The main agent is configured in Hermes itself.
  await expect(s.registry.update('hermes', { permissions: { unattended_approvals: 'approve' } })).rejects.toMatchObject({ status: 409 })
})

it('a container agent written by an older release gets the approvals block on the next managed upgrade', async () => {
  const s = scene()
  const { agent } = await s.registry.create(privateBody())
  // What a box had before approvals were on for everyone: no approvals block, and its stamp.
  const old = s.config(agent.id).replace(/^approvals:\n(?: {2}.*\n)+/mu, '').replace(/^security:\n {2}approval:\n {4}transport: .*\n/mu, '')
  expect(old).not.toContain('approvals:')
  writeFileSync(join(s.dir, agent.id, 'home', 'config.yaml'), old)
  writeFileSync(join(s.dir, agent.id, 'config.sha256'), 'stamp-from-an-older-release')
  const before = s.calls.length
  await s.registry.migrateManagedHarnesses()
  expect(s.config(agent.id)).toBe(hermesConfigYaml(s.registry.read(agent.id)))
  expect(s.config(agent.id)).toContain('unattended_mode: "approve"')
  expect(s.calls.length).toBeGreaterThan(before)
  expect(s.calls.at(-1)).toBe(agent.id)
})

it('a hand-edited approvals value never hides the agent', async () => {
  const s = scene()
  const { agent } = await s.registry.create(privateBody())
  const raw = s.stored(agent.id); raw.permissions.unattended_approvals = 'yolo'
  writeFileSync(join(s.dir, agent.id, 'agent.json'), JSON.stringify(raw))
  expect(s.registry.read(agent.id)?.permissions.unattended_approvals).toBeUndefined()
  expect((await s.registry.publicAgent(s.registry.read(agent.id))).permissions.unattended_approvals).toBe('approve')
})

it('withApprovalWindow stamps when a prompt closes and marks it expired after', () => {
  const payload = { status: 'waiting_for_approval', approval: { command: 'python3 -c x', timestamp: 1000 } }
  expect(withApprovalWindow(payload, 0)).toBe(payload)
  expect(withApprovalWindow({ status: 'running' }, 3600)).toEqual({ status: 'running' })
  expect(withApprovalWindow(payload, 3600, 1000 + 360).approval).toEqual({ command: 'python3 -c x', timestamp: 1000, window_s: 3600, expires_at: 4600 })
  expect(withApprovalWindow(payload, 3600, 4600).approval.expired).toBe(true)
  expect(payload.approval).not.toHaveProperty('expires_at')
})
