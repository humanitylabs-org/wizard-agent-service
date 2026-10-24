#!/usr/bin/env python3
"""Run pp-rehearsal-3 phases under the shared worker lock; pp-rig only."""
import sys,os,json,tarfile,io,time,subprocess,importlib.util
from pathlib import Path
ROOT=Path('/Volumes/ThalesMedia/AI-Wizards/private-providers');L=ROOT/'pp-launch/live'
spec=importlib.util.spec_from_file_location('prepare',L/'rig-prepare.py');mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
r=mod.Rig(ROOT)
phase=sys.argv[1]
def run_guest(args,timeout=900,payload=None):
 script="from pathlib import Path;import subprocess,sys;args="+repr(args)+";p=subprocess.run(['python3','/home/rig/pp-launch-3/guest.py',*args],input=sys.stdin.buffer.read(),capture_output=True);q=Path('/home/rig/pp-launch-3/phase-'+args[0]+'.log');q.write_bytes(p.stdout+p.stderr);q.chmod(0o600);print(p.stdout.decode() if p.returncode==0 else 'PHASE_FAILED '+args[0]);sys.exit(p.returncode)"
 return r.python(script,payload=payload,timeout=timeout)
assert json.loads((L/'RIG-PREPARATION.json').read_text())['status']=='prepared'
if phase in ['setup','setup-resume']:
 r.python("from pathlib import Path;import os;assert os.geteuid()==1000;assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers';Path('/home/rig/pp-launch-3').mkdir(exist_ok=True)")
 r.python("from pathlib import Path;import sys;Path('/home/rig/pp-launch-3/guest.py').write_bytes(sys.stdin.buffer.read())",payload=(L/'rehearse-guest.py').read_bytes())
 r.python(r'''
import tarfile,os
from pathlib import Path
assert os.geteuid()==1000
root=Path('/home/rig/pp-launch-3')
for name,target in [('service.tar','service'),('tinfoil-relay.tar','tinfoil')]:
 dst=root/target
 if dst.exists():continue
 dst.mkdir()
 def filt(member,path):
  if member.issym() and os.path.isabs(member.linkname):return None
  return tarfile.data_filter(member,path)
 with tarfile.open('/home/rig/pp-launch-2/'+name) as tf:tf.extractall(dst,filter=filt)
''')
 r.python("import subprocess;from pathlib import Path;assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers';subprocess.run(['systemctl','stop','pp-agent-runtime','pp-agent-service'],check=True)",root=True)
 try:print(r.run(['python3','/home/rig/pp-launch-3/guest.py','setup'],timeout=1800),flush=True)
 except Exception:
  print(r.python("from pathlib import Path; p=Path('/home/rig/pp-launch-3/last-command.log'); print(p.read_text()[-6000:] if p.exists() else 'No failed subprocess output')"),flush=True)
  raise
elif phase=='privacy':
 r.python("from pathlib import Path;import sys,uuid;root=Path('/home/rig/pp-launch-3');(root/'probe-guest.py').write_bytes(sys.stdin.buffer.read());p=root/'codeword';p.write_text('PP-CODE-'+uuid.uuid4().hex) if not p.exists() else None;p=root/'trigger.sh';p.write_text('#!/bin/sh\\nexec sudo -u rig python3 /home/rig/pp-launch-3/probe-guest.py pp-test-probe\\n');p.chmod(0o755)",payload=(L/'probe-guest.py').read_bytes())
 print(r.python(r'''
from pathlib import Path
import os,json,subprocess
assert os.geteuid()==0 and Path('/etc/pp-rig').read_text().strip()=='pp-private-providers'
R=Path('/home/rig/pp-launch-3');aid='pp-test-probe'
ids=subprocess.check_output(['docker','ps','-aq'],text=True).split();docs=json.loads(subprocess.check_output(['docker','inspect',*ids]))
main=[x for x in docs if any(m.get('Source')=='/home/rig/.wizard-os/agents/'+aid+'/home' and m.get('Destination')=='/opt/data' for m in x.get('Mounts',[])) and x['State']['Running']]
client=[x for x in docs if (x['Config'].get('Labels') or {}).get('com.docker.compose.service')=='agent-'+aid+'-client' and x['State']['Running']]
provider=[x for x in docs if (x['Config'].get('Labels') or {}).get('com.docker.compose.service')=='wizard-tinfoil' and x['State']['Running']]
assert len(main)==len(client)==len(provider)==1
vol=[x['Source'] for x in provider[0]['Mounts'] if x.get('Destination')=='/data'];assert len(vol)==1
base=['python3',str(R/'service/ops/private-provider-rig/checks/check.py'),'--agent',aid,'--provider-app','wizard-tinfoil','--hermes-container',main[0]['Id'],'--client-container',client[0]['Id'],'--provider-container',provider[0]['Id'],'--provider-data',vol[0],'--os-home','/home/rig/.wizard-os','--runtipi-root','/home/rig/runtipi','--evidence-dir',str(R/'privacy-evidence'),'--trigger',str(R/'trigger.sh'),'--codeword',(R/'codeword').read_text().strip(),'--key-sha256',(R/'key-sha256').read_text().strip(),'--timeout','240']
checks={}
for name in ['relay','hermes','client','key-location','stop-provider','codeword']:
 p=subprocess.run([*base,name],capture_output=True,text=True,timeout=900)
 log=R/('check-'+name+'.log');log.write_text(p.stdout+p.stderr);log.chmod(0o600)
 checks[name]='passed' if p.returncode==0 else 'failed';print('CHECK',name,checks[name],flush=True)
 if p.returncode:break
out={'checks':checks,'privacy_checks_passed':sum(v=='passed' for v in checks.values())};(R/'privacy.json').write_text(json.dumps(out,indent=2)+'\n');assert len(checks)==6 and all(v=='passed' for v in checks.values())
''',root=True,timeout=1800),flush=True)
elif phase=='baseline-resume':
 r.python("from pathlib import Path;import sys;Path('/home/rig/pp-launch-3/guest.py').write_bytes(sys.stdin.buffer.read())",payload=(L/'rehearse-guest.py').read_bytes())
 for step in [['baseline-prepare'],['chat','pp-test-legacy']]:print(run_guest(step),flush=True)
elif phase=='baseline-all':
 r.python("from pathlib import Path;import sys;Path('/home/rig/pp-launch-3/guest.py').write_bytes(sys.stdin.buffer.read())",payload=(L/'rehearse-guest.py').read_bytes())
 print(r.run(['python3','/home/rig/pp-launch-3/guest.py','key'],payload=sys.stdin.buffer.read()),flush=True)
 for step in [['baseline'],['chat','pp-test-legacy']]:print(r.run(['python3','/home/rig/pp-launch-3/guest.py',*step],timeout=900),flush=True)
elif phase=='key':print(r.run(['python3','/home/rig/pp-launch-3/guest.py','key'],payload=sys.stdin.buffer.read()),flush=True)
else:
 r.python("from pathlib import Path;import sys;Path('/home/rig/pp-launch-3/guest.py').write_bytes(sys.stdin.buffer.read())",payload=(L/'rehearse-guest.py').read_bytes())
 r.python("from pathlib import Path;import sys;Path('/home/rig/pp-launch-3/local_projection.py').write_bytes(sys.stdin.buffer.read())",payload=(L/'local_projection.py').read_bytes())
 print(r.run(['python3','/home/rig/pp-launch-3/guest.py',phase,*sys.argv[2:]],timeout=900),flush=True)
