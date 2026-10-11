import { describe, expect, it } from 'vitest'
import { readCanonicalSessionsHttp } from '../server/hermes-http-readers.mjs'

// GET /api/sessions on stock Hermes: newest first, compression chains listed under their root id
// with the live tip's fields (_lineage_root_id), delegate children flagged is_internal_child.
describe('canonical session listing over Hermes HTTP', () => {
  it('keeps Wizard-visible human threads, under their root id, and appends archived ones', async () => {
    const now = Date.UTC(2026, 9, 11)
    const t = now / 1000
    const page = [
      { id: 'tip_1', _lineage_root_id: 'wizard_root', _lineage_ids: ['wizard_root', 'tip_1'], source: 'api_server', title: 'Live tip title', last_active: t - 10, message_count: 4 },
      { id: 'tg_1', source: 'telegram', title: 'Telegram', last_active: t - 20, message_count: 2 },
      { id: 'cron_1', source: 'cron', title: 'Cron', last_active: t - 30, message_count: 2 },
      { id: 'wizard_child', source: 'api_server', is_internal_child: true, last_active: t - 40, message_count: 2 },
      { id: 'wizard_empty', source: 'api_server', last_active: t - 50, message_count: 0 },
      { id: 'wizard_hidden', source: 'api_server', hidden: true, last_active: t - 55, message_count: 3 },
      { id: 'wizard_old', source: 'api_server', last_active: t - 40 * 86400, message_count: 3 },
    ]
    const seen: string[] = []
    const request = async (path: string) => { seen.push(path); return { object: 'list', data: path.includes('offset=0') ? page : [] } }
    const archived = () => [{ id: 'wizard_archived', source: 'api_server', last_active: t - 15, message_count: 2, archived: true, pinned: false, hidden: false }]
    const sessions = await readCanonicalSessionsHttp(request, { archived, now })
    expect(sessions.map((s) => s.id)).toEqual(['wizard_root', 'wizard_archived', 'tg_1'])
    expect(sessions[0]).toMatchObject({ id: 'wizard_root', title: 'Live tip title', archived: false, pinned: false, hidden: false })
    expect(sessions[0]).not.toHaveProperty('_lineage_root_id')
    expect(seen).toEqual(['/api/sessions?limit=200&offset=0'])
  })

  it('pages until Hermes runs out or the listing reaches its limit', async () => {
    const now = Date.UTC(2026, 9, 11)
    const t = now / 1000
    const all = Array.from({ length: 450 }, (_, i) => ({ id: `wizard_${i}`, source: 'api_server', last_active: t - i, message_count: 1 }))
    const request = async (path: string) => {
      const u = new URL(path, 'http://h')
      const offset = Number(u.searchParams.get('offset')); const limit = Number(u.searchParams.get('limit'))
      return { object: 'list', data: all.slice(offset, offset + limit) }
    }
    expect((await readCanonicalSessionsHttp(request, { now })).length).toBe(450)
    expect((await readCanonicalSessionsHttp(request, { now, limit: 250 })).length).toBe(250)
  })
})
