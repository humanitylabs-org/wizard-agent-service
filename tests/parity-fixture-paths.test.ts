import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sceneTmp } from '../qa/agent-parity/fixture.mjs'
import { agentSocketPath } from '../server/agent-sockets.mjs'

// The restricted parity agent's ingress socket is the deepest path a scene creates. On macOS the default $TMPDIR
// pushed it past the Service's 103-byte limit, so every restricted scene failed there with ENOENT on the socket.
it('parity scenes leave room for the deepest agent ingress socket', () => {
  const root = mkdtempSync(join(sceneTmp(), 'parity-'))
  try {
    expect(Buffer.byteLength(agentSocketPath(join(root, 'os', 'agents'), 'parity-agent'))).toBeLessThanOrEqual(103)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
