import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

/** Issue 532: a box that deploys with an older installed deploy helper never runs the helper's plugin
 * refresh, so the host Hermes kept its old copy of the Service's own plugins (wizard_schedule without
 * `thread`). The Service therefore runs the same refresh (ops/sync-hermes-plugins.py, with all its
 * owner-edit, link, git-checkout and Hermes-install guards) from its own release folder once at startup,
 * whatever started it. It never blocks or fails startup. WIZARD_HERMES_PLUGIN_SYNC=0 turns it off.
 * Resolves to the parsed result, or `{ skipped }` / `{ error }`. */
export function startHermesPluginSync({
  releaseRoot = ROOT,
  hermesHome = process.env.HERMES_HOME || resolve(homedir(), '.hermes'),
  env = process.env,
  run = execFile,
  log = line => process.stdout.write(`${line}\n`),
  timeoutMs = 120_000,
} = {}) {
  const done = result => {
    log(`[hermes-plugins] ${JSON.stringify(result)}`)
    return result
  }
  try {
    if (env.WIZARD_HERMES_PLUGIN_SYNC === '0') return Promise.resolve(done({ skipped: 'off (WIZARD_HERMES_PLUGIN_SYNC=0)' }))
    const script = join(releaseRoot, 'ops', 'sync-hermes-plugins.py')
    if (!existsSync(script) || !existsSync(join(releaseRoot, 'hermes-plugin'))) {
      return Promise.resolve(done({ skipped: 'release has no plugin sync step' }))
    }
    const home = resolve(hermesHome)
    const plugins = join(home, 'plugins')
    if (!existsSync(plugins) || !statSync(plugins).isDirectory()) {
      return Promise.resolve(done({ skipped: 'no host Hermes plugins folder' }))
    }
    const python = env.WIZARD_PLUGIN_SYNC_PYTHON || 'python3'
    return new Promise(settle => {
      try {
        run(python, [script, releaseRoot, '--hermes-home', home], { timeout: timeoutMs, encoding: 'utf8', env }, (error, stdout) => {
          const last = String(stdout || '').trim().split('\n').at(-1) || ''
          try {
            if (last) return settle(done(JSON.parse(last)))
          } catch {}
          settle(done({ error: String(error?.message || 'no result').slice(-300) }))
        })
      } catch (error) {
        settle(done({ error: String(error?.message || error).slice(-300) }))
      }
    })
  } catch (error) {
    return Promise.resolve(done({ error: String(error?.message || error).slice(-300) }))
  }
}
