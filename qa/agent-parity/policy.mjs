// A declaration never skips execution: the same per-kind fixture must first pass.
export function policyExemptions(feature, manifest, checks) {
  if (!Array.isArray(feature.policy_exemptions)) throw new Error(`Missing policy exemptions: ${feature.id}`)
  const kinds = new Set()
  for (const entry of feature.policy_exemptions) {
    const policy = manifest.policies.find(p => p.id === entry?.policy)
    if (!manifest.runtime_kinds.includes(entry?.kind) || kinds.has(entry.kind)
      || !policy?.rule || !policy.kinds?.includes(entry.kind)
      || !feature.fixture || entry.assertion !== feature.fixture || typeof checks[entry.assertion] !== 'function') {
      throw new Error(`Policy exemption requires an executable per-kind policy assertion: ${feature.id}`)
    }
    kinds.add(entry.kind)
  }
  return feature.policy_exemptions
}
export function applyPolicyExemption(cell, entry, manifest) {
  if (cell.status !== 'pass' || !entry) return cell
  return { ...cell, status: 'policy-exempt', policy: entry.policy,
    reason: manifest.policies.find(p => p.id === entry.policy).rule }
}
