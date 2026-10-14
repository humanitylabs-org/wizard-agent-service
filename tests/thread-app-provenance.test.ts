import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeStatus, parseStatus, parseStatusAppId, replyAppId, stripStatus, projectStatusMarkers } from '../server/thread-status.mjs'
import { appProvenanceCatalog, appProvenanceRunNote, hasAppToolCalls, normalizeAppId, projectSessionAppProvenance } from '../server/thread-app-provenance.mjs'
import { readApps } from '../server/wizard-os-settings.mjs'
import { createWizardServer, latestVisibleSessionMessages, listen, runInstructions } from '../server/service.mjs'
import { readHermesSessionTruth } from '../server/session-truth.mjs'

const tag = (o: unknown) => `[WIZARD_STATUS_V1]${JSON.stringify(o)}[/WIZARD_STATUS_V1]`
const dirs: string[] = []
const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})
const directory = async () => { const d = await mkdtemp(join(tmpdir(), 'wizard-app-provenance-')); dirs.push(d); return d }
const project = (session: object, truth = new Map(), installed = ['topics', 'wisdom', 'usuals']) => JSON.parse(projectSessionAppProvenance(Buffer.from(JSON.stringify({ data: [session] })), truth, new Set(installed)).toString()).data[0]

describe('explicit reply app provenance', () => {
  it.each(['topics', 'wizard-signal', 'defleur-video', 'usuals', 'future-app-42', 'ab', 'a'.repeat(41)])('accepts registry-compatible ID %s without per-app allowlists', id => {
    expect(normalizeAppId(id)).toBe(id)
    expect(normalizeStatus({ state: 'done', ask: 'Finished', app_id: id })?.app_id).toBe(id)
  })
  it.each(['', 'a', 'a'.repeat(42), ' topics', 'topics ', 'TOPICS', 'topics\n', 'topics\r\n', '../topics', 'https://x.test', 'topics/icon', 'topics_id', '<img src=x onerror=alert(1)>', 'javascript:alert(1)', '\u0000topics', 42, {}, ['topics']])('rejects malformed/XSS ID %j without harming attention', id => {
    expect(normalizeAppId(id)).toBeNull()
    expect(normalizeStatus({ state: 'qa', ask: 'Judge the layout', subject: 'Wizard OS', title: 'Wizard OS · App', app_id: id })).toEqual({ state: 'check', ask: 'Judge the layout', subject: 'Wizard OS', title: 'Wizard OS · App' })
  })
  it('parses app-only markers independently of the status state/ask contract', () => {
    const text = `Published.\n${tag({ app_id: 'topics' })}`
    expect(parseStatus(text)).toBeNull()
    expect(parseStatusAppId(text)).toBe('topics')
    expect(stripStatus(text)).toBe('Published.')
    expect(projectStatusMarkers(Buffer.from(JSON.stringify({ data: [{ content: text }] }))).toString()).not.toContain('WIZARD_STATUS_V1')
  })
  it('never revives an earlier app ID after a later missing or malformed marker', () => {
    for (const tail of [tag({ state: 'fyi', ask: 'Unrelated' }), tag({ app_id: '../topics' }), '[WIZARD_STATUS_V1]{bad}[/WIZARD_STATUS_V1]', '[WIZARD_STATUS_V1]{"app_id":']) {
      expect(parseStatusAppId(`${tag({ app_id: 'topics' })}\n${tail}`)).toBeNull()
    }
  })
  it('rejects tool-call provenance even without a completion flag', () => {
    for (const calls of [[{function:{name:'fixture'}}], JSON.stringify([{function:{name:'fixture'}}]), '{malformed']) {
      expect(hasAppToolCalls({tool_calls:calls})).toBe(true)
      expect(latestVisibleSessionMessages({data:[{role:'assistant',content:'Not a final report',tool_calls:calls,display_metadata:{app_id:'topics'}}]}).appId).toBeNull()
    }
    for (const calls of [null, undefined, '', '[]', 'null', []]) expect(hasAppToolCalls({tool_calls:calls})).toBe(false)
  })
  it('accepts object/serialized publisher metadata, with explicit metadata taking precedence', () => {
    expect(replyAppId('Report', { app_id: 'topics', report_id: 'r1' })).toBe('topics')
    expect(replyAppId('Report', JSON.stringify({ app_id: 'wizard-signal' }))).toBe('wizard-signal')
    expect(replyAppId(tag({ app_id: 'wisdom' }), { app_id: 'topics' })).toBe('topics')
    expect(replyAppId(tag({ app_id: 'wisdom' }), { app_id: '<script>' })).toBeNull()
    expect(replyAppId(tag({ app_id: 'wisdom' }), { report_id: 'r1' })).toBe('wisdom')
    expect(replyAppId('Topics: Wisdom and Food', { appId: 'topics', report_topic: 'Topics' })).toBeNull()
  })
  it('crosschecks installed IDs, preserves original source fields, and does not infer from names', () => {
    const session = { id: 'wizard_mix', source: 'webui', title: 'Topics · report', subject: 'Wisdom', latest_message: { role: 'assistant', content: 'Food' }, custom: { keep: true }, wizard_attention: { state: 'done', ask: 'Finished', subject: 'Topics', title: 'Topics · report' } }
    expect(project(session)).toEqual(session)
    expect(project({ ...session, wizard_app_id: 'unknown-app' })).toEqual(session)
    expect(project({ ...session, wizard_app_id: 'topics' })).toEqual({ ...session, wizard_app_id: 'topics' })
    expect(project({ ...session, wizard_app_id: 'future-app-42' }, new Map(), ['future-app-42']).wizard_app_id).toBe('future-app-42')
    expect(project({ ...session, wizard_attention: { ...session.wizard_attention, app_id: 'unknown-app' } })).toEqual(session)
  })
  it('trusts canonical latest reply over stale preview and removes provenance on latest user', () => {
    const session = { id: 'wizard_mix', source: 'wizard-mobile', wizard_app_id: 'topics' }
    expect(project(session, new Map([['wizard_mix', { appId: null }]]))).not.toHaveProperty('wizard_app_id')
    expect(project(session, new Map([['wizard_mix', { lastUserAt: 30, lastAssistantAt: 20 }]]))).not.toHaveProperty('wizard_app_id')
    expect(project(session, new Map([['wizard_mix', { appId: 'wisdom' }]]))).toMatchObject({ wizard_app_id: 'wisdom', source: 'wizard-mobile' })
  })
  it('uses only the latest visible final reply in history, never user markers or title mentions', () => {
    const app = { role: 'assistant', display_kind: 'final', content: `Read the feed.\n${tag({ state: 'done', ask: 'Read the feed', app_id: 'topics' })}`, timestamp: 20 }
    const user = { role: 'user', content: 'What does epistemology mean?', timestamp: 30 }
    expect(latestVisibleSessionMessages({ data: [app] }).appId).toBe('topics')
    expect(latestVisibleSessionMessages({ data: [app] }).latest).not.toHaveProperty('appId')
    expect(latestVisibleSessionMessages({ data: [app, user] }).appId).toBeNull()
    expect(latestVisibleSessionMessages({ data: [app, user, { role: 'assistant', content: `An explanation.\n${tag({ state: 'fyi', ask: 'Explained', subject: 'Topics' })}`, timestamp: 40 }] }).appId).toBeNull()
    expect(latestVisibleSessionMessages({ data: [{ ...user, content: tag({ app_id: 'topics' }) }] }).appId).toBeNull()
    expect(latestVisibleSessionMessages({ data: [{ role: 'assistant', content: 'Report', display_metadata: { app_id: 'topics' }, timestamp: 40 }] }).appId).toBe('topics')
    expect(latestVisibleSessionMessages({ data: [app, { role: 'assistant', content: tag({ app_id: 'wisdom' }), display_kind: 'commentary', timestamp: 40 }] }).appId).toBe('topics')
  })
  it('builds a dynamic catalogue from the canonical reader plus builtin Food only', async () => {
    const dir = await directory(), appsJsonPath = join(dir, 'apps.json'), launcherPath = join(dir, 'launcher.json')
    await writeFile(appsJsonPath, JSON.stringify({ apps: [{ id: 'new-installed-app', name: 'New App', status: 'running' }] }))
    await writeFile(launcherPath, JSON.stringify({ links: [{ id: 'topics', name: 'Topics', url: '/topics/' }] }))
    const catalog = appProvenanceCatalog(readApps({ appsJsonPath, launcherPath }).apps)
    expect(catalog).toEqual([{ id: 'new-installed-app', name: 'New App' }, { id: 'topics', name: 'Topics' }, { id: 'usuals', name: 'Food' }])
    expect(appProvenanceRunNote(catalog)).toContain('new-installed-app')
    expect(appProvenanceRunNote(catalog)).toContain('actual work you performed')
    expect(runInstructions({ join: false })).toContain('Never carry the previous reply\'s app_id forward automatically')
  })
})

