import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { scene } from '../qa/agent-parity/fixture.mjs'
import { confirmedClaudePoolExhaustion, cooldownsBlockModel } from '../server/claude-cooldown-bridge.mjs'

const model = 'claude-opus-5-5'
const route = { provider: 'anthropic', model, require_model_lock: true }
const now = () => Date.now()
const grant = (id, reset = Date.now() / 1000 + 3600) => ({ id: id.repeat(24), models: { [model]: reset } })
const payload = () => ({ provider: 'claude', owner: 'hermes',
  modelCooldowns: { contract: 'wizard.model-cooldowns/1', observedAt: Date.now() / 1000,
    grants: [grant('a'), grant('b')] } })

function appRegistry(root) {
  const path = join(root, 'apps.json')
  writeFileSync(path, JSON.stringify({ apps: [{ id: 'wizard-claude', status: 'running',
    provides: ['ai-connection', 'claude-subscription'], mcp: { internal: 'http://wizard-claude:8799/mcp' } }] }))
  return path
}

test('exact model and fresh reset on every grant; ambiguous evidence fails open', () => {
  const good = payload()
  assert.equal(cooldownsBlockModel(good, model), true)
  for (const change of [
    p => { p.modelCooldowns.grants[1].models[model] = Date.now() / 1000 - 1 },
    p => { p.modelCooldowns.grants[1].models = { 'claude-sonnet-5-5': Date.now() / 1000 + 3600 } },
    p => { p.modelCooldowns.grants.push(grant('c')) },
    p => { p.modelCooldowns.grants[1].id = p.modelCooldowns.grants[0].id },
    p => { p.modelCooldowns.observedAt -= 60 },
    p => { p.modelCooldowns.grants[1].models[model] = '9999999999' },
    p => { delete p.modelCooldowns },
  ]) { const p = payload(); change(p); assert.equal(cooldownsBlockModel(p, model), false) }
})

test('production topology: /state lacks auth and Claude credentials; connector HTTP fast-fails saved run', async t => {
  let wire = payload(), connectorCalls = 0
  const s = await scene('main', ({ root }) => {
    const appsJsonPath = appRegistry(root)
    return { appsJsonPath, hermesHome: join(root, 'state'), appsMcpAddress: 'internal',
      fetchImpl: (url, init) => {
        if (String(url) === 'http://wizard-claude:8799/api/model-cooldowns') {
          connectorCalls++
          return Promise.resolve(new Response(JSON.stringify(wire), { headers: { 'Content-Type': 'application/json' } }))
        }
        return fetch(url, init)
      } }
  })
  t.after(() => s.close())
  assert.equal(existsSync(join(s.root, 'state', 'auth.json')), false)
  assert.equal(existsSync(join(s.root, '.claude', '.credentials.json')), false)
  const body = { session_id: 'wizard_parity', input: 'My saved original words', ...route }
  const send = (key, input = body) => s.request('/v1/runs', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input) })
  const start = Date.now()
  const accepted = await (await send('exhausted-opus')).json()
  assert.equal(accepted.status, 'failed')
  assert.equal(accepted.error.type, 'wizard_claude_pool_exhausted')
  assert.ok(Date.now() - start < 5000)
  assert.equal(connectorCalls, 1)
  assert.equal(s.runs.size, 0, 'no Hermes upstream generation')
  assert.equal((await (await send('exhausted-opus')).json()).run_id, accepted.run_id)
  assert.equal(connectorCalls, 1, 'idempotency replay does not recheck')
  const saved = await (await s.request(`/v1/runs/${accepted.run_id}`)).json()
  assert.match(saved.safe_error, /message is saved/i)
  wire = payload(); wire.modelCooldowns.grants[1].models[model] = Date.now() / 1000 - 1
  await s.restart()
  assert.equal((await (await s.request(`/v1/runs/${accepted.run_id}`)).json()).status, 'failed')
  const retry = await (await send('retry-saved', { ...body, wizard_retry_run_id: accepted.run_id })).json()
  assert.notEqual(retry.error?.type, 'wizard_claude_pool_exhausted')
  assert.equal(s.runs.size, 1, 'fresh reset allows normal locked upstream dispatch')
  const upstream = s.seen.find(x => x.path.endsWith('/chat/stream') && x.method === 'POST')?.body
  assert.equal(upstream?.model, model)
  assert.equal(upstream?.provider, 'anthropic')
  assert.equal(upstream?.message, body.input)
})

test('missing connector and alternate route never falsely block', async t => {
  const s = await scene('main', { claudePoolExhausted: async body => confirmedClaudePoolExhaustion(body, {
    appsJsonPath: '/state/no-apps.json', address: 'internal' }) })
  t.after(() => s.close())
  const response = await s.request('/v1/runs', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'no-bridge' },
    body: JSON.stringify({ session_id: 'wizard_parity', input: 'normal', ...route }) })
  assert.equal(response.status, 202)
  assert.notEqual((await response.json()).error?.type, 'wizard_claude_pool_exhausted')
})
