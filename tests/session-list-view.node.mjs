import test from 'node:test';
import assert from 'node:assert/strict';
import { listRow, normalizeFull } from '../server/session-list-view.mjs';
const fixture = { id: 'synthetic', title: 'A full title '.repeat(20), agent: { id: 'hermes', label: 'Not needed' }, status: 'failed', message_count: 8,
  wizard_last_user_at: 1700000000, wizard_last_assistant_at: 1700000100, wizard_activity_at: 1700000101,
  wizard_request_preview: 'FULL REQUEST '.repeat(300), latest_message: { role: 'assistant', content: '<memory-context>not visible</memory-context> **Visible** '+ 'answer '.repeat(50), timestamp: 1700000100 },
  wizard_run_id: 'run-exact', wizard_last_run_idempotency_key: 'key-exact', model: 'model-exact', provider: 'provider-exact', wizard_model_lock_updated_at: 123456789,
  wizard_helper_status: { phase: 'returned', canContinue: true }, wizard_safe_error: 'Safe failure', wizard_attention_level: 'critical', wizard_waiting_on: 'helper',
  wizard_title_renames: [{ from: 'Old', to: 'New', at: 123 }], wizard_attention: { state: 'needs_you', ask: 'Check me', subject: 'Subject' },
  wizard_follow_up: { active: true, count: 1, names: ['Knowledge MVP'], nextRun: '2026-10-24T01:00:00.000Z' },
  wizard_reconnect: { kind: 'provider_signed_out', provider: 'claude', app_id: 'wizard-claude', installed: true, app_status: 'expired' } };
test('list keeps exact grouping/unread/ack/model/helper inputs and full title', () => {
  const full = normalizeFull(fixture), list = listRow(fixture);
  for (const key of Object.keys(full).filter(k => !['request','renames','source','runtime','preview'].includes(k))) assert.deepEqual(list[key],full[key],key);
  assert.equal(list.preview,full.preview.slice(0,140)); assert.equal(list.preview.length,140);
  assert.equal(list.agent,'hermes'); assert.equal(list.listVersion,1);
  assert.deepEqual(list.followUp, fixture.wizard_follow_up);
  for (const k of ['request','renames','wizard_request_preview','latest_message','last_user_message','wizard_title_renames']) assert.equal(k in list,false,k);
});
test('clean attachments and memory before clipping; working selects user', () => {
  const row = listRow({ ...fixture, status:'running', last_user_message: { content:'[WIZARD_FILES_V1][{"mime":"image/png","filename":"one.png"}][/WIZARD_FILES_V1] hello' } });
  assert.equal(row.preview,'🖼 Photo hello');
  assert.equal(row.previewRole,'assistant'); // legacy unread semantics, not inferred from selected text
});
test('aliases, empty rows and optional metadata remain compatible', () => {
  assert.equal(listRow({title:'missing'}),null);
  assert.equal(listRow({id:'x',status:'accepted'}).status,'queued');
  assert.equal(listRow({id:'x'}).updatedAt,'1970-01-01T00:00:00.000Z');
});
