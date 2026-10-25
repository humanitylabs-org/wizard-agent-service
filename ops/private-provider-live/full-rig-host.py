#!/usr/bin/env python3
"""Direct shared-lock full orchestration job. All paid work stays on pp-rig."""
import base64,hashlib,importlib.util,json,os,shutil,subprocess,sys,tarfile,time
from pathlib import Path
L=Path('/Volumes/ThalesMedia/AI-Wizards/private-providers/pp-launch/live');s=importlib.util.spec_from_file_location('prepare',L/'rig-prepare.py');assert s and s.loader;m=importlib.util.module_from_spec(s);s.loader.exec_module(m);r=m.Rig(L.parents[1])
number=int(sys.argv[1]);assert number in {6,7,8,9,10}
prior=[x for x in L.glob('FULL-LIVE-RUN-*.json') if x.stem.rsplit('-',1)[-1].isdigit() and json.loads(x.read_text()).get('lane')=='pp-live-adapters-3'];assert len(prior)<5 and all(json.loads(x.read_text()).get('status')!='running' for x in prior),'five-job rig budget exhausted or another lane job is active'
key=sys.stdin.buffer.read();assert key and b'TINFOIL_API_KEY=' in key
receipt={'lane':'pp-live-adapters-3','rig_attempt':len(prior)+1,'job_label':number,'prior_job_labels':[x.name for x in prior],'status':'running','phases':[],'started_at':time.time()};path=L/('FULL-LIVE-RUN-'+str(number)+'.json');assert not path.exists()
def save():path.write_text(json.dumps(receipt,indent=2)+'\n')
def phase(name,argv,payload=None,timeout=1800):
 p=subprocess.run(argv,input=payload,capture_output=True,timeout=timeout)
 log=L/('full-'+str(number)+'-'+name+'.log');log.write_bytes(p.stdout+p.stderr);log.chmod(0o600);receipt['phases'].append({'name':name,'returncode':p.returncode,'log':str(log)});save();print(name,'passed' if p.returncode==0 else 'failed',flush=True)
 if p.returncode:raise RuntimeError('phase failed: '+name+'; private phase log preserved')
 return p.stdout

def host(name,*args,payload=None):return phase(name,[sys.executable,str(L/'postseal-rig.py'),*args],payload)
def guest(name,script,timeout=1800):
 # Real subprocess output is retained in the guest per phase, never dumped.
 wrapper="""from pathlib import Path
import subprocess,sys,os
assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers'
p=subprocess.run(['python3',"""+repr('/home/rig/pp-live-tooling/'+script)+"""],capture_output=True,env={**os.environ,'XDG_RUNTIME_DIR':'/run/user/1000','DBUS_SESSION_BUS_ADDRESS':'unix:path=/run/user/1000/bus'})
f=Path('/home/rig/pp-launch-3/"""+name+""".log');f.write_bytes(p.stdout+p.stderr);f.chmod(0o600)
print('EXIT='+str(p.returncode))
"""
 out=r.python(wrapper,timeout=timeout)
 receipt['phases'].append({'name':name,'returncode':int(out.strip().split('EXIT=')[-1]),'guest_log':'/home/rig/pp-launch-3/'+name+'.log'});save();print(name,'passed' if 'EXIT=0' in out else 'failed',flush=True)
 if 'EXIT=0' not in out:raise RuntimeError('guest phase failed: '+name)
