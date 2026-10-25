#!/usr/bin/env python3
"""pp-legacy-fix single shared-lease attempt, always resetting pp-rig."""
import importlib.util,sys,json,subprocess,traceback,time,hashlib
from pathlib import Path
L=Path('/Volumes/ThalesMedia/AI-Wizards/private-providers/pp-launch/live')
s=importlib.util.spec_from_file_location('prep',L/'rig-prepare.py');assert s and s.loader
m=importlib.util.module_from_spec(s);s.loader.exec_module(m);r=m.Rig(L.parents[1])
key=sys.stdin.buffer.read();assert key and b'TINFOIL_API_KEY=' in key
ATTEMPT=int(sys.argv[1]) if len(sys.argv)>1 else 1;assert 15<=ATTEMPT<=18
receipt={'lane':'pp-key-scrub','status':'running','checks':dict.fromkeys('abcdef','not_run'),'privacy_checks_passed':0,'root_cause':'Explicit migration retires plaintext home copies before seal publication. Pre-migration privacy proof exempts only the verified legacy home and exact services; migrated key-location has no exemptions. Final attempt starts from a reset covering generic sealed services by exact project and home mount.','tooling_base_commit':'87fd22d','repair_attempt':ATTEMPT}
preparation=json.loads((L/'RIG-PREPARATION.json').read_text())
for field in ['wam_image_id','wam_main_sha256','source']:receipt[field]=preparation[field]
receipt['wam_registry_commit']='0a1e0192'
receipt['service_engine_fix']=json.loads((L/'SERVICE-ENGINE-FIX.json').read_text())
receipt['tooling_files_sha256']={n:hashlib.sha256((L/n).read_bytes()).hexdigest() for n in ['rehearse-guest.py','rig-rehearse-3.py','legacy-extra.py','rig-reset-3.py','wam-cli.tar']}
def save():
 for name in ['REHEARSAL-LEGACY-FIX.json','REHEARSAL-LEGACY-FIX-'+str(ATTEMPT)+'.json']:(L/name).write_text(json.dumps(receipt,indent=2)+'\n')
def phase(name,args,payload=None):
 p=subprocess.run([sys.executable,*args],input=payload,capture_output=True)
 log=L/('legacy-fix-'+str(ATTEMPT)+'-'+name+'.log');log.write_bytes(p.stdout+p.stderr);log.chmod(0o600)
 print(name,'passed' if p.returncode==0 else 'failed',flush=True)
 if p.returncode:
  check={'legacy-chat':'a','install':'b','connect':'b','create-probe':'c','quarantine':'c','privacy':'c','migrate':'d','verify-migrated':'d','key-migrated':'d','regression':'f','remove':'e'}.get(name)
  if check:receipt['checks'][check]='failed'
  receipt['failed_phase']=name
  raise RuntimeError('phase failed: '+name+'; see private log')
 return p.stdout.decode()
def host(name,*args,payload=None):return phase(name,[str(L/'rig-rehearse-3.py'),*args],payload)
def extra(name,*args):return phase(name,[str(L/'legacy-host.py'),'legacy-extra.py',*args])
save()
try:
 phase('initial-reset',[str(L/'rig-reset-3.py')])
 host('setup','setup-resume')
 r.python("from pathlib import Path;import sys;Path('/home/rig/pp-launch-3/legacy-extra.py').write_bytes(sys.stdin.buffer.read())",payload=(L/'legacy-extra.py').read_bytes())
 r.python("from pathlib import Path; r=Path('/home/rig/pp-launch-3'); names=['minted-session','baseline-start','baseline-prepared','chat-pp-test-legacy','run-pp-test-legacy','trigger-pp-test-legacy','trigger-pp-test-probe','trigger-pp-test-other','legacy-checkpoint','migration','privacy','install','provider-connected','probe-created','d-verified','e-verified','f-verified'];[(r/(n+'.json')).unlink(missing_ok=True) for n in names]")
 host('key','key',payload=key);key=b''
 phase('diagnose',[str(L/'legacy-host.py'),'legacy-diagnose.py'])
 host('legacy-chat','chat','pp-test-legacy');receipt['checks']['a']='passed';receipt['root_cause_rig_log']='legacy-fix-'+str(ATTEMPT)+'-diagnose.log';save()
 host('install','install');host('connect','connect');receipt['checks']['b']='passed';save()
 host('create-probe','create-probe')
 # Record history/identity only. Product migration, never fixture code, retires keys.
 host('quarantine','quarantine-legacy-key')
 host('privacy','privacy');receipt['checks']['c']='passed';receipt['privacy_checks_passed']=6;save()
 errors=[]
 try:
  host('migrate','migrate');extra('verify-migrated','verify-migrated')
 except Exception as e:errors.append(str(e))
 # Key-location remains mandatory even when the migrated inference fails; no
 # exemption is passed once the synthetic legacy record has been sealed.
 try:host('key-migrated','key-migrated')
 except Exception as e:errors.append(str(e))
 receipt['checks']['d']='failed' if errors else 'passed';save()
 # Regression needs the installed provider; removal is deliberately the last destructive check.
 try:extra('regression','regression');receipt['checks']['f']='passed'
 except Exception as e:errors.append(str(e))
 save()
 try:extra('remove','remove');receipt['checks']['e']='passed'
 except Exception as e:errors.append(str(e))
 receipt['status']='blocked' if errors else 'passed'
 if errors:receipt['blocker']='; '.join(errors)
 save()
except Exception as e:
 receipt['status']='blocked';receipt['blocker']=str(e);save();print('BLOCKED',str(e),flush=True)
finally:
 key=b''
 try:
  phase('reset',[str(L/'rig-reset-3.py')]);receipt['reset']=json.loads((L/'RESET-3.json').read_text())
 except Exception as e:receipt['reset_error']=str(e);receipt['status']='blocked'
 try:
  raw=r.python("from pathlib import Path;import json; r=Path('/home/rig/pp-launch-3'); names=['baseline-start','chat-pp-test-legacy','install','provider-connected','privacy','legacy-checkpoint','migration','key-migrated','d-preflight','d-verified','e-verified','f-verified']; print(json.dumps({n:json.loads((r/(n+'.json')).read_text()) for n in names if (r/(n+'.json')).exists()}))")
  receipt['evidence']=json.loads(raw)
  if 'privacy' in receipt['evidence']:receipt['privacy_checks_passed']=receipt['evidence']['privacy']['privacy_checks_passed']
 except Exception as e:receipt['evidence_error']=str(e)
 save()
print(json.dumps(receipt,indent=2),flush=True)
assert receipt['status']=='passed' and all(v=='passed' for v in receipt['checks'].values())
