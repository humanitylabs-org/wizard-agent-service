import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { post } from './fixture.mjs'

export const providerChecks = {
  'private-provider-admission': async s => {
    // Every kind keeps normal owner admission when no provider is installed.
    const ordinary = await s.request('/v1/runs', post({ session_id: 'wizard_parity', input: 'Synthetic provider parity baseline' }))
    assert.equal(ordinary.status, 202)
    const rid = (await ordinary.json()).run_id
    await s.request(`/v1/runs/${rid}/stop`, post({}))
    const appsPath = join(s.root, 'apps.json')
    const apps = JSON.parse(readFileSync(appsPath, 'utf8'))
    apps.apps.push({ id: 'wizard-tinfoil', status: 'stopped', private_inference: { kind: 'attested-relay', relay_port: 8090 } })
    writeFileSync(appsPath, JSON.stringify(apps))
    const gated = ['container', 'restricted'].includes(s.kind)
    if (gated) {
      // This synthetic record represents an already migrated agent. Migration identity
      // and lifecycle are tested separately; the real proxy must gate BEFORE dispatch.
      const file = join(s.root, 'os/agents', s.id, 'agent.json')
      const record = JSON.parse(readFileSync(file, 'utf8'))
      record.runtime.private_client = true
      record.model.provider = 'wizard-tinfoil'
      record.model.fallback = false
      writeFileSync(file, JSON.stringify(record))
    }
    await s.restart()
    const before = s.seen.filter(r => r.method === 'POST').length
    const create = await s.request('/api/sessions', post({ id: 'wizard_provider_gate', hidden: true }))
    assert.equal(create.status, gated ? 503 : 201)
    if (gated) assert.equal((await create.json()).error, 'private_provider_unavailable')
    const run = await s.request('/v1/runs', post({ session_id: 'wizard_parity', input: 'Synthetic stopped provider admission' }))
    assert.equal(run.status, gated ? 503 : 202)
    if (gated) {
      assert.equal((await run.json()).error, 'private_provider_unavailable')
      assert.equal(s.seen.filter(r => r.method === 'POST').length, before, 'rejected requests must not reach Hermes')
    } else {
      const sent = s.seen.filter(r => r.method === 'POST' && r.path.endsWith('/v1/runs')).at(-1)
      assert.ok(sent)
      if (s.kind === 'host-profile') assert.ok(sent.path.startsWith('/p/parity-profile/'))
    }
  },
}
