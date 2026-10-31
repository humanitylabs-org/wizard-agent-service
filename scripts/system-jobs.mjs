// Owner console for host maintenance; shares the Agent Service owner API, not a second registry.
import { pathToFileURL } from 'node:url'
export function formatSystemJobs(jobs) {
  return jobs.map(job => `${job.enabled ? 'ON' : 'OFF'}  ${job.name}\n  ${job.id}\n  ${JSON.stringify(job.when)} (${job.timezone}) | Last: ${job.lastRun?.startedAt || 'never'} | ${job.lastRun?.outcome || 'not run'}${job.timerError ? `\n  ${job.timerError}` : ''}`).join('\n') || 'No system jobs have been added.'
}
export async function systemJobsCommand(argv, { origin = process.env.WIZARD_ORIGIN, proof = process.env.WIZARD_OWNER_PROOF, input = async () => { let text = ''; for await (const chunk of process.stdin) { text += chunk; if (text.length > 128 * 1024) throw new Error('Input too large') }; return JSON.parse(text || '{}') }, fetchImpl = fetch } = {}) {
  const [action = 'list', id] = argv
  const url = new URL(origin || 'http://127.0.0.1:8787')
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('Use HTTPS or a loopback Agent Service origin')
  const paths = { list: ['', 'GET'], create: ['', 'POST'], import: ['/import-hermes', 'POST'], enable: [`/${id}`, 'PATCH'], disable: [`/${id}`, 'PATCH'], edit: [`/${id}`, 'PATCH'], run: [`/${id}/run`, 'POST'] }
  if (!paths[action] || (['enable', 'disable', 'edit', 'run'].includes(action) && !/^[a-zA-Z0-9_-]{1,80}$/.test(id || ''))) throw new Error('Use list, create, import, enable ID, disable ID, edit ID or run ID')
  const [path, method] = paths[action]
  const body = ['enable', 'disable'].includes(action) ? { enabled: action === 'enable' } : action === 'run' ? {} : method !== 'GET' ? await input() : undefined
  const response = await fetchImpl(`${url.origin}/wizard/v1/system-jobs${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json', ...(proof ? { 'X-Wizard-Owner-Proof': proof } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  if (!response.ok) throw new Error(`System jobs request refused (${response.status})`)
  const result = await response.json()
  return action === 'list' ? formatSystemJobs(result.systemJobs) : JSON.stringify(result, null, 2)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) systemJobsCommand(process.argv.slice(2)).then(console.log).catch(error => { console.error(error.message); process.exitCode = 1 })
