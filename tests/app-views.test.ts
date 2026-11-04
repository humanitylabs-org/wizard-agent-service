import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { appView, serveAppView } from '../server/app-views.mjs';
import { readApps } from '../server/wizard-os-settings.mjs';
import { createWizardServer, listen as listenService } from '../server/service.mjs';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function box() {
  const dir = mkdtempSync(join(tmpdir(), 'own-view-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const appsJsonPath = join(dir, 'apps.json');
  writeFileSync(appsJsonPath, JSON.stringify({ apps: [{ id:'habits', name:'Habits', view:{ url:'/habits/' } }] }));
  const root = join(dir, 'views/habits'); mkdirSync(root, { recursive:true });
  const set = (v: object) => writeFileSync(join(root, 'view.json'), JSON.stringify(v));
  const state = { mode:'own', active:true, serving:'a'.repeat(64) }; set(state);
  const build = join(root, 'builds', state.serving); mkdirSync(build, { recursive:true });
  writeFileSync(join(build, 'index.html'), '<!doctype html><html><head><script src="app.js"></script></head><body>Own screen</body></html>');
  writeFileSync(join(build, 'app.js'), '/* own */'); writeFileSync(join(build, '.ok'), '{}');
  return { dir, appsJsonPath, launcherPath:'', build, set, state };
}
async function listen(b: ReturnType<typeof box>) {
  const server = createServer((req, res) => { if (!serveAppView(req, res, new URL(req.url || '/', 'http://box'), { appsJsonPath:b.appsJsonPath, apps:readApps(b).apps })) { res.writeHead(404); res.end(); } });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
}
it('registry exposes exact mode/url and keeps the original URL; inactive/suspended/malformed fail to original', () => {
  const b = box();
  expect(readApps(b).apps[0]).toMatchObject({ url:'/habits/', view:{ mode:'own', url:'/wizard/views/habits/' } });
  for (const v of [{ ...b.state, active:false }, { ...b.state, suspended:true }, { mode:'evil', active:true }]) {
    b.set(v); expect(appView(b.appsJsonPath, 'habits', '/habits/')).toEqual({ mode:'original', url:'/habits/' });
  }
  b.set({ mode:'overlay', active:true });
  expect(readApps(b).apps[0].view).toEqual({ mode:'overlay', url:'/habits/' });
});
it('actual HTTP serves own build and boot first, GET/HEAD only, no source or hidden files', async () => {
  const b = box(), base = await listen(b);
  const r = await fetch(base + '/wizard/views/habits/');
  expect(r.status).toBe(200);
  expect(await r.text()).toContain('<head><script src="/wizard/views/_boot.js"></script><script src="app.js">');
  expect(r.headers.get('content-security-policy')).toContain("script-src 'self'");
  expect((await fetch(base + '/wizard/views/habits/app.js', { method:'HEAD' })).status).toBe(200);
  for (const p of ['.ok', 'src/index.html', '%2e%2e%2fview.json', 'missing.js', 'api/mcp']) {
    expect((await fetch(base + '/wizard/views/habits/' + p)).status).toBeGreaterThanOrEqual(400);
  }
  expect((await fetch(base + '/wizard/views/habits/', { method:'POST', body:'{}' })).status).toBe(405);
  expect((await fetch(base + '/wizard/views/_boot.js')).status).toBe(200);
});
it('API preserves the original app gate with 307; reversion makes the old own URL unavailable', async () => {
  const b = box(), base = await listen(b);
  const r = await fetch(base + '/wizard/views/habits/api/items?q=x', { method:'POST', body:'{}', redirect:'manual' });
  expect(r.status).toBe(307); expect(r.headers.get('location')).toBe('/habits/api/items?q=x');
  b.set({ ...b.state, active:false });
  expect((await fetch(base + '/wizard/views/habits/')).status).toBe(404);
});
it('full Agent Service route reads the mounted projection and serves without a separate WAM door process', async () => {
  const b = box();
  const server = createWizardServer({ appsJsonPath:b.appsJsonPath, wizardOsHome:b.dir, agentBridge:false,
    requireJoinedDelegationCapability:false, upstreamOrigin:'http://127.0.0.1:9', hermesKey:'fixture-key',
    requireAccess:false, followThrough:false, settingsPath:join(b.dir, 'settings.json'),
    mediaRoot:join(b.dir, 'media'), mediaIndexPath:join(b.dir, 'media-index.json'),
    runQueueStatePath:join(b.dir, 'queue.sqlite3'), runQueuePollIntervalMs:0,
    activeSessionReader:async () => [], dispatchHealthReader:() => true });
  cleanup.push(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const address = await listenService(server), base = `http://127.0.0.1:${address.port}`;
  expect((await (await fetch(base + '/wizard/v1/apps')).json()).apps[0].view).toEqual({ mode:'own', url:'/wizard/views/habits/' });
  const r = await fetch(base + '/wizard/views/habits/'); expect(r.status).toBe(200); expect(await r.text()).toContain('Own screen');
});
it('missing build and escaping symlink fail closed without leaking a host path', async () => {
  const b = box(), base = await listen(b);
  symlinkSync(b.appsJsonPath, join(b.build, 'leak.json'));
  const leak = await fetch(base + '/wizard/views/habits/leak.json'); expect(leak.status).toBe(404);
  b.set({ ...b.state, serving:'../' });
  const r = await fetch(base + '/wizard/views/habits/'); expect(r.status).toBe(404);
  expect(await r.text()).not.toContain(b.dir);
});
