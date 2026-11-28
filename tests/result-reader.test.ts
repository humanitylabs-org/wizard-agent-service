// Issue 630: the result reader. A fixed private model reads each finished background run (bounded facts, the status
// line only a hint) and decides how it is filed; no private router or a bad reply files it exactly as before.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentInboxStore, NO_SUMMARY } from '../server/agent-inbox.mjs'
import { createAlertGate, AlertRulesFile } from '../server/agent-alerts.mjs'
import { createResultReader, examplesBlock, parseReaderReply, readerFacts, readerRouter, readResult, replyTail, statusHint, READER_REPLY_CHARS } from '../server/result-reader.mjs'

const T0 = Date.parse('2026-11-26T09:00:00Z')
const clock = () => { const c = { at: T0, now: () => c.at++ }; return c }
const privateR = { url: 'http://127.0.0.1:9/v1/chat/completions', model: 'fixture-private' }
const line = (v: any) => `\n[WIZARD_STATUS_V1]${JSON.stringify(v)}[/WIZARD_STATUS_V1]`
const saying = (reply: any, calls: any[] = []) => async (_url: string, init: any) => {
  calls.push(JSON.parse(init.body))
  return new Response(JSON.stringify({ choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }] }), { status: 200 })
}
const store = () => {
  const c = clock()
  const logs: string[] = []
  const inbox = new AgentInboxStore('', { now: c.now, log: (m: string) => { logs.push(m) } })
  const { record } = inbox.capture({ agent: 'hermes', thread_id: 'wizard_t1', title: 'Synthetic task', ask: 'Synthetic ask' })
  return { inbox, record, logs }
}
const choose = 'Two synthetic venues found. Which one should I book? Reply A or B.'

describe('result reader: the model call', () => {
  it('asks only a private router, at temperature 0, with bounded facts', async () => {
    expect(readerRouter(privateR)).toBe(privateR)
    expect(readerRouter({ url: 'https://inference.tinfoil.sh/v1/chat/completions', model: 'm' })).toBeTruthy()
    expect(readerRouter({ url: 'https://api.openai.example/v1/chat/completions', model: 'm', account: 'tinfoil' } as any)).toBeNull()
    expect(readerRouter({ url: 'http://127.0.0.2:9/v1', model: 'm' })).toBeNull()
    const calls: any[] = []
    const facts = readerFacts({ agent: 'philosopher', agentKind: 'private', run: { status: 'completed', output: `${'x'.repeat(9000)}\nThe end. Reply A or B.${line({ state: 'done', ask: 'Done' })}` }, durationMs: 90_000, owedWork: true, title: 'T' })
    expect(facts.final_reply_end.length).toBeLessThanOrEqual(READER_REPLY_CHARS + 1)
    expect(facts.final_reply_end.endsWith('Reply A or B.')).toBe(true)
    expect(facts.final_reply_end).not.toContain('WIZARD_STATUS_V1')
    expect(facts.status_line_hint).toEqual({ state: 'done', ask: 'Done' })
    expect([facts.outcome, facts.duration_minutes, facts.owed_background_work, facts.agent_kind]).toEqual(['ok', 1.5, true, 'private'])
    expect(readerFacts({ run: { status: 'cancelled' } }).outcome).toBe('killed')
    expect(readerFacts({ run: { status: 'failed', error: 'boom' } })).toMatchObject({ outcome: 'failed', error: 'boom' })
    const got = await readResult(facts, { router: privateR, fetchImpl: saying({ kind: 'needs_you', urgent: false, ask: 'Pick A or B' }, calls) as any, examples: [{ text: 'An example correction.' }] })
    expect(got).toEqual({ kind: 'needs_you', urgent: false, failed: false, ask: 'Pick A or B' })
    expect(calls[0].temperature).toBe(0)
    expect(calls[0].messages[0].content).toContain('An example correction.')
    await expect(readResult(facts, { router: { url: 'https://api.example.test/v1', model: 'm' }, fetchImpl: saying({}) as any })).rejects.toThrow('no private router')
  })

  it('accepts only strict JSON: kind from the set, urgent a boolean, an ask capped at 140, options only on needs_you', () => {
    expect(parseReaderReply('nope')).toBeNull()
    expect(parseReaderReply('{"kind":"done","urgent":false,"ask":"x"}')).toBeNull()
    expect(parseReaderReply('{"kind":"result","urgent":"no","ask":"x"}')).toBeNull()
    expect(parseReaderReply('{"kind":"result","urgent":false,"ask":"  "}')).toBeNull()
    const long = parseReaderReply(JSON.stringify({ kind: 'result', urgent: false, ask: 'word '.repeat(200) }))!
    expect(long.ask.length).toBeLessThanOrEqual(140)
    expect(parseReaderReply(JSON.stringify({ kind: 'fyi', urgent: false, ask: 'x', options: { a: 'A' } }))).toEqual({ kind: 'fyi', urgent: false, failed: false, ask: 'x' })
    expect(parseReaderReply(JSON.stringify({ kind: 'needs_you', urgent: true, ask: 'x', options: { a: 'A', 'Bad Token': 'B' } }))!.options).toEqual({ a: 'A' })
    expect(replyTail('short')).toBe('short')
    expect(statusHint('no line')).toBeNull()
    expect(examplesBlock([])).toBe('')
  })

  it('shares one read per finished run, logs no-router once, and returns a null result on a timeout', async () => {
    const logs: string[] = []
    let r: any = null
    const calls: any[] = []
    const reader = createResultReader({ router: () => r, fetchImpl: saying({ kind: 'result', urgent: false, ask: 'Done' }, calls) as any, log: (m: string) => { logs.push(m) } })
    expect(reader.read('k', {} as any)).toBeNull()
    expect(reader.read('k', {} as any)).toBeNull()
    expect(logs.filter(m => m.includes('no private router'))).toHaveLength(1)
    r = privateR
    const [a, b] = [reader.read('k', {} as any), reader.read('k', {} as any)]
    expect(a).toBe(b)
    expect((await a)!.result!.kind).toBe('result')
    expect(calls).toHaveLength(1)
    const slow = createResultReader({ router: () => privateR, timeoutMs: 20, log: (m: string) => { logs.push(m) },
      fetchImpl: ((_u: string, init: any) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))) as any })
    expect(await slow.read('s', {} as any)).toMatchObject({ result: null, error: 'timeout' })
    expect(logs.at(-1)).toContain('read failed (timeout)')
  })

})

