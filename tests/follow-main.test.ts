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
    expect(readFollowMainStatus(p)).toEqual({ state: 'behind', main: B, behind_by: 3, behind_since: at(T0), checked_at: at(T0), reason: 'the deploy stopped: refusing', cause: 'deploy' })
    writeStatus(p, { state: 'behind', cause: 'prepare', failures: 2, reason: 'x' })
    expect(readFollowMainStatus(p)).toMatchObject({ cause: 'prepare', failures: 2 })
    writeStatus(p, { state: 'behind', cause: 'nonsense', failures: -1, reason: 'the newest change on main failed its checks (test), so it is not installed' })
    expect(readFollowMainStatus(p)).toMatchObject({ cause: 'red-main' })
    expect(readFollowMainStatus(p)).not.toHaveProperty('failures')
    writeFileSync(p, JSON.stringify({ schema: 'other/1', state: 'current' }))
    expect(readFollowMainStatus(p)).toBeNull()
    expect(readFollowMainStatus(join(d, 'missing.json'))).toBeNull()
  })
  it('says how far behind, since when, why and the one step the owner can take (never "keeps retrying")', () => {
    expect(behindMessage({ state: 'behind', behind_by: 2, behind_since: at(T0), main: B, cause: 'deploy', failures: 2, reason: 'the deploy stopped: refusing to deploy' }))
      .toBe(`2 merged changes on main haven't gone live on this Wizard since 2026-11-24 10:00 UTC: the deploy stopped: refusing to deploy. It failed again after a retry. Ask your agent to run wizard-agent-service-deploy ${B} on this Wizard and fix what it reports.`)
    expect(behindMessage({ state: 'stale', reason: 'the follow-main timer has not run since x' }))
      .toBe("This Wizard has stopped following main: the follow-main timer has not run since x. Merged changes won't go live until it runs again. To restart it, run: systemctl --user enable --now wizard-agent-service-follow-main.timer")
    expect(behindMessage({ state: 'behind', behind_by: 1, reason: 'x' })).not.toMatch(/keeps retrying|Nothing to do/i)
  })
})

