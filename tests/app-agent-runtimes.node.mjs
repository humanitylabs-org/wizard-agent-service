import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRegistry } from '../server/agents.mjs';

function fixture(t, harness = 'another-harness') {
  const dir = mkdtempSync(join(tmpdir(), 'app-runtime-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const apps = join(dir, 'apps.json'), grants = join(dir, 'grants.json'), agentsDir = join(dir, 'agents');
  const runtime = { id: 'example-agent', label: 'Example', harness, port: 18659, host_port: 28659,
    model: { provider: 'wizard-router', model: 'reply' } };
  const app = { id: 'agent-example-agent', type: 'agent', agent_runtime: runtime };
  let key = createHash('sha256').update('synthetic install').digest('hex');
  const publish = (rows = [app]) => writeFileSync(apps, JSON.stringify({ schema: 2, apps: rows }));
  const credentials = () => writeFileSync(grants, JSON.stringify({ enforce: true, outgoing: { 'agent-example-agent': key }, provider_endpoints: { 'agent-example-agent': 'http://agent-example-agent:18659' } }));
  publish(); credentials();
  const registry = createAgentRegistry({ agentsDir, appsJsonPath: apps, appRuntimeGrantsPath: grants, upstreamMode: 'network' });
  return { dir, apps, grants, agentsDir, runtime, app, publish, credentials, registry, rotate() { key = 'b'.repeat(64); credentials(); }, key: () => key };
}

test('any harness is admitted using a scoped grant; uninstall and reinstall preserve thread references', t => {
  const f = fixture(t), r = f.registry;
  const agent = r.read('example-agent');
  assert.equal(agent.harness, 'another-harness');
  assert.equal(agent.runtime.managed_by, 'app');
  assert.equal(r.upstream(agent), 'http://agent-example-agent:18659');
  assert.equal(r.apiKey(agent.id), f.key());
  assert.equal(JSON.stringify(r.list()).includes(f.key()), false);
  assert.deepEqual(agent.permissions.wizard_apps, []);
  r.pin('synthetic-session', agent.id);
  f.rotate(); assert.equal(r.apiKey(agent.id), f.key());
  f.publish([]); assert.equal(r.read(agent.id), null); assert.equal(r.list().length, 1);
  assert.equal(r.pinnedAgent('synthetic-session'), agent.id);
  f.publish(); assert.equal(r.read(agent.id).harness, 'another-harness');
});

test('duplicates, reserved identities, missing grants and untrusted endpoints fail closed', t => {
  const f = fixture(t);
  f.publish([f.app, { ...f.app, id: 'second-runtime' }]); assert.equal(f.registry.read('example-agent'), null);
  f.runtime.id = 'main'; f.publish(); assert.equal(f.registry.list().length, 1);
  f.runtime.id = 'example-agent'; f.publish();
  writeFileSync(f.grants, JSON.stringify({ outgoing: { 'agent-example-agent': f.key() }, provider_endpoints: { 'agent-example-agent': 'http://attacker.example:18659' } }));
  assert.equal(f.registry.read('example-agent'), null);
  f.credentials(); f.runtime.host_port = 80; f.publish(); assert.equal(f.registry.read('example-agent'), null);
});

test('app install cannot replace a Service-owned agent or reach its key/home', t => {
  const f = fixture(t);
  mkdirSync(join(f.agentsDir, 'example-agent'), { recursive: true });
  writeFileSync(join(f.agentsDir, 'example-agent', 'agent.json'), '{}');
  writeFileSync(join(f.agentsDir, 'example-agent', 'runtime.key'), 'existing-owner-key');
  assert.equal(f.registry.read('example-agent'), null);
  assert.equal(f.registry.apiKey('example-agent'), 'existing-owner-key');
});

test('app-managed lifecycle and settings never invoke the Hermes driver', async t => {
  const f = fixture(t, 'pi');
  await assert.rejects(f.registry.update('example-agent', { label: 'Change' }), e => e.error === 'external_agent_read_only');
  await assert.rejects(f.registry.setRunning('example-agent', true), e => e.error === 'external_agent_read_only');
});