it('reads latest assistant metadata without migration, hides stale icons after unrelated requests/replies, and ignores compaction nudges', async () => {
  const dir = await directory(), path = join(dir, 'state.db'), db = new DatabaseSync(path)
  try {
    db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, started_at REAL);
      CREATE TABLE messages(session_id TEXT, role TEXT, finish_reason TEXT, timestamp REAL, content TEXT, display_kind TEXT, active INTEGER, display_metadata TEXT);
      CREATE INDEX recent_messages ON messages(session_id, active, timestamp);
      CREATE TABLE session_turn_leases(conversation_id TEXT, expires_at REAL);
      INSERT INTO sessions VALUES ('wizard_mix',1);`)
    const add = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,1,?)')
    add.run('wizard_mix','user',null,10,'Read the feed',null,null)
    add.run('wizard_mix','assistant','stop',20,'Published report','final',JSON.stringify({ app_id:'topics', report_id:'r1' }))
    const truth = () => readHermesSessionTruth(path,['wizard_mix'],200).get('wizard_mix')
    expect(truth()?.appId).toBe('topics')
    add.run('wizard_mix','user',null,25,'[CONTEXT COMPACTION — REFERENCE ONLY] old task',null,null)
    add.run('wizard_mix','assistant',null,26,tag({ app_id:'wisdom' }),'commentary',null)
    expect(truth()?.appId).toBe('topics')
    add.run('wizard_mix','user',null,30,'Explain epistemology',null,JSON.stringify({ app_id:'wisdom' }))
    expect(truth()?.appId).toBeUndefined()
    add.run('wizard_mix','assistant','stop',40,'Knowledge theory','final',null)
    expect(truth()?.appId).toBeNull()
    add.run('wizard_mix','assistant','stop',50,`Logged dinner.\n${tag({ app_id:'usuals' })}`,'final',null)
    expect(truth()?.appId).toBe('usuals')
    add.run('wizard_mix','user',null,50,'Unrelated next request at same timestamp',null,null)
    expect(truth()?.appId).toBeUndefined()
    const count = db.prepare('PRAGMA table_info(messages)').all().length
    expect(count).toBe(8)
  } finally { db.close() }
})

it('follows the compression tip only, ignores delegate/reset/branch forks, and fails closed on ambiguous continuations', async () => {
  const dir = await directory(), path = join(dir,'state.db'), db = new DatabaseSync(path)
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, started_at REAL, parent_session_id TEXT, end_reason TEXT, source TEXT, model_config TEXT);
    CREATE TABLE messages(session_id TEXT, role TEXT, finish_reason TEXT, timestamp REAL, content TEXT, display_kind TEXT, active INTEGER, display_metadata TEXT);
    CREATE TABLE session_turn_leases(conversation_id TEXT, expires_at REAL);
    INSERT INTO sessions VALUES ('wizard_root',1,NULL,'compression','wizard-mobile','{}'), ('wizard_tip',20,'wizard_root',NULL,'wizard-mobile','{}'),
      ('delegate',21,'wizard_root',NULL,'api_server','{"_delegate_from":"wizard_root"}'),
      ('reset',22,'wizard_root',NULL,'wizard-mobile','{"_reset_from":"wizard_root"}'),
      ('branch',23,'wizard_root',NULL,'wizard-mobile','{"_branched_from":"wizard_root"}');`)
  const add = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,1,?)')
  add.run('wizard_root','user',null,10,'Read Topics',null,null)
  add.run('wizard_root','assistant','stop',15,'Report','final',JSON.stringify({app_id:'topics'}))
  for(const id of ['delegate','reset','branch'])add.run(id,'assistant','stop',100,'Not this conversation','final',JSON.stringify({app_id:'wisdom'}))
  const truth = () => readHermesSessionTruth(path,['wizard_root'],200).get('wizard_root')
  expect(truth()?.appId).toBeUndefined() // empty tip: no ancestor fallback
  add.run('wizard_tip','user',null,30,'Unrelated question',null,null)
  expect(truth()?.appId).toBeUndefined()
  add.run('wizard_tip','assistant','stop',40,'Unrelated reply','final',null)
  expect(truth()?.appId).toBeNull()
  add.run('wizard_tip','assistant','stop',50,'Published','final',JSON.stringify({app_id:'wisdom'}))
  expect(truth()?.appId).toBe('wisdom')
  expect(truth()).toMatchObject({lastUserAt:10,lastAssistantAt:15,activityAt:15}) // existing status/activity untouched
  add.run('wizard_root','assistant',null,60,'Scheduled root report',null,JSON.stringify({app_id:'topics',report_id:'scheduled-root'}))
  expect(truth()?.appId).toBe('topics')
  add.run('wizard_tip','user',null,70,'Unrelated latest request',null,null)
  expect(truth()?.appId).toBeUndefined()
  db.exec("INSERT INTO sessions VALUES ('ambiguous',24,'wizard_root',NULL,'wizard-mobile','{}')")
  expect(truth()?.appId).toBeUndefined()
  db.close()
})

