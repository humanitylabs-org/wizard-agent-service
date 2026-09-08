import { createServer } from 'node:http'

const json = (response, status, value, headers = {}) => {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length, ...headers })
  response.end(body)
}

async function body(request) {
  const parts = []
  for await (const chunk of request) parts.push(chunk)
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')
}

const iso = (offset = 0) => new Date(Date.now() + offset).toISOString()
const inputText = (input) => typeof input === 'string' ? input : Array.isArray(input) ? input.find((part) => part.type === 'text')?.text ?? '' : ''

export function createHermesFixture(options = {}) {
  let sessionSequence = 2
  let runSequence = 0
  const admissions = new Map()
  const runs = new Map()
  const clients = new Map()
  const timers = new Set()
  const longMessages = Array.from({ length: 180 }, (_, index) => ({
    id: `long-${index}`,
    role: index % 2 ? 'assistant' : 'user',
    content: index % 2 ? `A calm, useful answer for transcript item ${index}.` : `Question number ${index}`,
    created_at: iso(-180000 + index * 1000),
  }))
  const sessions = options.empty ? [] : [
    { id: 'chat-recent', title: 'Plan the quiet weekend', source: 'wizard-mobile', preview: '[Your active task list was preserved across context compression]\n- [>] private task', updated_at: iso(-60_000), model: 'fixture-capable' },
    { id: 'chat-long', title: 'Long project notes', source: 'webui', preview: 'The complete working history', updated_at: iso(-3_600_000), model: 'fixture-fast' },
  ]
  const messages = new Map([
    ['chat-recent', [
      { id: 'm-1', role: 'user', content: 'Help me plan a quiet weekend.', created_at: iso(-120_000) },
      { id: 'm-2', role: 'assistant', content: 'I found three gentle options close to home.', created_at: iso(-60_000) },
      { id: 'm-hidden', role: 'user', content: '', display_kind: 'hidden', created_at: iso(-40_000) },
      { id: 'm-delegation', role: 'user', content: '[ASYNC DELEGATION BATCH COMPLETE — deleg_fixture]\nInternal worker transcript', display_kind: 'async_delegation_complete', created_at: iso(-30_000) },
      { id: 'm-task-restore', role: 'user', content: '[Your active task list was preserved across context compression]\n- [>] private task', created_at: iso(-20_000) },
    ]],
    ['chat-long', longMessages],
  ])

  function emit(run, event, data = {}) {
    const list = messages.get(run.sessionId) ?? []
    if (event === 'tool.started') {
      const callId = `call-${run.id}-${(run.toolSequence ?? 0) + 1}`
      run.toolSequence = (run.toolSequence ?? 0) + 1
      run.activeToolCallId = callId
      list.push({ id: `assistant-${callId}`, role: 'assistant', content: '', tool_calls: [{ call_id: callId, function: { name: 'read_file', arguments: '{}' } }], created_at: iso() })
      messages.set(run.sessionId, list)
    }
    if ((event === 'tool.completed' || event === 'tool.failed') && run.activeToolCallId) {
      list.push({ id: `result-${run.activeToolCallId}`, role: 'tool', tool_call_id: run.activeToolCallId, content: '{"ok":true}', created_at: iso() })
      messages.set(run.sessionId, list)
      run.activeToolCallId = ''
    }
    const value = { event, run_id: run.id, ...data }
    run.events.push(value)
    for (const response of clients.get(run.id) ?? []) response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)
  }

  function later(callback, delay) {
    const timer = setTimeout(() => { timers.delete(timer); callback() }, delay)
    timers.add(timer)
  }

  function complete(run, output = 'Done. I kept the answer concise and useful.') {
    if (['completed', 'cancelled', 'failed'].includes(run.status)) return
    run.status = 'completed'
    run.output = output
    const list = messages.get(run.sessionId) ?? []
    if (!list.some((message) => message.id === `assistant-${run.id}`)) list.push({ id: `assistant-${run.id}`, role: 'assistant', content: output, created_at: iso() })
    messages.set(run.sessionId, list)
    const session = sessions.find((item) => item.id === run.sessionId)
    if (session) { session.preview = output; session.updated_at = iso() }
    emit(run, 'run.completed', { status: 'completed' })
    later(() => { for (const response of clients.get(run.id) ?? []) response.end(); clients.delete(run.id) }, 20)
  }

  function schedule(run) {
    if (run.scenario === 'markdown') {
      later(() => emit(run, 'message.delta', { delta: '## Markdown result\n\n- **Bold** item\n' }), 40)
      later(() => complete(run, '## Markdown result\n\n- **Bold** item\n- `code` item\n\n[Safe link](https://example.com)\n\n<script>window.fixtureUnsafe = true</script>'), 140)
      return
    }
    if (run.scenario === 'approval') {
      later(() => emit(run, 'tool.started', { summary: 'Checking the selected backup' }), 30)
      later(() => {
        emit(run, 'tool.completed', { summary: 'Checked the selected backup' })
        run.status = 'waiting_for_approval'
        run.approval = { request_id: 'approval-1', redacted_action: 'restore snapshot 2026-09-04 →\n/home/james/restore-test/…', choices: ['allow_once', 'deny'] }
        emit(run, 'approval.request', run.approval)
      }, 90)
      return
    }
    later(() => emit(run, 'tool.started', { summary: 'Reading the helpful notes' }), 30)
    later(() => emit(run, 'message.delta', { delta: 'I checked the details. ' }), 70)
    later(() => emit(run, 'tool.completed', { summary: 'Checked the helpful notes' }), 350)
    if (run.scenario !== 'hold') later(() => complete(run), 1600)
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture')
    if (request.headers.authorization !== `Bearer ${options.expectedKey ?? 'fixture-secret'}`) { json(response, 401, { error: 'missing bearer' }); return }
    if (request.method === 'GET' && url.pathname === '/v1/capabilities') { json(response, 200, { capabilities: { sessions: true, runs: true, events: true, approvals: true, steer: true, stop: true, multimodal: true } }); return }
    if (request.method === 'GET' && url.pathname === '/api/model/options') { json(response, 200, { options: [{ value: 'fixture-fast', name: 'Swift', description: 'fastest' }, { value: 'fixture-capable', name: 'Sage', description: 'most capable' }] }); return }
    if (request.method === 'GET' && url.pathname === '/api/sessions') { json(response, 200, { sessions }); return }
    if (request.method === 'POST' && url.pathname === '/api/sessions') {
      const input = await body(request)
      const session = { id: typeof input.id === 'string' && input.id ? input.id : `chat-new-${++sessionSequence}`, title: input.title || 'New chat', source: input.source, preview: '', updated_at: iso(), model: input.model || 'fixture-capable', provider: input.provider }
      sessions.unshift(session); messages.set(session.id, []); json(response, 201, session); return
    }
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9._:-]+)$/)
    if (sessionMatch && request.method === 'GET') { const session = sessions.find((item) => item.id === sessionMatch[1]); json(response, session ? 200 : 404, session ?? { error: 'not found' }); return }
    if (sessionMatch && request.method === 'PATCH') { const session = sessions.find((item) => item.id === sessionMatch[1]); if (!session) { json(response, 404, {}); return } Object.assign(session, await body(request)); json(response, 200, session); return }
    const messageMatch = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9._:-]+)\/messages$/)
    if (messageMatch && request.method === 'GET') { json(response, messages.has(messageMatch[1]) ? 200 : 404, { messages: messages.get(messageMatch[1]) ?? [] }); return }
    const modelMatch = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9._:-]+)\/model$/)
    if (modelMatch && request.method === 'POST') { const session = sessions.find((item) => item.id === modelMatch[1]); if (!session) { json(response, 404, {}); return } const input = await body(request); session.model = input.model; session.provider = input.provider; json(response, 200, session); return }
    if (request.method === 'POST' && url.pathname === '/v1/runs') {
      const admissionKey = request.headers['idempotency-key']
      if (typeof admissionKey !== 'string') { json(response, 400, { error: 'key required' }); return }
      const prior = admissions.get(admissionKey)
      if (prior) { json(response, 200, { run_id: prior.id, session_id: prior.sessionId, status: prior.status }, { 'Idempotency-Replayed': 'true' }); return }
      const input = await body(request)
      const admittedContent = Array.isArray(input.input)
        && input.input.length === 1
        && input.input[0]?.role === 'user'
        && Array.isArray(input.input[0]?.content)
          ? input.input[0].content
          : input.input
      const text = inputText(admittedContent)
      const run = { id: `work-${++runSequence}`, sessionId: input.session_id, input: input.input, status: 'running', output: '', events: [], scenario: /markdown/i.test(text) ? 'markdown' : /approval/i.test(text) ? 'approval' : /hold|stop|steer/i.test(text) ? 'hold' : 'normal', approval: null }
      admissions.set(admissionKey, run); runs.set(run.id, run)
      const list = messages.get(run.sessionId) ?? []
      list.push({ id: `user-${admissionKey}`, role: 'user', content: admittedContent, created_at: iso() }); messages.set(run.sessionId, list)
      const session = sessions.find((item) => item.id === run.sessionId)
      if (session) { session.title = session.title === 'New chat' ? text.slice(0, 42) : session.title; session.preview = text; session.updated_at = iso() }
      schedule(run)
      json(response, 201, { run_id: run.id, session_id: run.sessionId, status: run.status }); return
    }
    const runMatch = url.pathname.match(/^\/v1\/runs\/([A-Za-z0-9._:-]+)$/)
    if (runMatch && request.method === 'GET') { const run = runs.get(runMatch[1]); json(response, run ? 200 : 404, run ? { run_id: run.id, session_id: run.sessionId, status: run.status, output: run.output, approval: run.status === 'waiting_for_approval' ? run.approval : undefined } : { error: 'not found' }); return }
    const eventMatch = url.pathname.match(/^\/v1\/runs\/([A-Za-z0-9._:-]+)\/events$/)
    if (eventMatch && request.method === 'GET') {
      const run = runs.get(eventMatch[1]); if (!run) { json(response, 404, {}); return }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
      for (const event of run.events) response.write(`event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`)
      if (['completed', 'cancelled', 'failed'].includes(run.status)) response.end()
      else { const set = clients.get(run.id) ?? new Set(); set.add(response); clients.set(run.id, set); request.once('close', () => set.delete(response)) }
      return
    }
    const approvalMatch = url.pathname.match(/^\/v1\/runs\/([A-Za-z0-9._:-]+)\/approval$/)
    if (approvalMatch && request.method === 'POST') {
      const run = runs.get(approvalMatch[1]); const input = await body(request)
      if (!run || run.status !== 'waiting_for_approval' || !run.approval.choices.includes(input.choice) || input.request_id !== run.approval.request_id) { json(response, 409, { accepted: false }); return }
      run.status = 'running'; emit(run, 'approval.responded', { choice: input.choice, request_id: input.request_id }); json(response, 200, { accepted: true })
      later(() => complete(run, input.choice === 'deny' ? 'I left everything unchanged.' : 'The approved step is complete.'), 120); return
    }
    const steerMatch = url.pathname.match(/^\/v1\/runs\/([A-Za-z0-9._:-]+)\/steer$/)
    if (steerMatch && request.method === 'POST') {
      const run = runs.get(steerMatch[1]); const input = await body(request)
      if (!run || !['running', 'waiting_for_approval'].includes(run.status)) { json(response, 409, { accepted: false, status: 'rejected' }); return }
      emit(run, 'run.steered', { accepted: true }); json(response, 200, { accepted: true }); later(() => complete(run, `I followed your guidance: ${String(input.input).slice(0, 80)}`), 120); return
    }
    const stopMatch = url.pathname.match(/^\/v1\/runs\/([A-Za-z0-9._:-]+)\/stop$/)
    if (stopMatch && request.method === 'POST') {
      const run = runs.get(stopMatch[1]); if (!run) { json(response, 404, {}); return }
      run.status = 'cancelled'; run.output = ''; emit(run, 'run.cancelled', { status: 'cancelled' }); json(response, 202, { accepted: true }); later(() => { for (const client of clients.get(run.id) ?? []) client.end() }, 20); return
    }
    json(response, 404, { error: 'not found' })
  })

  server.fixture = { sessions, messages, runs, admissions }
  server.closeFixture = async () => {
    for (const timer of timers) clearTimeout(timer)
    for (const set of clients.values()) for (const response of set) response.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
  return server
}
