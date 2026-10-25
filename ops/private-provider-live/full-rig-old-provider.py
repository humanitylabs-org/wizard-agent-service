"""Mirror James's existing canonical provider before testing provider replacement."""
import json,os,sys,tarfile,shutil
from pathlib import Path
import yaml
import subprocess
OLD_IMAGE='sha256:012e8b936f0f1b9207f268ef39fdee06712a25c6f883b4cfdf5c610a97fc0d19'
assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers' and os.geteuid()==1000
H=Path('/home/rig');B=H/'pp-live-assets';S=B/'old-provider'
subprocess.run(['docker','image','load','-i',str(B/'old-provider-runtime.tar.gz')],check=True,capture_output=True)
assert json.loads(subprocess.check_output(['docker','image','inspect',OLD_IMAGE]))[0]['Id']==OLD_IMAGE
with tarfile.open(B/'old-provider.tar') as tf:tf.extractall(S,filter='data')
sys.path.insert(0,'/opt/pp-rig/src/wam');from wam import cli
c=cli.Config();rt=c.runtipi();urn='wizard-tinfoil:wizardapps'
assert not any((x.get('info') or {}).get('urn')==urn for x in rt.installed())
dst=H/'runtipi/repos/wizardapps/apps/wizard-tinfoil'
if dst.exists():shutil.rmtree(dst)
(dst/'metadata').mkdir(parents=True)
comp=yaml.safe_load((S/'runtipi/docker-compose.yml').read_text());svc=comp['services']['wizard-tinfoil'];svc.update(image=OLD_IMAGE,pull_policy='never');assert svc.pop('volumes')==['tinfoil-private-data:/data'];comp.pop('volumes');svc['ports']=['127.0.0.1:${APP_PORT}:18804']
for n,raw in [('wizard.md',(S/'wizard.md').read_text()),('config.json',(S/'runtipi/config.json').read_text()),('docker-compose.yml',yaml.safe_dump(comp)),('.wizard-commit','cbfa896fdd1d484f9c96c44d8b5ad7c20dc3474e\n'),('.wizard-source',json.dumps({'repo':'local:wizard-tinfoil','private':True}))]:(dst/n).write_text(raw)
shutil.copy2(S/'runtipi/metadata/logo.jpg',dst/'metadata/logo.jpg');(dst/'metadata/description.md').write_text('Canonical pre-launch provider fixture\n')
override='services:\n  wizard-tinfoil:\n    volumes:\n      - tinfoil-private-data:/data\nvolumes:\n  tinfoil-private-data:\n    name: wizard-tinfoil-private-data\n'
rt.req('PUT','/user-config/'+urn,{'dockerCompose':override,'appEnv':''});after=rt.req('GET','/user-config/'+urn);assert after['dockerCompose'].rstrip('\n')==override.rstrip('\n')
rt.install(urn,{'openPort':False,'exposed':False,'exposedLocal':False,'port':18804,'WIZARD_TRUSTED_HOSTS':'127.0.0.1:18804,localhost:18804','WIZARD_TRUSTED_ORIGINS':'http://127.0.0.1:18804','HERMES_DASHBOARD_BASIC_AUTH_PASSWORD':'relay-only-unused-local-value'})
assert rt.wait_status(urn,{'running','stopped'},timeout=180)=='running'
cli.write_registry(c,rt);print('CANONICAL_PROVIDER_RUNNING_BEFORE_REPLACEMENT')
