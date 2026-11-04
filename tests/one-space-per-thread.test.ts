// A chat is in at most one Space of its agent (James, 29 Oct 2026: "A message should only be in one space").
// Every writer is held to it: owner PATCH (phone and desktop share it), Space creation, agent Spaces tools and
// automatic status filing, and full PUT snapshots from older shells. Moving never touches another agent's Spaces, and status filing never refiles a chat.
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWizardServer, listen } from '../server/service.mjs'
import { readUiPreferences, updateUiPreferences } from '../server/ui-preferences.mjs'
import { createSpaceFiling, SPACE_INSTRUCTIONS } from '../server/thread-spaces.mjs'
import { STATUS_INSTRUCTIONS } from '../server/thread-status.mjs'
import { createSpacesTools } from '../server/spaces-tools.mjs'
const servers: any[] = [], dirs: string[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(r)))); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
const home = () => { const d = mkdtempSync(join(tmpdir(), 'one-space-')); dirs.push(d); return d }
const space = (id: string, threads: string[] = [], agent?: string) => ({ id, name: id, threads, createdAt: '2026-10-29T00:00:00Z', ...(agent ? { agent } : {}) })
async function start(d: string) {
  const s = createWizardServer({ wizardOsHome: d, hermesKey: 'test', agentBridge: false, followThrough: false, requireAccess: false, runQueueStatePath: join(d, 'q.db'), runQueuePollIntervalMs: 0 })
  servers.push(s); const a: any = await listen(s); return `http://127.0.0.1:${a.port}/wizard/v1/ui-preferences`
}
const patch = (u: string, ops: any[]) => fetch(u, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops }) })
const members = (spaces: any[]) => Object.fromEntries(spaces.map(s => [s.id, s.threads]))
const seed = (d: string) => updateUiPreferences(join(d, 'ui-preferences.json'), { compact: true, spaces: [space('a', ['t1', 'keep']), space('b', ['other']), space('phil', ['t1'], 'philosopher')] })

it('moving A to B leaves only B, survives a restart, and never touches another agent’s Space', async () => {
  const d = home(); seed(d); let u = await start(d)
  expect((await patch(u, [{ op: 'add', key: 'spaces/b/threads', item: 't1' }])).status).toBe(200)
  const want = { a: ['keep'], b: ['other', 't1'], phil: ['t1'] }
  expect(members((await (await fetch(u)).json()).spaces)).toEqual(want)
  await new Promise<void>(r => servers.pop().close(r)); u = await start(d) // reload: read back from disk
  const got = await (await fetch(u)).json()
  expect(members(got.spaces)).toEqual(want); expect(got.compact).toBe(true)
})

it('the same Space again is a no-op; remove leaves the chat unfiled', async () => {
  const d = home(); seed(d); const u = await start(d)
  const once = await (await patch(u, [{ op: 'add', key: 'spaces/a/threads', item: 't1' }])).json()
  expect(members(once.spaces)).toEqual({ a: ['t1', 'keep'], b: ['other'], phil: ['t1'] })
  const out = await (await patch(u, [{ op: 'remove', key: 'spaces/a/threads', item: 't1' }])).json()
  expect(out.spaces.filter((s: any) => (s.agent || 'hermes') === 'hermes').some((s: any) => s.threads.includes('t1'))).toBe(false)
  expect(members(out.spaces).phil).toEqual(['t1'])
})

it('a new Space created with chats takes them from that agent’s other Spaces', async () => {
  const d = home(); seed(d); const u = await start(d)
  const out = await (await patch(u, [{ op: 'add', key: 'spaces', item: space('c', ['t1', 'other']) }])).json()
  expect(members(out.spaces)).toEqual({ a: ['keep'], b: [], phil: ['t1'], c: ['t1', 'other'] })
})

