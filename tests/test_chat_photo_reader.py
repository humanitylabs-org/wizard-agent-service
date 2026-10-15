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
if __name__=='__main__': unittest.main()
