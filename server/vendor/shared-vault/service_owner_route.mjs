// Candidate Wizard Service route adapter. NOT auto-loaded or activated.
// Caller passes Service's existing principalOf, AFTER resolver.attach(request).
// That Symbol-bound principal cannot be asserted in HTTP JSON or headers.
const BASE = '/wizard/apps/shared-vault/api/';
const routes = new Map([['GET status','status'], ['POST connect','connect'], ['POST grant','grant'], ['POST revoke','revoke'], ['POST disconnect','disconnect']]);

export function sharedVaultOwnerRoute({principalOf, publicOrigin, brokerOrigin, ownerToken}) {
  const site = new URL(publicOrigin), target = new URL(brokerOrigin);
  if (site.protocol !== 'https:' || site.origin !== publicOrigin ||
      !['http:','https:'].includes(target.protocol) || target.origin !== brokerOrigin ||
      (target.protocol === 'http:' && target.hostname !== '127.0.0.1') ||
      typeof ownerToken !== 'function' || typeof principalOf !== 'function') throw Error('Invalid trusted route configuration');
  return async function(request, response) {
    if (!request.url?.startsWith(BASE)) return false;
    const fail = (code) => { response.writeHead(code, {'content-type':'application/json','cache-control':'no-store'}); response.end('{"error":"shared_vault_denied"}'); return true; };
    // Reject every alternate encoding, query, path, method and anonymous/service/box-only principal.
    const leaf = request.url.slice(BASE.length), operation = routes.get(request.method+' '+leaf);
    const principal = principalOf(request);
    if (!operation || principal?.kind !== 'owner' || !['proxy_proof','access_verifier'].includes(principal.via)) return fail(403);
    const h = request.headers;
    if (h.host !== site.host || (h.origin !== undefined && h.origin !== publicOrigin) || h['sec-fetch-site'] === 'cross-site' ||
        (request.method === 'POST' && h.origin !== publicOrigin)) return fail(403);
    if (request.method === 'POST' && (h['content-type']?.split(';')[0] !== 'application/json' || h['transfer-encoding'] ||
        !/^\d+$/.test(h['content-length'] || '') || Number(h['content-length']) > 16384)) return fail(400);
    let body;
    try {
      if (request.method === 'POST') {
        const chunks = []; let size = 0;
        // Wall-clock bound, not a socket inactivity timeout. Service still owns
        // header parsing and must bound that before this extension is reached.
        const timer = setTimeout(() => request.destroy(), 6000); timer.unref();
        try {
          for await (const c of request) { size += c.length; if (size > 16384) return fail(400); chunks.push(c); }
        } finally { clearTimeout(timer); }
        body = Buffer.concat(chunks);
        if (body.length !== Number(h['content-length'])) return fail(400);
        JSON.parse(body);
      }
      // New header allowlist: never pass caller Authorization, Cookie, forwarding,
      // owner proof or identity headers. CSRF was checked BEFORE origin translation.
      const token = await ownerToken();
      if (typeof token !== 'string' || token.length < 32) return fail(503);
      const reply = await fetch(brokerOrigin+'/api/'+operation, {method: request.method, body,
        redirect: 'manual', signal: AbortSignal.timeout(23000), headers: {
          'Content-Type':'application/json', 'Origin':brokerOrigin, 'Authorization':'Bearer '+token,
        }});
      if (![200,403,503].includes(reply.status)) return fail(503);
      // Broker code is trusted and projects provider data. Bound body; never forward
      // backend headers (Set-Cookie, Location, CSP etc) or a redirect body.
      const chunks = []; let size = 0;
      for await (const chunk of reply.body) { size += chunk.length; if (size > 65536) { await reply.body.cancel().catch(()=>{}); return fail(503); } chunks.push(chunk); }
      const data = Buffer.concat(chunks).toString('utf8');
      JSON.parse(data);
      response.writeHead(reply.status, {'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});
      response.end(data); return true;
    } catch { return fail(503); }
  };
}
