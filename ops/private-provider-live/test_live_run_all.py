import importlib.util,json,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('launch',Path(__file__).with_name('live-run-all.py'));assert spec and spec.loader;m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
BASE={'containers':{'runtipi':{'image_id':'wam'}},'releases':{'service':{'sha':'live-feature-not-main'}}}
PLAN={'schema':1,'no_drain':True,'migration_agent':'private','rollback_scope':'attempt','commands':{x:['explicit-operation',x] for x in m.REQUIRED}}
RIG={'status':'passed','checks':dict.fromkeys(m.CHECKS,'passed'),'privacy_checks_passed':6,'reset':{'provider_key_present':False,'apps':0,'provider_volumes':[],'remaining_synthetic_containers':[],'remaining_synthetic_agent_dirs':[]},'wam_image_id':'wam','evidence':{'privacy':{'privacy_checks_passed':6},'d-verified':{'completed_migrated_request':True},'key-migrated':{'checks':{'key-location':'passed'}},'f-verified':{'other_agent_chat_completed':True,'vision_helper_completed':True,'colour':'red'}}}
class Fake:
 attempt='unit-attempt'
 def __init__(self,fail=None):self.calls=[];self.fail=fail
 def call(self,op,context,timeout):
  self.calls.append(op)
  if op==self.fail:raise m.LaunchError('injected '+op)
  result={'operation':op,'status':'passed','attempt':self.attempt}
  if op=='stage':result.update(base_sha='live-feature-not-main',focused_suites_passed=True)
  if op=='privacy':result['checks_passed']=6
  return result
class Tests(unittest.TestCase):
 def launch(self,fake=None,rig=RIG,plan=PLAN,dry=False,discover=lambda:BASE,clock=None):
  with tempfile.TemporaryDirectory() as d:
   kwargs={} if clock is None else {'clock':clock}
   ops=fake or Fake();r=m.Orchestrator(ops,discover,Path(d)/'receipt.json',**kwargs).run(rig,plan,dry)
   self.assertEqual(json.loads((Path(d)/'receipt.json').read_text())['status'],r['status']);return ops,r
 def test_dry_run_never_snapshot_deploy_or_migrate(self):
  f,r=self.launch(dry=True);self.assertEqual(r['status'],'passed');self.assertEqual(f.calls,['stage']);self.assertTrue(r['live_fingerprint_unchanged'])
 def test_real_order_migrates_only_after_six_and_regression(self):
  f,r=self.launch();self.assertEqual(r['status'],'passed');self.assertEqual(f.calls,['stage','snapshot','deploy','install','privacy','regression','migrate','verify'])
 def test_all_postwrite_failures_rollback(self):
  for fail in ['deploy','install','privacy','regression','migrate','verify']:
   with self.subTest(fail=fail):
    f,r=self.launch(Fake(fail));self.assertEqual(r['status'],'rolled_back');self.assertEqual(f.calls[-1],'rollback')
    if fail in ['deploy','install','privacy','regression']:self.assertNotIn('migrate',f.calls)
 def test_prewrite_failures_do_not_rollback(self):
  for fail in ['stage','snapshot']:
   f,r=self.launch(Fake(fail));self.assertEqual(r['status'],'blocked');self.assertNotIn('rollback',f.calls)
 def test_missing_plan_blocks_even_readonly(self):
  f,r=self.launch(plan={'schema':1},dry=True);self.assertEqual(f.calls,[]);self.assertEqual(r['status'],'blocked')
 def test_unproven_rig_cannot_pass(self):
  f,r=self.launch(rig={**RIG,'checks':{}},dry=True);self.assertEqual(r['status'],'blocked');self.assertEqual(f.calls,[])
 def test_reset_requires_negative_key_and_no_volumes(self):
  for reset in [{},{'provider_key_present':True,'apps':0,'provider_volumes':[]},{'provider_key_present':False,'apps':0,'provider_volumes':['secret']}]:
   self.assertTrue(m.validate_rig({**RIG,'reset':reset}))
 def test_wam_parity_is_not_a_warning(self):
  f,r=self.launch(rig={**RIG,'wam_image_id':'other'},dry=True);self.assertEqual(r['status'],'blocked');self.assertEqual(f.calls,[])
 def test_stale_base_cannot_deploy(self):
  class Stale(Fake):
   def call(self,*args,**kwargs):return {**super().call(*args,**kwargs),'base_sha':'main'}
  f,r=self.launch(Stale());self.assertEqual(r['status'],'blocked');self.assertEqual(f.calls,['stage'])
 def test_focused_suite_failure_cannot_deploy(self):
  class Bad(Fake):
   def call(self,*args,**kwargs):return {**super().call(*args,**kwargs),'focused_suites_passed':False}
  f,r=self.launch(Bad());self.assertEqual(r['status'],'blocked');self.assertEqual(f.calls,['stage'])
 def test_budget_bounds_drift_refresh(self):
  times=iter([0,0,601]);counter=iter([BASE,{'containers':BASE['containers'],'releases':{'service':{'sha':'drift'}}}])
  f,r=self.launch(dry=True,clock=lambda:next(times),discover=lambda:next(counter));self.assertEqual(r['status'],'blocked');self.assertIn('budget exhausted',r['blockers'][0])
 def test_partial_privacy_count_blocks_migration_and_rollsback(self):
  class Partial(Fake):
   def call(self,op,*args,**kwargs):
    r=super().call(op,*args,**kwargs)
    if op=='privacy':r['checks_passed']=5
    return r
  f,r=self.launch(Partial());self.assertEqual(r['status'],'rolled_back');self.assertNotIn('migrate',f.calls)
 def test_success_flags_without_actual_inference_evidence_block(self):
  import copy
  for name in ['f-verified','d-verified','key-migrated','privacy']:
   rig=copy.deepcopy(RIG);rig['evidence'].pop(name)
   with self.subTest(evidence=name):
    f,r=self.launch(rig=rig,dry=True);self.assertEqual(r['status'],'blocked');self.assertEqual(f.calls,[])
 def test_surviving_synthetic_runtime_blocks(self):
  import copy
  rig=copy.deepcopy(RIG);rig['reset']['remaining_synthetic_containers']=['survivor']
  f,r=self.launch(rig=rig,dry=True);self.assertEqual(r['status'],'blocked');self.assertEqual(f.calls,[])
 def test_failed_step_has_explicit_error_receipt(self):
  f,r=self.launch(Fake('snapshot'))
  self.assertEqual(r['steps'][-1]['operation'],'snapshot')
  self.assertEqual(r['steps'][-1]['receipt']['status'],'failed')
  self.assertIn('injected snapshot',r['steps'][-1]['receipt']['error'])
 def test_untrusted_exception_text_is_redacted(self):
  class Bad(Fake):
   def call(self,*args,**kwargs):raise ValueError('sensitive-response-sentinel')
  f,r=self.launch(Bad())
  self.assertNotIn('sensitive-response-sentinel',json.dumps(r))
  self.assertIn('ValueError',json.dumps(r))
if __name__=='__main__':unittest.main()
