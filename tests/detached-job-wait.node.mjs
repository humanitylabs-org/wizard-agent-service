import test from 'node:test'
import { scene, kinds } from '../qa/agent-parity/fixture.mjs'
import { serverChecks } from '../qa/agent-parity/server-checks.mjs'
for (const kind of kinds) test(`${kind}: a deploy the turn handed off to holds the thread in Working until it reports`, async () => {
  const s = await scene(kind)
  try { await serverChecks['detached-job-wait'](s) } finally { await s.close() }
})
