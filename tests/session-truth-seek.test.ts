import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { readHermesSessionTruth } from '../server/session-truth.mjs'

it('rewound turn never replaces the current request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wizard-truth-rewind-'))
  const path = join(dir, 'state.sqlite'), db = new DatabaseSync(path)
  try {
    db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, started_at REAL);
      CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,finish_reason TEXT,timestamp REAL,content TEXT,display_kind TEXT,active INT,compacted INT DEFAULT 0);
      CREATE TABLE session_turn_leases(conversation_id TEXT, expires_at REAL);
      INSERT INTO sessions VALUES ('thread',1);
      INSERT INTO messages VALUES
        (1,'thread','user',NULL,10,'Current approved request','',1,0),
        (2,'thread','assistant','stop',20,'Verified [WIZARD_STATUS_V1]{"state":"done","ask":"Fixed","app_id":"notes"}[/WIZARD_STATUS_V1]','final',1,0),
        (3,'thread','user',NULL,30,'Deleted newer request','',0,0);`)
    const before = readHermesSessionTruth(path, ['thread']).get('thread')!
    expect(before).toMatchObject({ requestPreview: 'Current approved request', lastUserAt: 10, activityAt: 20, status: { state: 'done' }, appId: 'notes' })
    db.exec('UPDATE messages SET compacted=1 WHERE id=3')
    const retained = readHermesSessionTruth(path, ['thread']).get('thread')!
    expect(retained.requestPreview).toBe('Deleted newer request')
    expect(retained.status).toBeUndefined(); expect(retained.appId).toBeUndefined()
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}) }
})

it('seeks newest visible activity without materializing old message bodies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wizard-truth-seek-'))
  const path = join(dir, 'state.sqlite')
  const db = new DatabaseSync(path)
  try {
    db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, started_at REAL);
      CREATE TABLE message_rows(session_id TEXT, role TEXT, finish_reason TEXT, timestamp REAL, content TEXT, display_kind TEXT, active INTEGER);
      CREATE INDEX recent_messages ON message_rows(session_id, active, timestamp);
      CREATE TABLE session_turn_leases(conversation_id TEXT, expires_at REAL);
      INSERT INTO sessions VALUES ('thread',1),('unanswered',1);
      INSERT INTO session_turn_leases VALUES ('thread',999);
      INSERT INTO message_rows VALUES
        ('thread','user',NULL,1,'older request','',1),
        ('thread','assistant','stop',2,'older reply','final',1),
        ('thread','user',NULL,100,'latest request','',1),
        ('thread','assistant','stop',110,'latest reply','final',1),
        ('thread','assistant',NULL,120,'working','commentary',1),
        ('thread','user',NULL,130,'hidden system event','internal_notification',1),
        ('thread','assistant','stop',140,'inactive reply','final',0),
        ('unanswered','user',NULL,100,'awaiting reply','',1);
      CREATE VIEW messages AS SELECT session_id,role,finish_reason,timestamp,
        CASE WHEN timestamp < 10 THEN abs(-9223372036854775808) ELSE content END AS content,
        display_kind,active FROM message_rows;`)
    // SQLite deliberately raises on obsolete bodies. Correct indexed seeks stop
    // before evaluating them, while a full-history scan fails this public result.
    const truth = readHermesSessionTruth(path, ['thread', 'unanswered'], 200)
    expect(truth.get('thread')).toMatchObject({lastUserAt:100,lastAssistantAt:110,activityAt:110,requestPreview:'latest request',active:true})
    expect(truth.get('unanswered')).toMatchObject({lastUserAt:100,lastAssistantAt:0,activityAt:100,requestPreview:'awaiting reply',active:false})
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}) }
})
