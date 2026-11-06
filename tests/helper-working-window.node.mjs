import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveCandidate, selectWindow } from '../server/session-list-window.mjs';
const now = Date.now(), old = now - 30 * 864e5;
test('a background helper is active even with an old owner ask and outside the first 50 Archive rows', () => {
  for (const background of ['helper', 'heavy']) {
    const s = { id: 'active-helper', status: 'completed', title: 'Messenger settings', wizard_background: background,
      last_active: old / 1000, wizard_attention: { state: 'needs_you', ask: 'Try Messenger' } };
    const archives = Array.from({ length: 60 }, (_, i) => ({ id: 'old-' + i, title: 'Old chat ' + i, status: 'completed', last_active: (old + i * 1000) / 1000 }));
    const active = selectWindow([...archives, s], { now });
    assert.ok(active.rows.some(x => x.id === s.id));
    assert.equal(active.archive_total, 60);
    s.wizard_background = '';
    const ended = selectWindow([...archives, s], { now });
    assert.equal(ended.archive_total, 61);
    assert.ok(!ended.rows.some(x => x.id === s.id));
  }
});
test('explicit archive and tracker-only running state keep their original window membership', () => {
  const base = { status: 'completed', title: 'Idle ask', updatedAt: new Date(old).toISOString() };
  assert.equal(archiveCandidate({ ...base, archived: true, background: 'helper' }, now), true);
  assert.equal(archiveCandidate({ ...base, items: [{ state: 'running' }], tracker: { running: 1 } }, now), true);
  assert.equal(archiveCandidate({ ...base, background: 'helper' }, now), false);
});
