import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyRunError, runErrorOf } from '../server/run-error.mjs'

// Synthetic, digit-free fixtures are assembled rather than written as credential literals.
// Assertions report booleans and family names so a failure never prints fixture secrets.
const credentials = [
  ['OpenAI sk', ['sk', '-', 'A'.repeat(40)].join('')],
  ['OpenAI rk', ['rk', '-', 'B'.repeat(40)].join('')],
  ['OpenAI pk', ['pk', '-', 'C'.repeat(40)].join('')],
  ['OpenAI session', ['sess', '-', 'D'.repeat(40)].join('')],
  ['Google', ['AI', 'za', 'E'.repeat(35)].join('')],
  ['GitHub classic', ['ghp', '_', 'F'.repeat(36)].join('')],
  ['GitHub OAuth', ['gho', '_', 'Q'.repeat(36)].join('')],
  ['GitHub user', ['ghu', '_', 'R'.repeat(36)].join('')],
  ['GitHub server', ['ghs', '_', 'S'.repeat(36)].join('')],
  ['GitHub refresh', ['ghr', '_', 'T'.repeat(36)].join('')],
  ['GitHub fine-grained', ['github', '_pat_', 'G'.repeat(50)].join('')],
  ['JWT', [['eyJ', 'H'.repeat(20)].join(''), 'J'.repeat(30), 'K'.repeat(30)].join('.')],
]

function assertRedacted(result, secret, name, preserveExplanation = true) {
  assert.ok(result && typeof result.message === 'string', `${name}: expected a classified message`)
  assert.equal(result.message.includes(secret), false, `${name}: credential must be removed`)
  assert.equal(result.message.includes('[redacted]'), true, `${name}: expected redaction marker`)
  if (preserveExplanation) assert.equal(result.message.includes('retry later'), true, `${name}: surrounding explanation must survive`)
  assert.ok(result.message.length <= 200, `${name}: message must remain bounded`)
}

for (const [name, secret] of credentials) {
  test(`redacts digit-free ${name} credentials from trusted message sources`, () => {
    assert.equal(/\d/.test(secret), false, 'fixture must exercise digit-free redaction')
    const raw = `HTTP 500: refused ${secret}; retry later`
    const payloads = [
      { status: 'failed', error: raw },
      { status: 'failed', error: { message: raw } },
      { status: 'failed', error: 'Run failed', output: `Your request was not processed. Provider said: ${raw}` },
      { status: 'failed', error: 'Run failed', final_response: { message: `Provider said: ${raw}` } },
    ]
    for (const payload of payloads) {
      const result = classifyRunError(payload)
      assert.equal(result?.code, 'unknown', `${name}: provider status must survive`)
      assertRedacted(result, secret, name)
    }
  })
}

test('redacts digit-free recognized credentials preceded by id_', () => {
  for (const [name, secret] of credentials) {
    const result = classifyRunError({ status: 'failed', error: `HTTP 500: refused id_${secret}; retry later` })
    assertRedacted(result, secret, name)
    assert.equal(result.message, 'HTTP 500: refused id_[redacted]; retry later', `${name}: underscore must allow prefix recognition`)
  }
})

test('preserves mixed-character fallback redaction', () => {
  const secret = ['opaque', 'L'.repeat(20), '7', 'M'.repeat(20)].join('')
  assertRedacted(classifyRunError({ status: 'failed', error: `HTTP 500: refused ${secret}; retry later` }), secret, 'mixed fallback')
})

test('redacts label values in JSON, colon and quoted equals formats', () => {
  const secret = ['Unprinted', 'N'.repeat(48)].join('')
  for (const label of ['key', 'token', 'secret', 'password', 'api_key', 'access_token', 'client_secret', 'key provided']) {
    const formats = [
      ['JSON', JSON.stringify({ [label]: secret })],
      ['colon', `${label}: ${secret}`],
      ['quoted equals', `${label} = '${secret}'`],
    ]
    for (const [format, value] of formats) {
      const result = classifyRunError({ status: 'failed', error: `HTTP 500: refused ${value}; retry later` })
      assertRedacted(result, secret, `${label} ${format}`)
    }
  }
})

