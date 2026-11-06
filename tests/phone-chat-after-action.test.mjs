import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_UI_PREFERENCES, validateUiPreferences, sanitizeUiPreferences, readUiPreferences, updateUiPreferences } from '../server/ui-preferences.mjs';
test('phone action preference defaults to stay without a migration write', () => {
 assert.equal(DEFAULT_UI_PREFERENCES.chatAfterAction, 'stay');
 assert.equal(sanitizeUiPreferences({}).chatAfterAction, 'stay');
 assert.equal(sanitizeUiPreferences({ chatAfterAction: 'malformed', compact: true }).chatAfterAction, 'stay');
});
test('phone action values are strict and do not alter unrelated preferences', () => {
 for (const value of ['stay', 'list']) assert.deepEqual(validateUiPreferences({ chatAfterAction: value }), { chatAfterAction: value });
 for (const value of ['back', 'STAY', 1, null, true, [], {}]) assert.throws(() => validateUiPreferences({ chatAfterAction: value }));
});
test('two clients and restart read the same atomic preference, preserving other keys', () => {
 assert(process.env.TMPDIR, 'use runtime scratch, never system temp');
 const dir = mkdtempSync(join(process.env.TMPDIR, 'chat-action-'));
 try {
  const file = join(dir, 'ui-preferences.json');
  updateUiPreferences(file, { compact: true, pinnedChats: ['synthetic-chat'], chatAfterAction: 'list' });
  const second = readUiPreferences(file); assert.equal(second.chatAfterAction, 'list'); assert.equal(second.compact, true);
  assert.deepEqual(second.pinnedChats, ['synthetic-chat']);
  updateUiPreferences(file, { chatAfterAction: 'stay' }); assert.equal(readUiPreferences(file).chatAfterAction, 'stay');
  const before = readFileSync(file, 'utf8'); assert.throws(() => updateUiPreferences(file, { chatAfterAction: 'invalid', compact: false }));
  assert.equal(readFileSync(file, 'utf8'), before);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
