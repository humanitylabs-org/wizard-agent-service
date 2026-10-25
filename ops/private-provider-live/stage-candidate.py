#!/usr/bin/env python3
"""Build a fresh tested candidate from the actual live Service base on Thales."""
import argparse,hashlib,json,os,shutil,subprocess,sys,tarfile,time
from pathlib import Path
SERVICE='5f590792828fd455bd5b4f5b71c155d30e7573ca'
UX='f34c7a35a8d5f4adbca9eeb57cb83837b1664ba6'
ROOT=Path('/Volumes/ThalesMedia/AI-Wizards/private-providers/pp-launch/live/staging')

def remote(data):
 assert sys.platform=='darwin'
 attempt=data['attempt'];assert len(attempt)==32 and all(c in '0123456789abcdef' for c in attempt)
 base=data['live']['releases']['service']['sha'];assert len(base)==40 and all(c in '0123456789abcdef' for c in base)
 attempt_root=ROOT/attempt;root=attempt_root/str(time.time_ns());root.mkdir(parents=True,exist_ok=True);remaining=min(float(data.get('budget',570)),float(data.get('expires_at',time.time()+570))-time.time());deadline=time.monotonic()+remaining;logs=[]
 if remaining<=0:raise RuntimeError('staging admission budget expired while waiting for worker')
 env=dict(os.environ,PATH='/opt/homebrew/bin:'+os.environ['PATH'],TMPDIR=str(Path('/Volumes/ThalesMedia/.pp-tmp')/attempt[:8]));Path(env['TMPDIR']).mkdir(parents=True,exist_ok=True)
 def run(argv,cwd=None,payload=None):
  left=deadline-time.monotonic()
  if left<=0:raise RuntimeError('staging budget exhausted')
  p=subprocess.run(argv,cwd=cwd,env=env,capture_output=True,timeout=left,input=payload)
  log=root/('step-'+str(len(logs))+'.log');log.write_bytes(p.stdout+p.stderr);logs.append({'argv':argv,'returncode':p.returncode,'log':str(log)})
  if p.returncode:raise RuntimeError('staging step failed: '+str(len(logs)-1))
  return p.stdout.decode().strip()
 svc=root/('service-'+base[:12]);ux=root/'ux'
 try:
  if svc.exists():shutil.rmtree(svc)
  svc.mkdir();run(['git','init','-q'],svc);run(['git','remote','add','origin','https://github.com/humanitylabs-org/wizard-agent-service.git'],svc)
  run(['git','fetch','--no-tags','origin',base,SERVICE],svc);run(['git','checkout','--detach',base],svc)
  # Replay the already reviewed integration as a delta, then the new product
  # delta. No branch/public merge is performed. Unknown apply conflicts fail closed.
  old_provider='5e445fca7c87da825e8d669fbf35e3e6eeeb5acb'
  old_live='4be54416627ab3f578a951166a084e459e9edd9c'
  integrated='8aa4372ff0c64ae2e053032da789395d03c70540'
  prior=ROOT/'f442c36a5fe942e4b55c7ec944482043/1792894907109610000/service-4be54416627a'
  run(['git','fetch','--no-tags',str(prior),integrated,old_provider],svc)
  resolutions=[]
  if base!=old_provider:
   delta=run(['git','diff','--binary',old_live,integrated],svc)+'\n'
   run(['git','apply','--3way','--index','-'],svc,payload=delta.encode())
  delta=run(['git','diff','--binary',old_provider,SERVICE],svc)+'\n'
  run(['git','apply','--3way','--index','-'],svc,payload=delta.encode())
  run(['git','-c','user.name=defleur-agents','-c','user.email=263346993+defleur-agents@users.noreply.github.com','commit','--allow-empty','-m','Stage reviewed private-provider deltas on exact live base'],svc)
  candidate=run(['git','rev-parse','HEAD'],svc)
  run(['git','merge-base','--is-ancestor',base,'HEAD'],svc)
  run(['npm','ci','--no-audit','--no-fund'],svc)
  run(['npx','--no-install','vitest','run','tests/agents-legacy-migration.test.ts','tests/private-provider-launch.test.ts','tests/legacy-private-compat.test.ts','tests/private-providers.test.ts','tests/agents.test.ts','tests/ui-preferences.test.ts','tests/thread-spaces.test.ts','tests/thread-spaces-http.test.ts','tests/routed-run-queue.test.ts'],svc)
  venv=root/'test-venv';python=str(venv/'bin/python')
  run([sys.executable,'-m','venv',str(venv)],svc)
  run([python,'-m','pip','install','--disable-pip-version-check','pytest','pyyaml'],svc)
  run([python,'-m','pytest','ops/agent-runtime/test_agent_runtime.py','ops/agent-runtime/test_private_providers.py','ops/agent-runtime/test_provider_launch_compat.py','ops/agent-runtime/test_provider_egress.py','ops/agent-runtime/test_provider_key_scrub.py','ops/agent-runtime/test_private_restore.py','ops/agent-runtime/test_local_readiness.py','-q'],svc)
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
   tf.add(svc/'ops/private-provider-rig/checks',arcname='acceptance')
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