for (const quote of ['"', "'"]) {
  for (const depth of [1, 2, 3]) {
    test(`redacts ${quote === '"' ? 'double' : 'single'}-quoted labelled passwords through ${depth} JSON layers`, () => {
      const fragments = ['alpha', 'beta', 'gamma']
      const secret = fragments.join(' ')
      let value = `password: ${quote}${secret}${quote}`
      let expected = `password: ${quote}[redacted]${quote}`
      for (let layer = 0; layer < depth; layer++) {
        value = JSON.stringify({ message: value, reason: 'busy' })
        expected = JSON.stringify({ message: expected, reason: 'busy' })
      }
      const raw = `HTTP 500: ${value}; retry later`
      const payloads = [
        { status: 'failed', error: raw },
        { status: 'failed', error: { message: raw } },
        { status: 'failed', error: 'Run failed', output: `Provider said: ${raw}` },
        { status: 'failed', error: 'Run failed', final_response: { message: `Provider said: ${raw}` } },
      ]
      for (const payload of payloads) {
        const result = classifyRunError(payload)
        assert.equal(result?.code, 'unknown', 'provider status must survive')
        assertRedacted(result, secret, 'JSON labelled password')
        for (const fragment of fragments) {
          assert.equal(result.message.includes(fragment), false, 'no password fragment may survive')
        }
        assert.equal(result.message === `HTTP 500: ${expected}; retry later`, true, 'JSON fields and outside explanation must survive')
        assert.deepEqual(classifyRunError({ status: 'failed', error: result.message }), result, 'label redaction must remain idempotent')
      }
    })
  }
}

test('preserves decoded unquoted label markers across JSON passes', () => {
  const secret = ['alpha', 'beta', 'gamma'].join('')
  const value = JSON.stringify({ message: `password: ${secret}`, reason: 'busy' })
  const result = classifyRunError({ status: 'failed', error: `HTTP 500: ${value}; retry later` })
  assertRedacted(result, secret, 'JSON unquoted label')
  assert.equal(result.message === 'HTTP 500: {"message":"password: [redacted]","reason":"busy"}; retry later', true, 'redaction markers must not gain trailing brackets')
  assert.deepEqual(classifyRunError({ status: 'failed', error: result.message }), result)
})

test('redacts entire long quoted values before applying the message bound', () => {
  const secret = ['HiddenBeginning', ' private words "with quotes" and \\ escapes '.repeat(30), 'HiddenEnd'].join('')
  const formats = [
    JSON.stringify({ password: secret }),
    `secret: '${secret}'`,
    `token: ${JSON.stringify(secret)}`,
  ]
  for (const value of formats) {
    const result = classifyRunError({ status: 'failed', error: `HTTP 500: refused ${value}; retry later` })
    assertRedacted(result, secret, 'long quoted label')
    for (const fragment of ['HiddenBeginning', 'private words', 'HiddenEnd']) {
      assert.equal(result.message.includes(fragment), false, 'no fragment of the quoted value may survive')
    }
  }
})

test('redacts Bearer values, including JSON and quoted values', () => {
  const secret = ['UnprintedBearer', 'P'.repeat(48)].join('')
  const formats = [
    `Bearer ${secret}`,
    `bearer ${secret}`,
    JSON.stringify({ Authorization: `Bearer ${secret}` }),
    `Bearer "${secret}"`,
  ]
  for (const value of formats) {
    assertRedacted(classifyRunError({ status: 'failed', error: `HTTP 500: refused ${value}; retry later` }), secret, 'Bearer')
  }
})

test('redacts JSON Authorization Bearer values wrapped in either quote form', () => {
  const secret = ['Opaque', 'A'.repeat(40)].join('')
  assert.equal(/\d/.test(secret), false, 'fixture must exercise digit-free redaction')
  for (const quote of ['"', "'"]) {
    const value = JSON.stringify({ Authorization: `Bearer ${quote}${secret}${quote}` })
    const raw = `HTTP 500: refused ${value}; retry later`
    const payloads = [
      { status: 'failed', error: raw },
      { status: 'failed', error: { message: raw } },
      { status: 'failed', error: 'Run failed', output: `Provider said: ${raw}` },
      { status: 'failed', error: 'Run failed', final_response: { message: `Provider said: ${raw}` } },
    ]
    for (const payload of payloads) {
      const result = classifyRunError(payload)
      assert.equal(result?.code, 'unknown', 'provider status must survive')
      assertRedacted(result, secret, 'JSON quoted Bearer')
      assert.equal(result.message.includes('Opaque'), false, 'credential prefix must be removed')
      assert.equal(result.message.includes('A'.repeat(8)), false, 'credential suffix must be removed')
      assert.equal(result.message === 'HTTP 500: refused {"Authorization":"Bearer [redacted]"}; retry later', true, 'JSON boundaries and surrounding explanation must survive')
    }
  }
})