describe('result reader: filing', () => {
  it('a reply asking the owner to choose, with no status line, lands as needs_you with the reader ask', () => {
    const { inbox, record } = store()
    const got = inbox.noteRun('hermes', 'wizard_t1', { id: 'r1', status: 'completed', output: choose }, { reader: { result: { kind: 'needs_you', urgent: false, failed: false, ask: 'Two venues found. Reply A or B', options: { a: 'Book A', b: 'Book B' } }, model: 'fixture-private' } })!
    expect([got.id, got.kind, got.state, got.ask, got.classified_by, got.status_line, got.options]).toEqual([record.id, 'needs_you', 'new', 'Two venues found. Reply A or B', 'reader', null, { a: 'Book A', b: 'Book B' }])
    expect(got.reader).toMatchObject({ kind: 'needs_you', model: 'fixture-private' })
    expect(inbox.readerStats()).toMatchObject({ calls: 1, reader: 1, disagreements: 0 })
  })

  it('a done line on a failed run files per the reply: classified_by reader and one counted disagreement', () => {
    const { inbox, logs } = store()
    const got = inbox.noteRun('hermes', 'wizard_t1', { id: 'r1', status: 'completed', output: `It failed.${line({ state: 'done', ask: 'Uploaded' })}` }, { reader: { result: { kind: 'result', urgent: false, failed: true, ask: 'The upload failed' } } })!
    expect([got.kind, got.failed, got.last_update, got.classified_by, got.status_line, got.reader_disagreed]).toEqual(['result', true, 'The upload failed', 'reader', { state: 'done', ask: 'Uploaded' }, true])
    expect(inbox.readerStats()!.disagreements).toBe(1)
    expect(logs.some(m => m.includes('disagree'))).toBe(true)
    // The same run seen again is filed once.
    expect(inbox.noteRun('hermes', 'wizard_t1', { id: 'r1', status: 'completed', output: `It failed.${line({ state: 'done', ask: 'Uploaded' })}` }, { reader: { result: null } })).toBeNull()
    expect(inbox.readerStats()!.calls).toBe(1)
  })

  it('a reader needs_you over a done line counts a disagreement; the same kind does not', () => {
    const { inbox } = store()
    inbox.noteRun('hermes', 'wizard_t1', { id: 'r1', status: 'completed', output: `x${line({ state: 'done', ask: 'Done' })}` }, { reader: { result: { kind: 'needs_you', urgent: false, failed: false, ask: 'Pick one' } } })
    inbox.noteRun('hermes', 'wizard_t1', { id: 'r2', status: 'completed', output: `y${line({ state: 'needs_you', ask: 'Pick' })}` }, { reader: { result: { kind: 'needs_you', urgent: false, failed: false, ask: 'Pick one' } } })
    expect(inbox.readerStats()).toMatchObject({ calls: 2, reader: 2, disagreements: 1 })
  })

  it('a failed read files from the status line (status_line), or as the no-summary result (fallback)', () => {
    const { inbox } = store()
    let got = inbox.noteRun('hermes', 'wizard_t1', { id: 'r1', status: 'completed', output: `x${line({ state: 'done', ask: 'Done here' })}` }, { reader: { result: null, error: 'invalid reply' } })!
    expect([got.kind, got.last_update, got.classified_by, got.reader.error]).toEqual(['result', 'Done here', 'status_line', 'invalid reply'])
    got = inbox.noteRun('hermes', 'wizard_t1', { id: 'r2', status: 'completed', output: 'no line' }, { reader: { result: null, error: 'timeout' } })!
    expect([got.kind, got.last_update, got.classified_by]).toEqual(['result', NO_SUMMARY, 'fallback'])
    expect(inbox.readerStats()).toMatchObject({ calls: 2, status_line: 1, fallback: 1 })
  })

  it('keeps the inbox rules: owed work holds a result back, a confirm line waits on the owner, an answered record archives', () => {
    const { inbox } = store()
    const owed = (s: any) => s.state === 'done' ? { ...s, state: 'fyi', ask: 'Background work is still running or waiting to report back.' } : s
    let got = inbox.noteRun('hermes', 'wizard_t1', { id: 'r1', status: 'completed', output: 'x' }, { guard: owed, reader: { result: { kind: 'result', urgent: false, failed: false, ask: 'Finished' } } })!
    expect([got.state, got.kind]).toEqual(['running', 'note'])
    got = inbox.noteRun('hermes', 'wizard_t1', { id: 'r2', status: 'completed', output: `x${line({ state: 'done', ask: 'Sent', confirm: true })}` }, { reader: { result: { kind: 'result', urgent: false, failed: false, ask: 'Ready to send' } } })!
    expect([got.state, got.kind, got.confirm]).toEqual(['new', 'needs_you', true])
    inbox.patch(got.id, { action: 'answer' })
    got = inbox.noteRun('hermes', 'wizard_t1', { id: 'r3', status: 'completed', output: 'sent' }, { reader: { result: { kind: 'result', urgent: false, failed: false, ask: 'Sent it' } } })!
    expect(got.state).toBe('archived')
  })

  it('urgent goes to the alert stage, which keeps its rules and cap', async () => {
    const { inbox } = store()
    const calls: any[] = []
    const gate = createAlertGate({ inbox, rules: new AlertRulesFile(''), now: () => T0, timezone: () => 'UTC', log: () => undefined,
      router: () => privateR, fetchImpl: (async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ choices: [{ message: { content: '{"urgent": true, "reason": "Person waiting today"}' } }] })) }) as any,
      notify: { available: () => true, send: async () => undefined } })
    const got = inbox.noteRun('hermes', 'wizard_t1', { id: 'r1', status: 'completed', output: 'x' }, { reader: { result: { kind: 'needs_you', urgent: true, failed: false, ask: 'Sam waits for your yes today' } } })!
    expect(got.severity).toBe('high')
    const decided = await gate.considerRecord(got)
    expect(decided!.decision.stage).toBe('model')
    expect(calls).toHaveLength(1)
    expect(inbox.list({ kind: 'alert' })).toHaveLength(1)
  })

  it('without the reader the store files byte for byte as before (no reader fields, no counts on disk)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'as-630-'))
    try {
      const path = join(dir, 'agent-inbox.json')
      const c = clock()
      const inbox = new AgentInboxStore(path, { now: c.now, log: () => undefined })
      inbox.capture({ agent: 'hermes', thread_id: 'wizard_t1', title: 'Synthetic task', ask: 'Synthetic ask' })
      inbox.noteRun('hermes', 'wizard_t1', { id: 'r1', status: 'completed', output: choose })
      const text = readFileSync(path, 'utf8')
      for (const key of ['classified_by', 'status_line', '"reader"', 'reader_disagreed']) expect(text).not.toContain(key)
      expect(JSON.parse(text).records[Object.keys(JSON.parse(text).records)[0]].last_update).toBe(NO_SUMMARY)
      inbox.noteRun('hermes', 'wizard_t1', { id: 'r2', status: 'completed', output: choose }, { reader: { result: null } })
      expect(new AgentInboxStore(path).readerStats()).toMatchObject({ calls: 1, fallback: 1 })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
