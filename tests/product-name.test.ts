// WizardOS is one word, always (James, 8 Nov 2026): titles, subjects, asks, voice and stored threads.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { misspellsProductName, spellProductName } from '../server/product-name.mjs'
import { ThreadTitleStore, normalizeTitle, provisionalTitleFrom, titleToApply, appTopicInText } from '../server/thread-titles.mjs'
import { STATUS_INSTRUCTIONS, normalizeStatus, parseStatus } from '../server/thread-status.mjs'
import { SubjectCatalog } from '../server/thread-subjects.mjs'
import { clientViewContext } from '../server/service.mjs'

const TWO = `Wizard${' '}OS`

describe('spellProductName', () => {
  it('writes every display spelling as WizardOS', () => {
    for (const gap of [' ', '  ', '-', ' - ', ' – ', '\u00a0']) for (const variant of [`Wizard${gap}OS`, `WIZARD${gap}OS`, ...(gap === '-' ? [] : [`wizard${gap}os`])])
      expect(spellProductName(`Ship ${variant} today`)).toBe('Ship WizardOS today')
    expect(spellProductName(`${TWO} · Desktop`)).toBe('WizardOS · Desktop')
    expect(spellProductName(`${TWO}'s shell, ${TWO}.`)).toBe("WizardOS's shell, WizardOS.")
  })
  it('keeps identifiers, paths and longer words', () => {
    for (const kept of ['wizard-os', 'humanitylabs-org/wizard-os', '~/.wizard-os/settings.json', 'wizard-os-home', 'wizard_os', 'WizardOS', 'wizardos', 'Wizard OSes', 'wizard-os/spec/AGENTS.md', 'Wizard Osaka'])
      expect(spellProductName(kept)).toBe(kept)
    expect(misspellsProductName('the wizard-os repo')).toBe(false)
    expect(misspellsProductName(TWO)).toBe(true)
  })
})

describe('titles, subjects and asks', () => {
  it('normalizes agent, provisional and topic titles', () => {
    expect(normalizeTitle(`${TWO} · Desktop`)).toBe('WizardOS · Desktop')
    expect(normalizeTitle(`${TWO.toLowerCase()}: Voice`)).toBe('WizardOS · Voice')
    expect(provisionalTitleFrom(`fix the ${TWO} chats list`)).not.toMatch(/wizard\s+os/iu)
    expect(appTopicInText(`something about ${TWO} desks`, [])).toBe('WizardOS')
    expect(provisionalTitleFrom(`the ${TWO} desks keep jumping`)).toBe('WizardOS desks keep jumping')
    expect(provisionalTitleFrom(`the ${TWO} desks keep jumping`, [] as any)).toBe('WizardOS')
  })
  it('renames a two-word title even when the agent proposes the same words', () => {
    expect(titleToApply({ currentTitle: `${TWO} · Desktop`, proposed: `${TWO} · Desktop`, record: null, assistantAt: 1, topic: '' })).toBe('WizardOS · Desktop')
    expect(titleToApply({ currentTitle: 'WizardOS · Desktop', proposed: `${TWO} · Desktop`, record: null, assistantAt: 2, topic: '' })).toBe('')
  })
  it('respells the status line: ask, subject and title', () => {
    const status = normalizeStatus({ state: 'fyi', ask: `${TWO} desks are live`, subject: TWO, title: `${TWO} · Phone app` })
    expect(status).toMatchObject({ ask: 'WizardOS desks are live', subject: 'WizardOS', title: 'WizardOS · Phone app' })
    expect(parseStatus(`Done.\n[WIZARD_STATUS_V1]{"state":"done","ask":"ok","subject":"${TWO}"}[/WIZARD_STATUS_V1]`)?.subject).toBe('WizardOS')
  })
  it('teaches the one-word name in the run instructions', () => {
    expect(misspellsProductName(STATUS_INSTRUCTIONS)).toBe(false)
    expect(STATUS_INSTRUCTIONS).toContain('"subject":"WizardOS","title":"WizardOS · Desktop"')
    expect(STATUS_INSTRUCTIONS).toContain('The product name is one word, WizardOS')
  })
  it('folds a two-word subjects.json into WizardOS, including old aliases and one-off thread fixes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wos-subjects-'))
    const path = join(dir, 'subjects.json')
    writeFileSync(path, JSON.stringify({ subjects: [{ name: TWO, about: 'the shell' }, 'Life'], aliases: { 'Wizard App': TWO }, threads: { s1: { from: TWO, subject: 'Wizard Apps' } } }))
    const catalog = new SubjectCatalog(path)
    expect(catalog.resolve('s0', TWO)).toBe('WizardOS')
    expect(catalog.resolve('s0', 'WizardOS')).toBe('WizardOS')
    expect(catalog.resolve('s0', 'Wizard App')).toBe('WizardOS')
    expect(catalog.resolve('s1', TWO)).toBe('Wizard Apps')
    expect(catalog.runNote()).toContain('WizardOS (the shell)')
    expect(misspellsProductName(catalog.runNote())).toBe(false)
  })
})

describe('stored titles and screen notes', () => {
  it('respells without taking a title from its owner or the agent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wos-titles-'))
    const store = new ThreadTitleStore(join(dir, 'thread-titles.json'), { now: () => 100 })
    store.recordRename('mine', { from: 'Old', to: `${TWO} notes`, by: 'you' })
    store.respell('mine', { from: `${TWO} notes`, to: 'WizardOS notes', locked: true })
    expect(store.get('mine')).toMatchObject({ title: 'WizardOS notes', locked: true })
    expect(store.visibleHistory('mine').every((entry: any) => !misspellsProductName(entry.to))).toBe(true)
    store.respell('auto', { from: `${TWO} · Voice`, to: 'WizardOS · Voice', locked: false })
    const auto = store.get('auto')!
    expect(auto).toMatchObject({ title: 'WizardOS · Voice', locked: false })
    expect(auto.history.at(-1)).toMatchObject({ by: 'agent', quiet: true })
    expect(store.visibleHistory('auto')).toEqual([])
  })
  it('accepts the old two-word screen note and forwards it in one word', () => {
    const note = clientViewContext(`[${TWO} context] Window in front: ${TWO} Settings`)
    expect(note).toContain('[WizardOS context] Window in front: WizardOS Settings')
    expect(clientViewContext('[WizardOS context] Window in front: Music')).toContain('[WizardOS context]')
    expect(clientViewContext('[Other context] x')).toBe('')
  })
})

describe('repository guard', () => {
  it('has no two-word product name in tracked text', () => {
    expect(() => execFileSync(process.execPath, ['scripts/check-product-name.mjs'], { encoding: 'utf8', stdio: 'pipe' })).not.toThrow()
  })
})
