import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readCanonicalSessionsHttp } from '../server/hermes-http-readers.mjs'
import { createWizardServer, listen } from '../server/service.mjs'

// Stock `hermes import` preserves session ids/sources. The listing must not require Wizard ids.
const now = Date.now()
const t = now / 1000
const rows = [
  { id: 'imported-cli', source: 'cli', last_active: t - 1, message_count: 2, title: 'CLI fixture' },
  { id: 'imported-tui', source: 'tui', last_active: t - 2, message_count: 2, title: 'TUI fixture' },
  { id: 'cron-fixture', source: 'cron', last_active: t - 3, message_count: 2 },
  { id: 'unknown-api', source: 'api_server', last_active: t - 4, message_count: 2 },
  { id: 'hidden-cli', source: 'cli', hidden: true, last_active: t - 5, message_count: 2 },
  { id: 'delegate-cli', source: 'cli', parent_session_id: 'imported-cli', is_internal_child: true, last_active: t - 6, message_count: 2 },
  { id: 'empty-tui', source: 'tui', last_active: t - 7, message_count: 0 },
  { id: 'old-tui', source: 'tui', last_active: t - 40 * 86400, message_count: 2 },
]

describe('imported stock Hermes interactive chats', () => {
  it('keeps original CLI/TUI ids in HTTP listing, without admitting background/hidden/child/old sessions', async () => {
    const result = await readCanonicalSessionsHttp(async () => ({ data: rows }), { now })
    expect(result.map((s: any) => s.id)).toEqual(['imported-cli', 'imported-tui'])
  })

  it('applies the same policy in the read-only SQLite reader without rewriting imported history', () => {
    const reader = fileURLToPath(new URL('../server/read-human-sessions.py', import.meta.url))
    const script = String.raw`
import importlib.util, json, sqlite3, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('reader', sys.argv[1])
r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)
with tempfile.TemporaryDirectory() as d:
 p = Path(d)/'state.db'; db = sqlite3.connect(p)
 db.execute('CREATE TABLE sessions(id TEXT,source TEXT,model TEXT,title TEXT,started_at REAL,ended_at REAL,end_reason TEXT,message_count INTEGER,parent_session_id TEXT,last_activity_at REAL,pinned INTEGER,archived INTEGER,hidden INTEGER,chat_id TEXT,thread_id TEXT,model_config TEXT)')
 for x in json.loads(sys.argv[2]):
  db.execute('INSERT INTO sessions VALUES(?,?,?,?,?,NULL,NULL,?,?,?,0,0,?,NULL,NULL,?)', (x['id'],x['source'],'fixture',x.get('title','fixture'),x['last_active'],x['message_count'],x.get('parent_session_id'),x['last_active'],int(x.get('hidden',False)),json.dumps({'_delegate_from':'parent'} if x.get('is_internal_child') else {})))
 db.commit(); db.close()
 before = p.read_bytes()
 result = r.read_sessions(str(p), '')
 assert before == p.read_bytes(), 'reader must preserve imported history bytes'
 print(json.dumps([x['id'] for x in result]))
`
    const output = execFileSync('python3', ['-c', script, reader, JSON.stringify(rows)], { encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual(['imported-cli', 'imported-tui'])
  })

  it('serves imported chats through the real compact Chats API, not just the intermediate reader', async () => {
    const root = mkdtempSync(join(tmpdir(), 'imported-chats-'))
    mkdirSync(join(root, 'os'))
    const upstream = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: rows.slice(0, 2) }))
    })
    let service: any
    try {
      const u = await listen(upstream)
      service = createWizardServer({ upstreamOrigin: `http://127.0.0.1:${u.port}`, hermesKey: 'synthetic-fixture', requireAccess: false,
        agents: false, agentBridge: false, followThrough: false, joinedDelegation: 'off', wizardOsHome: join(root, 'os'),
        canonicalSessionReader: () => rows.slice(0, 2), runQueue: false })
      const a = await listen(service)
      const response = await fetch(`http://127.0.0.1:${a.port}/wizard/hermes/api/sessions?view=list&window=archive-50`)
      expect(response.status).toBe(200)
      const body: any = await response.json()
      expect(body.data.map((s: any) => s.id)).toEqual(['imported-cli', 'imported-tui'])
    } finally {
      if (service) await new Promise<void>((resolve) => service.close(resolve))
      await new Promise<void>((resolve) => upstream.close(resolve))
      rmSync(root, { recursive: true, force: true })
    }
  })
})