test('redacts escaped quoted Bearer values containing spaces and interior quotes', () => {
  for (const quote of ['"', "'"]) {
    const secret = ['HiddenBeginning', ' private words ', `\\${quote}inner words\\${quote}`, ' HiddenEnd'].join('')
    assert.equal(/\d/.test(secret), false, 'fixture must exercise digit-free redaction')
    const quoted = `Bearer ${quote}${secret}${quote}`
    const escaped = `Bearer \\${quote}${secret}\\${quote}`
    const formats = [
      [quoted, 'Bearer [redacted]', true],
      [escaped, 'Bearer [redacted]', false],
      [JSON.stringify({ Authorization: quoted }), '{"Authorization":"Bearer [redacted]"}', true],
      [JSON.stringify({ Authorization: escaped }), '{"Authorization":"Bearer [redacted]"}', true],
    ]
    for (const [value, expected, preserveExplanation] of formats) {
      const result = classifyRunError({ status: 'failed', error: `HTTP 500: refused ${value}; retry later` })
      assertRedacted(result, secret, 'escaped quoted Bearer', preserveExplanation)
      for (const fragment of ['HiddenBeginning', 'private words', 'inner words', 'HiddenEnd']) {
        assert.equal(result.message.includes(fragment), false, 'no fragment of the quoted credential may survive')
      }
      const suffix = preserveExplanation ? '; retry later' : ''
      assert.equal(result.message === `HTTP 500: refused ${expected}${suffix}`, true, 'explanation preservation must follow the JSON or raw input boundary')
    }
  }
})

test('redacts long serialized quoted Bearer values before truncation', () => {
  for (const quote of ['"', "'"]) {
    const secret = ['HiddenBeginning', ' private words '.repeat(40), 'HiddenEnd'].join('')
    const value = JSON.stringify({ Authorization: `Bearer ${quote}${secret}${quote}`, reason: 'busy' })
    const result = classifyRunError({ status: 'failed', error: `HTTP 500: refused ${value}; retry later` })
    assertRedacted(result, secret, 'long JSON quoted Bearer')
    for (const fragment of ['HiddenBeginning', 'private words', 'HiddenEnd']) {
      assert.equal(result.message.includes(fragment), false, 'no fragment may survive before the message bound')
    }
    assert.equal(result.message === 'HTTP 500: refused {"Authorization":"Bearer [redacted]","reason":"busy"}; retry later', true, 'adjacent JSON fields and surrounding explanation must survive')
  }
})

test('conservatively redacts unterminated escaped quoted Bearer values', () => {
  const secret = ['HiddenBeginning', ' private words ', 'HiddenEnd'].join('')
  for (const quote of ['"', "'"]) {
    const result = classifyRunError({ status: 'failed', error: `HTTP 500: refused Bearer \\${quote}${secret}` })
    assert.equal(result?.code, 'unknown')
    assert.equal(result.message === 'HTTP 500: refused Bearer [redacted]', true, 'an unterminated escaped value must be consumed completely')
    for (const fragment of ['HiddenBeginning', 'private words', 'HiddenEnd']) {
      assert.equal(result.message.includes(fragment), false, 'no fragment of the unterminated credential may survive')
    }
  }
})

test('consumes unterminated escaped Bearer values with interior escaped quotes through the full credential suffix', () => {
  for (const quote of ['"', "'"]) {
    const secret = ['HiddenBeginning', ' private words ', `\\${quote}inner words\\${quote}`, ' HiddenEnd'].join('')
    assert.equal(/\d/.test(secret), false, 'fixture must exercise digit-free redaction')
    const result = classifyRunError({ status: 'failed', error: `HTTP 500: refused Bearer \\${quote}${secret}` })
    assert.equal(result?.code, 'unknown', 'provider status must survive')
    assertRedacted(result, secret, 'unterminated escaped Bearer with interior quotes', false)
    assert.equal(result.message === 'HTTP 500: refused Bearer [redacted]', true, 'interior escaped quotes must not establish a closing boundary')
    for (const fragment of ['HiddenBeginning', 'private words', 'inner words', 'HiddenEnd']) {
      assert.equal(result.message.includes(fragment), false, 'no fragment or suffix of the unterminated credential may survive')
    }
  }
})

