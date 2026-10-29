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
export function appView(appsJsonPath, id, original) {
  const v = metadata(appsJsonPath, id);
  const mode = v?.active === true && !v.suspended && ['own', 'overlay'].includes(v.mode) &&
    (v.mode !== 'own' || HASH.test(v.serving || '')) ? v.mode : 'original';
  return { mode, url: mode === 'own' ? `/wizard/views/${id}/` : original };
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
export function serveAppView(request, response, url, { appsJsonPath, apps, appOwnerApiRoutes = new Map() }) {
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
    const ownerRoutes = appOwnerApiRoutes.get(id);
    if (ownerRoutes) {
      const rawBase = `/wizard/views/${id}/api/`;
      const leaf = (request.url || '').slice(rawBase.length);
      if (!request.url?.startsWith(rawBase) || !ownerRoutes.has(`${request.method} ${leaf}`)) return reply(403, 'API route unavailable');
      // A same-origin method-preserving redirect only. The owner handler still verifies the
      // original Host/Origin and trusted principal; this mapping never adds authority.
      return reply(307, '', 'text/plain', { Location: `/wizard/apps/${id}/api/${leaf}` });
    }
    const apiPath = metadata(appsJsonPath, id)?.api_path || '/api';
    if (!app.url.startsWith('/') || app.url.startsWith('//') || !/^\/[a-zA-Z0-9_/-]+$/.test(apiPath) || /(?:^|\/)mcp(?:\/|$)/i.test(apiPath + '/' + parts.join('/'))) return reply(403, 'API route unavailable');
    const base = app.url.replace(/[?#].*$/, '').replace(/[^/]*$/, '');
    return reply(307, '', 'text/plain', { Location: base + apiPath.replace(/^\//, '').replace(/\/$/, '') + '/' + parts.slice(1).join('/') + url.search });
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
    return reply(200, body, type, { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'" });
  } catch { return reply(404, `Your version could not load ${rel}. Use the original screen.`); }
}
