// Follow main (issue 514, switch wizard/follow-main): the Service reads the host step's follow-main.json, shows it
// in /wizard/health while the switch is on, and tells the owner once when the box has been behind main for 30 min.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'
import { behindMessage, createFollowMain, FOLLOW_MAIN_SCHEMA, FOLLOW_MAIN_SWITCH, readFollowMainStatus } from '../server/follow-main.mjs'

const servers: any[] = [], dirs: string[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(r)))); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
const home = () => { const d = mkdtempSync(join(tmpdir(), 'follow-main-')); dirs.push(d); return d }
const A = 'a'.repeat(40), B = 'b'.repeat(40)
const T0 = Date.parse('2026-11-24T10:00:00Z')
const at = (ms: number) => new Date(ms).toISOString()
function writeStatus(path: string, extra: Record<string, unknown>) {
  writeFileSync(path, JSON.stringify({ schema: FOLLOW_MAIN_SCHEMA, live: A, main: B, checked_at: at(T0), ...extra }))
}
const setLook = (d: string, on: boolean) => { mkdirSync(join(d, 'Pages', 'wizard-look'), { recursive: true }); writeFileSync(join(d, 'Pages', 'wizard-look', 'look.json'), JSON.stringify({ version: 1, skin: null, tweaks: { [FOLLOW_MAIN_SWITCH]: { on, at: 1 } } })) }
async function start(d: string, extra: Record<string, unknown> = {}) {
  const s = createWizardServer({
    wizardOsHome: d, requireAccess: false, hermesKey: 'test', agentBridge: false, followThrough: false,
    runQueueStatePath: join(d, 'q.db'), runQueuePollIntervalMs: 0, followMainTtlMs: 0,
    pagesRoot: join(d, 'Pages'), pagesGitDir: join(d, 'pages-history.git'), pagesWatch: false,
    followMainStatusPath: join(d, 'follow-main.json'), ...extra,
  })
  servers.push(s); const a: any = await listen(s); return `http://127.0.0.1:${a.port}`
}

describe('follow-main status', () => {
  it('keeps only known fields and refuses foreign files', () => {
    const d = home(), p = join(d, 's.json')
    writeStatus(p, { state: 'behind', behind_by: 3, behind_since: at(T0), reason: 'the deploy stopped:\nrefusing', token: 'x', live: 'not-a-sha' })
    expect(readFollowMainStatus(p)).toEqual({ state: 'behind', main: B, behind_by: 3, behind_since: at(T0), checked_at: at(T0), reason: 'the deploy stopped: refusing' })
    writeFileSync(p, JSON.stringify({ schema: 'other/1', state: 'current' }))
    expect(readFollowMainStatus(p)).toBeNull()
    expect(readFollowMainStatus(join(d, 'missing.json'))).toBeNull()
  })
  it('says how far behind, since when and why', () => {
    expect(behindMessage({ state: 'behind', behind_by: 2, behind_since: at(T0), reason: 'the newest change on main failed its checks (test), so it is not installed' }))
      .toBe("2 merged changes on main haven't gone live on this Wizard since 2026-11-24 10:00 UTC: the newest change on main failed its checks (test), so it is not installed. It keeps retrying by itself.")
    expect(behindMessage({ state: 'behind', behind_by: 1, reason: 'x' })).toBe("1 merged change on main hasn't gone live on this Wizard: x. It keeps retrying by itself.")
  })
})

