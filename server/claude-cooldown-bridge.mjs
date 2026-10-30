// Secret-free admission hint from host Hermes, via the Claude connector.
import { readFileSync } from 'node:fs'
import { aiConnectionApps } from './ai-usage.mjs'

export const CLAUDE_POOL_SAFE_ERROR = 'Claude is temporarily unavailable for this model on both subscriptions. Your message is saved; retry after a limit resets.'

export function cooldownsBlockModel(payload, model, now = Date.now()) {
  const evidence = payload?.modelCooldowns
  if (payload?.provider !== 'claude' || payload?.owner !== 'hermes'
    || evidence?.contract !== 'wizard.model-cooldowns/1'
    || !Number.isFinite(evidence.observedAt)
    || Math.abs(now - evidence.observedAt * 1000) > 10_000
    || !Array.isArray(evidence.grants) || evidence.grants.length !== 2) return false
  const ids = new Set()
  return evidence.grants.every(grant => {
    if (!grant || typeof grant.id !== 'string' || !/^[a-f0-9]{24}$/.test(grant.id) || ids.has(grant.id)) return false
    ids.add(grant.id)
    const until = grant.models?.[model]
    return grant.models && typeof grant.models === 'object' && !Array.isArray(grant.models)
      && typeof until === 'number' && Number.isFinite(until)
      && until * 1000 > now + 10_000 && until * 1000 < now + 30 * 24 * 60 * 60 * 1000
  })
}

export async function confirmedClaudePoolExhaustion(body, {
  appsJsonPath, address = 'internal', fetchImpl = fetch, now = () => Date.now(),
} = {}) {
  if (body?.provider !== 'anthropic' || !/^claude-[a-zA-Z0-9._-]{1,100}$/.test(body.model || '')
    || body.require_model_lock !== true || !appsJsonPath) return false
  try {
    const registry = JSON.parse(readFileSync(appsJsonPath, 'utf8'))
    const apps = aiConnectionApps(registry, address)
    const app = apps.find(a => a.appId === 'wizard-claude' && a.provider === 'claude')
    if (!app) return false
    const url = app.url.replace(/\/api\/connection$/, '/api/model-cooldowns')
    if (url === app.url) return false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2_000)
    try {
      const response = await fetchImpl(url, { headers: { Accept: 'application/json' },
        redirect: 'error', signal: controller.signal, cache: 'no-store' })
      if (!response.ok || Number(response.headers.get('content-length')) > 256 * 1024) return false
      const text = await response.text()
      if (text.length > 256 * 1024) return false
      return cooldownsBlockModel(JSON.parse(text), body.model, now())
    } finally { clearTimeout(timer) }
  } catch { return false }
}
