import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// ops/host-container/wizard-agent-service-container is Linux-only (systemd, sg, GNU env -0).
const launcher = resolve(__dirname, '../ops/host-container/wizard-agent-service-container')

function run(extraEnv: Record<string, string> = {}, args: string[] = [], cwdInHome = true) {
  const root = mkdtempSync(join(tmpdir(), 'wizard-host-container-'))
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const work = join(home, 'apps', 'wizard-mobile')
  mkdirSync(work, { recursive: true })
  mkdirSync(bin)
  const log = join(root, 'docker.log')
  // Stub docker: the socket is reachable, no leftover container, `run` records its argv.
  writeFileSync(join(bin, 'docker'), `#!/bin/bash
case "$1" in
  version) exit 0 ;;
  container) exit 1 ;;
  run) shift; printf '%s\\0' "$@" > ${JSON.stringify(log)}; exit 0 ;;
  *) echo "$@" >> ${JSON.stringify(log + '.other')}; exit 0 ;;
esac
`)
  chmodSync(join(bin, 'docker'), 0o755)
  const result = spawnSync('/bin/bash', [launcher, ...args], {
    cwd: cwdInHome ? work : root,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, WIZARD_HERMES_API_KEY: 'value-must-not-reach-argv', WIZARD_PORT: '8923', ...extraEnv },
    encoding: 'utf8',
  })
  let argv: string[] = []
  try { argv = readFileSync(log, 'utf8').split('\0').filter(Boolean) } catch { /* no run */ }
  return { result, argv, home, work, root }
}

describe.skipIf(process.platform !== 'linux')('host-container launcher', () => {
  it('runs the installed release isolated, with the home at the same path and env by name only', () => {
    const { result, argv, home, work } = run()
    expect(result.status, result.stderr).toBe(0)
    const joined = argv.join(' ')
    for (const flag of ['--read-only', '--init', '--rm']) expect(argv).toContain(flag)
    expect(joined).toContain('--network host')
    expect(joined).toContain('--cap-drop ALL')
    expect(joined).toContain('--security-opt no-new-privileges')
    expect(joined).toContain(`--user ${process.getuid!()}:${process.getgid!()}`)
    expect(argv).toContain(`type=bind,src=${home},dst=${home}`)
    expect(joined).toContain(`-w ${work}`)
    expect(argv.at(-1)).toBe(`${home}/.local/share/wizard-mobile-server/current/server/index.mjs`)
    expect(joined).toContain('-e WIZARD_HERMES_API_KEY')
    expect(joined).toContain('-e WIZARD_PORT')
    expect(joined).not.toContain('value-must-not-reach-argv')
    expect(joined).not.toMatch(/-e (PATH|PWD|WIZARD_CONTAINER_\w+)(\s|$)/)
  })

  it('takes overrides from WIZARD_CONTAINER_* and falls back to the home outside it', () => {
    const { result, argv, home } = run({ WIZARD_CONTAINER_NAME: 'rehearsal', WIZARD_CONTAINER_HOME_RO: '1',
      WIZARD_CONTAINER_RW: '/tmp/a=/data/a', WIZARD_CONTAINER_ENTRY: '/opt/x/index.mjs', XDG_DATA_HOME: '/unused' }, [], false)
    expect(result.status, result.stderr).toBe(0)
    const joined = argv.join(' ')
    expect(joined).toContain('--name rehearsal')
    expect(argv).toContain(`type=bind,src=${home},dst=${home},readonly`)
    expect(argv).toContain('type=bind,src=/tmp/a,dst=/data/a')
    expect(joined).toContain(`-w ${home}`)
    expect(argv.at(-1)).toBe('/opt/x/index.mjs')
  })

  it('--stop never starts a container', () => {
    const { result, argv } = run({}, ['--stop'])
    expect(result.status).toBe(0)
    expect(argv).toEqual([])
  })
})
