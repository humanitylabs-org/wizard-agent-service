// Main agent provider attach (issue 428). Behind switch WIZARD_MAIN_PROVIDER_ATTACH (off by default).
//
// A provider sign-in (Claude, ChatGPT, Tinfoil, ...) is box-wide: every connected provider shows up in the main
// Hermes's GET /api/model/options. With the switch on, that inventory is only the box's provider pool. The main
// agent's chat picker and its runs use just the providers attached to it, and attaching one is an explicit owner
// action (PUT /wizard/v1/main-providers). The first time a provider exists, the main agent's configured provider
// (the onboarding choice) is attached, so a fresh box keeps working; nothing connected later is ever added for it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const MAIN_PROVIDERS_SCHEMA = 'wizard.main-providers/1'
const SLUG_RE = /^[a-z0-9][a-z0-9._:-]{0,99}$/u

/** `custom:wizard-tinfoil` and the user-defined row slug `wizard-tinfoil` are the same provider. */
export const providerKey = (slug) => (typeof slug === 'string' ? slug.trim().replace(/^custom:/u, '') : '')

const readJson = (path) => {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null } catch { return null }
}

/**
 * path: the attach file (Service-owned, beside the agent registry). loadOptions(): the main Hermes's raw
 * GET /api/model/options payload.
 */
export function createMainProviderAttach({ path, loadOptions }) {
  const stored = () => {
    const value = readJson(path)
    if (!value || value.schema !== MAIN_PROVIDERS_SCHEMA || !Array.isArray(value.attached)) return null
    return [...new Set(value.attached.map(providerKey).filter((slug) => SLUG_RE.test(slug)))]
  }
  const write = (attached) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ schema: MAIN_PROVIDERS_SCHEMA, attached }, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, path)
    return attached
  }

  /** The attached list; on first sight of a configured provider, that one provider (and only it) is attached. */
  const attachedFor = (options) => {
    const current = stored()
    if (current) return current
    const configured = providerKey(options?.provider)
    return configured && SLUG_RE.test(configured) ? write([configured]) : []
  }

  const rows = (options) => (Array.isArray(options?.providers) ? options.providers : []).filter((row) => row && typeof row === 'object')
  const isAttached = (attached, slug) => attached.includes(providerKey(slug))

  /** The main agent's picker: only attached rows. The rest are listed by name, so a client can offer to attach them. */
  function filterOptions(options) {
    // Before onboarding there is no agent default yet and nothing to keep apart: show the inventory as is.
    if (!stored() && !providerKey(options?.provider)) return options
    const attached = attachedFor(options)
    const all = rows(options)
    const kept = all.filter((row) => isAttached(attached, row.slug ?? row.id))
    const pool = all.filter((row) => !isAttached(attached, row.slug ?? row.id) && row.authenticated !== false)
      .map((row) => ({ slug: String(row.slug ?? row.id ?? ''), name: String(row.name || row.slug || row.id || '') }))
    return { ...options, providers: kept, wizard_attached_providers: attached, wizard_unattached_providers: pool }
  }

  /** A run, new thread or model change on the main agent that names an unattached provider is refused. */
  async function refusal(value) {
    const provider = value && typeof value === 'object' ? value.provider : undefined
    if (typeof provider !== 'string' || !provider.trim()) return null
    let attached = stored()
    if (!attached) {
      let options = null
      try { options = await loadOptions() } catch { options = null }
      attached = attachedFor(options)
    }
    if (isAttached(attached, provider)) return null
    return { error: 'provider_not_attached', check: 'agent.main.attached_providers', provider: providerKey(provider),
      message: 'This provider is connected to the box but not attached to this agent. Attach it to use it here.' }
  }

  async function state() {
    let options = null
    try { options = await loadOptions() } catch { options = null }
    const attached = options ? attachedFor(options) : (stored() ?? [])
    const pool = rows(options).filter((row) => row.authenticated !== false)
      .map((row) => ({ slug: String(row.slug ?? row.id ?? ''), name: String(row.name || row.slug || row.id || ''), attached: isAttached(attached, row.slug ?? row.id) }))
    return { schema: MAIN_PROVIDERS_SCHEMA, attached, pool }
  }

  /** The owner's explicit attach/detach: replaces the attached list. */
  function set(body) {
    const list = body && typeof body === 'object' && !Array.isArray(body) ? body.attached : undefined
    if (!Array.isArray(list) || list.length > 32 || list.some((slug) => typeof slug !== 'string' || !SLUG_RE.test(providerKey(slug)))) {
      throw Object.assign(new Error('attached must be a list of provider slugs'), { status: 400, code: 'invalid_attached_providers' })
    }
    return write([...new Set(list.map(providerKey))])
  }

  return { filterOptions, refusal, state, set, attached: stored }
}
