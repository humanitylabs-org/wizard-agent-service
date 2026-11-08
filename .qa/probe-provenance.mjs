import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { rmSync } from 'node:fs'
import { readHermesSessionTruth } from '../server/session-truth.mjs'
import { normalizeStatus, parseStatusAppId, replyAppId, stripStatus } from '../server/thread-status.mjs'
import { projectSessionAppProvenance } from '../server/thread-app-provenance.mjs'
const path = new URL('./probe.db', import.meta.url).pathname
rmSync(path, {force:true})
const db = new DatabaseSync(path)
let checks = 0
const eq = (a,b) => {assert.deepEqual(a,b); checks++}
const marker = o => `[WIZARD_STATUS_V1]${JSON.stringify(o)}[/WIZARD_STATUS_V1]`
try {
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, started_at REAL, parent_session_id TEXT, end_reason TEXT, source TEXT, model_config TEXT);
    CREATE TABLE messages(session_id TEXT, role TEXT, finish_reason TEXT, timestamp REAL, content TEXT, display_kind TEXT, active INTEGER, display_metadata TEXT);
    CREATE INDEX recent ON messages(session_id, active, timestamp);
    CREATE TABLE session_turn_leases(conversation_id TEXT, expires_at REAL);
    INSERT INTO sessions VALUES ('root',1,NULL,'compression','wizard-mobile','{}'),('tip',20,'root',NULL,'wizard-mobile','{}');`)
  const add = db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,1,?)')
  add.run('root','user',null,10,'Read app',null,null)
  add.run('root','assistant','stop',15,'Report','final',JSON.stringify({app_id:'topics'}))
  const truth = () => readHermesSessionTruth(path,['root'],200).get('root')
  eq(truth().appId,undefined)
  add.run('tip','user',null,30,'Unrelated next request',null,null)
  eq(truth().appId,undefined)
  add.run('tip','assistant','stop',40,'Unrelated reply','final',null)
  eq(truth().appId,null)
  add.run('tip','assistant','stop',50,'Read another app','final',JSON.stringify({app_id:'wisdom'}))
  eq(truth().appId,'wisdom')
  add.run('root','assistant','stop',60,'Scheduled Topics output','final',JSON.stringify({app_id:'topics'}))
  eq(truth().appId,'topics')
  add.run('tip','user',null,70,'New unrelated question',null,null)
  eq(truth().appId,undefined)
  eq(normalizeStatus({state:'qa',ask:'Judge layout',app_id:'topics\n'}),{state:'check',ask:'Judge layout'})
  eq(parseStatusAppId(marker({app_id:'topics'})), 'topics')
  eq(parseStatusAppId(marker({app_id:'topics'})+marker({state:'fyi',ask:'Unrelated'})),null)
  eq(replyAppId('Published',{app_id:'topics',report_id:'r1'}),'topics')
  eq(replyAppId(marker({app_id:'wisdom'}),{app_id:'<script>'}),null)
  eq(stripStatus('Published\n'+marker({app_id:'topics'})),'Published')
  const session={id:'root',source:'wizard-mobile',title:'Topics',wizard_app_id:'topics'}
  const result=JSON.parse(projectSessionAppProvenance(Buffer.from(JSON.stringify({data:[session]})),new Map([['root',truth()]]),new Set(['topics','wisdom'])).toString())
  eq(result.data[0],{id:'root',source:'wizard-mobile',title:'Topics'})
  console.log(JSON.stringify({placement:'VPS lightweight module probe only; npm suite not run here',passed_assertions:checks}))
} finally {db.close();rmSync(path,{force:true})}