it('automatic status filing files only unfiled chats and never refiles a chat already in a Space', () => {
  const d = home(); seed(d); const path = join(d, 'ui-preferences.json'), filing = createSpaceFiling(path)
  expect(filing.apply('hermes', 't1', { space: 'b' })).toBe(false) // already in a: the owner's choice stands
  expect(filing.apply('hermes', 'fresh', { space: 'b' })).toBe(true)
  expect(filing.apply('hermes', 'fresh', { space: 'a' })).toBe(false) // one membership, never a second
  expect(filing.apply('philosopher', 'keep', { space: 'phil' })).toBe(true) // another agent's Spaces are separate
  expect(members(readUiPreferences(path).spaces)).toEqual({ a: ['t1', 'keep'], b: ['other', 'fresh'], phil: ['t1', 'keep'] })
})

it('the injected status contract states the one-Space rule, not additive membership', () => {
  for (const text of [SPACE_INSTRUCTIONS, STATUS_INSTRUCTIONS]) {
    expect(text).not.toMatch(/without removing the thread from other Spaces/u)
    expect(text).toContain('one Space at a time')
  }
})

it('agent Spaces tools move a chat between the caller’s own Spaces only', async () => {
  const d = home(), path = join(d, 'ui-preferences.json')
  updateUiPreferences(path, { spaces: [space('p1', ['x'], 'philosopher'), space('p2', [], 'philosopher'), space('main', ['x'])] })
  const tools = createSpacesTools({ path, loadThreads: async () => [{ id: 'x' }], threadExists: async () => true })
  const r = await tools.call('spaces_add', { space_id: 'p2', thread_ids: ['x'] }, 'philosopher')
  expect(r.isError).toBeFalsy()
  expect(members(readUiPreferences(path).spaces)).toEqual({ p1: [], p2: ['x'], main: ['x'] })
})

it('a full PUT (older shell snapshot) cannot leave a chat in two Spaces of one agent', async () => {
  const d = home(); seed(d); const u = await start(d)
  const put = (spaces: any[]) => fetch(u, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spaces }) })
  // Add-only client: t1 newly joined b, still listed in a -> it moved to b.
  let out = await (await put([space('a', ['t1', 'keep']), space('b', ['other', 't1']), space('phil', ['t1'], 'philosopher')])).json()
  expect(members(out.spaces)).toEqual({ a: ['keep'], b: ['other', 't1'], phil: ['t1'] })
  // `other` newly joined a: it moved there out of b; another agent's Space is never touched.
  out = await (await put([space('a', ['keep', 'other']), space('b', ['other', 't1']), space('phil', ['t1'], 'philosopher')])).json()
  expect(members(out.spaces)).toEqual({ a: ['keep', 'other'], b: ['t1'], phil: ['t1'] })
  expect(members(readUiPreferences(join(d, 'ui-preferences.json')).spaces)).toEqual({ a: ['keep', 'other'], b: ['t1'], phil: ['t1'] })
})

