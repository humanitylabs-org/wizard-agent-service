import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateUiPreferences, sanitizeUiPreferences, updateUiPreferences, readUiPreferences } from '../server/ui-preferences.mjs'

// wizard-ux issue 1955: the phone Apps panel's Favorites and the apps taken off Recent (switch wizard/apps-panel)
// follow the owner to every device.
describe('appFavorites and appRecentHidden ui preferences', () => {
  it('accept a list of app ids, refuse anything else, and have no default', () => {
    for (const key of ['appFavorites', 'appRecentHidden']) {
      for (const v of [[], ['notes'], ['wizard-calendar', 'wizard-music', 'app.v2_x']]) expect(validateUiPreferences({ [key]: v })).toEqual({ [key]: v })
      for (const v of [null, 'notes', [''], ['a b'], ['../x'], ['x'.repeat(81)], ['notes', 'notes'], [1], Array.from({ length: 101 }, (_, i) => `a${i}`)])
        expect(() => validateUiPreferences({ [key]: v })).toThrow('invalid_preferences')
      expect(sanitizeUiPreferences({})[key]).toBeUndefined()
      expect(sanitizeUiPreferences({ [key]: ['bad id'] })[key]).toBeUndefined()
    }
  })
  it('a second device reads the same Favorites and Recent removals, and other keys are kept', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apps-panel-'))
    try {
      const file = join(dir, 'prefs.json')
      updateUiPreferences(file, { phoneSlot: 'messenger', readyOrder: 'priority' })
      updateUiPreferences(file, { appFavorites: ['wizard-calendar', 'wizard-music'] })
      updateUiPreferences(file, { appRecentHidden: ['notes'] })
      expect(readUiPreferences(file)).toMatchObject({ appFavorites: ['wizard-calendar', 'wizard-music'], appRecentHidden: ['notes'], phoneSlot: 'messenger', readyOrder: 'priority' })
      updateUiPreferences(file, { appFavorites: ['wizard-music', 'wizard-calendar'], appRecentHidden: [] })
      expect(readUiPreferences(file)).toMatchObject({ appFavorites: ['wizard-music', 'wizard-calendar'], appRecentHidden: [] })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
