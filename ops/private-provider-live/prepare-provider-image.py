#!/usr/bin/env python3
"""Build/export the pinned amd64 provider interpreter inside the shared rig lease."""
import gzip,hashlib,importlib.util,json,subprocess,sys
from pathlib import Path
L=Path('/Volumes/ThalesMedia/AI-Wizards/private-providers/pp-launch/live');s=importlib.util.spec_from_file_location('prepare',L/'rig-prepare.py');assert s and s.loader;m=importlib.util.module_from_spec(s);s.loader.exec_module(m);r=m.Rig(L.parents[1]);A=L/'assets-2'
raw=r.python("""from pathlib import Path
import json,subprocess
assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers'
root=Path('/home/rig/pp-launch-3/tinfoil')
p=subprocess.run(['docker','build','--platform','linux/amd64','-t','pp-provider-runtime:07eca-amd64','-f','app/Dockerfile','.'],cwd=root,capture_output=True)
log=Path('/home/rig/pp-launch-3/provider-amd64-build.log');log.write_bytes(p.stdout+p.stderr);log.chmod(0o600)
assert p.returncode==0,'amd64 provider build failed; private build log retained'
d=json.loads(subprocess.check_output(['docker','image','inspect','pp-provider-runtime:07eca-amd64']))[0]
assert d['Architecture']=='amd64'
print(json.dumps({'id':d['Id'],'architecture':d['Architecture']}))
""",timeout=1200);image=json.loads(raw)
out=A/'provider-runtime.tar.gz';cmd=['/opt/homebrew/bin/limactl','shell','--workdir','/home/rig','pp-rig','--','docker','image','save',image['id']]
p=subprocess.Popen(cmd,env=r.env,stdout=subprocess.PIPE,stderr=subprocess.PIPE);assert p.stdout and p.stderr
try:
 with gzip.open(out,'wb',compresslevel=3) as sink:
  while chunk:=p.stdout.read(1048576):sink.write(chunk)
 err=p.stderr.read();assert p.wait(timeout=60)==0,'provider interpreter export failed'
finally:
 if p.poll() is None:p.kill();p.wait()
assert out.stat().st_size<=500_000_000,'control-plane compressed artifact exceeds bound'
assets=json.loads((A/'assets.json').read_text());assets.update(provider_image_archive=str(out),provider_image_archive_sha256=hashlib.sha256(out.read_bytes()).hexdigest(),provider_image_id=image['id']);(A/'assets.json').write_text(json.dumps(assets,indent=2)+'\n');print(json.dumps({'provider_image_id':image['id'],'archive_bytes':out.stat().st_size,'sha256':assets['provider_image_archive_sha256']}))
