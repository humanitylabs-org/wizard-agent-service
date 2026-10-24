// "Connect your phone": the Agent Service half of Wizard OS phone setup (Tailscale).
//
// The box's root helper `wizard-private-access` (ops/private-access/) owns Tailscale; this module talks to
// it over its unix socket and turns its status into the Setup app's steps:
//
//   unavailable  no helper socket (a dev box), or Tailscale is not installed
//   off          Tailscale is installed but not started / not signed in, and no sign-in is pending
//   signin       the owner must open auth_url and sign in to Tailscale
//   https        signed in; Serve is not on yet (https_enable_url, when present, turns HTTPS on for the tailnet)
//   serving      https://<this box>.<tailnet>.ts.net/ answers through Tailscale Serve
//   phone_seen   the owner's phone reached it (or an iOS/Android device of the owner is online)
//
// Once serving, it records the address and owner in Wizard OS settings (network.base_url, network.aliases,
// access.tailscale) through updateSettings, so tailnet-access.mjs authorizes the owner's phone without a
// restart. Reset clears them. Nothing here is specific to one owner, tailnet or machine.

import { existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { readSettings, updateSettings, validLogin, validTailnetOrigin } from './wizard-os-settings.mjs'

export const DEFAULT_PRIVATE_ACCESS_SOCKET = '/run/wizard-private-access/sock'
export const INSTALL_URL = 'https://tailscale.com/download'
export const PHONE_ITEM_TITLE = 'Use Wizard on your phone'
const MOBILE_OS = new Set(['ios', 'android', 'ipados'])
const MOBILE_UA = /\b(?:iPhone|iPad|iPod|Android)\b|\bMobile\b/u
const SERVE_RETRY_MS = 5000

/** Call the helper: resolves { status, body } or rejects with { code: 'unavailable' | 'helper_error' }. */
export function helperCall(socketPath, method, path, body, { timeoutMs = 20000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    if (!socketPath || !existsSync(socketPath)) {
      // absent: this box has no private-access helper at all (a dev box, or one whose owner runs Tailscale).
      reject(Object.assign(new Error('no helper socket'), { code: 'unavailable', absent: true }))
      return
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = httpRequest({
      socketPath, method, path,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : { 'Content-Length': 0 },
    }, (res) => {
      const parts = []
      let size = 0
      res.on('data', (part) => {
        size += part.length
        if (size > 256 * 1024) { req.destroy(new Error('helper reply too large')); return }
        parts.push(part)
      })
      res.on('end', () => {
        let value = null
        try { value = JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { /* handled below */ }
        if (!value || typeof value !== 'object') { reject(Object.assign(new Error('bad helper reply'), { code: 'helper_error' })); return }
        resolvePromise({ status: res.statusCode || 0, body: value })
      })
      res.on('error', (error) => reject(Object.assign(error, { code: 'helper_error' })))
    })
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('helper timeout'), { code: 'helper_timeout' })))
    req.on('error', (error) => {
      // EACCES is a socket-group mistake on a real box, not a dev box: say so instead of "unavailable".
      const code = ['ENOENT', 'ECONNREFUSED'].includes(error?.code) ? 'unavailable' : error?.code === 'EACCES' ? 'helper_forbidden'
        : error?.code === 'helper_timeout' ? 'helper_timeout' : 'helper_error'
      // ECONNREFUSED: the helper's socket exists but nothing answers, an outage on a helper-managed box, not an absent helper.
      reject(Object.assign(new Error('helper unreachable'), { code, absent: error?.code === 'ENOENT' }))
    })
    if (payload) req.end(payload)
    else req.end()
  })
}

function nowIso(now) {
  return new Date(now()).toISOString().replace(/\.\d{3}Z$/u, 'Z')
}

function cleanName(value, max = 64) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, max) : ''
}

/** The tailnet origin of a helper status, or '' when the box is not signed in with a valid name. */
export function statusOrigin(status) {
  const dns = typeof status?.dns_name === 'string' ? status.dns_name.replace(/\.$/u, '').toLowerCase() : ''
  return dns ? validTailnetOrigin(`https://${dns}`) : ''
}

function isPhone(peer) {
  return MOBILE_OS.has(String(peer?.os || '').toLowerCase())
}

/** Requests through Serve from a phone or tablet browser (or the Wizard Android app's WebView). */
export function mobileUserAgent(request) {
  const ua = request?.headers?.['user-agent']
  return typeof ua === 'string' && MOBILE_UA.test(ua)
}

