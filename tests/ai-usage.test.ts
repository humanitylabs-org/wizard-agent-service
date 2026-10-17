import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { aiConnectionApps, aiConnectionUrl, createAiUsageReader } from '../server/ai-usage.mjs'
import { createWizardServer } from '../server/service.mjs'

const CLAUDE_TOKEN = 'sk-ant-oat-FIXTURE-CLAUDE-TOKEN'
const NOW = Date.parse('2026-09-23T07:11:00.000Z')

// Disposable ChatGPT tokens shaped like the real ones: the account identity a
// pool row, the auth store and the CLI all agree on lives in the claims.
function codexToken({ account = '', plan = 'pro', issued = NOW - 60_000, expires = 4_102_444_800_000 } = {}) {
  const claims = {
    sub: account ? `sub-${account}` : undefined,
    iat: Math.floor(issued / 1000),
    exp: Math.floor(expires / 1000),
    ...(account ? { 'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_plan_type: plan } } : {}),
  }
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
}

const CODEX_TOKEN = codexToken()
const EXPIRED_CODEX_TOKEN = codexToken({ expires: 1_000_000 })
const FIRST_TOKEN = codexToken({ account: 'acct-first' })
const SECOND_TOKEN = codexToken({ account: 'acct-second', plan: 'plus' })

// Field-for-field shape of the live Anthropic OAuth usage response, with the
// numbers replaced. Legacy model windows are null while limits[] carries a
// model-scoped window, which is exactly the payload Wizard must handle.
const claudePayload = {
  five_hour: { utilization: 1.0, resets_at: '2026-09-23T09:00:00.254856+00:00' },
  seven_day: { utilization: 8.0, resets_at: '2026-09-26T01:00:00.254877+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: { is_enabled: true, monthly_limit: 3000, used_credits: 720.0, currency: 'USD', decimal_places: 2 },
  limits: [
    { kind: 'session', group: 'session', percent: 1, resets_at: '2026-09-23T09:00:00.254856+00:00', scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 8, resets_at: '2026-09-26T01:00:00.254877+00:00', scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: 13, resets_at: '2026-09-26T01:00:00.255062+00:00', scope: { model: { id: null, display_name: 'Fable' } } },
  ],
  spend: {
    used: { amount_minor: 720, currency: 'USD', exponent: 2 },
    limit: { amount_minor: 3000, currency: 'USD', exponent: 2 },
    percent: 24, enabled: true, can_toggle: false,
  },
}

const codexPayload = {
  user_id: 'user-fixture', account_id: 'account-fixture', email: 'someone@example.com', plan_type: 'pro',
  rate_limit: {
    allowed: true,
    // The live account's *primary* window is weekly, not a session.
    primary_window: { used_percent: 94, limit_window_seconds: 604_800, reset_after_seconds: 263_788, reset_at: 1_790_411_263 },
    secondary_window: null,
  },
  credits: { has_credits: false, unlimited: false, balance: '0' },
  rate_limit_reset_credits: { available_count: 1 },
}

// Every fixture writes its own Hermes auth store, so a test never reads (or
// depends on) the credentials of whoever runs it.
function credentialFixture(overrides: { claude?: unknown; codex?: unknown; pool?: unknown[]; store?: unknown } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wizard-ai-usage-'))
  const claudePath = join(dir, 'claude-credentials.json')
  const codexPath = join(dir, 'codex-auth.json')
  const hermesPath = join(dir, 'hermes-auth.json')
  writeFileSync(claudePath, JSON.stringify(overrides.claude ?? {
    claudeAiOauth: { accessToken: CLAUDE_TOKEN, expiresAt: NOW + 3_600_000, subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
  }))
  writeFileSync(codexPath, JSON.stringify(overrides.codex ?? { tokens: { access_token: CODEX_TOKEN, account_id: 'account-fixture' } }))
  writeFileSync(hermesPath, JSON.stringify({
    version: 1,
    credential_pool: overrides.pool ? { 'openai-codex': overrides.pool } : {},
    providers: overrides.store ? { 'openai-codex': { tokens: overrides.store } } : {},
  }))
  return { claudeCredentialsPath: claudePath, codexAuthPath: codexPath, hermesAuthPath: hermesPath, hermesGlobalAuthPath: '' }
}

const poolRow = (token: string, extra: Record<string, unknown> = {}) => ({
  id: `row-${String(extra.priority ?? 0)}`, label: 'device_code', auth_type: 'oauth', source: 'device_code',
  priority: 0, access_token: token, base_url: 'https://chatgpt.com/backend-api/codex', ...extra,
})

const bearer = (call: unknown[]) => String((call[1] as { headers: Record<string, string> }).headers.Authorization)

const jsonResponse = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

function reader(options: Record<string, unknown> = {}, fetchImpl?: ReturnType<typeof vi.fn>) {
  const fetcher = fetchImpl ?? vi.fn(async (url: string) => jsonResponse(String(url).includes('anthropic') ? claudePayload : codexPayload))
  const usage = createAiUsageReader({
    ...credentialFixture(),
    anthropicUsageUrl: 'https://api.anthropic.example/api/oauth/usage',
    codexUsageUrl: 'https://chatgpt.example/backend-api/wham/usage',
    fetchImpl: fetcher as unknown as typeof fetch,
    now: () => NOW,
    ...options,
  })
  return { usage, fetcher }
}

const provider = (snapshot: { providers: Array<Record<string, unknown>> }, id: string) => snapshot.providers.find((entry) => entry.id === id) as Record<string, any>

describe('AI usage provider reads', () => {
  it('renders every labelled Claude window, including a model-scoped one legacy fields omit', async () => {
    const { usage } = reader()
    const claude = provider(await usage.read() as never, 'claude')

    expect(claude.status).toBe('ok')
    expect(claude.plan).toBe('Max 20x')
    expect(claude.limits.map((limit: Record<string, unknown>) => [limit.label, limit.remainingPercent])).toEqual([
      ['Session', 99],
      ['All models · weekly', 92],
      ['Fable · weekly', 87],
    ])
    expect(claude.limits[2].resetsAt).toBe('2026-09-26T01:00:00.255Z')
  })

  it('reads a legacy payload truthfully: utilization is a percentage, not a fraction', async () => {
    const legacy = { ...claudePayload, limits: [], spend: undefined }
    const fetcher = vi.fn(async (url: string) => jsonResponse(String(url).includes('anthropic') ? legacy : codexPayload))
    const { usage } = reader({}, fetcher)
    const claude = provider(await usage.read() as never, 'claude')

    expect(claude.limits.map((limit: Record<string, unknown>) => [limit.label, limit.remainingPercent])).toEqual([
      ['Session', 99],
      ['All models · weekly', 92],
    ])
    // The legacy extra_usage block reports the same minor units: $30.00, not $3000.
    expect(claude.paid).toMatchObject({ type: 'spend', usedMinor: 720, limitMinor: 3000, exponent: 2, currency: 'USD' })
  })

  it('reports paid extra usage as money, separately from the subscription windows', async () => {
    const { usage } = reader()
    const claude = provider(await usage.read() as never, 'claude')

    expect(claude.paid).toEqual({ type: 'spend', enabled: true, currency: 'USD', exponent: 2, usedMinor: 720, limitMinor: 3000, balanceMinor: null, unlimited: false })
    expect(claude.limits.some((limit: Record<string, unknown>) => String(limit.label).includes('Paid'))).toBe(false)
  })

  it('labels the Codex window by its real duration rather than its position', async () => {
    const { usage } = reader()
    const codex = provider(await usage.read() as never, 'codex')

    expect(codex.plan).toBe('Pro')
    expect(codex.limits).toEqual([{ id: 'primary_window', label: 'Weekly', usedPercent: 94, remainingPercent: 6, resetsAt: '2026-09-26T08:27:43.000Z' }])
    expect(codex.paid).toBeNull()
  })

  it('keeps an expired sign-in an honest unavailable state and makes no provider request', async () => {
    const fetcher = vi.fn(async () => jsonResponse(claudePayload))
    const fixture = credentialFixture({
      claude: { claudeAiOauth: { accessToken: CLAUDE_TOKEN, expiresAt: NOW - 1, subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } },
      codex: { tokens: { access_token: EXPIRED_CODEX_TOKEN } },
    })
    const { usage } = reader({ ...fixture }, fetcher)
    const snapshot = await usage.read() as never

    expect(provider(snapshot, 'claude')).toMatchObject({ status: 'unavailable', limits: [], paid: null, error: { code: 'expired' } })
    expect(provider(snapshot, 'codex')).toMatchObject({ status: 'unavailable', limits: [], error: { code: 'expired' } })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reports a missing sign-in as unknown, never as a full allowance', async () => {
    const fixture = credentialFixture({ claude: {}, codex: {} })
    const { usage, fetcher } = reader({ ...fixture })
    const snapshot = await usage.read() as never

    expect(provider(snapshot, 'claude')).toMatchObject({ status: 'unavailable', limits: [], error: { code: 'signed_out' } })
    expect(provider(snapshot, 'codex')).toMatchObject({ status: 'unavailable', limits: [], error: { code: 'signed_out' } })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('never exposes a credential, account, or contact detail to the client shape', async () => {
    const { usage } = reader()
    const serialized = JSON.stringify(await usage.read())

    for (const secret of [CLAUDE_TOKEN, CODEX_TOKEN, 'account-fixture', 'someone@example.com', 'user-fixture']) {
      expect(serialized).not.toContain(secret)
    }
  })
})

describe('ChatGPT subscriptions in the credential pool', () => {
  it('same account with different subjects remains separate; same principal grants dedupe', async () => {
    const alter = (sub: string) => {
      const claims = JSON.parse(Buffer.from(FIRST_TOKEN.split('.')[1], 'base64url').toString())
      claims.sub = sub
      return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
    }
    const {usage} = reader({...credentialFixture({pool:[poolRow(alter('person-a'),{id:'a',label:'CODEX'}),poolRow(alter('person-b'),{id:'b',label:'CODEX-2'}),poolRow(alter('person-a'),{id:'c',label:'CODEX-3'})]})})
    const out = await usage.read()
    expect(out.providers.filter(p=>/^codex/.test(p.id))).toHaveLength(2)
  })

  const codexPayloadFor = (remaining: number, resetAt: number, plan: string) => ({
    plan_type: plan,
    rate_limit: { primary_window: { used_percent: 100 - remaining, limit_window_seconds: 604_800, reset_at: resetAt } },
  })

  // Answers by the credential that asked, so a test can tell one subscription's
  // numbers from the other's.
  function poolFetcher(byToken: Record<string, unknown>) {
    return vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      if (String(url).includes('anthropic')) return jsonResponse(claudePayload)
      const token = String(init.headers.Authorization).replace('Bearer ', '')
      const payload = byToken[token]
      return payload === undefined ? jsonResponse({ error: 'unauthorized' }, 401) : jsonResponse(payload)
    })
  }

  const twoAccounts = {
    [FIRST_TOKEN]: codexPayloadFor(5, 1_790_411_263, 'pro'),
    [SECOND_TOKEN]: codexPayloadFor(48, 1_790_267_723, 'plus'),
  }

  it('reads both pooled subscriptions as separate accounts, each with its own windows', async () => {
    const fetcher = poolFetcher(twoAccounts)
    const { usage } = reader({ ...credentialFixture({ pool: [poolRow(FIRST_TOKEN), poolRow(SECOND_TOKEN, { id: 'row-1', priority: 1, label: 'openai-codex-oauth-2' })] }) }, fetcher)
    const snapshot = await usage.read() as never

    expect((snapshot as { providers: Array<Record<string, unknown>> }).providers.map((entry) => entry.id)).toEqual(['claude', 'codex', 'codex-2'])
    expect(provider(snapshot, 'codex')).toMatchObject({ name: 'ChatGPT 1', plan: 'Pro', status: 'ok' })
    expect(provider(snapshot, 'codex-2')).toMatchObject({ name: 'ChatGPT 2', plan: 'Plus', status: 'ok' })
    expect(provider(snapshot, 'codex').limits[0]).toMatchObject({ remainingPercent: 5, resetsAt: '2026-09-26T08:27:43.000Z' })
    expect(provider(snapshot, 'codex-2').limits[0]).toMatchObject({ remainingPercent: 48, resetsAt: '2026-09-24T16:35:23.000Z' })
    // Distinguishable without naming anyone: a tag, never an account id.
    expect(provider(snapshot, 'codex').accountTag).not.toBe(provider(snapshot, 'codex-2').accountTag)
    expect(fetcher.mock.calls.filter((call) => !String(call[0]).includes('anthropic')).map(bearer))
      .toEqual([`Bearer ${FIRST_TOKEN}`, `Bearer ${SECOND_TOKEN}`])
  })

  it('folds a CLI sign-in into the pooled account it belongs to, preferring the freshest copy', async () => {
    const stalePoolCopy = codexToken({ account: 'acct-first', issued: NOW - 86_400_000 })
    const fetcher = poolFetcher(twoAccounts)
    const fixture = credentialFixture({
      pool: [poolRow(stalePoolCopy), poolRow(SECOND_TOKEN, { id: 'row-1', priority: 1 })],
      codex: { tokens: { access_token: FIRST_TOKEN, account_id: 'acct-first' } },
      store: { access_token: stalePoolCopy },
    })
    const { usage } = reader({ ...fixture }, fetcher)
    const snapshot = await usage.read() as never

    expect((snapshot as { providers: unknown[] }).providers).toHaveLength(3)
    expect(provider(snapshot, 'codex')).toMatchObject({ status: 'ok', limits: [expect.objectContaining({ remainingPercent: 5 })] })
    expect(fetcher.mock.calls.map(bearer)).toContain(`Bearer ${FIRST_TOKEN}`)
    expect(fetcher.mock.calls.map(bearer)).not.toContain(`Bearer ${stalePoolCopy}`)
  })

  it('keeps one subscription readable when another one fails', async () => {
    const fetcher = poolFetcher({ [SECOND_TOKEN]: twoAccounts[SECOND_TOKEN] })
    const { usage } = reader({ ...credentialFixture({ pool: [poolRow(FIRST_TOKEN), poolRow(SECOND_TOKEN, { id: 'row-1', priority: 1 })] }) }, fetcher)
    const snapshot = await usage.read() as never

    expect(provider(snapshot, 'codex')).toMatchObject({ name: 'ChatGPT 1', status: 'unavailable', limits: [], error: { code: 'expired' } })
    // The failing one keeps its stable tag: that is the pointer to which real
    // subscription has to be signed in again.
    expect(provider(snapshot, 'codex').accountTag).toMatch(/^[0-9a-f]{6}$/)
    expect(provider(snapshot, 'codex').accountTag).not.toBe(provider(snapshot, 'codex-2').accountTag)
    expect(provider(snapshot, 'codex-2')).toMatchObject({ name: 'ChatGPT 2', status: 'ok' })
    expect(provider(snapshot, 'codex-2').limits[0].remainingPercent).toBe(48)
    expect(provider(snapshot, 'claude').status).toBe('ok')
  })

  it('never drops a configured subscription it cannot read', async () => {
    const fetcher = poolFetcher(twoAccounts)
    const { usage } = reader({ ...credentialFixture({ pool: [poolRow(''), poolRow(SECOND_TOKEN, { id: 'row-1', priority: 1 })] }) }, fetcher)
    const snapshot = await usage.read() as never

    expect((snapshot as { providers: unknown[] }).providers).toHaveLength(3)
    expect(provider(snapshot, 'codex')).toMatchObject({ status: 'unavailable', error: { code: 'signed_out' } })
    expect(provider(snapshot, 'codex-2').status).toBe('ok')
    expect(fetcher.mock.calls.map(bearer)).toEqual([`Bearer ${CLAUDE_TOKEN}`, `Bearer ${SECOND_TOKEN}`])
  })

  it('reads an expired pooled sign-in as expired without refreshing it', async () => {
    const fetcher = poolFetcher(twoAccounts)
    const expired = codexToken({ account: 'acct-first', expires: NOW - 1 })
    const fixture = credentialFixture({ pool: [poolRow(expired), poolRow(SECOND_TOKEN, { id: 'row-1', priority: 1 })] })
    const { usage } = reader({ ...fixture }, fetcher)
    const snapshot = await usage.read() as never

    expect(provider(snapshot, 'codex')).toMatchObject({ status: 'unavailable', error: { code: 'expired' } })
    expect(fetcher.mock.calls.map(bearer)).not.toContain(`Bearer ${expired}`)
    expect(JSON.parse(readFileSync(fixture.hermesAuthPath, 'utf8')).credential_pool['openai-codex'][0].access_token).toBe(expired)
  })

  it('picks up a subscription added to the pool, once the cache window passes', async () => {
    let clock = NOW
    const fetcher = poolFetcher(twoAccounts)
    const fixture = credentialFixture({ pool: [poolRow(FIRST_TOKEN)] })
    const { usage } = reader({ ...fixture, cacheMs: 60_000, now: () => clock }, fetcher)

    expect(((await usage.read()) as { providers: unknown[] }).providers).toHaveLength(2)

    const store = JSON.parse(readFileSync(fixture.hermesAuthPath, 'utf8'))
    store.credential_pool['openai-codex'].push(poolRow(SECOND_TOKEN, { id: 'row-1', priority: 1 }))
    writeFileSync(fixture.hermesAuthPath, JSON.stringify(store))
    expect(((await usage.read()) as { providers: unknown[] }).providers).toHaveLength(2)

    clock += 60_001
    const later = await usage.read() as never
    expect((later as { providers: unknown[] }).providers).toHaveLength(3)
    expect(provider(later, 'codex-2')).toMatchObject({ name: 'ChatGPT 2', status: 'ok' })
  })

  it('falls back to the Codex CLI sign-in when no pool is configured', async () => {
    const { usage } = reader({ ...credentialFixture() })
    const snapshot = await usage.read() as never

    expect((snapshot as { providers: Array<Record<string, unknown>> }).providers.map((entry) => entry.id)).toEqual(['claude', 'codex'])
    expect(provider(snapshot, 'codex').name).toBe('ChatGPT')
  })

  it('caches per account and coalesces the reads behind one window', async () => {
    const fetcher = poolFetcher(twoAccounts)
    const { usage } = reader({ ...credentialFixture({ pool: [poolRow(FIRST_TOKEN), poolRow(SECOND_TOKEN, { id: 'row-1', priority: 1 })] }), cacheMs: 60_000 }, fetcher)
    await Promise.all([usage.read(), usage.read()])
    await usage.read()

    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('never exposes a pooled credential or account id to the client shape', async () => {
    const fetcher = poolFetcher(twoAccounts)
    const { usage } = reader({ ...credentialFixture({ pool: [poolRow(FIRST_TOKEN), poolRow(SECOND_TOKEN, { id: 'row-1', priority: 1 })] }) }, fetcher)
    const serialized = JSON.stringify(await usage.read())

    for (const secret of [FIRST_TOKEN, SECOND_TOKEN, 'acct-first', 'acct-second', 'sub-acct-first']) {
      expect(serialized).not.toContain(secret)
    }
  })
})

describe('AI usage caching and failure handling', () => {
  it('coalesces concurrent reads and serves the cached read inside the window', async () => {
    const { usage, fetcher } = reader({ cacheMs: 60_000 })
    await Promise.all([usage.read(), usage.read()])
    await usage.read()

    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('refetches once the cache window passes', async () => {
    let clock = NOW
    const { usage, fetcher } = reader({ cacheMs: 60_000, now: () => clock })
    await usage.read()
    clock += 60_001
    await usage.read()

    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('keeps the last good read as clearly stale when the provider becomes unreachable', async () => {
    let clock = NOW
    let fail = false
    const fetcher = vi.fn(async (url: string) => {
      if (fail) throw new Error('network down')
      return jsonResponse(String(url).includes('anthropic') ? claudePayload : codexPayload)
    })
    const { usage } = reader({ cacheMs: 1, now: () => clock }, fetcher)
    const good = provider(await usage.read() as never, 'claude')
    fail = true
    clock += 120_000
    const stale = provider(await usage.read() as never, 'claude')

    expect(stale.status).toBe('stale')
    expect(stale.fetchedAt).toBe(good.fetchedAt)
    expect(stale.limits).toEqual(good.limits)
    expect(stale.error).toMatchObject({ code: 'unreachable' })
  })

  it('stops showing old numbers once the stale window is exhausted', async () => {
    let clock = NOW
    let fail = false
    const fetcher = vi.fn(async (url: string) => {
      if (fail) throw new Error('network down')
      return jsonResponse(String(url).includes('anthropic') ? claudePayload : codexPayload)
    })
    const { usage } = reader({ cacheMs: 1, staleLimitMs: 60_000, now: () => clock }, fetcher)
    await usage.read()
    fail = true
    clock += 120_000

    expect(provider(await usage.read() as never, 'claude')).toMatchObject({ status: 'unavailable', limits: [] })
  })

  it('treats a rejected provider request as expired auth without inventing windows', async () => {
    const fetcher = vi.fn(async (url: string) => String(url).includes('anthropic') ? jsonResponse({ error: 'unauthorized' }, 401) : jsonResponse(codexPayload))
    const { usage } = reader({}, fetcher)
    const claude = provider(await usage.read() as never, 'claude')

    expect(claude).toMatchObject({ status: 'unavailable', limits: [], error: { code: 'expired' } })
    expect(claude.error.message).toContain('expired')
  })
})

// apps.json as the App Manager writes it, with one AI connection app per provider.
function connectionApp(id: string, port: number, provides: string[], extra: Record<string, unknown> = {}) {
  return {
    id, name: id === 'claude' ? 'Claude' : 'ChatGPT', status: 'running', provides,
    mcp: { url: `http://127.0.0.1:${port}/mcp`, internal: `http://${id}:${port}/mcp` },
    view: { url: `https://box.example/${id}/`, local: `http://127.0.0.1:${port}/` },
    health: `http://127.0.0.1:${port}/health`,
    ...extra,
  }
}

function appsJson(apps: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'wizard-ai-apps-'))
  const path = join(dir, 'apps.json')
  writeFileSync(path, JSON.stringify({ apps }))
  return path
}

const connectedClaude = {
  contract: 'wizard.ai-connection/1', provider: 'claude', name: 'Claude', status: 'connected', plan: 'Max 20x', account: 'owner@example.com',
  usage: {
    fetchedAt: '2026-09-23T07:10:30.000Z',
    limits: [{ id: 'weekly_all:weekly', label: 'All models · weekly', usedPercent: 12, remainingPercent: 88, resetsAt: '2026-09-26T01:00:00.000Z' }],
    paid: { type: 'spend', enabled: true, currency: 'USD', exponent: 2, usedMinor: 720, limitMinor: 3000, balanceMinor: null, unlimited: false },
  },
  error: null,
}

const CLAUDE_APP_URL = 'http://127.0.0.1:8811/api/connection'

describe('AI connection apps', () => {
  const claudeApp = connectionApp('claude', 8811, ['ai-connection', 'claude-subscription'])

  it('derives the connection URL from the app\'s own address, never from anything else', () => {
    expect(aiConnectionUrl(claudeApp)).toBe(CLAUDE_APP_URL)
    expect(aiConnectionUrl(claudeApp, 'internal')).toBe('http://claude:8811/api/connection')
    expect(aiConnectionUrl({ ...claudeApp, view: { local: 'http://evil.example/' }, health: 'http://evil.example/health' })).toBe('')
    expect(aiConnectionUrl({ ...claudeApp, mcp: { internal: 'http://other-app:8811/mcp' } }, 'internal')).toBe('')
    expect(aiConnectionApps({ apps: [claudeApp, { ...claudeApp, id: 'stopped', status: 'exited' }, connectionApp('notes', 9000, ['notes'])] }))
      .toEqual([{ appId: 'claude', provider: 'claude', name: 'Claude', url: CLAUDE_APP_URL }])
  })

  it('reads a connected app with usage as the provider row, keeping the shell\'s shape', async () => {
    const fetcher = vi.fn(async (url: string) => jsonResponse(url === CLAUDE_APP_URL ? connectedClaude : codexPayload))
    const { usage } = reader({ appsJsonPath: appsJson([claudeApp]) }, fetcher)
    const claude = provider(await usage.read() as never, 'claude')

    expect(claude).toEqual({
      id: 'claude', name: 'Claude', status: 'ok', plan: 'Max 20x', fetchedAt: '2026-09-23T07:10:30.000Z',
      limits: [{ id: 'weekly_all:weekly', label: 'All models · weekly', usedPercent: 12, remainingPercent: 88, resetsAt: '2026-09-26T01:00:00.000Z' }],
      paid: { type: 'spend', enabled: true, currency: 'USD', exponent: 2, usedMinor: 720, limitMinor: 3000, balanceMinor: null, unlimited: false },
      error: null,
    })
    expect(JSON.stringify(claude)).not.toContain('owner@example.com')
    const call = fetcher.mock.calls.find((entry) => entry[0] === CLAUDE_APP_URL) as unknown[]
    expect(call[1]).toMatchObject({ redirect: 'error' })
    expect(JSON.stringify(call[1])).not.toContain('Authorization')
  })

  it('reports a not-connected app as unavailable with the app\'s own message', async () => {
    const notConnected = { contract: 'wizard.ai-connection/1', provider: 'claude', name: 'Claude', status: 'not_connected', plan: null, account: null, usage: null, error: { code: 'signed_out', message: 'Claude is not connected. Open the Claude app to connect.' } }
    const fetcher = vi.fn(async (url: string) => jsonResponse(url === CLAUDE_APP_URL ? notConnected : codexPayload))
    const { usage } = reader({ appsJsonPath: appsJson([claudeApp]) }, fetcher)

    expect(provider(await usage.read() as never, 'claude')).toEqual({
      id: 'claude', name: 'Claude', status: 'unavailable', plan: null, fetchedAt: null, limits: [], paid: null,
      error: { code: 'signed_out', message: 'Claude is not connected. Open the Claude app to connect.' },
    })
  })

  it('keeps the last good read for under 30 minutes when the app becomes unreachable', async () => {
    let clock = NOW
    let down = false
    const fetcher = vi.fn(async (url: string) => {
      if (url === CLAUDE_APP_URL && down) throw new TypeError('fetch failed')
      return jsonResponse(url === CLAUDE_APP_URL ? connectedClaude : codexPayload)
    })
    const { usage } = reader({ appsJsonPath: appsJson([claudeApp]), cacheMs: 1, now: () => clock }, fetcher)
    const good = provider(await usage.read() as never, 'claude')
    down = true
    clock += 29 * 60_000
    const stale = provider(await usage.read() as never, 'claude')

    expect(stale).toMatchObject({ status: 'stale', limits: good.limits, fetchedAt: good.fetchedAt, error: { code: 'unreachable' } })
    clock += 2 * 60_000
    expect(provider(await usage.read() as never, 'claude')).toMatchObject({ status: 'unavailable', limits: [], error: { code: 'unreachable' } })
  })

  it('suppresses the host Claude reader when a Claude connection app is installed', async () => {
    const fetcher = vi.fn(async (url: string) => jsonResponse(url === CLAUDE_APP_URL ? connectedClaude : codexPayload))
    const { usage } = reader({ appsJsonPath: appsJson([claudeApp]) }, fetcher)
    const snapshot = await usage.read() as { providers: Array<Record<string, unknown>> }

    expect(snapshot.providers.map((entry) => entry.id)).toEqual(['codex', 'claude'])
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes('anthropic'))).toBe(false)
    expect(fetcher.mock.calls.map(bearer).some((value) => value.includes(CLAUDE_TOKEN))).toBe(false)
  })

  it('suppresses the host ChatGPT readers when a ChatGPT connection app is installed', async () => {
    const chatgptApp = connectionApp('chatgpt', 8812, ['ai-connection', 'chatgpt-subscription'])
    const fetcher = vi.fn(async (url: string) => String(url).includes('anthropic') ? jsonResponse(claudePayload)
      : jsonResponse({ contract: 'wizard.ai-connection/1', provider: 'chatgpt', name: 'ChatGPT', status: 'expired', plan: 'Pro', usage: null, error: null }))
    const { usage } = reader({ appsJsonPath: appsJson([chatgptApp]) }, fetcher)
    const snapshot = await usage.read() as { providers: Array<Record<string, any>> }

    expect(snapshot.providers.map((entry) => entry.id)).toEqual(['claude', 'chatgpt'])
    expect(provider(snapshot, 'chatgpt')).toMatchObject({ status: 'unavailable', plan: 'Pro', error: { code: 'expired' } })
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes('wham'))).toBe(false)
  })

  it('keeps the host ChatGPT usage behind a connected ChatGPT app that reports usage: null', async () => {
    const chatgptApp = connectionApp('chatgpt', 8812, ['ai-connection', 'chatgpt-subscription'])
    const fetcher = vi.fn(async (url: string) => String(url).includes('anthropic') ? jsonResponse(claudePayload)
      : String(url).includes('wham') ? jsonResponse(codexPayload)
      : jsonResponse({ contract: 'wizard.ai-connection/1', provider: 'chatgpt', name: 'ChatGPT', status: 'connected', plan: null, account: null, usage: null, error: null }))
    const { usage } = reader({ appsJsonPath: appsJson([chatgptApp]) }, fetcher)
    const snapshot = await usage.read() as { providers: Array<Record<string, any>> }
    const hostOnly = provider(await reader().usage.read() as never, 'codex')

    // One ChatGPT row, under the app's id and name, carrying the host reader's usage exactly.
    expect(snapshot.providers.map((entry) => entry.id)).toEqual(['claude', 'chatgpt'])
    const chatgpt = provider(snapshot, 'chatgpt')
    expect(chatgpt).toMatchObject({ status: 'ok', name: 'ChatGPT', error: null })
    expect(chatgpt.limits).toEqual(hostOnly.limits)
    expect(chatgpt.paid).toEqual(hostOnly.paid)
    expect(chatgpt.plan).toBe(hostOnly.plan)
    expect(chatgpt.limits.length).toBeGreaterThan(0)
  })

  it('keeps the ChatGPT app\'s own row when it reports usage: null and the host has no ChatGPT sign-in', async () => {
    const chatgptApp = connectionApp('chatgpt', 8812, ['ai-connection', 'chatgpt-subscription'])
    const fetcher = vi.fn(async (url: string) => String(url).includes('anthropic') ? jsonResponse(claudePayload)
      : String(url).includes('wham') ? jsonResponse({}, 401)
      : jsonResponse({ contract: 'wizard.ai-connection/1', provider: 'chatgpt', name: 'ChatGPT', status: 'connected', plan: 'Plus', account: null, usage: null, error: null }))
    const { usage } = reader({ ...credentialFixture({ pool: [] }), codexAuthPath: '/nonexistent/auth.json', appsJsonPath: appsJson([chatgptApp]) }, fetcher)
    const snapshot = await usage.read() as { providers: Array<Record<string, any>> }

    expect(snapshot.providers.map((entry) => entry.id)).toEqual(['claude', 'chatgpt'])
    expect(provider(snapshot, 'chatgpt')).toMatchObject({ status: 'ok', plan: 'Plus', limits: [], paid: null, error: null })
  })

  it('keeps the host readers unchanged when there is no apps.json', async () => {
    const withoutApps = reader({ appsJsonPath: join(mkdtempSync(join(tmpdir(), 'wizard-no-apps-')), 'apps.json') })
    const baseline = reader()
    const a = await withoutApps.usage.read()
    const b = await baseline.usage.read()

    expect(a).toEqual(b)
    expect((a as { providers: Array<Record<string, unknown>> }).providers.map((entry) => entry.id)).toEqual(['claude', 'codex'])
    expect(withoutApps.fetcher.mock.calls.map((call) => call[0])).toEqual(baseline.fetcher.mock.calls.map((call) => call[0]))
  })

  it('picks up a newly installed connection app once the cache window passes', async () => {
    let clock = NOW
    const path = appsJson([])
    const fetcher = vi.fn(async (url: string) => jsonResponse(url === CLAUDE_APP_URL ? connectedClaude : String(url).includes('anthropic') ? claudePayload : codexPayload))
    const { usage } = reader({ appsJsonPath: path, cacheMs: 60_000, now: () => clock }, fetcher)
    expect(provider(await usage.read() as never, 'claude').plan).toBe('Max 20x')
    expect(fetcher.mock.calls.some((call) => call[0] === CLAUDE_APP_URL)).toBe(false)
    writeFileSync(path, JSON.stringify({ apps: [claudeApp] }))
    clock += 60_001
    await usage.read()

    expect(fetcher.mock.calls.some((call) => call[0] === CLAUDE_APP_URL)).toBe(true)
  })

  it('refuses a response that is not the connection contract', async () => {
    const fetcher = vi.fn(async (url: string) => jsonResponse(url === CLAUDE_APP_URL ? { status: 'connected', usage: connectedClaude.usage } : codexPayload))
    const { usage } = reader({ appsJsonPath: appsJson([claudeApp]) }, fetcher)

    expect(provider(await usage.read() as never, 'claude')).toMatchObject({ status: 'unavailable', limits: [], error: { code: 'provider_error' } })
  })
})

const servers: ReturnType<typeof createWizardServer>[] = []
afterEach(async () => { await Promise.all(servers.map((server) => new Promise<void>((done) => server.close(() => done())))); servers.length = 0 })

async function endpoint(requireAccess = false) {
  const { usage } = reader()
  const server = createWizardServer({ requireAccess, accessVerifier: async () => false, aiUsageReader: usage, archivedSessionReader: () => [] })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  return `http://127.0.0.1:${address.port}/wizard/ai-usage`
}

describe('AI usage HTTP boundary', () => {
  it('serves the normalized snapshot to an authorized reader', async () => {
    const response = await fetch(await endpoint())
    const snapshot = await response.json() as { providers: Array<Record<string, unknown>> }

    expect(response.status).toBe(200)
    expect(snapshot.providers.map((entry) => entry.id)).toEqual(['claude', 'codex'])
    expect(JSON.stringify(snapshot)).not.toContain(CLAUDE_TOKEN)
  })

  it('keeps the existing Access boundary', async () => {
    const response = await fetch(await endpoint(true))

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'access_required' })
  })

  it('ignores query input: the client cannot steer the provider read', async () => {
    const url = await endpoint()
    const steered = await fetch(`${url}?url=https://attacker.example/usage&path=/etc/passwd`)

    expect(steered.status).toBe(200)
    expect((await steered.json() as { providers: unknown[] }).providers).toHaveLength(2)
  })

  it('rejects writes to the read-only usage route', async () => {
    const response = await fetch(await endpoint(), { method: 'POST' })

    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})
