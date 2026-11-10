#!/usr/bin/env node
// Issue 440: check the channel store migration against a COPY of a real ui-preferences.json, read-only.
//   node scripts/channels-migrate-check.mjs <copy of ui-preferences.json>
// Migrates into a temporary channels.sqlite (deleted afterwards), then compares every Space and membership
// with what the store holds. Prints counts only (no names, no thread ids). Exit 0 when identical.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readUiPreferences } from '../server/ui-preferences.mjs'
import { createChannelStore } from '../server/channel-store.mjs'

export function checkMigration(file) {
  const spaces = readUiPreferences(resolve(file)).spaces
  const dir = mkdtempSync(join(tmpdir(), 'channels-check-'))
  const store = createChannelStore(join(dir, 'channels.sqlite'))
  try {
    const first = store.migrateSpaces(spaces)
    store.seedAlerts()
    const second = store.migrateSpaces(spaces)
    store.seedAlerts()
    const mismatches = []
    const seen = new Map()
    for (const s of spaces) {
      let channel = null
      try { channel = store.get(s.id) } catch { mismatches.push({ space: spaces.indexOf(s), problem: 'missing_channel' }); continue }
      if (channel.name !== s.name || channel.agent !== (s.agent || 'hermes') || channel.createdAt !== s.createdAt) mismatches.push({ space: spaces.indexOf(s), problem: 'channel_fields' })
      const members = store.members(s.id).map(m => m.sessionId)
      const expected = s.threads.filter(t => { const k = `${s.agent || 'hermes'}\n${t}`; if (seen.has(k)) return false; seen.set(k, s.id); return true })
      if (JSON.stringify([...members].sort()) !== JSON.stringify([...expected].sort())) mismatches.push({ space: spaces.indexOf(s), problem: 'memberships', expected: expected.length, got: members.length })
    }
    const channels = store.list().channels
    const alerts = channels.filter(c => c.kind === 'alerts')
    const memberships = spaces.reduce((n, s) => n + s.threads.length, 0)
    const filed = channels.reduce((n, c) => n + c.count, 0)
    if (alerts.length !== 1) mismatches.push({ problem: 'alerts', got: alerts.length })
    if (second.migrated) mismatches.push({ problem: 'not_idempotent' })
    return { ok: mismatches.length === 0 && first.migrated, spaces: spaces.length, memberships, channels: channels.length - alerts.length,
      filed, duplicates: first.duplicates, alerts: alerts.length === 1, mismatches }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (!process.argv[2]) { console.error('usage: node scripts/channels-migrate-check.mjs <copy of ui-preferences.json>'); process.exit(2) }
  const report = checkMigration(process.argv[2])
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.ok ? 0 : 1)
}
