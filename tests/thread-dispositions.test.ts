import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ThreadDispositionStore } from '../server/thread-dispositions.mjs'
import { post, scene } from '../qa/agent-parity/fixture.mjs'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const statePath = () => {
  const directory = mkdtempSync(join(tmpdir(), 'thread-dispositions-'))
  directories.push(directory)
  return join(directory, 'thread-dispositions.json')
}

describe('ThreadDispositionStore device markers', () => {
  it('merges device-only and deferred-only writes without losing the other field', () => {
    const path = statePath()
    const store = new ThreadDispositionStore(path)

    expect(store.set('owner', 'direct', 'wizard_device', { deferred: true, device: '  Abby’s   iPhone  ' })).toMatchObject({
      deferred: true,
      device: 'Abby’s iPhone',
      agent_id: 'hermes',
      session_id: 'wizard_device',
    })
    expect(store.set('owner', 'direct', 'wizard_device', false)).toMatchObject({ deferred: false, device: 'Abby’s iPhone' })
    expect(store.set('owner', 'direct', 'wizard_device', { device: '  Quinn’s iPad  ' })).toMatchObject({ deferred: false, device: 'Quinn’s iPad' })
    expect(store.set('owner', 'direct', 'wizard_device', { device: '   ' })).toMatchObject({ deferred: false })
    expect(store.get('owner')['direct:wizard_device']).not.toHaveProperty('device')
    expect(store.set('owner', 'direct', 'wizard_device_only', { device: 'Laptop' })).toMatchObject({ deferred: false, device: 'Laptop' })
    expect(new ThreadDispositionStore(path).get('owner')['direct:wizard_device']).toMatchObject({ deferred: false, session_id: 'wizard_device' })
  })

  it('keeps schema-1 deferred-only records readable and rejects invalid device values without writing', () => {
    const path = statePath()
    writeFileSync(path, JSON.stringify({ schema: 1, scopes: { owner: {
      'direct:wizard_legacy': { deferred: true, updatedAt: '2026-10-30T00:00:00.000Z', agent_id: 'hermes', session_id: 'wizard_legacy' },
    } } }))
    const store = new ThreadDispositionStore(path)
    expect(store.get('owner')['direct:wizard_legacy']).toMatchObject({ deferred: true, session_id: 'wizard_legacy' })

    const before = readFileSync(path, 'utf8')
    for (const device of ['x'.repeat(61), 12, null]) {
      expect(() => store.set('owner', 'direct', 'wizard_legacy', { device } as any)).toThrow(/Invalid thread disposition/)
      expect(readFileSync(path, 'utf8')).toBe(before)
    }
  })

  it('keeps the HTTP PUT contract partial, validated, and read-back durable', async () => {
    const fixture = await scene('main')
    try {
      const put = (body: Record<string, unknown>) => fixture.raw('/wizard/thread-dispositions', { ...post(body), method: 'PUT' })
      const seed = await put({ runtime: 'direct', sessionId: 'wizard_http_device', deferred: true, device: '  Pixel   Tablet  ' })
      expect(seed.status).toBe(200)
      expect((await seed.json()).record).toMatchObject({ deferred: true, device: 'Pixel Tablet', session_id: 'wizard_http_device' })

      const deferredOnly = await put({ runtime: 'direct', sessionId: 'wizard_http_device', deferred: false })
      expect(deferredOnly.status).toBe(200)
      expect((await deferredOnly.json()).record).toMatchObject({ deferred: false, device: 'Pixel Tablet' })

      const deviceOnly = await put({ runtime: 'direct', sessionId: 'wizard_http_device', device: '  Pixel Phone  ' })
      expect(deviceOnly.status).toBe(200)
      expect((await deviceOnly.json()).record).toMatchObject({ deferred: false, device: 'Pixel Phone' })

      const cleared = await put({ runtime: 'direct', sessionId: 'wizard_http_device', device: '' })
      expect(cleared.status).toBe(200)
      expect((await cleared.json()).record).toMatchObject({ deferred: false })
      const beforeInvalid = await (await fixture.raw('/wizard/thread-dispositions')).json()
      for (const body of [
        { runtime: 'direct', sessionId: 'wizard_http_device' },
        { runtime: 'direct', sessionId: 'wizard_http_device', deferred: 'false' },
        { runtime: 'direct', sessionId: 'wizard_http_device', device: 7 },
        { runtime: 'direct', sessionId: 'wizard_http_device', device: 'x'.repeat(61) },
      ]) expect((await put(body)).status).toBe(400)
      expect(await (await fixture.raw('/wizard/thread-dispositions')).json()).toEqual(beforeInvalid)
    } finally {
      await fixture.close()
    }
  })

  it('merges simultaneous writes from two clients instead of losing either field', async () => {
    const fixture = await scene('main')
    try {
      const put = (body: Record<string, unknown>) => fixture.raw('/wizard/thread-dispositions', { ...post(body), method: 'PUT' })
      const [deferred, device] = await Promise.all([
        put({ runtime: 'direct', sessionId: 'wizard_two_devices', deferred: true }),
        put({ runtime: 'direct', sessionId: 'wizard_two_devices', device: 'Shared Tablet' }),
      ])
      expect(deferred.status).toBe(200)
      expect(device.status).toBe(200)
      const state = await (await fixture.raw('/wizard/thread-dispositions')).json()
      expect(state.state['direct:wizard_two_devices']).toMatchObject({ deferred: true, device: 'Shared Tablet' })
    } finally {
      await fixture.close()
    }
  })
})
