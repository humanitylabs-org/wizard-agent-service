// App Manager's installed registry is the only source of app runtimes. No caller URLs,
// filesystem provisioning, profile access, or Hermes runtime driver involvement.
import { readFileSync } from 'node:fs';
const id = /^[a-z0-9][a-z0-9-]{1,40}$/u;
const read = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } };
export function appAgentRuntimes(appsPath, grantsPath) {
  const apps = read(appsPath).apps;
  if (!Array.isArray(apps)) return [];
  const grants = read(grantsPath);
  const candidates = apps.filter(a => a?.agent_runtime && typeof a.id === 'string' && id.test(a.id));
  const counts = new Map();
  for (const a of candidates) counts.set(a.agent_runtime.id, (counts.get(a.agent_runtime.id) || 0) + 1);
  return candidates.flatMap(a => {
    const r = a.agent_runtime, m = r.model;
    if (counts.get(r.id) !== 1 || typeof r.id !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/u.test(r.id) || ['main', 'hermes', 'default', 'new', 'options'].includes(r.id) || typeof r.harness !== 'string' || !id.test(r.harness)
        || a.type !== 'agent' || a.privacy === 'private' || typeof r.label !== 'string' || !r.label.trim() || r.label.length > 80
        || !Number.isInteger(r.port) || r.port < 1024 || r.port > 65535 || !Number.isInteger(r.host_port) || r.host_port < 1024 || r.host_port > 65535
        || !m || typeof m.provider !== 'string' || typeof m.model !== 'string' || !m.provider || !m.model) return [];
    const key = grants.outgoing?.[a.id];
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/u.test(key)) return [];
    // Endpoint is compiled by WAM from its recipe, never supplied by the app at runtime.
    let endpoint;
    try { endpoint = new URL(grants.provider_endpoints?.[a.id]); } catch { return []; }
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== a.id || Number(endpoint.port) !== r.port
        || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) return [];
    return [{ schema: 1, id: r.id, label: r.label, harness: r.harness, privacy: 'standard',
      model: { ...m, allowed_models: [m.model], fallback: false },
      permissions: { preset: 'standard', outside_tools: [], files: 'own', wizard_apps: [], agent_apps: [], other_agents: 'none', shared_with_agents: false },
      runtime: { kind: 'external', managed_by: 'app', app_id: a.id, api: endpoint.origin, port: r.host_port }, key }];
  });
}
