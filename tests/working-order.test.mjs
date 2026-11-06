import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateUiPreferences, sanitizeUiPreferences, updateUiPreferences, readUiPreferences } from '../server/ui-preferences.mjs';
test('Working order validates independently and does not alter Ready defaults', () => {
  assert.equal(sanitizeUiPreferences({}).readyOrder, 'newest');
  assert.equal(sanitizeUiPreferences({}).workingOrder, undefined, 'missing choice is the shell A to Z default');
  for (const workingOrder of ['alphabetical', 'newest', 'oldest']) assert.deepEqual(validateUiPreferences({ workingOrder }), { workingOrder });
  for (const workingOrder of ['priority', '', null, 1]) assert.throws(() => validateUiPreferences({ workingOrder }), { message: 'invalid_preferences' });
});
test('persist and read Working for a second device without replacing Ready or other keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'working-order-'));
  try {
    const file = join(dir, 'prefs.json');
    updateUiPreferences(file, { readyOrder: 'priority', compact: true });
    updateUiPreferences(file, { workingOrder: 'oldest' });
    const next = readUiPreferences(file);
    assert.equal(next.workingOrder, 'oldest'); assert.equal(next.readyOrder, 'priority'); assert.equal(next.compact, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
