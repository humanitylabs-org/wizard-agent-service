import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { lintReport, REPORTER_INSTRUCTIONS } from '../server/reporter.mjs'
import { Scheduler } from '../server/scheduler.mjs'
const status = '[WIZARD_STATUS_V1]{"state":"done","ask":"The check finished"}[/WIZARD_STATUS_V1]'
const valid = `**The check finished.**\n\n**What happened:** Nothing needs your attention.\n${status}`
const services: any[] = [], roots: string[] = []
afterEach(async () => { for (const s of services.splice(0)) await s.close(); for (const r of roots.splice(0)) rmSync(r,{recursive:true,force:true}) })

describe('Reporter shared plain-words contract', () => {
  it('accepts short status reports and exact SILENT', () => {
    expect(lintReport(valid)).toEqual({ ok:true, reasons:[] })
    expect(lintReport('[SILENT]')).toEqual({ ok:true, reasons:[] })
  })
  it.each(['Not bold.', '**No sentence**', '**First sentence. Second sentence.**', '**What I did:** Changed it.', '**Result:** all good.'])('rejects invalid opening %s', opening => {
    expect(lintReport(`${opening}\n${status}`).ok).toBe(false)
  })
  it.each(['lane','gate','waive','receipt','cutover','soak','parity','unblock','PR #123','issue #12','feat/reporter','abcdef1234567','v0.3.44','0.3.44'])('rejects internal jargon or identifiers: %s', jargon => {
    expect(lintReport(`**The check finished.**\n**What happened:** ${jargon}\n${status}`).ok).toBe(false)
    expect(lintReport(`**The check finished.**\n${jargon}\n${status}`, {kind:'digest'}).ok).toBe(false)
  })
  it('limits status labels, word count, and Still open bullets', () => {
    expect(lintReport(`**The check finished.**\n**Does it work:** Yes.\n${status}`).ok).toBe(false)
    expect(lintReport(`**The check finished.**\n**Extra heading**\n${status}`).ok).toBe(false)
    expect(lintReport(`**The check finished.**\n**Still open:**\n- One\n**Still open:**\n- Two\n- Three\n${status}`).ok).toBe(false)
    expect(lintReport(`**The check finished.**\n${'word '.repeat(121)}\n${status}`).ok).toBe(false)
    expect(lintReport(`**The check finished.**\n**Still open:**\n- One\n- Two\n- Three\n${status}`).ok).toBe(false)
    expect(lintReport(`**The check finished.**\n**Still open:**\n- One\n- Two\n${status}`).ok).toBe(true)
  })
  it('requires one parsed status marker on the last line, with a real ask', () => {
    for (const tail of ['', '[WIZARD_STATUS_V1]{"state":"wrong","ask":"x"}[/WIZARD_STATUS_V1]', '[WIZARD_STATUS_V1]{"state":"done"}[/WIZARD_STATUS_V1]', status+'\nMore', status+'\n'+status]) expect(lintReport(`**Done.**\n${tail}`).ok).toBe(false)
  })
  it('allows digest content and headings beyond 120 words, but checks opening, jargon, and status', () => {
    expect(lintReport(`**Here is your roundup.**\n## Stories\n${'Useful news. '.repeat(150)}\n${status}`,{kind:'digest'}).ok).toBe(true)
  })
})

