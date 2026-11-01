// Production browser-trust admission facts, read from what the App Manager writes (default-off).
// apps.json `browser` (wizard-app-manager wam/browser_admission.py) is the only source: installation,
// recorded source, installed commit, permission revision, installed browser_contract and the owner's
// browser grants for THIS installation+source. Nothing comes from a frame, URL or request body.
import { readFileSync, statSync } from 'node:fs'

const MAX_REGISTRY_BYTES = 2 * 1024 * 1024

function readRegistry(path) {
  try {
    if (!path || statSync(path).size > MAX_REGISTRY_BYTES) return null
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    return doc && Array.isArray(doc.apps) ? doc : null
  } catch { return null }
}

/**
 * resolveInstallation(appId) re-reads apps.json on every call (bindings, each admission and before each
 * result delivery), so uninstall, update, source switch, grant revocation and slot/provider changes take
 * effect on the next check without any cache or event bus.
 */
export function createWamInstallationResolver({ appsJsonPath }) {
  const entry = appId => {
    const doc = readRegistry(appsJsonPath)
    if (!doc) return null
    // Two entries for one id (e.g. both published `profiles` sources) is ambiguous: refuse, never pick one.
    const found = doc.apps.filter(a => a?.id === appId)
    if (found.length !== 1) return null
    const app = found[0], b = app.browser
    if (app.staged === true || app.app_id || !b || b.schema !== 1) return null
    return { doc, app, b }
  }
  return Object.freeze({
    resolveInstallation(appId) {
      const e = entry(appId)
      if (!e) return null
      const { doc, app, b } = e
      if (!b.installation_id || !b.source_id || !b.commit || !b.permission_revision || !b.contract) return null
      const providers = {}
      for (const [slot, value] of Object.entries(doc.slots || {})) {
        if (value?.default === appId && Array.isArray(app.provides) && app.provides.includes(slot)) providers[slot] = true
      }
      return {
        status: app.status,
        installationId: b.installation_id,
        sourceId: b.source_id,
        installedCommit: b.commit,
        permissionRevision: b.permission_revision,
        browser_contract: { operations: [...(b.contract.operations || [])], state: { persistent_bytes: b.contract.state?.persistent_bytes || 0 } },
        providers,
        upstream: typeof b.upstream === 'string' && /^http:\/\/[a-z0-9.-]+:[0-9]{1,5}$/i.test(b.upstream) ? b.upstream : null,
      }
    },
    resolveGrants(installationId, sourceId) {
      const doc = readRegistry(appsJsonPath)
      if (!doc) return { operations: [] }
      const hits = doc.apps.filter(a => a?.browser?.installation_id === installationId)
      if (hits.length !== 1) return { operations: [] }
      const b = hits[0].browser
      if (sourceId !== undefined && b.source_id !== sourceId) return { operations: [] }
      return { operations: b.admissible === true && Array.isArray(b.granted) ? [...b.granted] : [] }
    },
  })
}
