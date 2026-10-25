#!/usr/bin/env python3
"""Build real owner systemd selections in the marked disposable guest."""
import json,os,shutil,signal,subprocess,tarfile,time
from pathlib import Path
assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers' and os.geteuid()==1000
H=Path('/home/rig');R=H/'pp-launch-3';B=H/'pp-live-assets';U=H/'.config/systemd/user';U.mkdir(parents=True,exist_ok=True)
env=dict(os.environ,XDG_RUNTIME_DIR='/run/user/1000',DBUS_SESSION_BUS_ADDRESS='unix:path=/run/user/1000/bus');os.environ.update(env)
def run(args,**kw):
 p=subprocess.run(args,capture_output=True,**kw)
 if p.returncode:raise RuntimeError('bootstrap failed '+args[0]+' output withheld')
 return p.stdout
run(['sudo','loginctl','enable-linger','rig']);run(['sudo','systemctl','start','user@1000.service'])
# Stop only the exact processes started by the accepted fixture bootstrap.
pids=json.loads((R/'pids.json').read_text())
for pid in pids.values():
 p=Path('/proc')/str(pid)/'cmdline'
 if p.exists():assert str(R/'service') in p.read_text();os.kill(pid,signal.SIGTERM)
time.sleep(2);(R/'pids.json').unlink()
base='4be54416627ab3f578a951166a084e459e9edd9c'
store=H/'.local/share/wizard-mobile-server/releases';store.mkdir(parents=True,exist_ok=True)
serial=str(time.time_ns());service=store/('baseline-'+serial);service.mkdir()
with tarfile.open(B/'baseline-service.tar') as tf:tf.extractall(service,filter='data')
run(['npm','ci','--omit=dev','--no-audit','--no-fund'],cwd=service)
for store_name,src in [('wizard-mobile-server',service),('wizard-agent-runtime',service/'ops/agent-runtime')]:
 root=H/'.local/share'/store_name;root.mkdir(parents=True,exist_ok=True)
 if store_name=='wizard-agent-runtime':
  dst=root/'releases'/('baseline-'+serial);dst.parent.mkdir(exist_ok=True);shutil.copytree(src,dst)
 else:dst=src
 (dst/'RELEASE_SHA').write_text(base+'\n');(dst/'SOURCE_REPO').write_text('https://github.com/humanitylabs-org/wizard-agent-service.git\n')
 p=root/'current';p.unlink(missing_ok=True);p.symlink_to(dst)
wams=H/'.local/share/wam-fixture/releases'/serial;wams.mkdir(parents=True)
with tarfile.open(B/'wam-baseline.tar') as tf:tf.extractall(wams,filter='data')
launcher=H/'.local/bin/wam';launcher.parent.mkdir(parents=True,exist_ok=True);launcher.write_text('#!/bin/sh\nexport PYTHONDONTWRITEBYTECODE=1\ncd "'+str(wams/'cli')+'" && exec /usr/bin/python3 -m wam "$@"\n');launcher.chmod(0o755)
ux=H/'apps/wizard-os-home/web';ux.parent.mkdir(parents=True,exist_ok=True)
if ux.is_symlink():ux.unlink()
elif ux.exists():shutil.rmtree(ux)
shutil.copytree(B/'candidate/ux',ux)
(H/'apps/wizard-mobile/.ui-live').mkdir(parents=True,exist_ok=True);(H/'apps/wizard-mobile/.ui-live/index.html').write_text('Legacy wrapper fixture, unchanged by UX source rollout\n')
common='[Unit]\nDescription=Private-provider acceptance fixture\n[Service]\nType=simple\nRestart=no\nEnvironment=HOME=/home/rig\nEnvironment=RUNTIPI_ROOT=/home/rig/runtipi\nEnvironment=WIZARD_OS_HOME=/home/rig/.wizard-os\nUnsetEnvironment=WIZARD_AGENT_ISOLATION WIZARD_AGENT_HOST WIZARD_AGENT_PORT\nEnvironment=PYTHONDONTWRITEBYTECODE=1\n'
(U/'wizard-mobile.service').write_text(common+'WorkingDirectory='+str(R/'service')+'\nEnvironmentFile=/opt/pp-rig/service.env\nEnvironment=WIZARD_AGENT_RUNTIME_URL=http://127.0.0.1:7795\nEnvironment=WIZARD_UX_DIR='+str(ux)+'\nExecStart=/usr/local/bin/node '+str(H/'.local/share/wizard-mobile-server/current/server/index.mjs')+'\n')
(U/'wizard-agent-runtime.service').write_text(common+'WorkingDirectory='+str(R/'service')+'\nExecStart=/usr/bin/python3 '+str(H/'.local/share/wizard-agent-runtime/current/agent_runtime.py')+' --driver runtipi --wam '+str(wams/'runtime')+' --agents-dir '+str(H/'.wizard-os/agents')+' --token-file '+str(H/'.wizard-os/agent-runtime/token')+' --tinfoil-key-file '+str(R/'legacy-key.env')+' --port 7795 --home-mount alongside\n')
(U/'wizard-app-manager-api.service').write_text(common+'WorkingDirectory='+str(wams/'api')+'\nExecStart=/usr/bin/python3 -m wam serve\n')
(U/'wizard-app-manager-api.service.d').mkdir(exist_ok=True);(U/'wizard-app-manager-api.service.d/connection-fork-registry.conf').write_text('[Service]\nWorkingDirectory='+str(wams/'api')+'\n')
p=U/'wizard-agent-runtime.service.d/99-pp-launch-wam.conf';p.unlink(missing_ok=True)
# This creates/stops only real owner services in pp-rig; none on the VPS.
run(['systemctl','--user','daemon-reload']);run(['systemctl','--user','start','wizard-app-manager-api','wizard-agent-runtime','wizard-mobile'])
import urllib.request
for origin,path in [('http://127.0.0.1:8787','/wizard/health'),('http://127.0.0.1:7790','/healthz'),('http://127.0.0.1:7795','/healthz')]:
 deadline=time.monotonic()+60
 while True:
  try:
   q=urllib.request.Request(origin+path,headers={'x-wizard-owner-proof':(H/'.wizard-os/agent-runtime/owner-proof').read_text().strip()})
   with urllib.request.urlopen(q,timeout=3) as response:assert response.status==200
   break
  except Exception:
   if time.monotonic()>deadline:raise RuntimeError('real owner unit did not become ready: '+origin)
   time.sleep(1)
print('REAL_OWNER_SELECTIONS_STARTED')
