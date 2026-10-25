import ast,io,json,os,sys,tempfile,types,unittest,urllib.request
from pathlib import Path
from unittest.mock import Mock,patch

class ProviderAuthenticationTests(unittest.TestCase):
 def execute_connect(self,verified=True,inference='PP_AUTH',stored=True):
  tree=ast.parse(Path(__file__).with_name('rehearse-guest.py').read_text())
  branch=next(n for n in ast.walk(tree) if isinstance(n,ast.If) and ast.unparse(n.test)=="step == 'connect'")
  code=compile(ast.fix_missing_locations(ast.Module(body=branch.body,type_ignores=[])),'connect-step','exec')
  calls=[];saved=[]
  replies=[{'credentialStored':stored,'credentialVerified':False,'status':'not_connected'}, {'choices':[{'message':{'content':inference}}]}, {'credentialVerified':verified,'status':'connected' if verified else 'not_connected','models':[]}]
  def urlopen(request,**kwargs):
   calls.append(request if isinstance(request,str) else request.full_url)
   return io.BytesIO(json.dumps(replies.pop(0)).encode())
  agents=Mock();agents.return_value.providers.reconcile_installed.return_value=[]
  run=Mock(side_effect=[b'fixture\n',json.dumps({'token':'synthetic-control-token'}).encode()])
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'legacy-key.env').write_text('TINFOIL_API_KEY=synthetic-fixture-credential\n')
   env={'os':types.SimpleNamespace(geteuid=lambda:1000),'sys':sys,'S':root,'A':root/'agents','O':root,'R':root,'json':json,'urllib':__import__('urllib'),'run':run,'save':lambda n,v:saved.append((n,v))}
   with patch.dict(sys.modules,{'agent_runtime':types.SimpleNamespace(Agents=agents)}),patch.object(urllib.request,'urlopen',side_effect=urlopen),patch.object(sys,'path',sys.path.copy()):
    try:exec(code,env)
    finally:self.calls=calls;self.saved=saved
  return calls,saved
 def test_stored_but_unverified_key_requires_genuine_completed_request_and_readback(self):
  calls,saved=self.execute_connect()
  self.assertEqual([c.rsplit('/',2)[-1] for c in calls],['connect','completions','connection'])
  self.assertTrue(saved[0][1]['credential_verified'])
  self.assertNotIn('synthetic-',json.dumps(saved))
 def test_unverified_readback_never_claims_connected(self):
  with self.assertRaisesRegex(AssertionError,'not verified'):self.execute_connect(verified=False)
  self.assertEqual(self.saved,[])
 def test_incomplete_inference_never_claims_connected(self):
  with self.assertRaisesRegex(AssertionError,'did not complete'):self.execute_connect(inference='')
  self.assertEqual(self.saved,[])
 def test_unstored_credential_never_attempts_inference(self):
  with self.assertRaisesRegex(AssertionError,'not stored'):self.execute_connect(stored=False)
  self.assertEqual(len(self.calls),1);self.assertEqual(self.saved,[])

if __name__=='__main__':unittest.main()
