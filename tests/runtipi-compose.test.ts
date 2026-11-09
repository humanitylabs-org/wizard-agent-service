import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { expect, it } from 'vitest'

const composePath = fileURLToPath(new URL('../runtipi/docker-compose.yml', import.meta.url))
const composeText = readFileSync(composePath, 'utf8')
const compose = parse(composeText)

it('gives the Agent Service enough temporary space for queue recovery', () => {
  expect(compose.services['wizard-agent-service'].tmpfs).toEqual([
    '/tmp:rw,noexec,nosuid,size=512m',
  ])
  expect(composeText).not.toContain('size=64m')
})
