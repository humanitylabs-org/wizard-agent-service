import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateUiPreferences, sanitizeUiPreferences, updateUiPreferences, readUiPreferences } from '../server/ui-preferences.mjs'

// wizard-ux#1929: the phone bar's pinned slot (switch wizard/phone-sections) follows the owner to every device.
describe('phoneSlot ui preference', () => {
  it('accepts an app id or empty (Messenger), refuses anything else, and has no default', () => {
    for (const phoneSlot of ['', 'messenger', 'wizard-calendar', 'app.v2_x']) expect(validateUiPreferences({ phoneSlot })).toEqual({ phoneSlot })
    for (const phoneSlot of [null, 1, 'a b', '../x', 'x'.repeat(81), ['messenger']]) expect(() => validateUiPreferences({ phoneSlot })).toThrow('invalid_preferences')
    expect(sanitizeUiPreferences({}).phoneSlot).toBeUndefined()
    expect(sanitizeUiPreferences({ phoneSlot: 'bad id' }).phoneSlot).toBeUndefined()
  })
  it('a second device reads the pin and the reset, and other keys are kept', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phone-slot-'))
    try {
      const file = join(dir, 'prefs.json')
      updateUiPreferences(file, { readyOrder: 'priority', compact: true })
      updateUiPreferences(file, { phoneSlot: 'wizard-calendar' })
      expect(readUiPreferences(file)).toMatchObject({ phoneSlot: 'wizard-calendar', readyOrder: 'priority', compact: true })
      updateUiPreferences(file, { phoneSlot: '' })
      expect(readUiPreferences(file).phoneSlot).toBe('')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
