// Display-only App Manager refusal. No credential, command, or approval authority crosses this boundary.
const ROOT = '/wizard-os-home/store-install/_approve/'
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/
export function ownerApprovalFromTool(value, depth = 0) {
  if (depth > 8 || value == null) return null
  if (typeof value === 'object' && !Array.isArray(value) && value.error === 'needs_owner_approval'
    && typeof value.app === 'string' && ID.test(value.app)
    && Array.isArray(value.risks) && value.risks.length <= 100 && value.risks.every(r => typeof r === 'string' && r.length <= 4096)
    && typeof value.approve_url === 'string' && new RegExp('^' + ROOT + value.app + '/[a-f0-9]{64}$').test(value.approve_url)) {
    return { error: 'needs_owner_approval', app: value.app, risks: value.risks, approve_url: value.approve_url }
  }
  if (typeof value === 'string' && value.length <= 262144) {
    try { const hit = ownerApprovalFromTool(JSON.parse(value), depth + 1); if (hit) return hit } catch {}
    for (const line of value.split('\n')) {
      if (!line.trim().startsWith('{')) continue
      try { const hit = ownerApprovalFromTool(JSON.parse(line), depth + 1); if (hit) return hit } catch {}
    }
  } else if (Array.isArray(value)) {
    for (const row of value.slice(0, 100)) { const hit = ownerApprovalFromTool(row, depth + 1); if (hit) return hit }
  } else if (typeof value === 'object') {
    for (const key of ['content', 'text', 'output', 'stderr', 'result', 'data']) {
      const hit = ownerApprovalFromTool(value[key], depth + 1)
      if (hit) return hit
    }
  }
  return null
}