save()
try:
 stage_attempt='a210'*8;receipt['stage_attempt']=stage_attempt;save()
 stage_input={'attempt':stage_attempt,'budget_seconds':570,'live':{'releases':{'service':{'sha':'4be54416627ab3f578a951166a084e459e9edd9c'}}}}
 phase('stage',[sys.executable,str(L/'stage-candidate.py'),'--remote'],json.dumps(stage_input).encode(),timeout=590)
 stage_root=L/'staging'/stage_attempt;stage=json.loads((stage_root/'stage-result.json').read_text());assert stage['status']=='passed'
 assets=L/'assets-2';shutil.copyfile(stage['artifact'],assets/'candidate.tar.gz');(assets/'stage.json').write_text(json.dumps(stage,indent=2)+'\n');assert hashlib.sha256((assets/'candidate.tar.gz').read_bytes()).hexdigest()==stage['artifact_sha256']
 phase('initial-reset',[sys.executable,str(L/'full-rig-reset.py')])
 host('setup','setup-resume')
 phase('provider-interpreter-build',[sys.executable,str(L/'prepare-provider-image.py')],timeout=1300)
 r.python("from pathlib import Path; r=Path('/home/rig/pp-launch-3'); names=['minted-session','baseline-start','baseline-prepared','chat-pp-test-legacy','run-pp-test-legacy','trigger-pp-test-legacy','trigger-pp-test-probe','trigger-pp-test-other','legacy-checkpoint','migration','privacy'];[(r/(n+'.json')).unlink(missing_ok=True) for n in names]")
 host('key','key',payload=key);key=b''
 phase('legacy-diagnose',[sys.executable,str(L/'legacy-host.py'),'legacy-diagnose.py'])
 host('legacy-chat','chat','pp-test-legacy');host('checkpoint','quarantine-legacy-key')
 # Only source/public receipts are transferred; credentials took stdin above.
 bundle=L/('full-input-'+str(number)+'.tar')
 with tarfile.open(bundle,'w') as tf:
  for item in assets.iterdir():
   if item.is_file():tf.add(item,arcname='pp-live-assets/'+item.name)
  tf.add(L/'REHEARSAL-LEGACY-FIX-17.json',arcname='pp-live-assets/seed-rig-evidence.json')
  with tarfile.open(L/'tooling-2.tar') as tools:
   for item in tools:
    raw=tools.extractfile(item) if item.isfile() else None;item.name='pp-live-tooling/'+item.name;tf.addfile(item,raw)
 payload=bundle.read_bytes()
 r.python("from pathlib import Path;import sys,tarfile,io,shutil;h=Path('/home/rig');assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers';[(shutil.rmtree(h/n) if (h/n).exists() else None) for n in ['pp-live-assets','pp-live-tooling','pp-live-receipts']];tf=tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()));tf.extractall(h,filter='data');(h/'pp-live-assets/candidate').mkdir();tf=tarfile.open(h/'pp-live-assets/candidate.tar.gz');tf.extractall(h/'pp-live-assets/candidate',filter='data')",payload=payload);payload=b''
 guest('real-owner-bootstrap','full-rig-bootstrap.py')
 guest('old-provider-baseline','full-rig-old-provider.py',timeout=500)
 guest('full-live-run-all','full-rig-guest.py',timeout=3000)
 raw=r.python("from pathlib import Path;print(Path('/home/rig/pp-live-receipts/full-result.json').read_text())")
 receipt['full_result']=json.loads(raw);assert receipt['full_result']['status']=='passed';receipt['full_live_run_all']=receipt['full_result']['full_live_run_all'];receipt['status']='passed'
except Exception as e:
 receipt['status']='blocked';receipt['blocker']=str(e);save();print('BLOCKED',str(e),flush=True)
 try:
  safe=r.python("import subprocess,re;from pathlib import Path;assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers';p=subprocess.run(['docker','logs','--tail','200','runtipi'],capture_output=True,text=True);print('\\n'.join(x for x in (p.stdout+p.stderr).splitlines() if not re.search('key|token|secret',x,re.I)))",timeout=30);(L/('full-'+str(number)+'-runtipi-diagnostic.log')).write_text(safe)
 except Exception:pass
finally:
 key=b''
 try:
  raw=r.python("from pathlib import Path;import json;h=Path('/home/rig');p=h/'pp-live-receipts/full-result.json';print(p.read_text() if p.exists() else '{}')")
  if raw.strip()!='{}':receipt['full_result']=json.loads(raw)
  # Binary collection stays inside this host process. Never print evidence data.
  p=subprocess.run(['/opt/homebrew/bin/limactl','shell','--workdir','/home/rig','pp-rig','--','tar','--exclude=prior-provider-image.tar.gz','-C','/home/rig','-czf','-','pp-live-receipts','pp-launch-3/real-owner-bootstrap.log','pp-launch-3/old-provider-baseline.log','pp-launch-3/full-live-run-all.log'],capture_output=True,env=r.env,timeout=90)
  artifact=L/('FULL-LIVE-RUN-'+str(number)+'-guest-evidence.tar.gz');artifact.write_bytes(p.stdout);artifact.chmod(0o600);receipt['guest_evidence']={'path':str(artifact),'sha256':hashlib.sha256(p.stdout).hexdigest(),'returncode':p.returncode}
 except Exception as e:receipt['collection_error']=type(e).__name__
 try:
  r.python("from pathlib import Path;import os,subprocess;assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers';p=subprocess.run(['systemctl','--user','stop','wizard-mobile','wizard-agent-runtime','wizard-app-manager-api'],env={**os.environ,'XDG_RUNTIME_DIR':'/run/user/1000','DBUS_SESSION_BUS_ADDRESS':'unix:path=/run/user/1000/bus'},capture_output=True);print('OWNER_UNITS_STOPPED' if p.returncode==0 else 'OWNER_UNITS_ALREADY_ABSENT')",timeout=240)
  phase('reset',[sys.executable,str(L/'full-rig-reset.py')],timeout=900);receipt['reset']=json.loads((L/'RESET-FULL.json').read_text())
 except Exception as e:receipt['status']='blocked';receipt['reset_error']=str(e)
 receipt['finished_at']=time.time();save()
print('FULL_RECEIPT',str(path),'STATUS',receipt['status'],flush=True)
assert receipt['status']=='passed'