it('recognizes real script-publisher null completion flags and clears only provenance safely', async () => {
  const dir=await directory(),path=join(dir,'publisher.db'),db=new DatabaseSync(path)
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, started_at REAL); INSERT INTO sessions VALUES ('publisher',1);
    CREATE TABLE messages(session_id TEXT, role TEXT, finish_reason TEXT, timestamp REAL, content TEXT, display_kind TEXT, active INTEGER, display_metadata TEXT);
    CREATE TABLE session_turn_leases(conversation_id TEXT, expires_at REAL);`)
  db.exec('ALTER TABLE messages ADD COLUMN tool_calls TEXT')
  const add=db.prepare('INSERT INTO messages(session_id,role,finish_reason,timestamp,content,display_kind,active,display_metadata) VALUES (?,?,?,?,?,?,1,?)')
  const truth=()=>readHermesSessionTruth(path,['publisher'],200).get('publisher')
  add.run('publisher','user',null,10,'Read the feed',null,null)
  add.run('publisher','assistant',null,20,'Scheduled report',null,JSON.stringify({app_id:'wizard-signal',report_id:'weekly'}))
  expect(truth()?.appId).toBe('wizard-signal')
  expect(truth()).toMatchObject({lastUserAt:10,lastAssistantAt:0,activityAt:10})
  for(const [kind,finish] of [['commentary',null],['hidden',null],[null,'tool_calls']]) {
    add.run('publisher','assistant',finish,25,'Not an output',kind,JSON.stringify({app_id:'wisdom'}))
    expect(truth()?.appId).toBe('wizard-signal')
  }
  add.run('publisher','assistant',null,27,'Tool action',null,JSON.stringify({app_id:'wisdom'}))
  db.prepare('UPDATE messages SET tool_calls=? WHERE timestamp=27').run(JSON.stringify([{function:{name:'not_a_report'}}]))
  expect(truth()?.appId).toBe('wizard-signal')
  add.run('publisher','assistant',null,30,'Different unbranded report',null,JSON.stringify({report_id:'other'}))
  expect(truth()?.appId).toBeNull()
  add.run('publisher','assistant',null,40,'New report',null,JSON.stringify({app_id:'topics',report_id:'new'}))
  expect(truth()?.appId).toBe('topics')
  add.run('publisher','user',null,50,'An unrelated question',null,null)
  expect(truth()?.appId).toBeUndefined()
  db.close()
})

it('supports old message schemas without display_metadata', async () => {
  const dir = await directory(), path = join(dir,'state.db'), db = new DatabaseSync(path)
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, started_at REAL); INSERT INTO sessions VALUES ('wizard_old',1);
    CREATE TABLE messages(session_id TEXT, role TEXT, finish_reason TEXT, timestamp REAL, content TEXT, display_kind TEXT, active INTEGER);
    CREATE TABLE session_turn_leases(conversation_id TEXT, expires_at REAL);`)
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run('wizard_old','assistant','stop',20,`Finished.\n${tag({app_id:'wisdom'})}`,'final',1)
  db.close()
  expect(readHermesSessionTruth(path,['wizard_old'],200).get('wizard_old')?.appId).toBe('wisdom')
})

