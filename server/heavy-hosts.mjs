// Operator-owned placement. A job's host is immutable; there is no failover.
export const HEAVY_HOSTS = ['thales', 'forum']

export function heavyHostConfigs(env = process.env) {
  const names = (env.WIZARD_BUILD_HOSTS || 'thales').split(',').map(s => s.trim()).filter(Boolean)
  if (!names.length || names.some(name => !HEAVY_HOSTS.includes(name))) throw new Error('invalid heavy hosts')
  return Object.fromEntries(names.map(name => {
    const prefix = `WIZARD_HEAVY_${name.toUpperCase()}_`
    // Only Thales inherits the single-host settings. Never reuse a Mac path,
    // Python, Docker socket, or SSH target on the Linux host.
    const legacy = name === 'thales'
    const setting = (key, old, fallback) => env[prefix + key] ?? (legacy ? env[old] || fallback : fallback)
    return [name, {
      host: setting('SSH_HOST', 'WIZARD_BUILD_HOST', legacy ? env.WIZARD_HEAVY_SSH_HOST : name),
      workRoot: setting('ROOT', 'WIZARD_HEAVY_ROOT', legacy ? env.WIZARD_WORK_ROOT : undefined),
      script: setting('REMOTE_SCRIPT', 'WIZARD_HEAVY_REMOTE_SCRIPT'),
      root: setting('REMOTE_ROOT', 'WIZARD_HEAVY_REMOTE_ROOT'),
      lock: setting('REMOTE_LOCK', 'WIZARD_HEAVY_REMOTE_LOCK'),
      python: setting('REMOTE_PYTHON', 'WIZARD_HEAVY_REMOTE_PYTHON', legacy ? '/opt/homebrew/bin/python3' : '/usr/bin/python3'),
      settings: Object.fromEntries(['AGENT_IMAGE', 'DOCKER_BIN', 'DOCKER_HOST'].map(key =>
        [`WIZARD_HEAVY_${key}`, setting(key, `WIZARD_HEAVY_${key}`)])),
    }]
  }))
}

export function heavyHost(spec) {
  const host = spec?.host === undefined ? 'thales' : spec.host
  if (!HEAVY_HOSTS.includes(host)) throw Object.assign(new Error('invalid heavy host'), { status: 400 })
  return host
}
