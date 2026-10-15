"""Production supervisor regression; only the external control transport is fake.
Real files/flocks/fsync and a separate helper process exercise crash persistence.
The guest suite separately executes the real authenticated stock backend.
"""
import json, os, sys, tempfile, unittest, uuid
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'ops/agent-runtime'))
from managed_maintenance import ManagedMaintenance, MaintenanceError
C={'id':'owned','name':'owned','hostname':'owned','running':True,'managed':True,'image':'managed'}
R={'container':C,'pid':23,'start':'42','bootId':'boot','role':'backend','home':'/opt/data','managed':True}
class Transport(ManagedMaintenance):
 def __init__(self, root, fault=None):
  super().__init__(root); self.fault=fault;self.calls=[]
  self.state=self.root/'backend.json'
  if not self.state.exists():self.state.write_text(json.dumps({'committed':False,'alive':True}))
 def host_legacy(self):return False
 def containers(self):return [dict(C)]
 def reservations(self):return set()
 def control(self,c,action,**kw):
  self.calls.append((action,kw));s=json.loads(self.state.read_text())
  if action=='snapshot':return {'processes':[dict(R,pid=23 if s['alive'] else 24)] if not (self.read() and not s['alive']) else [],'reservations':[]}
  if action=='alive':return {'alive':s['alive']}
  if action=='backend':
   assert kw['runtime']['bootId']=='boot'
   verb=kw['verb']
   if verb=='prepare':return {'ok':True,'token':'exact-permit'}
   assert kw['body']['token']=='exact-permit'
   if verb=='commit':
    assert self.read()['runtimes'][0].get('commitIntent') or self.read()['runtimes'][0].get('committed')
    s['committed']=True;self.state.write_text(json.dumps(s))
    if self.fault=='crash':os._exit(86)
    if self.fault=='drop':self.fault=None;raise MaintenanceError('dropped_commit_reply')
    if self.fault=='reject':return {'ok':False}
    return {'ok':True}
   if verb=='cancel':return {'ok':not s['committed']}
  if action=='stop-backend':
   assert s['committed'];s['alive']=False;self.state.write_text(json.dumps(s));return {'ok':True}
  if action=='backend-ready':
   assert (self.root/'resume.json').exists()
   assert (self.root/'resume.json').stat().st_uid==1000
   child=os.fork()
   if child==0:
    os.setgid(1000);os.setuid(1000)
    json.loads((self.root/'resume.json').read_text());os._exit(0)
   assert os.waitpid(child,0)[1]==0,'normal supervisor cannot resume root-created recovery'
   with self.assert_fenced():pass
   return {'ok':True}
  raise AssertionError(action)
 def assert_fenced(self):
  try:self.enter()
  except MaintenanceError:return __import__('contextlib').nullcontext()
  raise AssertionError('operation admission reopened before readiness')
class Recovery(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.token=str(uuid.uuid4())
 def tearDown(self):self.tmp.cleanup()
 def test_dropped_commit_reply_recovers(self):
  m=Transport(self.root,'drop')
  with self.assertRaisesRegex(MaintenanceError,'dropped_commit_reply'):m.acquire(self.token)
  self.assertIsNone(m.read());self.assertFalse((self.root/'resume.json').exists())
  self.assertEqual(sum(a=='backend' and k['verb']=='commit' for a,k in m.calls),2)
  self.assertTrue(any(a=='backend-ready' for a,k in m.calls))
 def test_helper_crash_after_commit_reloads_exact_intent(self):
  pid=os.fork()
  if pid==0:Transport(self.root,'crash').acquire(self.token);os._exit(99)
  self.assertEqual(os.waitpid(pid,0)[1]>>8,86)
  m=Transport(self.root);r=m.read()['runtimes'][0]
  self.assertTrue(r['commitIntent']);self.assertNotIn('committed',r)
  with self.assertRaisesRegex(MaintenanceError,'mismatch'):m.release(str(uuid.uuid4()))
  self.assertTrue(m.release(self.token)['ok']);self.assertIsNone(m.read())
 def test_refused_cancel_retains_fence(self):
  m=Transport(self.root);m.state.write_text(json.dumps({'committed':True,'alive':True}))
  m.save({'token':self.token,'phase':'acquiring','containers':[C],'runtimes':[dict(R,permit='exact-permit')]})
  with self.assertRaisesRegex(MaintenanceError,'backend_cancel_reconciliation_unknown'):m.release(self.token)
  self.assertIsNotNone(m.read());self.assertFalse(any(a=='stop-backend' for a,k in m.calls))
 def test_refused_replay_retains_fence(self):
  m=Transport(self.root,'reject')
  m.save({'token':self.token,'phase':'acquiring','containers':[C],'runtimes':[dict(R,permit='exact-permit',commitIntent=True)]})
  with self.assertRaisesRegex(MaintenanceError,'backend_commit_reconciliation_unknown'):m.release(self.token)
  self.assertIsNotNone(m.read());self.assertFalse(any(a=='stop-backend' for a,k in m.calls))
 def test_operation_and_reacquire_block_during_resume(self):
  m=Transport(self.root);(self.root/'resume.json').write_text(json.dumps({'token':self.token}))
  with self.assertRaisesRegex(MaintenanceError,'maintenance_active'):m.enter()
  with self.assertRaisesRegex(MaintenanceError,'recovery_required'):m.acquire(str(uuid.uuid4()))
if __name__=='__main__':unittest.main()
