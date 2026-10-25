#!/usr/bin/env python3
"""Attempt-scoped orchestration and receipts, with a bounded staging refresh.

Production operations are supplied as an explicit, versioned plan of argv arrays.
No shell expansion or implicit defaults; no lifecycle operation in dry-run mode.
This engine deliberately refuses readiness without both exact-rig acceptance and
an exercised, complete operation plan. It does not turn unit fakes into proof.
"""
import argparse,fcntl,hashlib,json,os,subprocess,sys,time,uuid
from pathlib import Path

REQUIRED=('snapshot','stage','deploy','install','privacy','regression','migrate','verify','rollback')
CHECKS=('a','b','c','d','e','f')

class LaunchError(RuntimeError):pass

def atomic(path,data):
 path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
 tmp=path.with_name(path.name+'.tmp');tmp.write_text(json.dumps(data,indent=2)+'\n');tmp.chmod(0o600);os.replace(tmp,path)

def validate_plan(plan):
 if plan.get('schema')!=1:raise LaunchError('unsupported plan schema')
 for key in REQUIRED:
  cmd=plan.get('commands',{}).get(key)
  if not isinstance(cmd,list) or not cmd or not all(isinstance(x,str) and x for x in cmd):raise LaunchError('missing argv operation: '+key)
  if any('\x00' in x for x in cmd):raise LaunchError('NUL in argv')
 if plan.get('no_drain') is not True:raise LaunchError('explicit --no-drain approval missing')
 if plan.get('migration_agent')!='private':raise LaunchError('only explicit Private migration is authorized')
 if plan.get('rollback_scope')!='attempt':raise LaunchError('rollback must be attempt-scoped')
 return plan

def validate_rig(rig):
 blockers=[]
 if rig.get('status')!='passed':blockers.append('exact pinned rehearsal is not passed')
 if set(rig.get('checks',{}))!=set(CHECKS) or any(rig.get('checks',{}).get(x)!='passed' for x in CHECKS):blockers.append('rehearsal checks a-f incomplete')
 if rig.get('privacy_checks_passed')!=6:blockers.append('six privacy checks incomplete')
 reset=rig.get('reset',{})
 if reset.get('provider_key_present') is not False or reset.get('apps')!=0 or reset.get('provider_volumes')!=[]:blockers.append('verified rig reset missing')
 if reset.get('remaining_synthetic_containers')!=[] or reset.get('remaining_synthetic_agent_dirs')!=[]:blockers.append('synthetic runtime reset readback missing')
 evidence=rig.get('evidence',{})
 if evidence.get('privacy',{}).get('privacy_checks_passed')!=6:blockers.append('actual privacy receipt incomplete')
 if evidence.get('d-verified',{}).get('completed_migrated_request') is not True:blockers.append('completed migrated inference unproven')
 if evidence.get('key-migrated',{}).get('checks',{}).get('key-location')!='passed':blockers.append('post-migration credential-location receipt incomplete')
 vision=evidence.get('f-verified',{})
 if vision.get('other_agent_chat_completed') is not True or vision.get('vision_helper_completed') is not True or vision.get('colour')!='red':blockers.append('real regression chat and red-image vision evidence incomplete')
 return blockers

class Commands:
 def __init__(self,plan,attempt,output):self.plan=plan;self.attempt=attempt;self.output=Path(output)
 def call(self,operation,context,timeout):
  # Only explicitly selected argv; values are context paths, never secret text.
  env=dict(os.environ,PP_LAUNCH_ATTEMPT=self.attempt,PP_LAUNCH_CONTEXT=str(context),PP_LAUNCH_RECEIPTS=str(self.output),PP_LAUNCH_NO_DRAIN='1')
  out=self.output/(operation+'.json')
  p=subprocess.run(self.plan['commands'][operation],env=env,capture_output=True,timeout=timeout)
  log=self.output/(operation+'.log');log.write_bytes(p.stdout+p.stderr);log.chmod(0o600)
  # Never echo subprocess stdout/stderr; operational logs could contain secrets.
  if p.returncode:
   error_path=self.output/'adapter-error.json'
   detail=json.loads(error_path.read_text()) if error_path.exists() else {'type':'SubprocessFailure','returncode':p.returncode}
   atomic(out,{'attempt':self.attempt,'operation':operation,'status':'failed','error':detail})
   raise LaunchError(operation+' failed (exit '+str(p.returncode)+'); redacted error in '+operation+'.json')
  if not out.is_file():raise LaunchError(operation+' returned no exact-target readback receipt')
  data=json.loads(out.read_text())
  if data.get('attempt')!=self.attempt or data.get('operation')!=operation or data.get('status')!='passed':raise LaunchError(operation+' receipt is not an attempt-scoped pass')
  return data

