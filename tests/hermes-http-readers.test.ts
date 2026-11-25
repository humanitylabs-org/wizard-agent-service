import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readCanonicalSessionsHttp } from '../server/hermes-http-readers.mjs'
import { readArchivedSessions } from '../server/archived-sessions.mjs'

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

  // Issue 612: after a /new in Telegram, stock Hermes v2026.9.24 starts a new session whose
  // parent_session_id is the old one (end_reason session_reset). It is its own conversation.
  it('lists the conversation after a /new or a /branch, never a sub-agent child', async () => {
    const now = Date.UTC(2026, 10, 24)
    const t = now / 1000
    const page = [
      { id: 'tg_new', source: 'telegram', parent_session_id: 'tg_old', title: 'Boat trip', last_active: t - 5, message_count: 3 },
      { id: 'slack_branch', source: 'slack', parent_session_id: 'slack_far', title: 'Branch', last_active: t - 6, message_count: 2 },
      { id: 'tg_helper', source: 'telegram', parent_session_id: 'tg_live', title: 'Helper', last_active: t - 7, message_count: 2 },
      { id: 'tg_old', source: 'telegram', end_reason: 'session_reset', title: 'Garden', last_active: t - 10, message_count: 4 },
      { id: 'tg_live', source: 'telegram', title: 'Live', last_active: t - 12, message_count: 4 },
    ]
    const seen: string[] = []
    const request = async (path: string) => {
      seen.push(path)
      if (path === '/api/sessions/slack_far') return { object: 'hermes.session', session: { id: 'slack_far', end_reason: 'branched' } }
      return { object: 'list', data: path.includes('offset=0') ? page : [] }
    }
    const parents = new Map()
    const sessions = await readCanonicalSessionsHttp(request, { now, parents })
    expect(sessions.map((s) => s.id)).toEqual(['tg_new', 'slack_branch', 'tg_old', 'tg_live'])
    expect(sessions[0]).toMatchObject({ id: 'tg_new', title: 'Boat trip', parent_session_id: 'tg_old', archived: false, hidden: false })
    // Only the parent that was not on the page is read, once; later lists use the cache.
    expect(seen.filter((p) => !p.startsWith('/api/sessions?'))).toEqual(['/api/sessions/slack_far'])
    await readCanonicalSessionsHttp(request, { now: now + 1000, parents })
    expect(seen.filter((p) => p === '/api/sessions/slack_far')).toHaveLength(1)
  })

  it('keeps an archived conversation after a /new in the archive, without sub-agent or compression children', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archived-612-'))
    try {
      const path = join(dir, 'state.db')
      const db = new DatabaseSync(path)
      db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, title TEXT, started_at REAL, ended_at REAL,
        end_reason TEXT, message_count INTEGER, parent_session_id TEXT, last_activity_at REAL, pinned INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, model_config TEXT)`)
      const add = db.prepare('INSERT INTO sessions (id, source, end_reason, message_count, parent_session_id, last_activity_at, archived, model_config) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      add.run('old', 'telegram', 'session_reset', 4, null, 10, 1, null)
      add.run('after_new', 'telegram', null, 3, 'old', 20, 1, JSON.stringify({ _reset_from: 'old' }))
      add.run('legacy_reset', 'telegram', null, 2, 'old', 15, 1, null)
      add.run('compressed', 'telegram', 'compression', 5, null, 30, 1, null)
      add.run('continuation', 'telegram', null, 5, 'compressed', 31, 1, null)
      add.run('helper', 'telegram', null, 2, 'compressed', 32, 1, JSON.stringify({ _delegate_from: 'compressed' }))
      add.run('helper_of_reset', 'telegram', null, 2, 'old', 33, 1, JSON.stringify({ _delegate_from: 'old' }))
      db.close()
      expect(readArchivedSessions(path).map((s) => s.id)).toEqual(['compressed', 'after_new', 'legacy_reset', 'old'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
