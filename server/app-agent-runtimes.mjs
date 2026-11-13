// App Manager's installed registry is the only source of app runtimes. No caller URLs,
// filesystem provisioning, profile access, or Hermes runtime driver involvement.
import { readFileSync, statSync } from 'node:fs';
const id = /^[a-z0-9][a-z0-9-]{1,40}$/u;
// A missing file or bad JSON is a stable state of that file version; any other read error (EMFILE, EIO) is
// transient and marks the result so it is never cached under the unchanged signature.
const read = (path, failed) => {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') failed.transient = true; return {}; }
  try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
};
// apps.json grows with every app (hundreds of KB), and the registry asks for these rows on every agent read.
// Parse once per file version: the signature is mtime+size+inode of both files (as agents.mjs syncApps uses),
// so a read costs two stats until App Manager rewrites a file (issue 501).
const cache = new Map();
const signature = path => { try { const st = statSync(path); return `${st.mtimeMs}:${st.size}:${st.ino}`; } catch { return 'missing'; } };
export function appAgentRuntimes(appsPath, grantsPath) {
  const slot = `${appsPath}\0${grantsPath}`, sig = `${signature(appsPath)}|${signature(grantsPath)}`;
  let hit = cache.get(slot);
  if (!hit || hit.sig !== sig) {
    const failed = { transient: false };
    hit = { sig, rows: compute(appsPath, grantsPath, failed) };
    cache.delete(slot);
    if (failed.transient) return hit.rows;
    cache.set(slot, hit);
    if (cache.size > 16) cache.delete(cache.keys().next().value);
  }
  // Callers get their own copy, so a caller that edits a row cannot change the next read.
  return structuredClone(hit.rows);
}
function compute(appsPath, grantsPath, failed) {
  const apps = read(appsPath, failed).apps;
  if (!Array.isArray(apps)) return [];
  const grants = read(grantsPath, failed);
  const candidates = apps.filter(a => a?.agent_runtime && typeof a.id === 'string' && id.test(a.id) && a.id === `agent-${a.agent_runtime.id}`);
  const counts = new Map();
  for (const a of candidates) counts.set(a.agent_runtime.id, (counts.get(a.agent_runtime.id) || 0) + 1);
  return candidates.flatMap(a => {
    const r = a.agent_runtime, m = r.model;
    if (counts.get(r.id) !== 1 || typeof r.id !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/u.test(r.id) || ['main', 'hermes', 'default', 'new', 'options'].includes(r.id) || typeof r.harness !== 'string' || !id.test(r.harness)
        || a.id !== `agent-${r.id}` || a.type !== 'agent' || a.privacy === 'private' || typeof r.label !== 'string' || !r.label.trim() || r.label.length > 80
        || !Number.isInteger(r.port) || r.port < 1024 || r.port > 65535 || !Number.isInteger(r.host_port) || r.host_port < 1024 || r.host_port > 65535
        || ['tinfoil', 'local'].includes(m?.provider) || !m || typeof m.provider !== 'string' || typeof m.model !== 'string' || !m.provider || !m.model) return [];
    const key = grants.outgoing?.[a.id];
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/u.test(key)) return [];
    // Endpoint is compiled by WAM from its recipe, never supplied by the app at runtime.
    let endpoint;
    try { endpoint = new URL(grants.provider_endpoints?.[a.id]); } catch { return []; }
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== a.id || Number(endpoint.port) !== r.port
        || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) return [];
    return [{ schema: 1, id: r.id, label: r.label, harness: r.harness, privacy: 'standard',
      model: { ...m, allowed_models: [m.model], fallback: false },
      permissions: { preset: 'standard', outside_tools: [], files: 'none', wizard_apps: [], agent_apps: [], other_agents: 'none', shared_with_agents: false },
      runtime: { kind: 'external', managed_by: 'app', app_id: a.id, api: endpoint.origin, port: r.host_port }, key }];
  });
}
