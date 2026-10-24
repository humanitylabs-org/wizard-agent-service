#!/usr/bin/env python3
"""Build a fresh tested candidate from the actual live Service base on Thales."""
import argparse,hashlib,json,os,shutil,subprocess,sys,tarfile,time
from pathlib import Path
SERVICE='888ecee067cde661f069875dc5915a7abe341103'
UX='f34c7a35a8d5f4adbca9eeb57cb83837b1664ba6'
ROOT=Path('/Volumes/ThalesMedia/AI-Wizards/private-providers/pp-launch/live/staging')

def remote(data):
 assert sys.platform=='darwin'
 attempt=data['attempt'];assert len(attempt)==32 and all(c in '0123456789abcdef' for c in attempt)
 base=data['live']['releases']['service']['sha'];assert len(base)==40 and all(c in '0123456789abcdef' for c in base)
 attempt_root=ROOT/attempt;root=attempt_root/str(time.time_ns());root.mkdir(parents=True,exist_ok=True);remaining=min(float(data.get('budget',570)),float(data.get('expires_at',time.time()+570))-time.time());deadline=time.monotonic()+remaining;logs=[]
 if remaining<=0:raise RuntimeError('staging admission budget expired while waiting for worker')
 env=dict(os.environ,PATH='/opt/homebrew/bin:'+os.environ['PATH'],TMPDIR=str(Path('/Volumes/ThalesMedia/.pp-tmp')/attempt[:8]));Path(env['TMPDIR']).mkdir(parents=True,exist_ok=True)
 def run(argv,cwd=None):
  left=deadline-time.monotonic()
  if left<=0:raise RuntimeError('staging budget exhausted')
  p=subprocess.run(argv,cwd=cwd,env=env,capture_output=True,timeout=left)
  log=root/('step-'+str(len(logs))+'.log');log.write_bytes(p.stdout+p.stderr);logs.append({'argv':argv,'returncode':p.returncode,'log':str(log)})
  if p.returncode:raise RuntimeError('staging step failed: '+str(len(logs)-1))
  return p.stdout.decode().strip()
 svc=root/('service-'+base[:12]);ux=root/'ux'
 try:
  if svc.exists():shutil.rmtree(svc)
  svc.mkdir();run(['git','init','-q'],svc);run(['git','remote','add','origin','https://github.com/humanitylabs-org/wizard-agent-service.git'],svc)
  run(['git','fetch','--no-tags','origin',base,SERVICE],svc);run(['git','checkout','--detach',base],svc)
  resolutions=[]
  try:run(['git','-c','user.name=defleur-agents','-c','user.email=263346993+defleur-agents@users.noreply.github.com','merge','--no-ff','--no-edit',SERVICE],svc)
  except RuntimeError:
   from merge_resolver import resolve
   conflicts=run(['git','diff','--name-only','--diff-filter=U'],svc).splitlines()
   if not conflicts or not (svc/'.git/MERGE_HEAD').exists():raise
   resolutions=resolve(svc,conflicts)
   run(['git','add','--',*conflicts],svc)
   run(['git','-c','user.name=defleur-agents','-c','user.email=263346993+defleur-agents@users.noreply.github.com','commit','--no-edit'],svc)
  candidate=run(['git','rev-parse','HEAD'],svc)
  run(['git','merge-base','--is-ancestor',base,'HEAD'],svc);run(['git','merge-base','--is-ancestor',SERVICE,'HEAD'],svc)
  run(['npm','ci','--no-audit','--no-fund'],svc)
  run(['npx','--no-install','vitest','run','tests/private-provider-launch.test.ts','tests/legacy-private-compat.test.ts','tests/private-providers.test.ts','tests/agents.test.ts','tests/ui-preferences.test.ts','tests/thread-spaces.test.ts','tests/thread-spaces-http.test.ts','tests/routed-run-queue.test.ts'],svc)
  venv=root/'test-venv';python=str(venv/'bin/python')
  run([sys.executable,'-m','venv',str(venv)],svc)
  run([python,'-m','pip','install','--disable-pip-version-check','pytest','pyyaml'],svc)
  run([python,'-m','pytest','ops/agent-runtime/test_agent_runtime.py','ops/agent-runtime/test_private_providers.py','ops/agent-runtime/test_provider_launch_compat.py','ops/agent-runtime/test_provider_egress.py','-q'],svc)
  if not ux.exists():
   ux.mkdir();run(['git','init','-q'],ux);run(['git','remote','add','origin','https://github.com/humanitylabs-org/wizard-ux.git'],ux);run(['git','fetch','--no-tags','origin',UX],ux);run(['git','checkout','--detach',UX],ux)
  assert run(['git','rev-parse','HEAD'],ux)==UX
  gnu_sed=Path('/opt/homebrew/opt/gnu-sed/libexec/gnubin')
  if not (gnu_sed/'sed').is_file():
   env['HOMEBREW_NO_AUTO_UPDATE']='1'
   run(['/opt/homebrew/bin/brew','install','gnu-sed'],ux)
  env['PATH']=str(gnu_sed)+':'+env['PATH']
  # wizard-ux ships checked-in static web assets; it has no lockfile/build script.
  run(['npm','test'],ux)
  artifact=root/('candidate-'+base[:12]+'.tar.gz')
  with tarfile.open(artifact,'w:gz') as tf:
   for name in ['server','node_modules','package.json','package-lock.json']:tf.add(svc/name,arcname='service/'+name)
   tf.add(svc/'ops/agent-runtime',arcname='runtime',filter=lambda i:None if '__pycache__' in i.name or '.pytest_cache' in i.name else i)
   tf.add(ux/'web',arcname='ux')
  result={'attempt':attempt,'operation':'stage','status':'passed','base_sha':base,'provider_sha':SERVICE,'candidate_sha':candidate,'ux_sha':UX,'focused_suites_passed':True,'reviewed_merge_resolutions':resolutions,'artifact':str(artifact),'artifact_sha256':hashlib.sha256(artifact.read_bytes()).hexdigest(),'steps':logs}
 except Exception as e:
  result={'attempt':attempt,'operation':'stage','status':'blocked','base_sha':base,'error':type(e).__name__+': '+str(e),'steps':logs}
 (root/'stage-result.json').write_text(json.dumps(result,indent=2)+'\n');(attempt_root/'stage-result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result));return 0 if result['status']=='passed' else 1

def main():
 p=argparse.ArgumentParser(__doc__);p.add_argument('--remote',action='store_true');a=p.parse_args()
 if a.remote:return remote(json.load(sys.stdin))
 context=Path(os.environ['PP_LAUNCH_CONTEXT']);data=json.loads(context.read_text());data['budget']=570;data['expires_at']=time.time()+570
 # The script itself is copied to the remote lane by the parent tooling staging step.
 remote_script='/Volumes/ThalesMedia/AI-Wizards/private-providers/pp-launch/live/stage-candidate.py'
 cmd=['ssh','thales','/opt/homebrew/bin/python3','/Volumes/ThalesMedia/AI-Wizards/private-providers/run-locked.py','/opt/homebrew/bin/python3',remote_script,'--remote']
 p=subprocess.run(cmd,input=json.dumps(data),capture_output=True,text=True,timeout=590)
 if p.returncode:raise RuntimeError('Thales candidate refresh failed; see attempt-scoped remote staging receipt')
 result=json.loads(p.stdout);out=Path(os.environ['PP_LAUNCH_RECEIPTS']);local=out/'candidate.tar.gz'
 subprocess.run(['scp','thales:'+result['artifact'],str(local)],check=True,capture_output=True,timeout=60)
 assert hashlib.sha256(local.read_bytes()).hexdigest()==result['artifact_sha256']
 result['local_artifact']=str(local);(out/'stage.json').write_text(json.dumps(result,indent=2)+'\n');return 0
if __name__=='__main__':sys.exit(main())
