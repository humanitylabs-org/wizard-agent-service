import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const dockerfile = readFileSync(resolve(__dirname, '../ops/host-container/Dockerfile'), 'utf8')

describe('host-container runtime dependencies', () => {
  it('installs the binaries used by Pages, session readers and the direct worker transport', () => {
    const packages = dockerfile.match(/apk add --no-cache ([^&\n]+)/)?.[1].trim().split(/\s+/) ?? []
    for (const dependency of ['python3', 'git', 'openssh-client']) expect(packages).toContain(dependency)
  })

  it('executes dependency checks during the image build, not only on the host', () => {
    const buildChecks = dockerfile.split('\n').filter(line => line.startsWith('RUN ')).join('\n')
    for (const command of ['git --version', 'ssh -V', 'python3 -c "import sqlite3,hashlib,json,re"', 'node --version']) {
      expect(buildChecks).toContain(command)
    }
  })
})
