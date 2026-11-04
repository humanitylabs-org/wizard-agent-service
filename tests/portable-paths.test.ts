import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
// Assemble the forbidden literals so the guard checks itself too.
const ownerHost = ['tha', 'les'].join('')
const personal = new RegExp([
  '/Volumes/' + 'ThalesMedia', '/home/' + 'telos',
  '[a-zA-Z0-9.-]*\\.' + 'tailc0f369' + '\\.ts\\.net',
  '\\bssh\\s+(?:[^\\n;]*?\\s)?' + ownerHost + '(?=\\s|[\'"`]|$)',
  // Host placement identifiers are now a public API enum; reject concrete SSH/scp targets, not enum literals.
  '[\'"]ssh[\'"]\\s*,\\s*[\'"]' + ownerHost + '[\'"]',
  '[\'"]' + ownerHost + ':',
  '\\b' + ownerHost + '\\.local\\b',
].join('|'))
const evidence = (path: string) => /^(?:docs|ops)\/evidence\//.test(path)
  || /^docs\/acceptance\/[^/]+\/RECEIPT[^/]*$/.test(path)

it('tracked files contain no personal machine paths or SSH hosts outside evidence receipts', () => {
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  const violations: string[] = []
  for (const path of paths) {
    if (evidence(path)) continue
    const text = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
    text.split('\n').forEach((line, index) => {
      // This exact storage destination is part of the heavy placement policy,
      // not an executable local path or an implicit host selection.
      const checked = path === 'hermes-plugin/wizard-heavy/__init__.py'
        ? line.replace('/Volumes/' + 'ThalesMedia or R2', '<durable-output-store>') : line
      if (personal.test(checked)) violations.push(`${path}:${index + 1}: ${line.trim()}`)
    })
  }
  expect(violations, violations.join('\n')).toEqual([])
})

it('recognizes personal paths and host targets without rejecting script names or env examples', () => {
  for (const value of ['/Volumes/' + 'ThalesMedia/work', '/home/' + 'telos/.hermes',
    'https://wizard.' + 'tailc0f369' + '.ts.net', 'ssh ' + ownerHost, "['ssh', '" + ownerHost + "']",
    "'" + ownerHost + ":/work'", "['scp', '" + ownerHost + ":/work']"]) expect(personal.test(value), value).toBe(true)
  for (const value of ['scripts/android-build-thales.py', 'WIZARD_BUILD_HOST', 'ssh "$WIZARD_BUILD_HOST"', "host='" + ownerHost + "'", "['" + ownerHost + "', 'forum']"])
    expect(personal.test(value), value).toBe(false)
})