class Orchestrator:
 def __init__(self,ops,discover,receipt,clock=time.monotonic,budget=600):
  self.ops=ops;self.discover=discover;self.receipt=Path(receipt);self.clock=clock;self.budget=budget
  self.result={'attempt':getattr(ops,'attempt','test'),'status':'blocked','steps':[],'blockers':[],'mutated':False}
 def mark(self,step,data):
  self.result['steps'].append({'operation':step,'receipt':data});atomic(self.receipt,self.result)
 def run(self,rig,plan,dry_run=False):
  context=self.receipt.parent/'context.json';active='discover'
  try:
   before=self.discover();self.result['before']=before
   blockers=validate_rig(rig)
   try:validate_plan(plan)
   except LaunchError as e:blockers.append(str(e))
   if rig.get('wam_image_id')!=before['containers']['runtipi']['image_id']:blockers.append('rig/live WAM image parity mismatch')
   if blockers:raise LaunchError('; '.join(blockers))
   # Refresh staging onto the actual running Service revision, not main or a stale pinned baseline.
   deadline=self.clock()+self.budget
   while True:
    left=deadline-self.clock()
    if left<=0:raise LaunchError('600s staging-refresh budget exhausted')
    context=self.receipt.parent/'context.json';atomic(context,{'attempt':self.result['attempt'],'live':before,'plan':plan,'dry_run':dry_run})
    active='stage';staged=self.ops.call('stage',context,timeout=left);self.mark('stage',staged)
    if staged.get('base_sha')!=before['releases']['service']['sha'] or staged.get('focused_suites_passed') is not True:raise LaunchError('staging is not tested on exact current live Service')
    after=self.discover()
    if after==before:break
    before=after;self.result['before']=before
   if dry_run:
    after=self.discover();self.result['after']=after
    self.result['live_fingerprint_unchanged']=before==after
    if before!=after:raise LaunchError('live drift during final dry-run verification')
    self.result.update(status='passed',mode='read-only-dry-run');return self.result
   active='snapshot';self.mark('snapshot',self.ops.call('snapshot',context,timeout=120))
   # Last compare immediately before the first live write; never promote an older base.
   if self.discover()!=before:raise LaunchError('live drift after snapshot; rerun staging')
   self.result['mutated']=True;atomic(self.receipt,self.result)
   for step in ['deploy','install','privacy','regression']:
    active=step;data=self.ops.call(step,context,timeout=600);self.mark(step,data)
    if step=='privacy' and data.get('checks_passed')!=6:raise LaunchError('six live privacy checks did not pass')
   # The only product migration is last, after both safety and regression gates.
   active='migrate';self.mark('migrate',self.ops.call('migrate',context,timeout=300))
   active='verify';self.mark('verify',self.ops.call('verify',context,timeout=300));self.result['status']='passed';return self.result
  except Exception as e:
   safe=type(e).__name__+(': '+str(e) if isinstance(e,LaunchError) else ': details withheld')
   failed=self.receipt.parent/(active+'.json')
   detail=json.loads(failed.read_text()) if failed.exists() and json.loads(failed.read_text()).get('status')=='failed' else {'status':'failed','error':safe}
   self.mark(active,detail);self.result['blockers'].append(safe)
   if self.result['mutated']:
    try:self.mark('rollback',self.ops.call('rollback',context,timeout=600));self.result['status']='rolled_back'
    except Exception as rollback:
     failed=self.receipt.parent/'rollback.json'
     detail=json.loads(failed.read_text()) if failed.exists() else {'status':'failed','error':type(rollback).__name__}
     self.mark('rollback',detail);self.result['blockers'].append('rollback failed: '+type(rollback).__name__);self.result['status']='blocked'
   return self.result
  finally:
   self.result['finished_at']=time.time();atomic(self.receipt,self.result)

def main():
 p=argparse.ArgumentParser(__doc__);p.add_argument('--dry-run',action='store_true');p.add_argument('--plan',type=Path,required=True);p.add_argument('--rig-evidence',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--no-drain',action='store_true');p.add_argument('--parent-lifecycle-authorized',action='store_true');a=p.parse_args()
 if not a.dry_run and not(a.no_drain and a.parent_lifecycle_authorized):p.error('live invocation is parent-only and requires explicit --no-drain and --parent-lifecycle-authorized')
 import importlib.util
 spec=importlib.util.spec_from_file_location('preflight',Path(__file__).with_name('live-preflight.py'));assert spec and spec.loader;mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
 plan=json.loads(a.plan.read_text());rig=json.loads(a.rig_evidence.read_text());attempt=uuid.uuid4().hex;root=a.output.parent/attempt;root.mkdir(parents=True)
 if not plan.get('rig_target'):
  from production_readiness import check
  before=mod.fingerprint(Path.home());blockers=check(plan,rig,before,Path(__file__).parent);after=mod.fingerprint(Path.home())
  if before!=after:blockers.append('live drift during authenticated read-only admission')
  if blockers:
   report={'attempt':attempt,'status':'blocked','blockers':blockers,'before':before,'after':after,'live_fingerprint_unchanged':before==after,'mutated':False};atomic(a.output,report);print(json.dumps(report,indent=2));return 1
 with (a.output.parent/'launch.lock').open('a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  report=Orchestrator(Commands(plan,attempt,root),lambda:mod.fingerprint(Path.home()),root/'receipt.json').run(rig,plan,a.dry_run)
  atomic(a.output,report);print(json.dumps(report,indent=2));return 0 if report['status']=='passed' else 1

if __name__=='__main__':sys.exit(main())