const put = (u: string, body: any) => fetch(u, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const legacy = (d: string) => {
  const spaces = [space('a', ['dup', 'other']), space('b', ['dup']), space('c'), space('phil', ['dup'], 'philosopher')]
  writeFileSync(join(d, 'ui-preferences.json'), JSON.stringify({ compact: true, future: { kept: true }, spaces }) + '\n')
  return spaces
}

it('an unrelated full PUT, rename or reorder preserves unresolved legacy duplicates and other stored keys', async () => {
  const d = home(), spaces = legacy(d), u = await start(d)
  const reordered = [spaces[1], { ...spaces[0], name: 'Renamed' }, spaces[3], spaces[2]]
  expect((await put(u, { spaces: reordered, readyOrder: 'oldest' })).status).toBe(200)
  expect((await (await fetch(u)).json()).spaces).toEqual(reordered)
  expect(JSON.parse(readFileSync(join(d, 'ui-preferences.json'), 'utf8')).future).toEqual({ kept: true })
  expect((await put(u, { compact: false })).status).toBe(200)
  await new Promise<void>(r => servers.pop().close(r))
  expect((await (await fetch(await start(d))).json()).spaces).toEqual(reordered)
})

it('an unambiguous full-PUT move resolves only the chosen legacy chat, not unrelated duplicates', async () => {
  const d = home(), spaces = legacy(d), u = await start(d)
  spaces[1].threads.push('other') // unchanged legacy duplicate below must survive another chat moving
  writeFileSync(join(d, 'ui-preferences.json'), JSON.stringify({ spaces }))
  spaces[2].threads.push('dup')
  const r = await put(u, { spaces }); expect(r.status).toBe(200)
  expect(members((await r.json()).spaces)).toEqual({ a: ['other'], b: ['other'], c: ['dup'], phil: ['dup'] })
})

it('an explicit full-PUT removal or keeper choice resolves a legacy duplicate without adding membership', async () => {
  for (const keeper of ['a', 'b', null]) {
    const d = home(), spaces = legacy(d), u = await start(d)
    const selected = spaces.map(s => s.id !== keeper && (s.id === 'a' || s.id === 'b') ? { ...s, threads: s.threads.filter(t => t !== 'dup') } : s)
    expect((await put(u, { spaces: selected })).status).toBe(200)
    expect((await (await fetch(u)).json()).spaces).toEqual(selected)
  }
})

it('a new duplicate or multiple new targets rejects the whole PUT atomically, independent of array order', async () => {
  for (const existing of [false, true]) for (const reverse of [false, true]) {
    const d = home(), spaces = legacy(d), file = join(d, 'ui-preferences.json'), before = readFileSync(file, 'utf8'), u = await start(d)
    const thread = existing ? 'dup' : 'new-chat'
    const proposed = [...spaces, space('d', [thread])].map(s => s.id === 'c' ? { ...s, threads: [thread] } : s)
    const r = await put(u, { compact: false, spaces: reverse ? proposed.reverse() : proposed })
    expect(r.status).toBe(400); expect(await r.json()).toMatchObject({ error: 'invalid_preferences' })
    expect(readFileSync(file, 'utf8')).toBe(before)
  }
})

it('changing a Space owner cannot grandfather duplicate memberships under its old owner', async () => {
  const d = home(), file = join(d, 'ui-preferences.json')
  const spaces = [space('a', ['x'], 'philosopher'), space('b', ['x'], 'philosopher')]
  writeFileSync(file, JSON.stringify({ spaces })); const before = readFileSync(file, 'utf8'), u = await start(d)
  expect((await put(u, { spaces: spaces.map(s => ({ ...s, agent: 'hermes' })) })).status).toBe(400)
  expect(readFileSync(file, 'utf8')).toBe(before)
})

it('omitted and explicit hermes owners are the same, while separate agents may keep the same chat id', async () => {
  const d = home(), u = await start(d)
  expect((await put(u, { spaces: [space('a', ['x']), space('b', ['x'], 'hermes')] })).status).toBe(400)
  const spaces = [space('a', ['x']), space('b', ['x'], 'philosopher')]
  expect((await put(u, { spaces })).status).toBe(200)
  expect((await (await fetch(u)).json()).spaces).toEqual(spaces)
})

it('automatic status filing preserves unresolved legacy owner choices while filing a different unfiled chat', () => {
  const d = home(), spaces = legacy(d), path = join(d, 'ui-preferences.json'), filing = createSpaceFiling(path)
  expect(filing.apply('hermes', 'dup', { space: 'c' })).toBe(false)
  expect(filing.apply('hermes', 'fresh', { space: 'c' })).toBe(true)
  expect(members(readUiPreferences(path).spaces)).toEqual({ ...members(spaces), c: ['fresh'] })
})

it('owner PATCH explicitly selects a legacy keeper or removes one membership without bulk reconciliation', async () => {
  const d = home(); legacy(d); const u = await start(d)
  let r = await patch(u, [{ op: 'add', key: 'spaces/b/threads', item: 'dup' }])
  expect(r.status).toBe(200)
  expect(members((await r.json()).spaces)).toEqual({ a: ['other'], b: ['dup'], c: [], phil: ['dup'] })
  legacy(d)
  r = await patch(u, [{ op: 'remove', key: 'spaces/a/threads', item: 'dup' }])
  expect(r.status).toBe(200)
  expect(members((await r.json()).spaces)).toEqual({ a: ['other'], b: ['dup'], c: [], phil: ['dup'] })
})
