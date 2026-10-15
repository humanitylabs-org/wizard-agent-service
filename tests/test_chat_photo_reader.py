import importlib.util
import json
import pathlib
import unittest
s=importlib.util.spec_from_file_location('reader', pathlib.Path(__file__).parents[1]/'server/read-chat-photos.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Photos(unittest.TestCase):
 def test_eligibility(self):
  session=dict(id='wizard_123_abcdef',source='api_server',user_id=None,chat_id=None,chat_type=None,profile_name='default',hidden=0,archived=1,parent_session_id=None,title='A normal human chat',model_config='{}')
  self.assertEqual(m.session_reason(session,'123'),'')
  for change in [dict(hidden=1),dict(parent_session_id='p'),dict(profile_name='private'),dict(source='cron'),dict(title='QA canary'),dict(model_config='{"_delegate_from":"p"}')]:
   self.assertTrue(m.session_reason({**session,**change},'123'))
  tg={**session,'source':'telegram','user_id':'123','chat_id':'123','chat_type':'dm'}
  self.assertEqual(m.session_reason(tg,'123'),'')
  self.assertTrue(m.session_reason({**tg,'chat_type':'group'},'123'))
  self.assertTrue(m.session_reason({**tg,'chat_id':'other'},'123'))
 def test_attachment_syntax_not_prose_or_fences(self):
  self.assertEqual(m.photo_refs('look at /a/image.jpg','user'),[])
  self.assertEqual(m.photo_refs('```\nMEDIA:/a/image.jpg\n```','assistant'),[])
  self.assertEqual(m.photo_refs('[Image attached at: /a/image.jpg]','user'),[{'kind':'received','path':'/a/image.jpg'}])
  self.assertEqual(m.photo_refs('MEDIA:/a/movie.mp4','assistant'),[])
  self.assertEqual(m.photo_refs('MEDIA:/a/image.jpg','user'),[])
 def test_durable_wizard_identity_and_native_dedup(self):
  text='[WIZARD_FILES_V1]\n'+json.dumps([{'id':'drop_'+'a'*32,'mime':'image/png','sha256':'b'*64}])+'\n[/WIZARD_FILES_V1]'
  self.assertEqual(m.photo_refs(text,'user')[0]['kind'],'wizard')
  self.assertEqual(m.photo_refs(text,'assistant'),[])
  native=json.dumps([{'type':'text','text':text},{'type':'image_url','image_url':{'url':'data:image/png;base64,fixture'}}])
  self.assertEqual(len(m.photo_refs(native,'user')),1)
 def test_wrong_owner_and_private_pin_never_open_content(self):
  import sqlite3, tempfile
  from unittest.mock import patch
  with tempfile.TemporaryDirectory() as root:
   path=str(pathlib.Path(root)/'history.db')
   c=sqlite3.connect(path)
   c.executescript('CREATE TABLE sessions(id TEXT,source TEXT,user_id TEXT,chat_id TEXT,chat_type TEXT,profile_name TEXT,hidden INTEGER,archived INTEGER,parent_session_id TEXT,title TEXT,model_config TEXT,origin_json TEXT,created_source TEXT,transport_profile TEXT); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,timestamp REAL,display_kind TEXT,_compressed_summary INTEGER,tool_calls TEXT,platform_message_id TEXT,content TEXT);')
   for i, (sid, uid) in enumerate([('wrong','other'),('legacy',None),('pinned',None)],1):
    c.execute('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(sid,'webui',uid,None,None,'default',0,1,None,'Owner chat','{}',None,'human',None))
    c.execute('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)',(i,sid,'user',10,None,0,None,None,'[Image attached at: /image.png]'))
   c.commit();c.close()
   (pathlib.Path(root)/'.threads.json').write_text(json.dumps({'schema':1,'threads':{'pinned':'private-agent'}}))
   original=sqlite3.connect; content_ids=[]
   class Traced:
    def __init__(self, conn): self.conn=conn
    @property
    def row_factory(self): return self.conn.row_factory
    @row_factory.setter
    def row_factory(self, value): self.conn.row_factory=value
    def execute(self, sql, parameters=()):
     if sql.startswith('SELECT content'):
      content_ids.append(parameters[0]); assert parameters[0]==2
     return self.conn.execute(sql,parameters)
    def close(self): self.conn.close()
   with patch.object(m.sqlite3,'connect',side_effect=lambda *a,**kw: Traced(original(*a,**kw))):
    result=m.scan(path,0,0,'123',250,root)
   self.assertEqual(content_ids,[2]);self.assertEqual([e['thread_id'] for e in result['evidence']],['legacy'])
 def test_assistant_inline_image_candidate(self):
  self.assertEqual(m.photo_refs(json.dumps([{'type':'image_url','image_url':{'url':'data:image/png;base64,fixture'}}]),'assistant'),[{'kind':'inline'}])
if __name__=='__main__': unittest.main()
