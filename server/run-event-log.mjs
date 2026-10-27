// Live run events for model-locked turns.
//
// A model-locked Wizard turn runs inside Hermes' POST /api/sessions/<id>/chat/stream response,
// which the locked-run bridge (or the run stream keeper) reads. Hermes registers those runs for
// status, steer, stop and approval, but not for GET /v1/runs/<id>/events: that endpoint only
// serves runs started through POST /v1/runs, so it answered 404 for every Wizard turn and the
// screen sat still until the turn ended. The bridge already reads every frame, so it records
// them here, translated to the /v1/runs event vocabulary, and the Agent Service serves them.

const TERMINAL = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'])
const MAX_EVENTS = 4000
const MAX_BYTES = 4 * 1024 * 1024
const PREVIEW_MAX = 500

const clip = value => typeof value === 'string' && value.length > PREVIEW_MAX ? value.slice(0, PREVIEW_MAX) : value

// Session-stream frame -> native run event fields (null = not forwarded).
export function nativeRunEvent(name, payload) {
  const p = payload && typeof payload === 'object' ? payload : {}
  switch (name) {
    case 'assistant.delta': return typeof p.delta === 'string' ? ['message.delta', { delta: p.delta }] : null
    case 'assistant.commentary': {
      const text = p.text ?? p.content ?? p.delta
      return typeof text === 'string' && text.trim() ? ['message.interim', { text, already_streamed: Boolean(p.already_streamed) }] : null
    }
    case 'tool.started': return ['tool.started', { tool: p.tool_name ?? p.tool ?? null, preview: clip(p.preview ?? null) }]
    case 'tool.completed':
    case 'tool.failed': return ['tool.completed', { tool: p.tool_name ?? p.tool ?? null, duration: Number(p.duration) || 0, error: name === 'tool.failed' || Boolean(p.error) }]
    case 'tool.progress':
      if ((p.tool_name ?? '') === '_thinking') return typeof p.delta === 'string' ? ['reasoning.available', { text: p.delta }] : null
      return null
    case 'approval.request': {
      const { session_id: _s, seq: _q, ts: _t, run_id: _r, event: _e, ...rest } = p
      return ['approval.request', rest]
    }
    case 'run.completed': case 'run.failed': case 'run.cancelled': case 'run.interrupted': {
      // Terminal frames carry the whole turn transcript; the status read has the answer, so stay small.
      const { messages: _m, session_id: _s, seq: _q, ts: _t, run_id: _r, event: _e, ...rest } = p
      return [name, rest]
    }
    case 'error': return ['run.failed', { error: typeof p.message === 'string' ? p.message : 'Run failed' }]
    default: return null
  }
}

export class RunEventLog {
  constructor({ retainMs = 10 * 60_000, now = () => Date.now() } = {}) {
    this.runs = new Map()
    this.retainMs = retainMs
    this.now = now
  }
  open(runId) {
    let run = this.runs.get(runId)
    if (!run) {
      run = { events: [], seq: 0, bytes: 0, dropped: 0, terminal: false, endedAt: 0, listeners: new Set() }
      this.runs.set(runId, run)
    }
    this.prune()
    return run
  }
  has(runId) { return this.runs.has(runId) }
  record(runId, name, payload) {
    const mapped = nativeRunEvent(name, payload)
    if (!mapped) return null
    const run = this.open(runId)
    if (run.terminal) return null
    const [event, fields] = mapped
    run.seq += 1
    const value = { event, run_id: runId, timestamp: this.now() / 1000, ...fields, seq: run.seq }
    const frame = `id: ${run.seq}\nevent: ${event}\ndata: ${JSON.stringify(value)}\n\n`
    run.events.push([run.seq, frame])
    run.bytes += frame.length
    while (run.events.length > 1 && (run.events.length > MAX_EVENTS || run.bytes > MAX_BYTES)) {
      run.bytes -= run.events.shift()[1].length; run.dropped += 1
    }
    if (TERMINAL.has(event)) { run.terminal = true; run.endedAt = this.now() }
    for (const listener of run.listeners) listener()
    return value
  }
  // The stream ended without a terminal frame (connection lost, Agent Service stopping).
  detach(runId) {
    const run = this.runs.get(runId)
    if (!run || run.terminal) return
    run.detached = true; run.endedAt = this.now()
    for (const listener of run.listeners) listener()
  }
  // Async iterator of SSE frames after lastSeq; ends after the terminal frame or a detach.
  async *frames(runId, lastSeq = -1, signal) {
    const run = this.runs.get(runId)
    if (!run) return
    let cursor = Number.isFinite(lastSeq) ? lastSeq : -1
    if (run.events.length && run.events[0][0] > Math.max(cursor, 0) + 1) {
      yield `event: replay.truncated\ndata: ${JSON.stringify({ event: 'replay.truncated', run_id: runId, oldest_retained_seq: run.events[0][0] })}\n\n`
    }
    while (!signal?.aborted) {
      const pending = run.events.filter(([seq]) => seq > cursor)
      for (const [seq, frame] of pending) { cursor = seq; yield frame }
      if (run.terminal || run.detached) return
      await new Promise(resolve => {
        const wake = () => { run.listeners.delete(wake); signal?.removeEventListener?.('abort', wake); resolve() }
        run.listeners.add(wake)
        signal?.addEventListener?.('abort', wake, { once: true })
      })
    }
  }
  prune() {
    const cutoff = this.now() - this.retainMs
    for (const [id, run] of this.runs) if ((run.terminal || run.detached) && run.endedAt < cutoff && !run.listeners.size) this.runs.delete(id)
  }
}