test('preserves existing Bearer redaction markers on subsequent passes', () => {
  const formats = [
    'Bearer [redacted]',
    JSON.stringify({ Authorization: 'Bearer [redacted]', reason: 'busy' }),
  ]
  for (const value of formats) {
    const raw = `HTTP 500: refused ${value}; retry later`
    const first = classifyRunError({ status: 'failed', error: raw })
    assert.equal(first?.code, 'unknown')
    assert.equal(first.message, raw, 'generated markers and surrounding explanation must survive')
    const second = classifyRunError({ status: 'failed', error: first.message })
    assert.deepEqual(second, first, 'redaction must remain idempotent')
  }
})

test('redacts token: Bearer followed by a digit-free opaque value before label redaction', () => {
  const secret = ['OpaqueBearer', 'U'.repeat(48)].join('')
  assert.equal(/\d/.test(secret), false, 'fixture must exercise digit-free redaction')
  const result = classifyRunError({ status: 'failed', error: `HTTP 500: refused token: Bearer ${secret}; retry later` })
  assertRedacted(result, secret, 'labelled Bearer')
  assert.equal(result.message, 'HTTP 500: refused token: [redacted] [redacted]; retry later')
})

test('keeps ordinary error text useful and limits messages to 200 characters', () => {
  const raw = 'HTTP 503: DocumentationIdentifierWithOnlyLetters is unavailable.\n  Retry after a brief pause. ' + 'ordinary words '.repeat(30)
  const result = classifyRunError({ status: 'failed', error: raw })
  assert.equal(result?.code, 'unknown')
  assert.equal(result.message, raw.replace(/\s+/g, ' ').trim().slice(0, 200))
  assert.equal(result.message.length, 200)
})

const signInHints = [
  { prose: 'To configure the example, run codex login before continuing.', route: 'openai-codex', provider: 'chatgpt', app: 'wizard-chatgpt' },
  { prose: 'The documentation describes claude auth login as a setup step.', route: 'anthropic', provider: 'claude', app: 'wizard-claude' },
]

for (const field of ['output', 'final_response']) {
  test(`unmarked ${field} never supplies sign-out evidence`, () => {
    const failures = [
      ['Run failed', null],
      ['ECONNRESET: socket hang up', 'network'],
      ['HTTP 429: quota reached', 'provider_quota'],
      ['HTTP 402: payment required', 'provider_billing'],
      ['HTTP 503: service unavailable', 'unknown'],
    ]
    for (const hint of signInHints) {
      for (const structured of [false, true]) {
        for (const annotated of [false, true]) {
          for (const [error, expected] of failures) {
            const payload = {
              status: 'failed',
              runtime: { provider: hint.route },
              error,
              [field]: structured ? { message: hint.prose } : hint.prose,
            }
            if (annotated) {
              payload.wizard_reconnect = { kind: 'provider_signed_out', provider: hint.provider, app_id: hint.app }
            }
            const result = classifyRunError(payload)
            if (expected === null) {
              assert.equal(result, null, 'generic failure must stay unclassified')
            } else {
              assert.equal(result?.code, expected, 'partial prose or its annotation must not override error evidence')
              assert.equal(result.provider, hint.route)
              assert.equal(result.message, error)
            }
          }
        }
      }
    }
  })
}

test('filters both partial fields and ignores reconnect-only evidence without mutating the payload', () => {
  const payload = {
    status: 'failed',
    error: 'Run failed',
    output: signInHints[0].prose,
    final_response: signInHints[1].prose,
    wizard_reconnect: { kind: 'provider_signed_out', provider: 'chatgpt', app_id: 'wizard-chatgpt' },
  }
  const before = JSON.stringify(payload)
  assert.equal(classifyRunError(payload), null)
  assert.equal(JSON.stringify(payload), before)
  assert.equal(classifyRunError({ status: 'failed', wizard_reconnect: payload.wizard_reconnect }), null)
  assert.equal(classifyRunError({ status: 'failed', output: payload.output, final_response: payload.final_response }), null)
})

test('preserves genuine error auth, billing, quota, network and unknown classifications', () => {
  const cases = [
    ['HTTP 401: unauthorized', 'provider_auth'],
    ['HTTP 403: forbidden', 'provider_auth'],
    ['invalid_api_key', 'provider_auth'],
    [{ message: 'Failed to authenticate' }, 'provider_auth'],
    [{ type: 'authentication_error', detail: 'Credentials rejected' }, 'provider_auth'],
    ['HTTP 402: payment required', 'provider_billing'],
    ['insufficient_quota', 'provider_billing'],
    ['You exceeded your current quota', 'provider_billing'],
    ['subscription has expired', 'provider_billing'],
    ['HTTP 429: busy', 'provider_quota'],
    ['usage_limit_reached', 'provider_quota'],
    ['rate limit reached', 'provider_quota'],
    ['resource_exhausted', 'provider_quota'],
    ['ECONNRESET', 'network'],
    ['fetch failed', 'network'],
    [{ message: 'Service unavailable', status: 503 }, 'unknown'],
    ['Error code: 400 invalid request', 'unknown'],
  ]
  for (const [error, code] of cases) {
    const result = classifyRunError({ status: 'failed', runtime: { provider: 'openai' }, error })
    assert.equal(result?.code, code)
    assert.equal(result.provider, 'openai')
  }
})