it('serves crosschecked canonical provenance on all pages even with unavailable/stale history; injects current catalogue into stock run instructions', async () => {
  const dir = await directory(), path = join(dir,'state.db'), appsJsonPath = join(dir,'apps.json'), launcherPath = join(dir,'launcher.json')
  await writeFile(appsJsonPath, JSON.stringify({ apps: [{ id:'new-installed-app', name:'New App', status:'running' }] }))
  await writeFile(launcherPath, JSON.stringify({ links: [{ id:'topics', name:'Topics', url:'/topics/' }] }))
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, started_at REAL);
    CREATE TABLE messages(session_id TEXT, role TEXT, finish_reason TEXT, timestamp REAL, content TEXT, display_kind TEXT, active INTEGER, display_metadata TEXT);
    CREATE TABLE session_turn_leases(conversation_id TEXT, expires_at REAL);`)
  const sessions = Array.from({length:60},(_,i)=>({id:`wizard_app_${i}`,source:'wizard-mobile',title:'Topics',message_count:2,started_at:1,last_active:20,extra_field:'keep'}))
  const add = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,1,?)')
  sessions.forEach((s,i)=>{
    db.prepare('INSERT INTO sessions VALUES (?,1)').run(s.id)
    add.run(s.id,'user',null,10,'Ask',null,null)
    const id = i===55?'unknown-app':i===54?'usuals':i===53?'new-installed-app':'topics'
    add.run(s.id,'assistant',null,20,'Report',null,JSON.stringify({app_id:id,report_id:`r${i}`}))
  })
  add.run('wizard_app_56','user',null,30,'Unrelated next request',null,null)
  add.run('wizard_app_57','assistant','stop',40,'Unrelated answer','final',null)
  db.close()
  let admitted: any = null
  const upstream = createServer(async (req,res)=>{
    const url = new URL(req.url||'/','http://fixture')
    res.setHeader('Content-Type','application/json')
    if(url.pathname==='/v1/capabilities'){res.end(JSON.stringify({}));return}
    if(url.pathname==='/api/sessions'){
      const offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||100)
      res.end(JSON.stringify({data:sessions.slice(offset,offset+limit),has_more:offset+limit<sessions.length}));return
    }
    if(url.pathname.endsWith('/messages')){res.statusCode=503;res.end('{}');return}
    if(url.pathname==='/v1/runs' && req.method==='POST'){
      let text='';for await(const chunk of req)text+=chunk;admitted=JSON.parse(text)
      res.statusCode=202;res.end(JSON.stringify({run_id:'run_provenance_fixture',status:'running',session_id:admitted.session_id}));return
    }
    res.end('{}')
  })
  servers.push(upstream); const address=await listen(upstream)
  const proxy = createWizardServer({ upstreamOrigin:`http://127.0.0.1:${address.port}`,hermesKey:'fixture-key',requireAccess:false,joinedDelegation:'prefer',hermesStatePath:path,sessionDbPath:path,appsJsonPath,launcherPath,archivedSessionReader:()=>[],followThrough:false })
  servers.push(proxy); const service=await listen(proxy), origin=`http://127.0.0.1:${service.port}`
  const list=async(offset=0)=>{
    const response=await fetch(`${origin}/wizard/hermes/api/sessions?limit=100&offset=${offset}`)
    expect(response.status).toBe(200);return (await response.json() as any).data
  }
  const whole=await list()
  expect(whole).toHaveLength(60)
  expect(whole[0]).toMatchObject({wizard_app_id:'topics',source:'wizard-mobile',extra_field:'keep'})
  expect(whole[53].wizard_app_id).toBe('new-installed-app')
  expect(whole[54].wizard_app_id).toBe('usuals')
  for(const i of [55,56,57])expect(whole[i]).not.toHaveProperty('wizard_app_id')
  const second=await list(50)
  expect(second[0].wizard_app_id).toBe('topics')
  for(const i of [5,6,7])expect(second[i]).not.toHaveProperty('wizard_app_id')
  const response=await fetch(`${origin}/wizard/hermes/v1/runs`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:'wizard_app_0',input:'Do work'})})
  expect(response.status).toBe(202)
  expect(admitted.instructions).toContain('new-installed-app')
  expect(admitted.instructions).toContain('"id":"topics","name":"Topics"')
  expect(admitted.instructions).toContain('"id":"usuals","name":"Food"')
  expect(admitted).not.toHaveProperty('delegation_delivery')
  await writeFile(appsJsonPath, JSON.stringify({ apps:[{id:'later-app',name:'Later App'}] }))
  await fetch(`${origin}/wizard/hermes/v1/runs`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:'wizard_app_1',input:'Next'})})
  expect(admitted.instructions).toContain('later-app')
  expect(admitted.instructions).not.toContain('new-installed-app')
  expect((await list())[53]).not.toHaveProperty('wizard_app_id')
})