describe('the behind notice', () => {
  const notifier = () => { const sent: any[] = []; return { sent, available: () => true, send: async (n: any) => { sent.push(n); return { app: 'notes' } } } }
  it('is sent once per cause after a deploy failed again past its retry, never while off or current', async () => {
    const d = home(), p = join(d, 'follow-main.json'), n = notifier()
    let now = T0, on = false
    const fm = createFollowMain({ statusPath: p, on: () => on, notifier: n, now: () => now, log: () => undefined })
    writeStatus(p, { state: 'behind', behind_by: 1, behind_since: at(T0), cause: 'deploy', failures: 2, reason: 'the deploy stopped: refusing to deploy' })
    now = T0 + 31 * 60_000; writeStatus(p, { state: 'behind', behind_by: 1, behind_since: at(T0), checked_at: at(now), cause: 'deploy', failures: 2, reason: 'the deploy stopped: refusing to deploy' })
    expect(fm.health()).toBeNull(); expect(await fm.tick()).toBeNull(); expect(n.sent).toEqual([])
    on = true
    expect(fm.health()).toMatchObject({ on: true, state: 'behind', live: A, main: B, reason: 'the deploy stopped: refusing to deploy' })
    expect(await fm.tick()).toBeTruthy()
    expect(n.sent).toEqual([{ agent: 'main', title: 'Wizard is behind', message: expect.stringContaining('refusing to deploy') }])
    expect(await fm.tick()).toBeNull(); expect(n.sent).toHaveLength(1)
    // A restarted Service remembers it already told the owner.
    const again = createFollowMain({ statusPath: p, on: () => true, notifier: n, now: () => now, log: () => undefined })
    expect(await again.tick()).toBeNull(); expect(n.sent).toHaveLength(1)
    // The same cause on a newer merge is no news (issue 638: one notice per cause, not per merge).
    writeStatus(p, { state: 'behind', main: 'c'.repeat(40), behind_by: 2, behind_since: at(T0), checked_at: at(now), cause: 'deploy', failures: 3, reason: 'the deploy stopped: health check failed' })
    expect(await fm.tick()).toBeNull(); expect(n.sent).toHaveLength(1)
    // A new cause is a new notice; catching up sends nothing and makes the next episode news again.
    writeStatus(p, { state: 'behind', behind_by: 1, behind_since: at(T0), checked_at: at(now), cause: 'prepare', failures: 2, reason: "couldn't prepare the release: npm failed" })
    await fm.tick(); expect(n.sent).toHaveLength(2)
    // Back to the deploy failure in the same episode: already told.
    writeStatus(p, { state: 'behind', behind_by: 1, behind_since: at(T0), checked_at: at(now), cause: 'deploy', failures: 2, reason: 'the deploy stopped: x' })
    expect(await fm.tick()).toBeNull(); expect(n.sent).toHaveLength(2)
    expect(await createFollowMain({ statusPath: p, on: () => true, notifier: n, now: () => now, log: () => undefined }).tick()).toBeNull()
    writeStatus(p, { state: 'current', live: B, checked_at: at(now) })
    expect(await fm.tick()).toBeNull(); expect(n.sent).toHaveLength(2)
    writeStatus(p, { state: 'behind', behind_by: 1, behind_since: at(T0), checked_at: at(now), cause: 'prepare', failures: 2, reason: "couldn't prepare the release: npm failed" })
    await fm.tick(); expect(n.sent).toHaveLength(3)
  })
  it('a first deploy failure waits for its retry: the owner hears only when it fails again', async () => {
    const d = home(), p = join(d, 'follow-main.json'), n = notifier(), now = T0 + 40 * 60_000
    writeStatus(p, { state: 'behind', behind_since: at(T0), checked_at: at(now), cause: 'deploy', failures: 1, reason: 'the deploy stopped: x' })
    const fm = createFollowMain({ statusPath: p, on: () => true, notifier: n, now: () => now, log: () => undefined })
    expect(await fm.tick()).toBeNull(); expect(n.sent).toEqual([])
  })
  it('a red check on main never tells the owner, for any number of merges or hours (issue 638)', async () => {
    const d = home(), p = join(d, 'follow-main.json'), n = notifier(); let now = T0
    const fm = createFollowMain({ statusPath: p, on: () => true, notifier: n, now: () => now, log: () => undefined })
    for (const [i, main] of ['b', 'c', 'd', 'e'].entries()) {
      now = T0 + (31 + i * 60) * 60_000
      // Both what the new host step writes and what an older one wrote (no cause; read from the reason).
      for (const cause of [{ cause: 'red-main' }, {}]) {
        writeStatus(p, { state: 'behind', main: main.repeat(40), behind_by: i + 1, behind_since: at(T0), checked_at: at(now), ...cause, reason: 'the newest change on main failed its checks (test), so it is not installed' })
        expect(fm.health()).toMatchObject({ state: 'behind', cause: 'red-main' })
        expect(await fm.tick()).toBeNull()
      }
    }
    for (const [cause, reason] of [['checks-pending', "waiting for main's checks (test)"], ['github', "couldn't read main's checks from GitHub: x"]]) {
      writeStatus(p, { state: 'behind', behind_since: at(T0), checked_at: at(now), cause, reason })
      expect(await fm.tick()).toBeNull()
    }
    expect(n.sent).toEqual([])
  })
  it('a deploy only waiting for the heavy queue tells nobody, for any number of passes or hours (issue 644)', async () => {
    const d = home(), p = join(d, 'follow-main.json'), n = notifier(); let now = T0
    const fm = createFollowMain({ statusPath: p, on: () => true, notifier: n, now: () => now, log: () => undefined })
    for (let i = 0; i < 5; i++) {
      now = T0 + (31 + i * 60) * 60_000
      writeStatus(p, { state: 'waiting', behind_by: 1, behind_since: at(T0), heavy_since: at(T0), heavy_job: 'heavy_x (./mac.sh)', checked_at: at(now), cause: 'heavy-busy', reason: 'waiting for 1 heavy job to finish (heavy_x (./mac.sh)); installs when the heavy queue is idle' })
      expect(fm.health()).toMatchObject({ state: 'waiting', cause: 'heavy-busy', heavy_since: at(T0), heavy_job: 'heavy_x (./mac.sh)' })
      expect(await fm.tick()).toBeNull()
      // What an older host step wrote for the same wait: a deploy failure with the helper's heavy refusal.
      writeStatus(p, { state: 'behind', behind_by: 1, behind_since: at(T0), checked_at: at(now), cause: 'deploy', failures: i + 2, reason: 'the deploy stopped: heavy queue not idle: 1 active jobs; retry after completion' })
      expect(fm.health()).toMatchObject({ state: 'behind', cause: 'heavy-busy' })
      expect(fm.health()).not.toHaveProperty('failures')
      expect(await fm.tick()).toBeNull()
    }
    expect(n.sent).toEqual([])
  })
  it('a heavy wait past every job limit tells the owner once, naming the job, not the deploy command', async () => {
    const d = home(), p = join(d, 'follow-main.json'), n = notifier(), now = T0 + 5 * 3600_000 + 60_000
    writeStatus(p, { state: 'behind', behind_by: 1, behind_since: at(T0), heavy_since: at(T0), heavy_job: 'heavy_x (./mac.sh)', checked_at: at(now), cause: 'heavy-stuck', reason: 'heavy job heavy_x (./mac.sh) has held the heavy queue for 5 h, longer than any heavy job may run, so the update can\'t install' })
    const fm = createFollowMain({ statusPath: p, on: () => true, notifier: n, now: () => now, log: () => undefined })
    expect(await fm.tick()).toBe('heavy-stuck')
    expect(await fm.tick()).toBeNull()
    expect(n.sent).toHaveLength(1)
    expect(n.sent[0].message).toBe("Updates can't install on this Wizard: heavy job heavy_x (./mac.sh) has held the heavy queue since 2026-11-24 10:00 UTC, longer than any heavy job may run. Ask your agent to check that job and cancel it if it is stuck; the update then installs by itself.")
    expect(n.sent[0].message).not.toMatch(/wizard-agent-service-deploy/)
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
  it('a pass still deploying 45 min later is not stale (the unit allows 60 min); at 80 min it is', () => {
    const d = home(), p = join(d, 'follow-main.json'); let now = T0 + 45 * 60_000
    writeStatus(p, { state: 'deploying', behind_since: at(T0), reason: 'installing the release' })
    const fm = createFollowMain({ statusPath: p, on: () => true, now: () => now, log: () => undefined })
    expect(fm.health()).toMatchObject({ state: 'deploying' })
    now = T0 + 80 * 60_000
    expect(fm.health()).toMatchObject({ state: 'stale', last_state: 'deploying' })
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
