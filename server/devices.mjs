// Owner phone metadata only. Diagnostics events and accessibility services never enter this store.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const STRINGS = ['manufacturer', 'model', 'appVersion', 'webviewPackage', 'webviewVersion']
const VERSIONS = ['sdk', 'appVersion', 'versionCode', 'webviewPackage', 'webviewVersion']
const MAX_DEVICES = 20
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max
const key = (device) => JSON.stringify(['android', device.manufacturer, device.model])

function metadata(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return null
  const device = {}
  for (const field of STRINGS) {
    const value = session[field]
    if (typeof value !== 'string' || value.length > 80) return null
    device[field] = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim()
    if (!device[field]) return null
  }
  if (!integer(session.sdk, 1, 100) || !integer(session.versionCode, 1, 2147483647)) return null
  return { ...device, sdk: session.sdk, versionCode: session.versionCode }
}

export function createDevices({ statePath = '', now = Date.now } = {}) {
  const devices = new Map()
  const written = new Map()
  let dirty = false
  const list = () => [...devices.values()].sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen)).map(device => ({ ...device }))
  const cap = () => {
    while (devices.size > MAX_DEVICES) {
      const oldest = key(list().at(-1))
      devices.delete(oldest)
      written.delete(oldest)
    }
  }
  try {
    if (statePath && statSync(statePath).size <= 65536) {
      const stored = JSON.parse(readFileSync(statePath, 'utf8'))
      for (const row of Array.isArray(stored.devices) ? stored.devices.slice(0, MAX_DEVICES) : []) {
        const device = metadata(row)
        if (!device || typeof row.first_seen !== 'string' || typeof row.last_seen !== 'string'
          || !Number.isFinite(Date.parse(row.first_seen)) || !Number.isFinite(Date.parse(row.last_seen))
          || Date.parse(row.first_seen) > Date.parse(row.last_seen) || !integer(row.report_count, 1, Number.MAX_SAFE_INTEGER)) continue
        const value = { ...device, first_seen: new Date(row.first_seen).toISOString(), last_seen: new Date(row.last_seen).toISOString(), report_count: row.report_count }
        devices.set(key(device), value)
        written.set(key(device), Date.parse(value.last_seen))
      }
    }
  } catch { /* missing/corrupt metadata is disposable; never prevent service startup */ }

  function flush() {
    if (!statePath || !dirty) return
    const temp = `${statePath}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
      writeFileSync(temp, JSON.stringify({ devices: list() }) + '\n', { mode: 0o600 })
      renameSync(temp, statePath)
      dirty = false
      for (const id of devices.keys()) written.set(id, now())
    } finally { rmSync(temp, { force: true }) }
  }

  return {
    list,
    flush,
    record(session) {
      const device = metadata(session)
      if (!device) return false
      const id = key(device)
      const prior = devices.get(id)
      const time = now()
      const at = new Date(time).toISOString()
      devices.set(id, { ...device, first_seen: prior?.first_seen ?? at, last_seen: at, report_count: Math.min(Number.MAX_SAFE_INTEGER, (prior?.report_count ?? 0) + 1) })
      cap()
      dirty = true
      if (!prior || VERSIONS.some(field => prior[field] !== device[field]) || time - (written.get(id) ?? 0) >= 60000) flush()
      return true
    },
  }
}

const TOOL = {
  name: 'wizard_devices',
  description: "[Wizard OS] The owner's phones running the Wizard OS app: model, Android, app version, WebView version and when each last checked in. Check this first when the owner reports a phone or app problem or asks what version they have; never ask them.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}
const ago = (at, now) => {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60000))
  if (!minutes) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`
  return `${Math.floor(minutes / 1440)} days ago`
}
export function devicesTool({ devices, now = Date.now }) {
  return {
    list: () => [TOOL],
    call(name, args = {}) {
      if (name !== TOOL.name) return undefined
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) return { isError: true, content: [{ type: 'text', text: 'wizard_devices takes no arguments.' }] }
      const text = devices.list().map(d => `- ${d.manufacturer} ${d.model} (Android SDK ${d.sdk}): Wizard OS ${d.appVersion} (code ${d.versionCode}), WebView ${d.webviewPackage} ${d.webviewVersion}, last seen ${ago(d.last_seen, now())}`).join('\n')
        || 'No phones have checked in yet. The Wizard OS phone app reports itself while it is open.'
      return { content: [{ type: 'text', text }] }
    },
  }
}
