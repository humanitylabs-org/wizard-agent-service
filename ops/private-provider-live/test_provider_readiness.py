"""Credential-free fixture readiness; synthetic time/network only."""
import ast,io,json,http.client,types,unittest,urllib.request
from pathlib import Path
from unittest.mock import patch

class ReadinessTests(unittest.TestCase):
 def ready(self,answers,timeout=1):
  node=next(n for n in ast.parse(Path(__file__).with_name('rehearse-guest.py').read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='wait_provider_ready')
  clock=[0.0];calls=[]
  def sleep(t):clock[0]+=t
  def urlopen(url,**kwargs):
   calls.append((url,kwargs));answer=answers.pop(0) if answers else ConnectionRefusedError()
   if isinstance(answer,Exception):raise answer
   return io.BytesIO(json.dumps(answer).encode())
  env={'time':types.SimpleNamespace(monotonic=lambda:clock[0],sleep=sleep),'urllib':__import__('urllib'),'json':json}
  exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),'readiness','exec'),env)
  with patch.object(urllib.request,'urlopen',side_effect=urlopen):
   try:return env['wait_provider_ready']('http://127.0.0.1:18804',timeout=timeout)
   finally:self.calls=calls;self.elapsed=clock[0]
 def test_restart_disconnect_then_bodyless_ready(self):
  self.ready([http.client.RemoteDisconnected(),ConnectionRefusedError(),{'contract':'wizard.ai-connection/1','provider':'tinfoil'}])
  self.assertEqual(len(self.calls),3)
  self.assertTrue(all(url=='http://127.0.0.1:18804/api/connection' for url,_ in self.calls))
 def test_timeout_never_posts_a_credential(self):
  with self.assertRaisesRegex(RuntimeError,'no credential submitted'):self.ready([])
  self.assertEqual(self.elapsed,1)
  self.assertTrue(all(isinstance(url,str) and '/api/connection' in url for url,_ in self.calls))
 def test_wrong_contract_never_admits(self):
  with self.assertRaisesRegex(RuntimeError,'readiness timeout'):self.ready([{'provider':'tinfoil'},{'contract':'wizard.ai-connection/1','provider':'other'}])
 def test_data_dir_token_path_preserved(self):
  tree=ast.parse(Path(__file__).with_name('rehearse-guest.py').read_text())
  code=ast.unparse(next(n for n in ast.walk(tree) if isinstance(n,ast.If) and ast.unparse(n.test)=="step == 'connect'"))
  self.assertIn("os.environ.get('DATA_DIR','/data')",code)
  self.assertLess(code.index('wait_provider_ready'),code.index('legacy-key.env'))

if __name__=='__main__':unittest.main()
