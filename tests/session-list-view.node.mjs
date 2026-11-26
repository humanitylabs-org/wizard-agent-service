import test from 'node:test';
import assert from 'node:assert/strict';
import { listRow, normalizeFull } from '../server/session-list-view.mjs';
const fixture = { id: 'synthetic', source: 'telegram', title: 'A full title '.repeat(20), agent: { id: 'hermes', label: 'Not needed' }, status: 'failed', message_count: 8,
  wizard_started_at: 1699999000, wizard_last_user_at: 1700000000, wizard_last_assistant_at: 1700000100, wizard_activity_at: 1700000101,
  wizard_request_preview: 'FULL REQUEST '.repeat(300), latest_message: { role: 'assistant', content: '<memory-context>not visible</memory-context> **Visible** '+ 'answer '.repeat(50), timestamp: 1700000100 },
  wizard_run_id: 'run-exact', wizard_last_run_idempotency_key: 'key-exact', model: 'model-exact', provider: 'provider-exact', wizard_model_lock_updated_at: 123456789,
  wizard_helper_status: { phase: 'returned', canContinue: true }, wizard_safe_error: 'Safe failure', wizard_attention_level: 'critical', wizard_waiting_on: 'helper', wizard_background: 'helper',
  wizard_title_renames: [{ from: 'Old', to: 'New', at: 123 }], wizard_attention: { state: 'needs_you', ask: 'Check me', subject: 'Subject' },
  wizard_follow_up: { active: true, count: 1, names: ['Knowledge MVP'], nextRun: '2026-10-24T01:00:00.000Z' },
  wizard_reconnect: { kind: 'provider_signed_out', provider: 'claude', app_id: 'wizard-claude', installed: true, app_status: 'expired' },
  wizard_last_run_error: { code: 'provider_billing', provider: 'openai-codex', message: 'Synthetic plan ended' } };
