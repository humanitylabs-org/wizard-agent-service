// Own screens are published by WAM into the existing read-only wizard-os share.
// Source trees, .git and logs are never served. App APIs retain their original gate.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve, sep, extname } from 'node:path';

const ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
const HASH = /^[a-f0-9]{40,64}$/;
function confined(root, ...parts) {
  const base = realpathSync(root), file = realpathSync(resolve(base, ...parts));
  if (!file.startsWith(base + sep) || file !== resolve(base, ...parts)) throw new Error('outside view');
  return file;
}
function metadata(appsJsonPath, id) {
  if (!appsJsonPath || !ID.test(id)) return null;
  try {
    const root = confined(dirname(appsJsonPath), 'views');
    const file = confined(root, id, 'view.json');
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch { return null; }
}
// The original app's API folder for an own screen's relative `api/…` calls: the same target as the 307 below, or ''
// when there is none (an external app URL, a bad api_path, an MCP route).
function viewApi(v, original) {
  const apiPath = v?.api_path || '/api';
  if (typeof original !== 'string' || !original.startsWith('/') || original.startsWith('//') || typeof apiPath !== 'string' ||
    !/^\/[a-zA-Z0-9_/-]+$/.test(apiPath) || apiPath.includes('//') || /(?:^|\/)mcp(?:\/|$)/i.test(apiPath)) return '';
  return original.replace(/[?#].*$/, '').replace(/[^/]*$/, '') + apiPath.replace(/^\//, '').replace(/\/$/, '') + '/';
}
export function appView(appsJsonPath, id, original) {
  const v = metadata(appsJsonPath, id);
  const mode = v?.active === true && !v.suspended && ['own', 'overlay'].includes(v.mode) &&
    (v.mode !== 'own' || HASH.test(v.serving || '')) ? v.mode : 'original';
  if (mode !== 'own') return { mode, url: original };
  // `api`: under the browser boundary (wizard-os#133) the shell makes a sandboxed own screen's `api/…` calls itself,
  // straight to this folder, because the 307 below leaves the screen's own path.
  const api = viewApi(v, original);
  return { mode, url: `/wizard/views/${id}/`, ...(api ? { api } : {}) };
}
// Browser boundary (wizard-os#133): an own screen's files, read by a sandboxed (opaque) window. Like the shell's own
// static files they carry no owner data and need no shell token; its `api/` redirect and the page's writes do.
export function appViewFile(method, pathname) {
  if (!['GET', 'HEAD'].includes(method) || typeof pathname !== 'string' || pathname.includes('//') || /%2e|%2f|%5c|\\/iu.test(pathname)) return false;
  if (pathname === '/wizard/views/_boot.js') return true;
  const m = pathname.match(/^\/wizard\/views\/([a-z0-9][a-z0-9-]{1,40})\/(.*)$/);
  return !!m && !/^api(?:\/|$)/.test(m[2]) && !m[2].split('/').some(p => p.startsWith('.'));
}

const BOOT = `(() => {
  const send = (type, file) => { if (parent !== window) parent.postMessage({ type, file }, location.origin); };
  addEventListener('error', e => {
    const file = e.target?.src || e.target?.href || e.filename || 'index.html';
    send('wizard:own-view:error', file);
  }, true);
  addEventListener('unhandledrejection', () => send('wizard:own-view:error', 'index.html'));
  addEventListener('DOMContentLoaded', () => send('wizard:own-view:ready', 'index.html'));
})();`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.woff2': 'font/woff2' };
export function serveAppView(request, response, url, { appsJsonPath, apps }) {
  if (!url.pathname.startsWith('/wizard/views/')) return false;
  const reply = (code, body, type = 'text/plain; charset=utf-8', extra = {}) => {
    response.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
    response.end(request.method === 'HEAD' ? undefined : body);
    return true;
  };
  if (url.pathname === '/wizard/views/_boot.js') return ['GET', 'HEAD'].includes(request.method) ? reply(200, BOOT, TYPES['.js']) : reply(405, 'Read only');
  let parts;
  try { parts = decodeURIComponent(url.pathname).split('/').slice(3); } catch { return reply(404, 'View not found'); }
  const id = parts.shift(), app = apps.find(a => a.id === id);
  if (!app || !ID.test(id) || appView(appsJsonPath, id, app.url).mode !== 'own') return reply(404, 'View not found');
  if (parts.some(p => p === '..' || p.startsWith('.') || p.includes('\\') || p.includes('\0'))) return reply(404, 'View not found');
  // A same-origin redirect, not a privileged proxy: data requests still go through
  // the app's existing API route and its authentication/CSRF checks. No MCP route.
  if (parts[0] === 'api') {
    const api = viewApi(metadata(appsJsonPath, id), app.url);
    if (!api || /(?:^|\/)mcp(?:\/|$)/i.test(parts.join('/'))) return reply(403, 'API route unavailable');
    return reply(307, '', 'text/plain', { Location: api + parts.slice(1).join('/') + url.search });
  }

  if (!['GET', 'HEAD'].includes(request.method)) return reply(405, 'Read only');
  const rel = parts.join('/') || 'index.html';
  try {
    const v = metadata(appsJsonPath, id);
    if (!HASH.test(v?.serving || '')) throw new Error('no build');
    const views = resolve(dirname(appsJsonPath), 'views');
    const build = confined(views, id, 'builds', v.serving);
    confined(build, '.ok');
    const file = confined(build, rel);
    if (!statSync(file).isFile()) throw new Error('not a file');
    let body = readFileSync(file);
    const type = TYPES[extname(file)] || 'application/octet-stream';
    if (extname(file) === '.html') {
      const boot = '<script src="/wizard/views/_boot.js"></script>';
      const html = body.toString('utf8');
      body = /<head(?:\s[^>]*)?>/i.test(html) ? html.replace(/<head(?:\s[^>]*)?>/i, m => m + boot) : boot + html;
    }
    // A sandboxed own screen asks for its module scripts, styles and fonts with `Origin: null` and needs a CORS answer.
    // Its page (a navigation) never does; an opaque caller of the page itself is refused.
    const opaque = String(request.headers.origin ?? '').trim().toLowerCase() === 'null';
    if (opaque && extname(file) === '.html') return reply(403, 'Opaque origin');
    return reply(200, body, type, { ...(opaque ? { 'Access-Control-Allow-Origin': '*' } : {}), 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'" });
  } catch { return reply(404, `Your version could not load ${rel}. Use the original screen.`); }
}
