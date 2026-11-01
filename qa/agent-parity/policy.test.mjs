import test from 'node:test'
import assert from 'node:assert/strict'
import { policyExemptions, applyPolicyExemption } from './policy.mjs'
const manifest = { runtime_kinds: ['main','host-profile','container','restricted'], policies: [
  { id: 'owner-scoped-hermes-only', kinds: ['host-profile','container','restricted'], rule: 'Explicit owner scope' },
] }
const entry = { kind: 'container', policy: 'owner-scoped-hermes-only', assertion: 'owned-open-work' }
const feature = { id: 'owned-open-work', fixture: 'owned-open-work', policy_exemptions: [entry] }
const checks = { 'owned-open-work': async () => {} }
test('owner scope requires an executable per-kind fixture, never a blanket exemption', () => {
  assert.deepEqual(policyExemptions(feature, manifest, checks), [entry])
  for (const invalid of ['all-routed', {...entry, kind:'main'}, {...entry, policy:'missing'}, {...entry, assertion:'not-implemented'}]) {
    assert.throws(() => policyExemptions({...feature, policy_exemptions:[invalid]}, manifest, checks), /executable per-kind/)
  }
  assert.throws(() => policyExemptions({...feature, policy_exemptions:[entry,entry]}, manifest, checks), /executable per-kind/)
  assert.throws(() => policyExemptions({...feature, fixture:null}, manifest, checks), /executable per-kind/)
  assert.throws(() => policyExemptions(feature, manifest, {}), /executable per-kind/)
})
test('failed policy assertions remain failures, not exemptions', () => {
  const failed = { status:'fail', reason:'routed behavior changed' }
  assert.equal(applyPolicyExemption(failed,entry,manifest),failed)
  const passed = { status:'pass', evidence:'fixture HTTP boundary' }
  assert.equal(applyPolicyExemption(passed,entry,manifest).status,'policy-exempt')
  assert.equal(applyPolicyExemption(passed,null,manifest),passed)
})
