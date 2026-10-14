// Explicit reply provenance only: never infer app ownership from a title, subject or body.
// Same ID grammar as the App Manager's wizard.md checker. Preserve IDs verbatim.
const APP_ID = /^[a-z0-9][a-z0-9-]{1,40}(?![\s\S])/u

export function normalizeAppId(value) {
  return typeof value === 'string' && APP_ID.test(value) ? value : null
}

// readApps is the sole installed-app source; Food is a native shell builtin, not a managed app.
export function appProvenanceCatalog(apps) {
  const catalog = new Map()
  for (const app of Array.isArray(apps) ? apps : []) {
    const id = normalizeAppId(app?.id)
    if (id && !catalog.has(id)) catalog.set(id, { id, name: String(app.name || id) })
  }
  if (!catalog.has('usuals')) catalog.set('usuals', { id: 'usuals', name: 'Food' })
  return [...catalog.values()]
}

export const APP_PROVENANCE_INSTRUCTIONS = 'App provenance is optional: add app_id to the final WIZARD_STATUS_V1 JSON only when this reply reports actual work you performed in one installed Wizard app (for example reading its data, changing it, or publishing its output). Use its exact installed ID from the catalogue below, never its display name or a guessed alias. Mentioning an app, discussing its subject, a thread title, or merely opening its screen is not app work. Screen context can help identify where to work, but does not itself establish provenance. If this request is unrelated, or no single app owns the result, omit app_id even if earlier replies used it. Never carry the previous reply\'s app_id forward automatically.'

export function appProvenanceRunNote(catalog) {
  // JSON keeps names data, not instruction syntax; the catalogue is read afresh for every run.
  return `${APP_PROVENANCE_INSTRUCTIONS}\nInstalled Wizard app IDs and names (data): ${JSON.stringify(catalog)}`
}

export function metadataAppId(metadata) {
  let value = metadata
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return { present: false, id: null } }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { present: false, id: null }
  const present = Object.hasOwn(value, 'app_id')
  return { present, id: present ? normalizeAppId(value.app_id) : null }
}

// Canonical DB truth wins over previews (including stale upstream cache). Without a DB, the
// history reader may supply the current reply's candidate. Unknown/uninstalled IDs fail closed.
export function projectSessionAppProvenance(result, truth, installedIds) {
  try {
    const payload = JSON.parse(result.toString('utf8'))
    for (const key of ['data', 'sessions']) {
      if (!Array.isArray(payload?.[key])) continue
      payload[key] = payload[key].map((session) => {
        if (!session || typeof session !== 'object') return session
        const projected = { ...session }
        delete projected.wizard_app_id
        const candidate = truth.has(session.id) ? truth.get(session.id)?.appId : session.wizard_app_id
        const id = normalizeAppId(candidate)
        if (id && installedIds.has(id)) projected.wizard_app_id = id
        // Keep the status/titles/subjects contract while rejecting unknown app IDs there too.
        if (projected.wizard_attention && Object.hasOwn(projected.wizard_attention, 'app_id')) {
          const attention = { ...projected.wizard_attention }
          const statusId = normalizeAppId(attention.app_id)
          if (!statusId || !installedIds.has(statusId)) delete attention.app_id
          projected.wizard_attention = attention
        }
        return projected
      })
    }
    return Buffer.from(JSON.stringify(payload))
  } catch { return result }
}