describe('the behind notice', () => {
  const notifier = () => { const sent: any[] = []; return { sent, available: () => true, send: async (n: any) => { sent.push(n); return { app: 'notes' } } } }
  it('is sent once per main and reason after 30 min behind, never while off or current', async () => {
    const d = home(), p = join(d, 'follow-main.json'), n = notifier()
    let now = T0, on = false
    const fm = createFollowMain({ statusPath: p, on: () => on, notifier: n, now: () => now, log: () => undefined })
    writeStatus(p, { state: 'behind', behind_by: 1, behind_since: at(T0), reason: 'the deploy stopped: refusing to deploy' })
    now = T0 + 31 * 60_000; writeStatus(p, { state: 'behind', behind_by: 1, behind_since: at(T0), checked_at: at(now), reason: 'the deploy stopped: refusing to deploy' })
    expect(fm.health()).toBeNull(); expect(await fm.tick()).toBeNull(); expect(n.sent).toEqual([])
    on = true
    expect(fm.health()).toMatchObject({ on: true, state: 'behind', live: A, main: B, reason: 'the deploy stopped: refusing to deploy' })
    expect(await fm.tick()).toBeTruthy()
    expect(n.sent).toEqual([{ agent: 'main', title: 'Wizard is behind', message: expect.stringContaining('refusing to deploy') }])
    expect(await fm.tick()).toBeNull(); expect(n.sent).toHaveLength(1)
    // A restarted Service remembers it already told the owner.
    const again = createFollowMain({ statusPath: p, on: () => true, notifier: n, now: () => now, log: () => undefined })
    expect(await again.tick()).toBeNull(); expect(n.sent).toHaveLength(1)
    // A new reason is a new notice; catching up sends nothing.
    writeStatus(p, { state: 'behind', behind_by: 1, behind_since: at(T0), checked_at: at(now), reason: "couldn't prepare the release: npm failed" })
    await fm.tick(); expect(n.sent).toHaveLength(2)
    writeStatus(p, { state: 'current', live: B, checked_at: at(now) })
    expect(await fm.tick()).toBeNull(); expect(n.sent).toHaveLength(2)
  })
  it('waits 30 min: a merge still in its checks is no news', async () => {
    const d = home(), p = join(d, 'follow-main.json'), n = notifier(), now = T0 + 10 * 60_000
    writeStatus(p, { state: 'waiting', behind_since: at(T0), checked_at: at(now), reason: "waiting for main's checks (test)" })
    const fm = createFollowMain({ statusPath: p, on: () => true, notifier: n, now: () => now, log: () => undefined })
    expect(await fm.tick()).toBeNull(); expect(n.sent).toEqual([])
  })
  it('reads a status nobody refreshed for 30 min as stale and says the timer stopped', async () => {
    const d = home(), p = join(d, 'follow-main.json'), n = notifier(), now = T0 + 45 * 60_000
    writeStatus(p, { state: 'current', live: B })
    const fm = createFollowMain({ statusPath: p, on: () => true, notifier: n, now: () => now, log: () => undefined })
    expect(fm.health()).toMatchObject({ state: 'stale', last_state: 'current' })
    await fm.tick()
    expect(n.sent[0].message).toMatch(/^This Wizard has stopped following main: the follow-main timer has not run since 2026-11-24T10:00:00/)
  })
  it('no status file reads not_installed and tells nobody', async () => {
    const d = home(), n = notifier()
    const fm = createFollowMain({ statusPath: join(d, 'follow-main.json'), on: () => true, notifier: n, log: () => undefined })
    expect(fm.health()).toMatchObject({ on: true, state: 'not_installed' })
    expect(await fm.tick()).toBeNull(); expect(n.sent).toEqual([])
  })
})

describe('/wizard/health', () => {
  it('has no follow_main field while the switch is off, and shows it once the Look-file switch is on', async () => {
    const d = home()
    writeStatus(join(d, 'follow-main.json'), { state: 'current', live: B, checked_at: at(Date.now()) })
    const base = await start(d)
    const off = await (await fetch(`${base}/wizard/health`)).json()
    expect(off.status).toBe('ok'); expect(off).not.toHaveProperty('follow_main')
    setLook(d, true)
    const on = await (await fetch(`${base}/wizard/health`)).json()
    expect(on.follow_main).toMatchObject({ on: true, state: 'current', live: B, main: B })
    setLook(d, false)
    expect(await (await fetch(`${base}/wizard/health`)).json()).not.toHaveProperty('follow_main')
  })
  it('env 1 forces it on and env 0 off, whatever the Look file says', async () => {
    const d = home(); setLook(d, true)
    expect(await (await fetch(`${await start(d, { followMain: false })}/wizard/health`)).json()).not.toHaveProperty('follow_main')
    const d2 = home()
    expect((await (await fetch(`${await start(d2, { followMain: true })}/wizard/health`)).json()).follow_main).toMatchObject({ on: true, state: 'not_installed' })
  })
})
