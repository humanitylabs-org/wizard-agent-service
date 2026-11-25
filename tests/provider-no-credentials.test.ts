// Issue 615 (24 Nov 2026 outage): with the server's Claude login gone, stock Hermes v0.23 fails every turn in
// about a second and GET /v1/runs/<id> says only this (no `error`, no `runtime`, `usage: {}`): its translated
// gateway.errors.no_credentials copy as `output`. Nothing recognised it, so the phone showed "Not sent ·
// message saved" / Needs retry instead of the sign-in card. The run below is the exact shape read from stock
// Hermes v0.23 with no Claude sign-in (POST /v1/runs and the model-locked chat/stream give the same run).
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DurableRunQueue, queueRequestHash } from '../server/run-queue.mjs'
import { annotateProviderSignOut, classifyProviderSignOut, hermesNoCredentialsCopy } from '../server/provider-reconnect.mjs'
import { classifyRunError } from '../server/run-error.mjs'
import { listRow } from '../server/session-list-view.mjs'

// hermes-agent locales/*.yaml gateway.errors.no_credentials (a sample of the shipped languages).
const COPY: Record<string, string> = {
  en: "⚠️ I couldn't connect to the AI model service, so this message wasn't processed. Use /login to sign in again, or /model to pick a different model. If it keeps failing, run `hermes doctor` on the host.",
  de: '⚠️ Ich konnte keine Verbindung zum KI-Modelldienst herstellen, daher wurde diese Nachricht nicht verarbeitet. Verwenden Sie /login, um sich erneut anzumelden, oder /model, um ein anderes Modell zu wählen. Falls es weiterhin fehlschlägt, führen Sie `hermes doctor` auf dem Host aus.',
  fr: "⚠️ Je n'ai pas pu me connecter au service de modèle IA ; ce message n'a donc pas été traité. Utilisez /login pour vous reconnecter, ou /model pour choisir un autre modèle. Si l'échec persiste, lancez `hermes doctor` sur l'hôte.",
  ja: '⚠️ AI モデルサービスに接続できなかったため、このメッセージは処理されませんでした。/login で再度サインインするか、/model で別のモデルを選んでください。失敗が続く場合は、ホストで `hermes doctor` を実行してください。',
  zh: '⚠️ 我无法连接 AI 模型服务，因此这条消息未被处理。请使用 /login 重新登录，或用 /model 选择其他模型。如果持续失败，请在主机上运行 `hermes doctor`。',
  ar: '⚠️ تعذّر الاتصال بخدمة نموذج الذكاء الاصطناعي، لذا لم تُعالج هذه الرسالة. استخدم /login لتسجيل الدخول مجددًا، أو /model لاختيار نموذج آخر. إن استمرّ الفشل، شغّل `hermes doctor` على المضيف.',
}
// Exactly what stock Hermes v0.23 GET /v1/runs/<id> returned for the failed turn.
const noCredentialsRun = (output = COPY.en) => ({ object: 'hermes.run', model: 'claude-sonnet-4-5', created_at: 1795570677.27,
  pending_controls: [], run_id: 'run_aa42de79932542d2a1ff840566018237', status: 'failed', session_id: 's615c',
  admission_id: 'b131e3bae93c46438a815b830d819f83', execution_generation: 1, output, usage: {} })

