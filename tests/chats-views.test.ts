import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { lintChatsModule, CHATS_CONTRACT } from '../server/chats-views.mjs';
import { readApps } from '../server/wizard-os-settings.mjs';
import { createWizardServer, listen } from '../server/service.mjs';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const source = "export default {id:'mizel-chats',contract:'wizard.chats-view/1',name:'Mizel Chats',mount(el,host){return {update(){el.replaceChildren(host.element('div'));},unmount(){el.replaceChildren();}}}};";
function box() {
  const home = mkdtempSync(join(tmpdir(), 'chats-view-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const sha256 = createHash('sha256').update(source).digest('hex');
  const view = { contract: CHATS_CONTRACT, module: `/wizard/v1/chats-views/mizel-chats/${sha256}.js`, sha256,
    bytes: Buffer.byteLength(source), commit: 'a'.repeat(40) };
  const app = { id: 'mizel-chats', name: 'Mizel Chats', provides: ['chats'], view: { url: '/mizel/' }, chats_view: view };
  const appsJsonPath = join(home, 'apps.json'), modulePath = join(home, 'chats-views/mizel-chats', `${sha256}.js`);
  mkdirSync(join(home, 'chats-views/mizel-chats'), { recursive: true }); writeFileSync(modulePath, source);
  const save = (apps: unknown[] = [app], choice = 'mizel-chats') => writeFileSync(appsJsonPath, JSON.stringify({ apps, slots: { chats: { default: choice } } }));
  save();
  return { home, app, view, appsJsonPath, modulePath, save, launcherPath: '' };
}
async function service(b: ReturnType<typeof box>, access = false) {
  const server = createWizardServer({ appsJsonPath: b.appsJsonPath, wizardOsHome: b.home, agentBridge: false,
    requireJoinedDelegationCapability: false, upstreamOrigin: 'http://127.0.0.1:9', hermesKey: 'fixture-key',
    requireAccess: access, accessVerifier: async () => false, followThrough: false,
    settingsPath: join(b.home, 'settings.json'), mediaRoot: join(b.home, 'media'), mediaIndexPath: join(b.home, 'media-index.json'),
    runQueueStatePath: join(b.home, 'queue.sqlite3'), runQueuePollIntervalMs: 0,
    activeSessionReader: async () => [], dispatchHealthReader: () => true });
  cleanup.push(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const address = await listen(server); return `http://127.0.0.1:${address.port}`;
}
it('real registry and route expose same-origin module, source, provides, hash, and owner-selected default', async () => {
  const b = box(), base = await service(b);
  const r = await fetch(base + '/wizard/v1/apps'); expect(r.status).toBe(200);
  const value = await r.json();
  expect(value.apps[0]).toMatchObject({ source: 'apps.json', provides: ['chats'], chats_view: b.view, url: '/wizard/v1/chats-views/mizel-chats/' });
  // Exactly PR #256 moduleURL's same-origin, non-root, app-prefix predicate.
  const appBase = new URL(value.apps[0].url, base), module = new URL(value.apps[0].chats_view.module, appBase);
  expect(module.origin).toBe(appBase.origin); expect(module.pathname.startsWith(appBase.pathname)).toBe(true);
  expect(value.slots.chats).toEqual({ default: 'mizel-chats', candidates: ['wizard-chats', 'mizel-chats'] });
  expect(value.parking[0].active).toBe('mizel-chats');
  const response = await fetch(module); expect(response.status).toBe(200); expect(await response.text()).toBe(source);
  expect(response.headers.get('x-wizard-sha256')).toBe(b.view.sha256);
  expect(response.headers.get('content-type')).toContain('text/javascript');
  expect(response.headers.get('cache-control')).toBe('no-store');
  const head = await fetch(module, { method: 'HEAD' }); expect(head.status).toBe(200); expect(await head.text()).toBe('');
});
it('tampered file is refused even with a matching length; no unchecked rehash', async () => {
  const b = box(), base = await service(b);
  writeFileSync(b.modulePath, source.replace('Mizel Chats', 'Other Chats'));
  const response = await fetch(base + b.view.module); expect(response.status).toBe(409);
  expect(await response.text()).not.toContain('export default');
});
it('removal/revocation removes provider and invalidates its former module URL; default falls back', async () => {
  const b = box(), base = await service(b); b.save([]);
  const result = await (await fetch(base + '/wizard/v1/apps')).json();
  expect(result.apps).toEqual([]); expect(result.slots.chats.default).toBe('wizard-chats');
  expect((await fetch(base + b.view.module)).status).toBe(404);
});
it('an uninstalled launcher link cannot supply provides or admit code', () => {
  const b = box(); b.save([]);
  b.launcherPath = join(b.home, 'launcher.json');
  writeFileSync(b.launcherPath, JSON.stringify({ links: [{ ...b.app, url: '/mizel/' }] }));
  const result = readApps(b); expect(result.apps[0].source).toBe('launcher.json');
  expect(result.apps[0].chats_view).toBeUndefined(); expect(result.slots.chats.default).toBe('wizard-chats');
});
it.each([
  { contract: 'wrong' }, { sha256: 'bad' }, { module: 'https://foreign.test/chats.js' },
  { module: '/mizel/chats.js' }, { bytes: 131073 }, { commit: 'bad' },
])('malformed install metadata is never admitted: %o', patch => {
  const b = box(); b.save([{ ...b.app, chats_view: { ...b.view, ...patch } }]);
  expect(readApps(b).apps[0].chats_view).toBeUndefined(); expect(readApps(b).slots.chats.default).toBe('wizard-chats');
});
it('only installed chats providers qualify; ordinary views and shell cannot become modules', () => {
  const b = box();
  for (const provides of [[], ['shell'], ['files']]) { b.save([{ ...b.app, provides }]); expect(readApps(b).slots.chats.candidates).toEqual(['wizard-chats']); }
});
it('route retains the existing owner access gate', async () => {
  const b = box(), base = await service(b, true); expect((await fetch(base + b.view.module)).status).toBe(403);
});
it('method/path/symlink/oversize guards fail closed', async () => {
  const b = box(), base = await service(b);
  expect((await fetch(base + b.view.module, { method: 'POST' })).status).toBe(405);
  expect((await fetch(base + b.view.module + '?x=1')).status).toBe(404);
  expect((await fetch(base + '/wizard/v1/chats-views/mizel-chats/%2e%2e%2fapps.json')).status).toBe(404);
  rmSync(b.modulePath); const other = join(b.home, 'other.js'); writeFileSync(other, source); symlinkSync(other, b.modulePath);
  expect((await fetch(base + b.view.module)).status).toBe(409);
  rmSync(b.modulePath); writeFileSync(b.modulePath, 'x'.repeat(131073));
  expect((await fetch(base + b.view.module)).status).toBe(409);
});
it.each(['fetch(', 'import(', "import './extra.js'", 'eval(', 'new Function', 'localStorage', 'innerHTML', 'document.cookie'])('banned APIs fail module lint: %s', token => {
  expect(() => lintChatsModule(source + token)).toThrow();
});
it('Agent Service settings cannot change the WAM-owned slot', async () => {
  const b = box(), base = await service(b);
  await fetch(base + '/wizard/v1/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slots: { chats: { default: 'wizard-chats' } } }) });
  expect((await (await fetch(base + '/wizard/v1/apps')).json()).slots.chats.default).toBe('mizel-chats');
});