describe('scheduled corrective run is durable and bounded', () => {
  function fixture(extra = {}) {
    const r = mkdtempSync(join(tmpdir(),'reporter-test-')); roots.push(r)
    const calls: any[] = [], results = new Map(); let clock = Date.parse('2026-10-25T12:00:00Z')
    const opts = { statePath:join(r,'schedules.sqlite3'), now:()=>clock, deliver: async (o: any) => { calls.push(o); return {run_id:o.key} }, lookup: async (_o: any, receipt: any) => results.get(receipt.run_id), ...extra }
    const s = new Scheduler(opts); services.push(s)
    return {s,calls,results,opts, advance:()=>{clock+=60_000}}
  }
  it('appends the format to normal work and digest, not reminders, and validates report choice', () => {
    const f=fixture()
    for (const report of ['status','digest']) {
      const j=f.s.create({name:'Report',when:{every:1},prompt:'Read it',report})
      const o=f.s.transaction(()=>f.s.reserve(j,Date.parse('2026-10-25T12:00:00Z')))
      expect(o.body.input).toContain(REPORTER_INSTRUCTIONS); expect(o.body.input).toContain(`report=${report}`); expect(o.report).toBe(report)
    }
    const j=f.s.create({name:'Reminder',kind:'remind',when:{every:1},prompt:'Eat'})
    expect(f.s.transaction(()=>f.s.reserve(j,Date.parse('2026-10-25T12:00:00Z'))).body.input).not.toContain(REPORTER_INSTRUCTIONS)
    expect(()=>f.s.create({name:'Bad',when:{every:1},prompt:'Read',report:'other'})).toThrow('report must')
  })
  it.each([valid,'[SILENT]'])('does not correct valid output %s', async output => {
    const f=fixture(); f.s.create({name:'Check',when:{once:'2026-10-25T12:00:00Z'},prompt:'Check it'})
    await f.s.tick(); f.results.set(f.calls[0].key,{status:'completed',output}); await f.s.refreshRuns()
    expect(f.calls).toHaveLength(1)
    expect(JSON.parse(f.s.db.prepare('SELECT report_lint FROM schedule_occurrences').get().report_lint).ok).toBe(true)
  })
  it('admits at most one correction in the same thread and records a failed second lint without looping', async () => {
    const f=fixture(); const j=f.s.create({name:'Check',when:{once:'2026-10-25T12:00:00Z'},prompt:'Check it'})
    await f.s.tick(); const first=f.calls[0]; f.results.set(first.key,{status:'completed',output:'PR #123 merged.'})
    await f.s.refreshRuns(); expect(f.calls).toHaveLength(2)
    const correction=f.calls[1]; expect(correction.thread).toBe(first.thread); expect(correction.createThread).toBe(false)
    expect(correction.body.input).toContain('[reporter] Your last report does not meet the report format:')
    f.results.set(correction.key,{status:'completed',output:'Still invalid.'})
    await f.s.refreshRuns(); await f.s.refreshRuns(); await f.s.tick(false)
    expect(f.calls).toHaveLength(2)
    const row=f.s.latest(j.id); expect(JSON.parse(row.report_lint).ok).toBe(false); expect(JSON.parse(row.report_final_lint).ok).toBe(false)
    expect(row.finished_at).toBeTruthy()
  })
  it('freezes the corrective request before admission and reuses its key after an ambiguous failure and restart', async () => {
    let ambiguous=true; const attempts:any[]=[]
    const f=fixture({deliver:async(o:any)=>{attempts.push(o); if(o.key.endsWith(':reporter')&&ambiguous) throw Error('lost response'); return {run_id:o.key}}})
    f.s.create({name:'Check',when:{once:'2026-10-25T12:00:00Z'},prompt:'Check it'})
    await f.s.tick(); f.results.set(attempts[0].key,{status:'completed',output:'Invalid.'}); await f.s.refreshRuns()
    await f.s.close(); services.splice(services.indexOf(f.s),1)
    ambiguous=false; const s=new Scheduler(f.opts); services.push(s)
    await s.refreshRuns(); const last=attempts.at(-1); f.results.set(last.key,{status:'completed',output:valid}); await s.refreshRuns(); await s.refreshRuns()
    expect(attempts).toHaveLength(3); expect(attempts[1]).toEqual(attempts[2])
    expect(JSON.parse(s.db.prepare('SELECT report_final_lint FROM schedule_occurrences').get().report_final_lint).ok).toBe(true)
  })
  it('keeps the original attention state, subject and title when asking for a rewrite (check stays on Ready)', async () => {
    const f=fixture(); f.s.create({name:'Check',when:{once:'2026-10-25T12:00:00Z'},prompt:'Check it'})
    await f.s.tick()
    const original='**0.10.16 is on your phone.**\n\n**Does it work:** yes.\n\n[WIZARD_STATUS_V1]{"state":"check","ask":"Translate bar update is on your phone. Say if it feels right","subject":"Wizard OS","title":"Wizard OS · Translate bar"}[/WIZARD_STATUS_V1]'
    f.results.set(f.calls[0].key,{status:'completed',output:original}); await f.s.refreshRuns()
    expect(f.calls).toHaveLength(2)
    expect(f.calls[1].body.input).toContain('Keep the status line\'s state "check", subject "Wizard OS" and title "Wizard OS · Translate bar" exactly')
  })
})
