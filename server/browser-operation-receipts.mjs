// Durable outcome receipts for browser app mutations (data.call operationKey semantics).
// Written by the Agent Service, the owning adapter, BEFORE the upstream effect, and read back from disk
// before any success is reported. Bounded: per installation, in total and by age; a full store refuses
// new writes (quota_exceeded) instead of evicting a live receipt or claiming a save.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code, ...extra }) }
export const RECEIPT_RETENTION_MS = 7 * 24 * 3600 * 1000

export function createOperationReceipts({ path, perInstallation = 256, total = 4096, maxBytes = 1024 * 1024, retentionMs = RECEIPT_RETENTION_MS, now = () => Date.now() }) {
  if (!path) throw new Error('receipt path required')
  const id = r => [r.installationId, r.operation, r.operationKey].join('|')
  function load() {
    let doc
    try { doc = JSON.parse(readFileSync(path, 'utf8')) } catch (e) {
      if (e.code === 'ENOENT') return { schema: 1, receipts: {} }
      fail('storage_unavailable')
    }
    if (!doc || doc.schema !== 1 || !doc.receipts || typeof doc.receipts !== 'object') fail('storage_unavailable')
    return doc
  }
  function save(doc) {
    const body = JSON.stringify(doc)
    if (Buffer.byteLength(body) > maxBytes) fail('quota_exceeded')
    const tmp = `${path}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const fd = openSync(tmp, 'w', 0o600)
      try { writeSync(fd, body); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(tmp, path)
      const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir) } finally { closeSync(dir) }
    } catch (e) {
      try { unlinkSync(tmp) } catch { /* nothing staged */ }
      fail(e.code === 'ENOSPC' || e.code === 'EDQUOT' ? 'quota_exceeded' : 'storage_unavailable')
    }
    if (readFileSync(path, 'utf8') !== body) fail('storage_unavailable')
  }
  function prune(doc) {
    const cutoff = now() - retentionMs
    for (const [k, r] of Object.entries(doc.receipts)) if (r.status !== 'pending' && r.updatedAt < cutoff) delete doc.receipts[k]
    return doc
  }
  return Object.freeze({
    get(installationId, operation, operationKey) {
      const r = prune(load()).receipts[id({ installationId, operation, operationKey })]
      return r ? structuredClone(r) : null
    },
    /** Create or advance one receipt atomically, then confirm the bytes on disk. */
    put(receipt) {
      const doc = prune(load())
      const k = id(receipt), existing = doc.receipts[k]
      if (!existing) {
        const all = Object.values(doc.receipts)
        // Pending receipts are never evicted; expired completed ones were pruned above.
        if (all.length >= total || all.filter(r => r.installationId === receipt.installationId).length >= perInstallation) fail('quota_exceeded')
      }
      const t = now()
      doc.receipts[k] = { ...structuredClone(receipt), createdAt: existing?.createdAt ?? t, updatedAt: t }
      save(doc)
      return structuredClone(doc.receipts[k])
    },
    size() { return Object.keys(prune(load()).receipts).length },
  })
}