test('preserves provider sign-out signals from the actual error and route fallback', () => {
  for (const [error, provider] of [
    ['codex_auth_expired', 'chatgpt'],
    [{ code: 'codex_refresh_failed' }, 'chatgpt'],
    ['Run codex login to restore your session', 'chatgpt'],
    ['ClaudeCodeLoggedOut', 'claude'],
    [{ detail: 'Run claude auth login to restore your session' }, 'claude'],
  ]) {
    const result = classifyRunError({ status: 'failed', error })
    assert.equal(result?.code, 'provider_auth')
    assert.equal(result.provider, provider)
  }
  assert.deepEqual(classifyRunError({ status: 'failed', error: 'invalid_grant' }, { provider: 'claude' }), {
    code: 'provider_auth', provider: 'claude', message: 'invalid_grant',
  })
})

test('preserves Hermes Provider said evidence in both output fields', () => {
  const cases = [
    ['ChatGPT rejected your sign-in', 'HTTP 401: token_expired', 'provider_auth'],
    ['Claude sign-in failed', 'Run claude auth login to restore your session', 'provider_auth'],
    ['Provider rejected the request', 'HTTP 402: payment required', 'provider_billing'],
    ['Provider rejected the request', 'HTTP 429: usage_limit_reached', 'provider_quota'],
    ['Provider request failed', 'ECONNRESET: socket hang up', 'network'],
    ['Provider request failed', 'HTTP 503: service unavailable', 'unknown'],
  ]
  for (const field of ['output', 'final_response']) {
    for (const structured of [false, true]) {
      for (const [prefix, said, code] of cases) {
        const copy = `${prefix}. Provider said: ${said}`
        const result = classifyRunError({
          status: 'failed',
          error: 'Your request was not processed',
          runtime: { provider: 'openai-codex' },
          [field]: structured ? { message: copy } : copy,
        })
        assert.deepEqual(result, { code, provider: 'openai-codex', message: said })
      }
    }
  }
})

test('keeps failed-only and preflight/recovery exclusions', () => {
  for (const status of ['completed', 'running', 'queued', 'cancelled', undefined]) {
    assert.equal(classifyRunError({ status, error: 'HTTP 401: codex_auth_expired' }), null)
  }
  for (const type of ['provider_preflight_failed', 'provider_recovery_failed']) {
    assert.equal(classifyRunError({
      status: 'failed',
      error: { type, message: 'HTTP 401: codex_auth_expired' },
      output: 'Provider said: HTTP 401: unauthorized',
      wizard_reconnect: { kind: 'provider_signed_out', provider: 'chatgpt', app_id: 'wizard-chatgpt' },
    }), null)
  }
  for (const payload of [null, undefined, 'failed', {}, { status: 'failed' }, { status: 'failed', error: 'Ordinary task failure' }]) {
    assert.equal(classifyRunError(payload), null)
  }
})

test('runErrorOf preserves compact classified fields and validates stored data', () => {
  const classified = classifyRunError({ status: 'failed', error: 'HTTP 429: quota reached', runtime: { provider: 'openai' } })
  assert.deepEqual(runErrorOf(classified), classified)
  for (const code of ['provider_auth', 'provider_billing', 'provider_quota', 'network', 'unknown']) {
    assert.deepEqual(runErrorOf({ code, provider: '  openai\n codex  ', message: '  Please\n retry  ', extra: true }), {
      code, provider: 'openai codex', message: 'Please retry',
    })
  }
  assert.deepEqual(runErrorOf({ code: 'network', provider: 'p'.repeat(80), message: 'm'.repeat(240) }), {
    code: 'network', provider: 'p'.repeat(60), message: 'm'.repeat(200),
  })
  assert.deepEqual(runErrorOf({ code: 'network', provider: {}, message: 42 }), { code: 'network', provider: '', message: '' })
  for (const value of [null, undefined, 'network', {}, { code: 'unsupported' }]) assert.equal(runErrorOf(value), null)
})