/**
 * @param {{ settingsPath: string, socketPath?: string, now?: () => number, call?: typeof helperCall, hostname?: string, accessPinned?: boolean, hostShellUrl?: () => string, launchMode?: string }} options
 */
export function createPhoneSetup({ settingsPath, socketPath = DEFAULT_PRIVATE_ACCESS_SOCKET, now = () => Date.now(), call = helperCall, hostname = 'wizard', accessPinned = false, hostShellUrl = () => '', launchMode = process.env.WIZARD_SETUP_MODE }) {
  let chain = Promise.resolve()
  let lastServeAttempt = 0
  // Serialize every helper action and settings write from this service.
  const serial = (task) => {
    const run = chain.then(task, task)
    chain = run.catch(() => {})
    return run
  }
  const settings = () => readSettings(settingsPath).settings
  const write = (mutate) => updateSettings(settingsPath, mutate)

  const helper = async (method, path, body) => {
    // start/serve/reset may wait on systemctl and the tailscale CLI (bounded in the helper to about a minute).
    const { status, body: value } = await call(socketPath, method, path, body, method === 'POST' ? { timeoutMs: 75000 } : undefined)
    if (status !== 200) throw Object.assign(new Error('helper refused'), { code: typeof value.error === 'string' ? value.error.slice(0, 60) : 'helper_error' })
    return value
  }

  // Running + serving: record the address and the owner (idempotent).
  const recordServing = (status) => {
    const origin = statusOrigin(status)
    const login = validLogin(status?.owner_login)
    if (!origin || !login) return settings()
    const current = settings()
    const already = current.network.base_url === origin && current.access.tailscale.origin === origin
      && current.access.tailscale.owner_logins.length === 1 && current.access.tailscale.owner_logins[0] === login
    if (already) return current
    return write((raw) => {
      const network = raw.network && typeof raw.network === 'object' && !Array.isArray(raw.network) ? raw.network : {}
      const aliases = Array.isArray(network.aliases) ? network.aliases.filter((v) => typeof v === 'string') : []
      const previous = current.network.base_url
      if (previous && previous !== origin) {
        const host = new URL(previous).hostname
        if (!aliases.includes(host)) aliases.unshift(host)
      }
      raw.network = { ...network, base_url: origin, aliases: aliases.filter((host) => host !== new URL(origin).hostname).slice(0, 8) }
      const access = raw.access && typeof raw.access === 'object' && !Array.isArray(raw.access) ? raw.access : {}
      raw.access = { ...access, tailscale: { origin, owner_logins: [login] } }
    })
  }

  const markSetup = (key, value) => write((raw) => {
    const setup = raw.setup && typeof raw.setup === 'object' && !Array.isArray(raw.setup) ? raw.setup : {}
    raw.setup = { ...setup, [key]: value }
  })

  const clearPhone = () => write((raw) => {
    const current = normalizeView(raw)
    const network = raw.network && typeof raw.network === 'object' && !Array.isArray(raw.network) ? raw.network : {}
    const aliases = Array.isArray(network.aliases) ? network.aliases.filter((v) => typeof v === 'string') : []
    // A former tailnet address stays an alias so old links still fold into paths; it no longer authorizes anyone.
    if (current.base && current.base === current.tailnet) {
      const host = new URL(current.base).hostname
      if (!aliases.includes(host)) aliases.unshift(host)
      raw.network = { ...network, base_url: '', aliases: aliases.slice(0, 8) }
    }
    const access = raw.access && typeof raw.access === 'object' && !Array.isArray(raw.access) ? raw.access : {}
    const { tailscale: _dropped, ...rest } = access
    raw.access = rest
    const setup = raw.setup && typeof raw.setup === 'object' && !Array.isArray(raw.setup) ? raw.setup : {}
    const { phone_started_at: _started, phone_seen_at: _seen, ...keep } = setup
    raw.setup = keep
  })

  const view = (status, error = null, absent = false) => {
    const saved = settings()
    const base = { step: 'unavailable', auth_url: null, https_enable_url: null, wizard_url: null, device_name: null, phones: [], install_url: INSTALL_URL, error }
    if (!status) {
      // A helper's clean stop can unlink its socket too. Saved enrollment is evidence
      // this is NOT an unmanaged host, so never reclassify its stale address as ready.
      if (absent && (saved.setup.phone_started_at || saved.access.tailscale.origin) && !accessPinned) {
        return { ...base, error: error || 'helper_unreachable' }
      }
      // No helper, but the host already serves this box privately on its tailnet (a hand-built box whose owner
      // runs Tailscale themselves) and network.base_url names that address: the phone can connect today, so
      // show the address and QR instead of "phone setup isn't available".
      // Only when the helper is genuinely absent: during a helper outage the saved address may be stale.
      const hosted = absent && !error && validTailnetOrigin(saved.network?.base_url)
      if (hosted) {
        const seen = Boolean(saved.setup.phone_seen_at)
        return { ...base, step: seen ? 'phone_seen' : 'serving', wizard_url: `${hosted}/`, device_name: new URL(hosted).hostname, managed: 'host' }
      }
      // Alongside installs: the installer runs host Tailscale itself (no helper) and records the shell's private
      // https address in apps.json, but never writes network.base_url. That address is where the phone opens Wizard.
      const shell = absent && !error ? hostShellLink(hostShellUrl) : null
      if (shell) {
        const seen = Boolean(saved.setup.phone_seen_at)
        return { ...base, step: seen ? 'phone_seen' : 'serving', wizard_url: shell.url, device_name: shell.host, managed: 'host' }
      }
      return base
    }
    const phones = (Array.isArray(status.peers) ? status.peers : []).filter(isPhone).slice(0, 16)
      .map((peer) => ({ name: cleanName(peer.name) || 'phone', os: cleanName(peer.os, 32), online: peer.online === true }))
    const out = { ...base, phones }
    if (!status.installed || status.daemon === 'missing') return { ...out, error: error || 'tailscale_not_installed' }
    const backend = status.backend_state
    if (status.daemon !== 'running' || backend !== 'Running') {
      const auth = typeof status.auth_url === 'string' && /^https:\/\//u.test(status.auth_url) ? status.auth_url : null
      if (auth) return { ...out, step: 'signin', auth_url: auth }
      if (backend === 'NeedsMachineAuth') return { ...out, step: 'signin', error: error || 'needs_machine_auth' }
      return { ...out, step: 'off' }
    }
    const origin = statusOrigin(status)
    const device = origin ? new URL(origin).hostname : null
    const serving = Boolean(origin && status.serve?.on)
    if (!serving) {
      const enable = typeof status.https_enable_url === 'string' && /^https:\/\//u.test(status.https_enable_url) ? status.https_enable_url : null
      return { ...out, step: 'https', https_enable_url: enable, device_name: device }
    }
    // Serving means the phone can sign in: Serve is on AND this box's settings name it and its owner.
    if (saved.access.tailscale.origin !== origin) return { ...out, step: 'https', device_name: device, error: error || 'owner_not_recorded' }
    const seen = Boolean(saved.setup.phone_seen_at)
    return { ...out, step: seen ? 'phone_seen' : 'serving', wizard_url: `${origin}/`, device_name: device }
  }

  const statusOrNull = async () => {
    try { return { status: await helper('GET', '/v1/status') } }
    catch (error) {
      if (error?.code !== 'unavailable') return { status: null, error: error?.code || 'helper_error' }
      // A helper that exists but is down is a failure to report, never a host-managed box with a stale QR.
      return error.absent === true ? { status: null, error: null, absent: true } : { status: null, error: 'helper_unreachable' }
    }
  }

  // Bring a signed-in box the rest of the way: Serve on, settings recorded, phone noticed.
  const advance = async (status, { forceServe = false } = {}) => {
    let current = status
    let error = null
    const started = Boolean(settings().setup.phone_started_at)
    if (current?.backend_state === 'Running' && current.daemon === 'running' && !current.serve?.on && (started || forceServe)
      && (forceServe || now() - lastServeAttempt >= SERVE_RETRY_MS)) {
      lastServeAttempt = now()
      try { current = await helper('POST', '/v1/serve', {}) } catch (e) { error = e?.code || 'helper_error' }
    }
    // Only an enrollment the owner started (and has not reset) is recorded: a poll after a reset that did not
    // reach Tailscale must never re-authorize the tailnet.
    if (current?.backend_state === 'Running' && current.serve?.on && statusOrigin(current) && settings().setup.phone_started_at) {
      try {
        recordServing(current)
        const saved = settings()
        if (!saved.setup.phone_seen_at && saved.access.tailscale.origin
          && (Array.isArray(current.peers) ? current.peers : []).some((peer) => isPhone(peer) && peer.online === true)) {
          markSetup('phone_seen_at', nowIso(now))
        }
      } catch (e) { error = error || e?.code || 'settings_unavailable' }
    }
    return view(current, error)
  }

  return {
    /** GET /wizard/v1/setup */
    async overview() {
      const saved = settings()
      // Host-managed private access is already configured outside Setup. Use the same validated
      // readiness as the phone screen, without pretending we have actually seen a phone.
      let ready = false
      if (hostShellLink(hostShellUrl) || validTailnetOrigin(saved.network?.base_url)) {
        const { status, error, absent } = await statusOrNull()
        const phone = view(status, error, absent)
        // This flag is a checklist-copy hint for ready-but-not-yet-seen, not a general capability.
        // Once a phone was seen, preserve the existing "connected" checklist state/copy instead.
        ready = phone.managed === 'host' && phone.step === 'serving'
      }
      const state = saved.setup.phone_seen_at || ready ? 'done'
        : (saved.setup.phone_started_at || saved.access.tailscale.origin) ? 'in_progress' : 'todo'
      return { first_run: !saved.setup.seen_at,
        ...(launchMode === 'alongside' ? { launch_mode: 'alongside' } : {}),
        items: [{ id: 'phone', title: PHONE_ITEM_TITLE, state, ...(ready ? { phone_ready: true } : {}) }] }
    },
    /** POST /wizard/v1/setup/seen */
    markSeen: () => serial(async () => {
      if (!settings().setup.seen_at) markSetup('seen_at', nowIso(now))
      return { ok: true }
    }),
    /** GET /wizard/v1/setup/phone */
    phone: () => serial(async () => {
      const { status, error, absent } = await statusOrNull()
      if (!status) return view(null, error, absent)
      return advance(status)
    }),
    /** POST /wizard/v1/setup/phone/start */
    start: () => serial(async () => {
      let status
      try { status = await helper('POST', '/v1/start', { hostname }) }
      catch (error) {
        if (error?.code === 'unavailable') return view(null)
        const fallback = await statusOrNull()
        return view(fallback.status, error?.code || 'helper_error')
      }
      try { if (!settings().setup.phone_started_at) markSetup('phone_started_at', nowIso(now)) } catch { /* the flow still works for this session */ }
      return advance(status, { forceServe: true })
    }),
    /** POST /wizard/v1/setup/phone/reset */
    reset: () => serial(async () => {
      let status = null
      let error = null
      // Settings are cleared first and regardless of the helper: revoking phone access must not depend on
      // Tailscale answering. A failed helper reset is reported; the box stays unauthorized until a new start.
      try { clearPhone() } catch (e) { error = e?.code || 'settings_unavailable' }
      try { status = await helper('POST', '/v1/reset', {}) }
      catch (e) {
        if (e?.code !== 'unavailable') {
          error = error || e?.code || 'helper_error'
          status = (await statusOrNull()).status
        }
      }
      lastServeAttempt = 0
      // WIZARD_TAILNET_ORIGIN/LOGIN pin tailnet access in the environment: settings do not grant or revoke it.
      return view(status, error || (accessPinned ? 'access_pinned_by_environment' : null))
    }),
    /** Called for every request the tailnet verifier accepted: a phone browser reaching Serve as the owner. */
    noteOwnerRequest(request) {
      if (!mobileUserAgent(request)) return
      const saved = settings()
      if (saved.setup.phone_seen_at || (!saved.access.tailscale.origin && !accessPinned)) return
      serial(async () => {
        const again = settings()
        if (!again.setup.phone_seen_at && (again.access.tailscale.origin || accessPinned)) markSetup('phone_seen_at', nowIso(now))
      }).catch(() => {})
    },
  }
}

/** The shell's private tailnet link (https://<box>.<tailnet>.ts.net[:port]/path/) from apps.json, or null. */
function hostShellLink(read) {
  let value = ''
  try { value = String(read() || '') } catch { return null }
  let u
  try { u = new URL(value) } catch { return null }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null
  if (!/^[a-z0-9.-]+\.ts\.net$/u.test(u.hostname)) return null
  return { url: u.href, host: u.hostname }
}

function normalizeView(raw) {
  const network = raw?.network && typeof raw.network === 'object' ? raw.network : {}
  const access = raw?.access && typeof raw.access === 'object' ? raw.access : {}
  return { base: validTailnetOrigin(network.base_url), tailnet: validTailnetOrigin(access.tailscale?.origin) }
}
