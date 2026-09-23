import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAiUsageReader } from '../server/ai-usage.mjs'
import { createWizardServer } from '../server/service.mjs'

const CLAUDE_TOKEN = 'sk-ant-oat-FIXTURE-CLAUDE-TOKEN'
const CODEX_TOKEN = `header.${Buffer.from(JSON.stringify({ exp: 4_102_444_800 })).toString('base64url')}.signature`
const EXPIRED_CODEX_TOKEN = `header.${Buffer.from(JSON.stringify({ exp: 1_000 })).toString('base64url')}.signature`
const NOW = Date.parse('2026-09-23T07:11:00.000Z')

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

function credentialFixture(overrides: { claude?: unknown; codex?: unknown } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wizard-ai-usage-'))
  const claudePath = join(dir, 'claude-credentials.json')
  const codexPath = join(dir, 'codex-auth.json')
  writeFileSync(claudePath, JSON.stringify(overrides.claude ?? {
    claudeAiOauth: { accessToken: CLAUDE_TOKEN, expiresAt: NOW + 3_600_000, subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
  }))
  writeFileSync(codexPath, JSON.stringify(overrides.codex ?? { tokens: { access_token: CODEX_TOKEN, account_id: 'account-fixture' } }))
  return { claudeCredentialsPath: claudePath, codexAuthPath: codexPath }
}

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
