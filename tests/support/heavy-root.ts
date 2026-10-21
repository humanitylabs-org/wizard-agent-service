import { afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const heavyRoot = mkdtempSync(join(tmpdir(), 'heavy-fixture-'))
beforeEach(() => vi.stubEnv('WIZARD_HEAVY_ROOT', heavyRoot))
afterEach(() => vi.unstubAllEnvs())
afterAll(() => rmSync(heavyRoot, { recursive: true, force: true }))
