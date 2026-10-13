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
  const media = new Map([
    ['1'.repeat(32), { name: 'weekend.png', mime: 'image/png', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') }],
    ['2'.repeat(32), { name: 'weekend-voice.webm', mime: 'audio/webm', bytes: Buffer.from('fixture-audio') }],
    ['3'.repeat(32), { name: 'weekend.mp4', mime: 'video/mp4', bytes: Buffer.from('fixture-video') }],
    ['4'.repeat(32), { name: 'weekend-notes.md', mime: 'text/markdown', bytes: Buffer.from('# Weekend notes\n\n- Keep Saturday quiet.\n- Walk after lunch.') }],
  ])
  const longMessages = Array.from({ length: 180 }, (_, index) => ({
    id: `long-${index}`,
    role: index % 2 ? 'assistant' : 'user',
    content: index % 2 ? `A calm, useful answer for transcript item ${index}.` : `Question number ${index}`,
    created_at: iso(-180000 + index * 1000),
  }))
  const sessions = options.empty ? [] : [
    { id: 'chat-recent', title: 'Plan the quiet weekend', source: 'wizard-mobile', preview: '[Your active task list was preserved across context compression]\n- [>] private task', updated_at: iso(-60_000), wizard_last_user_at: iso(-60_000), model: 'fixture-capable' },
    { id: 'chat-long', title: 'Long project notes', source: 'webui', preview: 'The complete working history', updated_at: iso(-3_600_000), wizard_last_user_at: iso(-3_600_000), model: 'fixture-fast' },
  ]
  const messages = new Map([
    ['chat-recent', [
      { id: 'm-1', role: 'user', content: 'Help me plan a quiet weekend.', created_at: iso(-120_000) },
      { id: 'm-2', role: 'assistant', content: 'I found three gentle options close to home.', created_at: iso(-60_000) },
      {
        id: 'm-helm-media',
        role: 'user',
        content: `[Workspace::v1: /home/developer]\nHere are the reference files.\n\n<helm_attachments>${JSON.stringify({ instruction: 'private attachment handling', items: [
          { id: '1'.repeat(32), name: 'weekend.png', mime: 'image/png', path: '/private/weekend.png' },
          { id: '2'.repeat(32), name: 'weekend-voice.webm', mime: 'audio/webm', transcript: 'Keep Saturday quiet.', path: '/private/weekend-voice.webm' },
          { id: '3'.repeat(32), name: 'weekend.mp4', mime: 'video/mp4', kind: 'video', path: '/private/weekend.mp4' },
          { id: '4'.repeat(32), name: 'weekend-notes.md', mime: 'text/markdown', kind: 'file', path: '/private/weekend-notes.md' },
        ] })}</helm_attachments>`,
        created_at: iso(-50_000),
      },
      { id: 'm-hidden', role: 'user', content: '', display_kind: 'hidden', created_at: iso(-40_000) },
      { id: 'm-delegation', role: 'user', content: '[ASYNC DELEGATION BATCH COMPLETE — deleg_fixture]\nInternal worker transcript', display_kind: 'async_delegation_complete', created_at: iso(-30_000) },
      { id: 'm-task-restore', role: 'user', content: '[Your active task list was preserved across context compression]\n- [>] private task', created_at: iso(-20_000) },
      { id: 'm-process-wakeup', role: 'user', content: '[IMPORTANT: Background process proc_fixture completed (exit_code=1).\nCommand: ./gradlew assembleDebug\nOutput:\nBUILD FAILED\n]', created_at: iso(-10_000) },
    ]],
    ['chat-long', longMessages],
  ])

  function emit(run, event, data = {}) {
    const list = messages.get(run.sessionId) ?? []
    if (event === 'tool.started') {
      const callId = `call-${run.id}-${(run.toolSequence ?? 0) + 1}`
      run.toolSequence = (run.toolSequence ?? 0) + 1
      run.activeToolCallId = callId
      list.push({ id: `assistant-${callId}`, role: 'assistant', content: '', tool_calls: [{ call_id: callId, function: { name: typeof data.tool === 'string' ? data.tool : 'read_file', arguments: '{}' } }], created_at: iso() })
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
    if (run.scenario === 'plain') {
      later(() => emit(run, 'message.delta', { delta: 'A plain reply with no private work.' }), 40)
      later(() => complete(run, 'A plain reply with no private work.'), 500)
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
    const phases = ['Comparing possible approaches', 'Reading the strongest source', 'Checking the current implementation', 'Tracing the live state', 'Confirming the edge case', 'Cross-checking the source', 'Reviewing the mobile path', 'Checking recovery behavior', 'Verifying the final constraint', 'Confirming source fidelity', 'Running the focused checks', 'Preparing the verified result']
    const tools = ['web_search', 'web_search', 'web_extract', 'read_file', 'read_file', 'read_file', 'web_search', 'web_extract', 'read_file', 'read_file', 'web_extract', 'read_file']
    tools.forEach((tool, index) => {
      const stepId = `phase-${run.id}-${index + 1}`
      later(() => emit(run, 'reasoning.available', { id: `summary-${stepId}`, summary: phases[index], detail: `${phases[index]} without exposing private arguments.` }), 24 + index * 50)
      later(() => emit(run, 'tool.started', { step_id: stepId, tool }), 30 + index * 50)
      later(() => emit(run, 'tool.completed', { step_id: stepId, tool }), 50 + index * 50)
    })
    later(() => emit(run, 'message.delta', { delta: 'I checked the details. ' }), 700)
    if (run.scenario !== 'hold') later(() => complete(run), 4000)
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture')
    const attachment = url.pathname.match(/^\/helm\/api\/attachments\/([0-9a-f]{32})$/)
    if (attachment && ['GET', 'HEAD'].includes(request.method ?? '')) {
      const item = media.get(attachment[1])
      if (!item) { json(response, 404, { error: 'not found' }); return }
      const range = typeof request.headers.range === 'string' ? request.headers.range.match(/^bytes=(\d+)-(\d*)$/) : null
      const start = range ? Number(range[1]) : 0
      const end = range && range[2] ? Math.min(Number(range[2]), item.bytes.length - 1) : item.bytes.length - 1
      if (range && (start >= item.bytes.length || end < start)) {
        response.writeHead(416, { 'Content-Range': `bytes */${item.bytes.length}`, 'Accept-Ranges': 'bytes' }); response.end(); return
      }
      const selected = item.bytes.subarray(start, end + 1)
      response.writeHead(range ? 206 : 200, {
        'Content-Type': item.mime,
        'Content-Length': selected.length,
        'Accept-Ranges': 'bytes',
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${item.bytes.length}` } : {}),
        'Content-Disposition': `inline; filename="${item.name}"`,
      })
      if (request.method === 'HEAD') response.end()
      else response.end(selected)
      return
    }
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
    if (messageMatch && request.method === 'GET') {
      const reply = () => json(response, messages.has(messageMatch[1]) ? 200 : 404, { messages: messages.get(messageMatch[1]) ?? [] })
      const delay = Number(server.fixture?.messageDelayMs ?? options.messageDelayMs ?? 0)
      if (delay > 0) later(reply, delay)
      else reply()
      return
    }
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
      const run = { id: `work-${++runSequence}`, sessionId: input.session_id, input: input.input, status: 'running', output: '', events: [], scenario: /markdown/i.test(text) ? 'markdown' : /plain reply/i.test(text) ? 'plain' : /approval/i.test(text) ? 'approval' : /hold|stop|steer/i.test(text) ? 'hold' : 'normal', approval: null }
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
      if (/decline steer/i.test(String(input.input))) { json(response, 200, { accepted: false, status: 'rejected' }); return }
      if (/reject steer/i.test(String(input.input))) { json(response, 409, { accepted: false, status: 'rejected' }); return }
      run.steers = [...(run.steers ?? []), input.input]
      const list = messages.get(run.sessionId) ?? []
      list.push({ id: `steer-${run.id}-${run.steers.length}`, role: 'user', content: input.input, created_at: iso() })
      messages.set(run.sessionId, list)
      emit(run, 'run.steered', { accepted: true }); json(response, 200, { accepted: true })
      const steerText = String(input.input)
      const hold = /continue holding|Please use the attached file|WIZARD_IMAGE_INTENT_V1/i.test(steerText)
        && !/Spoken fixture request/i.test(steerText)
      if (!hold) later(() => complete(run, `I followed your guidance: ${steerText.slice(0, 80)}`), 120)
      return
    }
    const stopMatch = url.pathname.match(/^\/v1\/runs\/([A-Za-z0-9._:-]+)\/stop$/)
    if (stopMatch && request.method === 'POST') {
      const run = runs.get(stopMatch[1]); if (!run) { json(response, 404, {}); return }
      run.status = 'cancelled'; run.output = ''; emit(run, 'run.cancelled', { status: 'cancelled' }); json(response, 202, { accepted: true }); later(() => { for (const client of clients.get(run.id) ?? []) client.end() }, 20); return
    }
    json(response, 404, { error: 'not found' })
  })

  server.fixture = { sessions, messages, runs, admissions, messageDelayMs: Number(options.messageDelayMs ?? 0) }
  server.closeFixture = async () => {
    for (const timer of timers) clearTimeout(timer)
    for (const set of clients.values()) for (const response of set) response.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
  return server
}
