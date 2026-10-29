// Synthetic setup regressions only; exercise unchanged Service socket implementation.
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAgentSocketGateway, agentSocketPath } from '../server/agent-sockets.mjs'

describe('Round11c synthetic socket setup', () => {
  it('reproduces Round11b actual Service refusal before Docker can create an empty mount', async () => {
    const agentsDir = '/srv/work/incog-seal-r11b-b11a7f0/work-tmp-round11b/r10-sealed-gw-XXXXXX/agents'
    expect(Buffer.byteLength(agentSocketPath(agentsDir, 'sealed'))).toBe(107)
    const sockets = createAgentSocketGateway({ agentsDir, ingress: () => { throw new Error('must not reach listener') } })
    try { await expect(sockets.ensure('sealed')).rejects.toThrow('agent_socket_path_too_long') }
    finally { await sockets.close() }
  })

  it('binds and serves on the short private root with real UID and socket permissions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r10-sealed-gw-'))
    const agentsDir = join(root, 'agents')
    mkdirSync(join(agentsDir, 'sealed'), { recursive: true })
    const sockets = createAgentSocketGateway({ agentsDir, ingress: () => createServer((req, res) => res.end('synthetic socket ready')) })
    try {
      const path = agentSocketPath(agentsDir, 'sealed')
      expect(Buffer.byteLength(path)).toBeLessThanOrEqual(103)
      await sockets.ensure('sealed')
      expect(lstatSync(path).isSocket()).toBe(true)
      expect(lstatSync(path).uid).toBe(process.getuid!())
      expect(lstatSync(path).mode & 0o777).toBe(0o600)
      expect(lstatSync(join(agentsDir, 'sealed', 'gateway')).mode & 0o777).toBe(0o700)
      const body = await new Promise<string>((resolve, reject) => {
        const req = request({ socketPath: path, path: '/' }, res => {
          let text = ''; res.on('data', chunk => { text += chunk }); res.on('end', () => resolve(text))
        }); req.on('error', reject); req.end()
      })
      expect(body).toBe('synthetic socket ready')
    } finally { await sockets.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
