// Cross-repo packaging contract test, opt-in to an explicit WAM checkout.
// WAM_REPO=<checkout> WAM_TEST_PYTHON=<python-with-pyyaml> node --test tests/chats-install-e2e.node.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWizardServer, listen } from '../server/service.mjs';

test('pinned fixture install -> registry -> module -> selection -> tamper refusal -> uninstall',
  { skip: !process.env.WAM_REPO }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'chats-install-e2e-'));
    let server;
    try {
      const fixture = operation => JSON.parse(execFileSync(process.env.WAM_TEST_PYTHON || 'python3',
        [join(process.env.WAM_REPO, 'scripts/chats-fixture.py'), root, operation], {
          encoding: 'utf8', env: { ...process.env, WIZARD_OS_HOME: join(root, 'owner') },
        }));
      const installed = fixture('install');
      const home = join(root, 'service');
      server = createWizardServer({ appsJsonPath: installed.apps_json, wizardOsHome: home, agentBridge: false,
        requireJoinedDelegationCapability: false, upstreamOrigin: 'http://127.0.0.1:9', hermesKey: 'fixture-key',
        requireAccess: false, followThrough: false, settingsPath: join(home, 'settings.json'),
        mediaRoot: join(home, 'media'), mediaIndexPath: join(home, 'media-index.json'),
        runQueueStatePath: join(home, 'queue.sqlite3'), runQueuePollIntervalMs: 0,
        activeSessionReader: async () => [], dispatchHealthReader: () => true });
      const address = await listen(server), base = `http://127.0.0.1:${address.port}`;
      const registry = async () => (await fetch(base + '/wizard/v1/apps')).json();
      const initial = await registry(), provider = initial.apps.find(a => a.id === 'mizel-chats');
      assert.deepEqual(provider.provides, ['chats']); assert.equal(provider.chats_view.sha256.length, 64);
      assert.equal(provider.chats_view.commit, 'a'.repeat(40));
      assert.equal(initial.slots.chats.default, 'wizard-chats');
      assert.ok(provider.chats_view.module.startsWith(provider.url));
      assert.equal((await fetch(base + provider.chats_view.module)).status, 200);
      fixture('choose'); assert.equal((await registry()).slots.chats.default, 'mizel-chats');
      writeFileSync(join(root, 'tipi/app-data/wizard-os/chats-views/mizel-chats', provider.chats_view.sha256 + '.js'), 'tampered');
      assert.equal((await fetch(base + provider.chats_view.module)).status, 409);
      fixture('uninstall'); assert.equal((await registry()).slots.chats.default, 'wizard-chats');
      assert.equal((await registry()).apps.length, 0);
      assert.equal((await fetch(base + provider.chats_view.module)).status, 404);
    } finally {
      if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
      rmSync(root, { recursive: true, force: true });
    }
  });
