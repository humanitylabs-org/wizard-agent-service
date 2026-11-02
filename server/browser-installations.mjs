// Production browser-trust admission facts, read from what the App Manager writes (default-off).
// apps.json `browser` (wizard-app-manager wam/browser_admission.py) is the only source: installation,
// recorded source, installed commit, permission revision, installed browser_contract and the owner's
// browser grants for THIS installation+source. Nothing comes from a frame, URL or request body.
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
        browser_contract: { operations: [...(b.contract.operations || [])], state: { persistent_bytes: b.contract.state?.persistent_bytes || 0 },
          // Reviewed provider sign-in pages (WAM normalize_navigation); anything off-shape is dropped, never widened.
          navigation: (Array.isArray(b.contract.navigation) ? b.contract.navigation : []).slice(0, 4).filter(n => n && typeof n.id === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(n.id)
            && typeof n.url === 'string' && /^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9._~/-]*$/.test(n.url) && (n.query === undefined || (Array.isArray(n.query) && n.query.every(q => typeof q === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(q)))))
            .map(n => ({ id: n.id, url: n.url, query: [...(n.query || [])] })) },
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
    /**
     * The installation's listener credential for the adapter's OWN upstream call (wizard-os #386), or null
     * when WAM recorded none (the app's listener has no gate). Read server-side from the WAM-minted file on
     * every call: rotation on reinstall and removal on uninstall apply at once. Never sent to a browser,
     * never the shell token. A recorded but missing/malformed key fails closed.
     */
    resolveListenerCredential(installationId) {
      const doc = readRegistry(appsJsonPath)
      if (!doc || !/^inst-[a-f0-9]{32}$/.test(String(installationId))) return null
      const hits = doc.apps.filter(a => a?.browser?.installation_id === installationId)
      if (hits.length !== 1) return null
      const c = hits[0].browser.listener_credential
      if (!c) return null
      const ref = `browser-app-credentials/${installationId}.key`
      if (c.ref !== ref || c.header !== 'X-Wizard-App-Credential') throw Object.assign(new Error('backend_unavailable'), { code: 'backend_unavailable' })
      let value = ''
      try { value = readFileSync(join(dirname(appsJsonPath), ref), 'utf8').trim() } catch { /* missing: fail closed below */ }
      if (!/^[a-f0-9]{64}$/.test(value)) throw Object.assign(new Error('backend_unavailable'), { code: 'backend_unavailable' })
      return { header: 'x-wizard-app-credential', value }
    },
  })
}
