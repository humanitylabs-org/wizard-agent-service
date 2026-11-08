import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ThreadTitleStore, provisionalTitleFrom, titleContextLine, titleToApply } from '../server/thread-titles.mjs'
const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })
const store = async () => { const d = await mkdtemp(join(tmpdir(), 'wizard-titles-')); dirs.push(d); return new ThreadTitleStore(join(d, 't.json')) }
it('cuts a short placeholder from the first message', () => {
  expect(provisionalTitleFrom('Fix the calendar sync bug on the phone app please')).toBe('Fix the calendar sync bug')
  expect(provisionalTitleFrom('Hey, can you plan a Tokyo trip itinerary for March?')).toBe('Plan a Tokyo trip itinerary')
  expect(provisionalTitleFrom('Are you unable to merge it? I would like you to just merge it.')).toBe('Are you unable to merge')
  expect(provisionalTitleFrom('x'.repeat(80)).length).toBeLessThanOrEqual(32)
})
it('ignores attachment blocks, links, screen context and empty text', () => {
  expect(provisionalTitleFrom('[WIZARD_FILES_V1][{"id":"a"}][/WIZARD_FILES_V1]')).toBe('')
  expect(provisionalTitleFrom('https://example.com/a/b')).toBe('')
  expect(provisionalTitleFrom('hey')).toBe('')
  expect(provisionalTitleFrom('Summarise this paper\n[Wizard OS context] Window in front: Browser')).toBe('Summarise this paper')
})
it('sets a placeholder once and never over an existing title, a lock or an agent title', async () => {
  const s = await store()
  expect(s.setProvisional('t1', 'Fix calendar sync')?.provisional).toBe(true)
  expect(s.setProvisional('t1', 'Another words')).toBeNull() // title already there
  s.recordRename('t2', { from: 'Old', to: 'Owner name', by: 'you' })
  expect(s.setProvisional('t2', 'Placeholder')).toBeNull()
  s.recordRename('t3', { from: '', to: 'Wizard OS · Phone app', by: 'agent' })
  expect(s.setProvisional('t3', 'Placeholder')).toBeNull()
})
it('the agent title replaces the placeholder (even a longer project label) and the placeholder is gone after', async () => {
  const s = await store()
  s.setProvisional('t1', 'Wizard OS')
  const record = s.get('t1')!
  expect(titleToApply({ currentTitle: 'Wizard OS', proposed: 'Wizard OS · Phone app', record, assistantAt: 5 })).toBe('Wizard OS · Phone app')
  expect(titleToApply({ currentTitle: 'Wizard OS', proposed: 'Wizard OS · Phone app', record: { ...record, provisional: false }, assistantAt: 5 })).toBe('')
  s.recordRename('t1', { from: 'Wizard OS', to: 'Wizard OS · Phone app', by: 'agent', assistantAt: 5 })
  expect(s.get('t1')?.provisional).toBeUndefined()
  expect(titleContextLine('Fix calendar sync', record)).toMatch(/placeholder/)
})
it('survives a reload and keeps the owner lock authoritative', async () => {
  const d = await mkdtemp(join(tmpdir(), 'wizard-titles-')); dirs.push(d)
  const a = new ThreadTitleStore(join(d, 't.json')); a.setProvisional('t1', 'Fix calendar sync')
  const b = new ThreadTitleStore(join(d, 't.json')); expect(b.get('t1')).toMatchObject({ title: 'Fix calendar sync', provisional: true })
  b.recordRename('t1', { from: 'Fix calendar sync', to: 'Mine', by: 'you' })
  expect(titleToApply({ currentTitle: 'Mine', proposed: 'Other', record: b.get('t1')!, assistantAt: 9 })).toBe('')
})
