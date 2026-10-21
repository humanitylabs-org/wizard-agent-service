// Owner-installed in-document code. Admission + integrity, not a JavaScript sandbox.
import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';

export const CHATS_CONTRACT = 'wizard.chats-view/1';
export const CHATS_DEFAULT = 'wizard-chats';
export const CHATS_MAX_BYTES = 128 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const BANNED = /\b(?:addEventListener|setTimeout|setInterval|requestAnimationFrame|fetch|XMLHttpRequest|__wos|__wux|localStorage|sessionStorage|innerHTML|outerHTML|history|eval|Function|WebSocket|import)\b|document\s*\.\s*cookie/;
export function lintChatsModule(source) {
  if (!source.length || Buffer.byteLength(source) > CHATS_MAX_BYTES || BANNED.test(source)) throw Error('Chats module admission failed');
}
export function chatsView(app) {
  const v = app?.chats_view, id = app?.id;
  if (!ID.test(id || '') || id === CHATS_DEFAULT || !Array.isArray(app?.provides) || !app.provides.includes('chats') ||
      v?.contract !== CHATS_CONTRACT || !HASH.test(v.sha256 || '') || !/^[a-f0-9]{40}$/.test(v.commit || '') ||
      !Number.isInteger(v.bytes) || v.bytes < 1 || v.bytes > CHATS_MAX_BYTES ||
      v.module !== `/wizard/v1/chats-views/${id}/${v.sha256}.js`) return null;
  return { contract: CHATS_CONTRACT, module: v.module, sha256: v.sha256, bytes: v.bytes, commit: v.commit };
}
export function serveChatsView(request, response, url, { appsJsonPath, apps }) {
  if (!url.pathname.startsWith('/wizard/v1/chats-views/')) return false;
  const reply = (code, body, extra = {}) => {
    response.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', ...extra });
    response.end(request.method === 'HEAD' ? undefined : body); return true;
  };
  if (!['GET', 'HEAD'].includes(request.method)) return reply(405, 'Read only');
  const match = /^\/wizard\/v1\/chats-views\/([a-z0-9][a-z0-9-]{0,63})\/([a-f0-9]{64})\.js$/.exec(url.pathname);
  if (!match || url.search) return reply(404, 'Chats view not found');
  const app = apps.find(a => a.id === match[1] && a.source === 'apps.json'), v = chatsView(app);
  if (!v || v.sha256 !== match[2] || !appsJsonPath) return reply(404, 'Chats view not found');
  let fd;
  try {
    const root = realpathSync(dirname(appsJsonPath));
    const path = resolve(root, 'chats-views', app.id, `${v.sha256}.js`);
    if (!path.startsWith(root + sep) || realpathSync(path) !== path) throw Error('outside package');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== v.bytes || stat.size > CHATS_MAX_BYTES) throw Error('size mismatch');
    const body = readFileSync(fd);
    if (body.length !== v.bytes || createHash('sha256').update(body).digest('hex') !== v.sha256) throw Error('hash mismatch');
    lintChatsModule(new TextDecoder('utf-8', { fatal: true }).decode(body));
    return reply(200, body, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': String(body.length),
      'X-Wizard-Sha256': v.sha256, ETag: `"${v.sha256}"` });
  } catch { return reply(409, 'Chats view integrity check failed; reinstall the checked package'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