test('list keeps exact grouping/unread/ack/model/helper inputs and full title', () => {
  const full = normalizeFull(fixture), list = listRow(fixture);
  for (const key of Object.keys(full).filter(k => !['request','renames','runtime','preview'].includes(k))) assert.deepEqual(list[key],full[key],key);
  assert.equal(list.preview,full.preview.slice(0,140)); assert.equal(list.preview.length,140);
  assert.equal(list.agent,'hermes'); assert.equal(list.listVersion,1);
  assert.deepEqual(list.followUp, fixture.wizard_follow_up);
  for (const k of ['request','renames','wizard_request_preview','latest_message','last_user_message','wizard_title_renames']) assert.equal(k in list,false,k);
});
test('clean attachments before clipping; Working helpers show the latest reply', () => {
  const row = listRow({ ...fixture, status:'running', last_user_message: { content:'[WIZARD_FILES_V1][{"mime":"image/png","filename":"one.png"}][/WIZARD_FILES_V1] hello' } });
  assert.ok(row.preview.startsWith('Visible answer'));
  assert.equal(listRow({ ...fixture, status: 'running', wizard_helper_status: null, last_user_message: { content: 'Request text' } }).preview, 'Request text');
  assert.equal(row.previewRole,'assistant'); // legacy unread semantics, not inferred from selected text
});
test('aliases, empty rows and optional metadata remain compatible', () => {
  assert.equal(listRow({title:'missing'}),null);
  assert.equal(listRow({id:'x',status:'accepted'}).status,'queued');
  assert.equal(listRow({id:'x'}).updatedAt,'1970-01-01T00:00:00.000Z');
  assert.equal(listRow({id:'x'}).startedAt,undefined);
});
// wizard-ux issue 1289: a channel feed orders posts by when each thread started, so every list row carries that
// time, and a later reply (last user/assistant/activity times) never changes it. Main and routed kinds alike.
test('rows carry the thread start time, unmoved by later replies, main and routed (host-profile, container, restricted)', () => {
  for (const kind of ['main', 'host-profile', 'container', 'restricted']) {
    const agent = kind === 'main' ? '' : `qa-${kind}`;
    // Main rows get wizard_started_at from the Service's state.db read; routed rows carry Hermes' own started_at.
    const base = { id: `start-${kind}`, title: 'Synthetic', status: 'completed', ...(agent ? { agent, started_at: 1700000000 } : { wizard_started_at: 1700000000 }) };
    const first = listRow({ ...base, wizard_last_user_at: 1700000000 });
    const replied = listRow({ ...base, wizard_last_user_at: 1700009000, wizard_last_assistant_at: 1700009100, wizard_activity_at: 1700009100 });
    assert.equal(first.startedAt, '2023-11-14T22:13:20.000Z', kind);
    assert.equal(replied.startedAt, first.startedAt, kind);
    assert.notEqual(replied.updatedAt, first.updatedAt, kind);
  }
});
// A reply can carry a tweak card ([WIZARD_TWEAK_V1]{"id":…}[/WIZARD_TWEAK_V1], wizard-ux core/chat-kit.js). The marker is
// drawn as a switch in the thread and never shows as text in the Chats list, for the main agent and every routed kind.
test('tweak-card marker never reaches the list preview, main and routed (host-profile, container, restricted)', () => {
  const mark = '[WIZARD_TWEAK_V1]{"id":"wizard/desktop-chats"}[/WIZARD_TWEAK_V1]';
  for (const kind of ['main', 'host-profile', 'container', 'restricted']) {
    const agent = kind === 'main' ? '' : `qa-${kind}`;
    const base = { id: `tweak-${kind}`, title: 'Synthetic', status: 'completed', ...(agent ? { agent } : {}), wizard_last_user_at: 1700000000 };
    for (const content of [`Shipped the phone list. It starts off.\n\n${mark}\n\nSay if it reads right.`, `Shipped the phone list. It starts off.\n\n${mark.slice(0, 30)}`]) {
      const row = listRow({ ...base, latest_message: { role: 'assistant', content, timestamp: 1700000100 } });
      assert.equal(row.agent, agent, kind);
      assert.doesNotMatch(row.preview, /WIZARD|TWEAK|desktop-chats/, `${kind}: ${row.preview}`);
      assert.match(row.preview, /^Shipped the phone list\. It starts off\./, kind);
      assert.equal(normalizeFull({ ...base, latest_message: { role: 'assistant', content } }).preview, row.preview, `${kind} full = slim`);
    }
    assert.equal(listRow({ ...base, latest_message: { role: 'assistant', content: 'No card here.' } }).preview, 'No card here.');
  }
});
// A reply can carry an app's action card ([WIZARD_ACTION_V1]{"app":…,"id":…}[/WIZARD_ACTION_V1], wizard-ux issue 1463,
// core/chat-kit.js actionIds). The marker is drawn as a card in the thread and never shows as text in the Chats list,
// for the main agent and every routed kind.
test('action-card marker never reaches the list preview, main and routed (host-profile, container, restricted)', () => {
  const mark = '[WIZARD_ACTION_V1]{"app":"wizard-messenger","id":"draft-1"}[/WIZARD_ACTION_V1]';
  for (const kind of ['main', 'host-profile', 'container', 'restricted']) {
    const agent = kind === 'main' ? '' : `qa-${kind}`;
    const base = { id: `action-${kind}`, title: 'Synthetic', status: 'completed', ...(agent ? { agent } : {}), wizard_last_user_at: 1700000000 };
    for (const content of [`I drafted a reply to Sam.\n\n${mark}\n\nSend it?`, `I drafted a reply to Sam.\n\n${mark.slice(0, 30)}`]) {
      const row = listRow({ ...base, latest_message: { role: 'assistant', content, timestamp: 1700000100 } });
      assert.equal(row.agent, agent, kind);
      assert.doesNotMatch(row.preview, /WIZARD|ACTION|draft-1|messenger/, `${kind}: ${row.preview}`);
      assert.match(row.preview, /^I drafted a reply to Sam\./, kind);
      assert.equal(normalizeFull({ ...base, latest_message: { role: 'assistant', content } }).preview, row.preview, `${kind} full = slim`);
    }
  }
});
// wizard-ux issue 1766: the compact list keeps the app a chat started in, so the shell can say a Telegram chat lives in
// Telegram (no Retry Hermes always refuses). A row with no source carries no key.
test('list rows keep the chat source (telegram, slack); a row without one has none', () => {
  assert.equal(listRow(fixture).source, 'telegram');
  assert.equal(listRow({ id: 'tg', source: 'slack', status: 'failed' }).source, 'slack');
  assert.equal('source' in listRow({ id: 'plain' }), false);
});
// Reply buttons (wizard-ux issue 1889, switch wizard/reply-buttons): a reply's [WIZARD_BUTTONS_V1] group previews as
// its labels in brackets, and the owner's taps message as its "Tapped …" line, never the JSON, for every kind.
test('reply buttons and taps preview as plain words, main and routed (host-profile, container, restricted)', () => {
  const group = '[WIZARD_BUTTONS_V1]{"group":"Ship desks","buttons":[{"id":"go","label":"Go for it"},{"id":"drop","label":"Drop this"}]}[/WIZARD_BUTTONS_V1]'
  const taps = 'Tapped Done · Workout\n[WIZARD_TAPS_V1]{"taps":[{"thread":"t","message":"41","group":"Workout","button":"done","label":"Done"}]}[/WIZARD_TAPS_V1]'
  for (const kind of ['main', 'host-profile', 'container', 'restricted']) {
    const agent = kind === 'main' ? '' : `qa-${kind}`
    const base = { id: `buttons-${kind}`, title: 'Synthetic', status: 'completed', ...(agent ? { agent } : {}), wizard_last_user_at: 1700000000 }
    const reply = listRow({ ...base, latest_message: { role: 'assistant', content: `Ship desks?\n${group}`, timestamp: 1700000100 } })
    assert.equal(reply.agent, agent, kind)
    assert.equal(reply.preview, 'Ship desks? [Go for it] [Drop this]', kind)
    assert.equal(listRow({ ...base, latest_message: { role: 'assistant', content: `Ship desks?\n${group.slice(0, 40)}`, timestamp: 1700000100 } }).preview, 'Ship desks?', `${kind}: cut off`)
    const tapped = listRow({ ...base, latest_message: { role: 'user', content: taps, timestamp: 1700000200 } })
    assert.equal(tapped.preview, 'Tapped Done · Workout', kind)
    assert.equal(normalizeFull({ ...base, latest_message: { role: 'user', content: taps } }).preview, tapped.preview, `${kind} full = slim`)
  }
})
