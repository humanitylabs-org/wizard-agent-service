import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { serviceLifetime } from '../server/service-lifetime.mjs'
import { acquireServiceLeases, restoreStoreSet, atomicStoreWrite } from '../server/store-migration.mjs'
import { startDelegationFollowThrough } from '../server/delegation-follow-through.mjs'

it('a stopped timer producer keeps its fence through an admitted continuation and handle close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timer-drain-'))
  const lifetime = serviceLifetime(acquireServiceLeases([dir]))
  let admit!: () => void, finish!: () => void
  const admitted = new Promise<void>(resolve => { admit = resolve })
  const pending = new Promise<void>(resolve => { finish = resolve })
  let admissions = 0, handleClosed = false
  const watcher = startDelegationFollowThrough({ enabled: async () => true,
    find: async () => [{ sessionId: 'wizard_fixture', messageId: 1 }], intervalMs: 60000,
    admit: async () => { admissions++; admit(); await pending; atomicStoreWrite(join(dir, 'receipt.json'), '{}') },
  })
  lifetime.own(async () => { await watcher.stop(); handleClosed = true }, () => watcher.stop())
  const tick = watcher.tick()
  await admitted
  const drained = lifetime.drain()
  try {
    expect(() => restoreStoreSet([dir], { serviceStopped: true })).toThrow(/exclusive writer ownership/)
    await watcher.tick() // stop disallows a later producer tick
    expect(admissions).toBe(1)
    expect(handleClosed).toBe(false)
    finish(); await tick; await drained
    expect(handleClosed).toBe(true)
    expect(restoreStoreSet([dir], { serviceStopped: true })).toContain(join(dir, 'receipt.json'))
  } finally { finish(); await drained; rmSync(dir, { recursive: true, force: true }) }
})

it('drains detached request continuations before closing handles or releasing any lease', async () => {
  const events: string[] = []
  const lifetime = serviceLifetime(() => { events.push('release-primary') })
  lifetime.lease(() => { events.push('release-optional') })
  lifetime.own(() => { events.push('close') }, () => { events.push('stop') })
  const done = lifetime.request()
  const drained = lifetime.drain()
  await Promise.resolve()
  expect(events).toEqual(['stop'])
  let finish!: () => void
  const child = lifetime.track(new Promise<void>(resolve => { finish = resolve }))
  done(); await Promise.resolve()
  expect(events).toEqual(['stop'])
  finish(); await child; await drained
  expect(events).toEqual(['stop', 'close', 'release-optional', 'release-primary'])
  expect(lifetime.drain()).toBe(drained)
})

it.each(['request', 'producer', 'close'])('R4_N3: bounded %s drain logs a diagnostic and retains the actual lease after late completion', async stage => {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-drain-'))
  const release = acquireServiceLeases([dir]), releaseSpy = vi.fn(release)
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const lifetime = serviceLifetime(releaseSpy, { drainTimeoutMs: 10 })
  const close = vi.fn(() => stage === 'close' ? pending : undefined)
  lifetime.own(close, () => stage === 'producer' ? pending : undefined)
  if (stage === 'request') void lifetime.track(pending)
  try {
    await expect(lifetime.drain()).rejects.toThrow(/writer drain timed out after 10ms/)
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('service lease retained'), expect.stringContaining('timed out'))
    expect(releaseSpy).not.toHaveBeenCalled()
    expect(() => restoreStoreSet([dir], { serviceStopped: true })).toThrow(/exclusive writer ownership/)
    if (stage !== 'close') expect(close).not.toHaveBeenCalled()
    finish()
    await new Promise(resolve => setImmediate(resolve))
    expect(close).toHaveBeenCalledOnce()
    expect(releaseSpy).not.toHaveBeenCalled()
    expect(() => restoreStoreSet([dir], { serviceStopped: true })).toThrow(/exclusive writer ownership/)
    await expect(lifetime.drain()).rejects.toThrow(/timed out/)
  } finally {
    finish(); release(); diagnostic.mockRestore(); rmSync(dir, { recursive: true, force: true })
  }
})
