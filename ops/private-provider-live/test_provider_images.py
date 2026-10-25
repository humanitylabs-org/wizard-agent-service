import gzip,io,json,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import provider_adapter as p
from owner_acceptance import load_legacy_source

class ImageSnapshot(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);self.source=self.root/'legacy.env';self.value='synthetic-credential-for-unit-tests';self.source.write_text('TINFOIL_API_KEY="'+self.value+'"\n')
  self.auth=self.root/'runtime-auth';self.auth.write_text('synthetic-runtime-auth')
  self.rt=SimpleNamespace(app=lambda urn:{'app':{'config':{'port':18804}}},installed=lambda:[{'info':{'urn':p.OLD},'app':{'status':'running'}}],req=lambda *a,**k:{'dockerCompose':'# generated template\n','appEnv':'# blank template\n'})
  with patch.object(p,'api',return_value=self.rt):self.provider=p.Provider(self.root,self.root,self.root,'a'*32)
 def process(self,body):return SimpleNamespace(stdout=io.BytesIO(body),stderr=io.BytesIO(),wait=lambda **kw:0,poll=lambda:0,kill=lambda:None)
 def inspect(self,argv,**kw):
  if argv[1]=='ps':return 'one-container\n'
  return json.dumps([{'Image':'sha256:old','Config':{'Image':'local:old'}}]).encode()
 def test_host_source_parser_handles_quotes(self):self.assertEqual(load_legacy_source(self.source),self.value)
 def test_snapshot_preserves_actual_app_status_and_code_only_image(self):
  with patch.object(p.subprocess,'check_output',side_effect=self.inspect),patch.object(p.subprocess,'Popen',return_value=self.process(b'public interpreter image bytes')):
   self.assertTrue(self.provider.snapshot(self.source,self.auth)['prior_interpreter_image_retained'])
  journal=json.loads(self.provider.journal.read_text());self.assertEqual(journal['old_status'],'running');self.assertNotIn(self.value,self.provider.journal.read_text());self.assertEqual(gzip.open(journal['prior_image_archive'],'rb').read(),b'public interpreter image bytes')
 def test_baked_credential_is_not_retained_in_undo_archive(self):
  with patch.object(p.subprocess,'check_output',side_effect=self.inspect),patch.object(p.subprocess,'Popen',return_value=self.process(b'prefix'+self.value.encode()+b'suffix')):
   with self.assertRaisesRegex(RuntimeError,'credential baked'):self.provider.snapshot(self.source,self.auth)
  self.assertFalse((self.root/'prior-provider-image.tar.gz').exists())
 def test_foreign_volume_is_not_deleted(self):
  self.rt.installed=lambda:[];self.provider.journal.write_text(json.dumps({'attempt':'a'*32,'new_owned':True,'new_volume':'wizard-tinfoil-private-'+'a'*32,'prior_user_config':{},'old_present':False}))
  result=SimpleNamespace(returncode=0,stdout=json.dumps([{'Labels':{'com.docker.compose.project':'foreign'}}]).encode())
  with patch.object(p.subprocess,'run',return_value=result) as run:
   with self.assertRaisesRegex(RuntimeError,'foreign provider data volume'):self.provider.rollback()
  self.assertEqual(run.call_count,1)
 def test_runtime_id_is_not_the_unavailable_recipe_registry_pin(self):
  source=Path(p.__file__).read_text();self.assertIn("svc.update(image=runtime['id'],pull_policy='never')",source)

if __name__=='__main__':unittest.main()
