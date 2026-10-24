"""Fixture-only request-adapter tests: no network, key, VM or inference."""
import io,json,sys,unittest,urllib.error
from email.message import Message
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).parent
class Response(io.BytesIO):
 def __init__(self,value,status=200):super().__init__(json.dumps(value).encode());self.status=status
class ProbeAdapterTests(unittest.TestCase):
 def run_probe(self,closed=False):
  requests=[];written=[]
  def read(p,*a,**k):
   if str(p)=='/etc/pp-rig':return 'pp-private-providers'
   if p.name=='owner-proof':return 'synthetic-proof'
   if p.name=='codeword':return 'synthetic-codeword'
   raise AssertionError('unexpected read '+str(p))
  def urlopen(req,**kw):
   body=json.loads(req.data) if req.data else None;requests.append((req.full_url,body))
   if '/api/sessions?' in req.full_url:
    if closed:raise urllib.error.HTTPError(req.full_url,503,'closed',Message(),Response({'error':'private_provider_unavailable'}))
    return Response({'session':{'id':'wizard_server_created'}},201)
   if '/v1/runs?' in req.full_url:return Response({'run_id':'synthetic-run'},202)
   if '/v1/runs/synthetic-run?' in req.full_url:return Response({'status':'completed','output':'PP_OK'})
   raise AssertionError('unexpected URL '+req.full_url)
  # Compile before mocking Path so the source read itself remains real.
  code=compile((ROOT/'probe-guest.py').read_text(),str(ROOT/'probe-guest.py'),'exec')
  with patch.object(sys,'argv',['probe-guest.py','pp-test-probe']),patch('pathlib.Path.read_text',read),patch('pathlib.Path.write_text',lambda p,v:written.append((str(p),json.loads(v)))),patch('urllib.request.urlopen',urlopen):
   with self.assertRaises(SystemExit) as result:exec(code,{'__name__':'__main__'})
  return result.exception.code,requests,written
 def test_canonical_create_then_completed_run(self):
  code,requests,written=self.run_probe();self.assertEqual(code,0)
  self.assertNotIn('id',requests[0][1]);self.assertNotIn('session_id',requests[0][1])
  self.assertEqual(requests[1][1]['session_id'],'wizard_server_created');self.assertTrue(written[0][1]['completed'])
 def test_provider_closure_is_not_counted_as_completion(self):
  code,requests,written=self.run_probe(closed=True);self.assertEqual(code,42);self.assertEqual(len(requests),1);self.assertEqual(written,[])
if __name__=='__main__':unittest.main()