describe('Hermes no-credentials copy', () => {
  it.each(Object.keys(COPY))('is recognised in %s', (lang) => {
    expect(hermesNoCredentialsCopy(noCredentialsRun(COPY[lang]))).toBe(true)
  })
  it('names the Claude app from the send route (Claude subscription and anthropic)', () => {
    for (const provider of ['anthropic', 'claude-subscription-directsdk-experimental'])
      expect(classifyProviderSignOut(noCredentialsRun(), { provider })).toMatchObject({ provider: 'claude', appId: 'wizard-claude' })
    expect(annotateProviderSignOut(noCredentialsRun(COPY.de), { provider: 'anthropic' }).wizard_reconnect)
      .toEqual({ kind: 'provider_signed_out', provider: 'claude', app_id: 'wizard-claude' })
  })
  it('names the ChatGPT app on a ChatGPT route', () => {
    expect(classifyProviderSignOut(noCredentialsRun(), { provider: 'openai-codex' })?.appId).toBe('wizard-chatgpt')
  })
  it('is provider_auth with the route, and provider_auth even when no route is known', () => {
    expect(classifyRunError(noCredentialsRun(), { provider: 'anthropic' })).toMatchObject({ code: 'provider_auth', provider: 'anthropic' })
    expect(classifyRunError(noCredentialsRun(COPY.ja))).toMatchObject({ code: 'provider_auth', provider: '' })
    // No connection app to name without a route: the plain reason still shows.
    expect(classifyProviderSignOut(noCredentialsRun())).toBeNull()
  })
  it('the gateway log wording counts too (No Anthropic credentials found / No usable credentials found / invalid_grant)', () => {
    const missing = "⚠️ Provider authentication failed: No Anthropic credentials found. Run 'hermes auth add anthropic' to sign in, or set ANTHROPIC_TOKEN / ANTHROPIC_API_KEY."
    expect(classifyProviderSignOut({ status: 'failed', error: missing })?.appId).toBe('wizard-claude')
    expect(classifyRunError({ status: 'failed', error: missing })?.code).toBe('provider_auth')
    expect(classifyProviderSignOut({ status: 'failed', error: "No usable credentials found for provider 'openai-codex'." }, { provider: 'openai-codex' })?.appId).toBe('wizard-chatgpt')
    expect(classifyRunError({ status: 'failed', error: "No usable credentials found for provider 'openai-codex'." }, { provider: 'openai-codex' })).toMatchObject({ code: 'provider_auth', provider: 'openai-codex' })
    expect(classifyProviderSignOut({ status: 'failed', error: 'Codex refresh token: invalid_grant' }, { provider: 'openai-codex' })?.appId).toBe('wizard-chatgpt')
  })
  it('never fires on an answer, a completed run, or the copy inside other text', () => {
    expect(classifyProviderSignOut({ ...noCredentialsRun(), status: 'completed' }, { provider: 'anthropic' })).toBeNull()
    expect(classifyRunError({ ...noCredentialsRun(), status: 'completed' })).toBeNull()
    const quoted = `Here is what Hermes says when it is signed out:\n\n${COPY.en}`
    expect(hermesNoCredentialsCopy(noCredentialsRun(quoted))).toBe(false)
    expect(classifyProviderSignOut(noCredentialsRun(quoted), { provider: 'anthropic' })).toBeNull()
    expect(classifyRunError(noCredentialsRun(quoted), { provider: 'anthropic' })).toBeNull()
    expect(hermesNoCredentialsCopy(noCredentialsRun('Use /login, then /model. Run `hermes doctor` on the host.'))).toBe(false)
  })
})

describe('run queue projection of the no-credentials run', () => {
  const dirs: string[] = [], queues: DurableRunQueue[] = []
  afterEach(async () => { for (const q of queues.splice(0)) q.close(); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })
  it('the thread row carries the Claude sign-in card fields and provider_auth (full and compact)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wizard-615-')); dirs.push(dir)
    const payload = noCredentialsRun()
    const q = new DurableRunQueue({ statePath: join(dir, 'q.sqlite3'), pollIntervalMs: 0, canDispatch: () => true, activeSessionIds: async () => [],
      launch: async () => ({ upstreamRunId: payload.run_id, payload: { status: 'running' } }), lookup: async () => ({ capacityStatus: 'failed', payload }) })
    queues.push(q)
    // The shell's send: model-locked on the chat's Claude route.
    const body = JSON.stringify({ session_id: 's615c', input: 'And on Saturday?', model: 'claude-sonnet-4-5', provider: 'anthropic', require_model_lock: true })
    await q.admit({ runtime: 'direct', sessionId: 's615c', idempotencyKey: 'send-615', requestHash: queueRequestHash('direct', body), body })
    await q.tick(true)
    for (const row of [q.latestProjections(['s615c'])[0], q.latestProjections()[0]]) {
      expect(row).toMatchObject({ status: 'failed', safeError: '',
        reconnect: { kind: 'provider_signed_out', provider: 'claude', app_id: 'wizard-claude' },
        runError: { code: 'provider_auth', provider: 'anthropic' } })
    }
    const compact = listRow({ id: 's615c', title: 'Plans', status: 'failed', message_count: 2,
      wizard_reconnect: { kind: 'provider_signed_out', provider: 'claude', app_id: 'wizard-claude', app_name: 'Claude', installed: true, app_status: 'connected' },
      wizard_last_run_error: { code: 'provider_auth', provider: 'anthropic', message: '' } }) as any
    expect(compact.reconnect).toMatchObject({ appId: 'wizard-claude' })
    expect(compact.runError).toMatchObject({ code: 'provider_auth', provider: 'anthropic' })
  })
})
