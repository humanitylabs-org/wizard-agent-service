import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHermesPluginSync } from '../server/hermes-plugin-sync.mjs'

// Issue 532: the box's installed deploy helper predates the plugin refresh, so the Service runs it itself
// at startup from its own release folder.
const root = fileURLToPath(new URL('../', import.meta.url))
const seedBlob = 'f96456523ec4b74af8e225a9d785ea55e4bcf89a'

function tempBox() {
  const base = mkdtempSync(join(tmpdir(), 'plugin-sync-startup-'))
  // A release folder like the deploy helper's: the repo's plugins and ops, no git history.
  const release = join(base, 'release')
  cpSync(join(root, 'hermes-plugin/wizard-schedule'), join(release, 'hermes-plugin/wizard-schedule'), { recursive: true, filter: p => !p.includes('__pycache__') })
  cpSync(join(root, 'ops/sync-hermes-plugins.py'), join(release, 'ops/sync-hermes-plugins.py'))
  cpSync(join(root, 'ops/hermes-plugin-seeds.json'), join(release, 'ops/hermes-plugin-seeds.json'))
  const home = join(base, 'hermes')
  mkdirSync(join(home, 'plugins'), { recursive: true })
  return { base, release, home }
}

function installHandCopy(home: string) {
  // The exact 22 Oct hand copy on the reporting box (blob f964565, listed in ops/hermes-plugin-seeds.json).
  const target = join(home, 'plugins/wizard-schedule')
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'plugin.yaml'), readFileSync(join(root, 'hermes-plugin/wizard-schedule/plugin.yaml')))
  writeFileSync(join(target, '__init__.py'), readFileSync(join(root, 'tests/fixtures/hermes-plugin-seeds/wizard-schedule-__init__.py.txt')))
  return { target }
}

const quiet: any = { log: () => undefined, env: { ...process.env, WAS_SOURCE: '/nonexistent', WIZARD_HERMES_PYTHON: '/bin/false' } }

describe('Service startup refreshes its own Hermes plugins', () => {
  it('replaces the box hand copy with the release copy, whatever deployed it', async () => {
    const box = tempBox()
    try {
      const { target } = installHandCopy(box.home)
      const handCopy = join(target, '__init__.py')
      const python = `import sys,runpy;m=runpy.run_path(sys.argv[1]);print(m['blob_sha'](open(sys.argv[2],'rb').read()))`
      expect(execFileSync('python3', ['-c', python, join(box.release, 'ops/sync-hermes-plugins.py'), handCopy], { encoding: 'utf8' }).trim()).toBe(seedBlob)
      const lines: string[] = []
      const result: any = await startHermesPluginSync({ releaseRoot: box.release, hermesHome: box.home, env: quiet.env, log: (l: string) => { lines.push(l) } })
      expect(result.plugins['wizard-schedule']).toBe('refreshed')
      expect(result.changed).toEqual(['wizard-schedule'])
      expect(readFileSync(handCopy, 'utf8')).toBe(readFileSync(join(box.release, 'hermes-plugin/wizard-schedule/__init__.py'), 'utf8'))
      expect(readFileSync(handCopy, 'utf8')).toContain("'thread'")
      expect(lines.join('\n')).toMatch(/^\[hermes-plugins\] \{/)
      // The next start finds it current and changes nothing.
      const again: any = await startHermesPluginSync({ releaseRoot: box.release, hermesHome: box.home, ...quiet })
      expect(again.plugins['wizard-schedule']).toBe('current')
      expect(again.changed).toEqual([])
    } finally {
      rmSync(box.base, { recursive: true, force: true })
    }
  }, 30_000)

  it('leaves an owner-edited copy alone', async () => {
    const box = tempBox()
    try {
      const { target } = installHandCopy(box.home)
      writeFileSync(join(target, '__init__.py'), '# my own schedule tool\n')
      const result: any = await startHermesPluginSync({ releaseRoot: box.release, hermesHome: box.home, ...quiet })
      expect(result.plugins['wizard-schedule']).toBe('owner-modified')
      expect(readFileSync(join(target, '__init__.py'), 'utf8')).toBe('# my own schedule tool\n')
    } finally {
      rmSync(box.base, { recursive: true, force: true })
    }
  }, 30_000)

  it('skips without a plugins folder, without the script, and when switched off; never throws', async () => {
    const box = tempBox()
    try {
      let ran = 0
      const run = (() => { ran += 1 }) as any
      expect(await startHermesPluginSync({ releaseRoot: box.release, hermesHome: join(box.base, 'none'), run, log: () => undefined } as any))
        .toEqual({ skipped: 'no host Hermes plugins folder' })
      expect(await startHermesPluginSync({ releaseRoot: join(box.base, 'empty'), hermesHome: box.home, run, log: () => undefined } as any))
        .toEqual({ skipped: 'release has no plugin sync step' })
      expect(await startHermesPluginSync({ releaseRoot: box.release, hermesHome: box.home, run, env: { WIZARD_HERMES_PLUGIN_SYNC: '0' }, log: () => undefined } as any))
        .toEqual({ skipped: 'off (WIZARD_HERMES_PLUGIN_SYNC=0)' })
      expect(ran).toBe(0)
      const broken: any = await startHermesPluginSync({ releaseRoot: box.release, hermesHome: box.home, env: { WIZARD_PLUGIN_SYNC_PYTHON: join(box.base, 'no-python') }, log: () => undefined } as any)
      expect(broken.error).toBeTruthy()
      const throwing: any = await startHermesPluginSync({ releaseRoot: box.release, hermesHome: box.home, run: (() => { throw new Error('spawn failed') }) as any, log: () => undefined } as any)
      expect(throwing).toEqual({ error: 'spawn failed' })
    } finally {
      rmSync(box.base, { recursive: true, force: true })
    }
  }, 30_000)

  it('index.mjs starts it after the Service listens', () => {
    const index = readFileSync(join(root, 'server/index.mjs'), 'utf8')
    const listen = index.indexOf('server.listen(port, host')
    expect(listen).toBeGreaterThan(0)
    expect(index.indexOf('startHermesPluginSync({ hermesHome })')).toBeGreaterThan(listen)
  })
})
