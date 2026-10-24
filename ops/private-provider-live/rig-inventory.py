#!/usr/bin/env python3
"""Read-only guest discovery; save non-secret scripts before any reset."""
import base64, hashlib, io, json, os, subprocess, tarfile
from pathlib import Path
ROOT = Path('/Volumes/ThalesMedia/AI-Wizards/private-providers')
DEST = ROOT / 'pp-launch/live/guest-saved'
SCRIPT = r'''
from pathlib import Path
import os,json,hashlib,subprocess,tarfile,io,base64
assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers'
assert os.geteuid()==1000
H=Path('/home/rig'); R=H/'runtipi'; O=Path('/opt/pp-rig')
files=[p for p in O.glob('*') if p.is_file() and p.suffix in ['.py','.sh']]
files += [p for p in (O/'checks').glob('*') if p.is_file() and p.suffix in ['.py','.sh']]
files += [p for p in H.glob('*') if p.is_file() and p.suffix in ['.py','.sh']]
if (H/'pp-candidates').is_dir():
 files += [p for p in (H/'pp-candidates').rglob('*') if p.is_file() and p.suffix in ['.py','.sh'] and not any(x in p.parts for x in ['.git','node_modules','.venv'])]
buf=io.BytesIO()
with tarfile.open(fileobj=buf,mode='w') as t:
 for p in sorted(set(files)):t.add(p,arcname=str(p).lstrip('/'),recursive=False)
c=json.loads(subprocess.check_output(['docker','inspect','runtipi']))[0]
out={'uid':os.geteuid(),'gid':os.getgid(),'marker':'pp-private-providers','pp_candidates_present':(H/'pp-candidates').exists(),'saved_scripts':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(set(files))},'ownership':{n:{'uid':(R/n).stat().st_uid,'gid':(R/n).stat().st_gid,'mode':oct((R/n).stat().st_mode&0o777),'writable':os.access(R/n,os.W_OK)} for n in ['user-config','app-data','apps','state']},'runtipi':{'image':c['Config']['Image'],'image_id':c['Image'],'running':c['State']['Running']},'wam_main_sha256':subprocess.check_output(['docker','exec','runtipi','sha256sum','/app/main.mjs'],text=True).split()[0],'containers':subprocess.check_output(['docker','ps','--format','{{.Names}}'],text=True).splitlines(),'units':subprocess.run(['systemctl','is-active','pp-agent-service','pp-agent-runtime'],capture_output=True,text=True).stdout.splitlines(),'archive':base64.b64encode(buf.getvalue()).decode()}
print(json.dumps(out))
'''
env = dict(os.environ, LIMA_HOME=str(ROOT/'rig/lima'))
p = subprocess.run(['/opt/homebrew/bin/limactl','shell','--workdir','/home/rig','pp-rig','--','python3','-c',SCRIPT],env=env,capture_output=True,text=True,check=True,timeout=60)
data = json.loads(p.stdout)
archive = base64.b64decode(data.pop('archive'))
DEST.mkdir(parents=True,exist_ok=True)
with tarfile.open(fileobj=io.BytesIO(archive)) as tf:
    tf.extractall(DEST, filter='data')
(DEST/'INVENTORY.json').write_text(json.dumps(data,indent=2)+'\n')
print(json.dumps(data,indent=2))
