#!/usr/bin/env python3
"""Durable-worker-only pp-rig source/WAM/ownership parity preparation.

No provider key is accepted; no paid inference or acceptance claim is made.
Run without nesting run-locked.py: durable admission owns the same lock.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

DEFAULT_ROOT = Path('/Volumes/ThalesMedia/AI-Wizards/private-providers')
GUEST = '/home/rig/pp-launch-2'
WAM = 'ghcr.io/humanitylabs-org/wizard-app-manager@sha256:07df73e79ee3bea5465cd27d90f99191317075e7a669678a8d066c51473d4116'
CLIENT = 'ghcr.io/humanitylabs-org/wizard-private-client:0.1.0@sha256:c562bef2166e6e1054be8eed34229cf0ead4574002da28f8fe5d4f09ad0e6631'
WAM_MAIN = '6e2b3e410f1e54fce473452d79102edc3c11e36ae69237e4ab232e8f43ebef42'
ARCHIVES = ('service.tar', 'ux.tar', 'tinfoil-relay.tar')


def validate(root):
    root = root.resolve()
    if root != DEFAULT_ROOT:
        raise ValueError('only the existing pp-rig project is authorized')
    live = root / 'pp-launch/live'
    manifest = json.loads((live/'SOURCE-MANIFEST.json').read_text())
    inventory = json.loads((live/'guest-saved/INVENTORY.json').read_text())
    if inventory['marker'] != 'pp-private-providers' or inventory['uid'] != 1000:
        raise ValueError('pre-reset guest inventory missing')
    for name in ARCHIVES:
        data = (live/'sources'/name).read_bytes()
        if hashlib.sha256(data).hexdigest() != manifest[name]['sha256']:
            raise ValueError('source archive drift: '+name)
    parity = json.loads((live/'live-ownership.json').read_text())
    if parity['uid'] != 1000:
        raise ValueError('live owner uid mismatch')
    for row in parity['rows']:
        p = Path(row['path'])
        if p.is_absolute() or '..' in p.parts or row.get('symlink'):
            raise ValueError('unsafe parity path')
    return live, manifest, parity


class Rig:
    def __init__(self, root):
        self.env = dict(os.environ, LIMA_HOME=str(root/'rig/lima'))
    def run(self, args, payload=None, timeout=1800):
        argv = ['/opt/homebrew/bin/limactl','shell','--workdir','/home/rig','pp-rig','--',*args]
        p = subprocess.run(argv, input=payload, capture_output=True, env=self.env, timeout=timeout)
        if p.returncode:
            # Docker/Compose diagnostics can include environment; don't echo them.
            raise RuntimeError('guest command failed: '+args[0]+'; output withheld')
        return p.stdout.decode()
    def python(self, script, root=False, payload=None, timeout=1800):
        return self.run((['sudo'] if root else [])+['python3','-c',script],payload,timeout)
    def put(self, target, content):
        assert str(target).startswith(GUEST+'/')
        self.python('from pathlib import Path;import sys; p=Path('+repr(str(target))+'); p.write_bytes(sys.stdin.buffer.read()); p.chmod(0o600)',payload=content)


ROOT_SETUP = r'''
from pathlib import Path
import json,os,subprocess
assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers' and os.geteuid()==0
H=Path('/home/rig'); R=H/'runtipi'; L=H/'pp-launch-2'
# Setup-only elevation: actual install/migration remains uid1000.
for row in json.loads((L/'live-ownership.json').read_text())['rows']:
 p=R/row['path']
 if row.get('absent'):
  assert not p.exists(), 'unexpected fixture path'
  continue
 assert not p.is_symlink()
 if row['directory']:p.mkdir(parents=True,exist_ok=True)
 assert p.exists()
 os.chown(p,row['uid'],row['gid']);p.chmod(row['mode'])
print('OWNERSHIP_SETUP_ONLY')
'''
OWNER_VERIFY = r'''
from pathlib import Path
import json,os,subprocess
assert os.geteuid()==1000
H=Path('/home/rig');R=H/'runtipi';L=H/'pp-launch-2'
rows=[]
for row in json.loads((L/'live-ownership.json').read_text())['rows']:
 p=R/row['path']
 if row.get('absent'):
  assert not p.exists();continue
 s=p.stat();w=os.access(p,os.W_OK)
 assert not p.is_symlink()
 assert (s.st_uid,s.st_gid,s.st_mode&0o7777,w)==(row['uid'],row['gid'],row['mode'],row['writable']), row['path']
 rows.append({'path':row['path'],'uid':s.st_uid,'gid':s.st_gid,'mode':s.st_mode&0o7777,'writable':w})
c=json.loads(subprocess.check_output(['docker','inspect','runtipi']))[0]
out={'installer_uid':os.geteuid(),'ownership':rows,'wam_image_id':c['Image'],'wam_image':c['Config']['Image'],'wam_main_sha256':subprocess.check_output(['docker','exec','runtipi','sha256sum','/app/main.mjs'],text=True).split()[0],'provider_key_present':(H/'.wizard-os/agent-runtime/tinfoil.env').exists(),'apps':json.loads((H/'.wizard-os/apps.json').read_text()).get('apps',[]),'provider_volumes':[n for n in subprocess.check_output(['docker','volume','ls','--format','{{.Name}}'],text=True).splitlines() if 'tinfoil' in n],'br_netfilter_present':Path('/sys/module/br_netfilter').exists()}
print(json.dumps(out))
'''


def prepare(root):
    live, manifest, parity = validate(root)
    report = {'lane':'pp-rehearsal-2','status':'blocked','started_at':time.time(),
              'scope':'preparation only; acceptance checks not run','source':manifest}
    rig = Rig(root)
    output = live/'RIG-PREPARATION.json'
    try:
        rig.python(r"""
from pathlib import Path
import os,json,subprocess
assert os.geteuid()==1000
assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers'
h=Path('/home/rig');assert not (h/'.wizard-os/agent-runtime/tinfoil.env').exists()
p=h/'.wizard-os/apps.json'; assert not p.exists() or not json.loads(p.read_text()).get('apps',[])
assert not any('tinfoil' in n for n in subprocess.check_output(['docker','volume','ls','--format','{{.Name}}'],text=True).splitlines())
""")
        rig.python("from pathlib import Path;import os;assert os.geteuid()==1000;assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers';p=Path("+repr(GUEST)+");p.mkdir(exist_ok=True);p.chmod(0o700)")
        for name in ARCHIVES:
            rig.put(GUEST+'/'+name,(live/'sources'/name).read_bytes())
        rig.put(GUEST+'/live-ownership.json',json.dumps(parity).encode())
        report['sources_copied'] = True
        # amd64 is deliberate: live digest is amd64; guest has Rosetta binfmt.
        rig.run(['docker','pull','--platform','linux/amd64',WAM],timeout=1200)
        rig.run(['docker','pull',CLIENT],timeout=1200)
        script = r'''
from pathlib import Path
import os,subprocess,yaml
assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers' and os.geteuid()==0
r=Path('/home/rig/runtipi');p=r/'user-config/tipi-compose.yml'
x=yaml.safe_load(p.read_text()) if False else None
# Preserve the exact existing reverse-proxy !override; alter only runtipi image.
s=p.read_text();s=s.replace('image: ghcr.io/humanitylabs-org/wizard-app-manager:latest','image: WAM_IMAGE')
assert 'WAM_IMAGE' in s or WAM_VALUE in s
s=s.replace('WAM_IMAGE',WAM_VALUE)
s=s.replace('    pull_policy: if_not_present','    platform: linux/amd64\n    pull_policy: never')
p.write_text(s)
cmd=['docker','compose','--env-file',str(r/'.env'),'-f',str(r/'docker-compose.yml'),'-f',str(p)]
subprocess.run(cmd+['config','--quiet'],cwd=r,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
subprocess.run(cmd+['up','-d','--no-deps','runtipi'],cwd=r,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
'''.replace('WAM_VALUE',repr(WAM))
        rig.python(script,root=True)
        # Retrying a failed parity run must not redo a running acceptance session.
        rig.python(ROOT_SETUP,root=True)
        state = json.loads(rig.python(OWNER_VERIFY))
        assert state['wam_image_id'] == WAM.split('@')[1]
        assert state['wam_main_sha256'] == WAM_MAIN
        assert not state['provider_key_present'] and not state['provider_volumes'] and not state['apps']
        report.update(state)
        report['status'] = 'prepared'
        report['blockers'] = ['Exact-pinned Service/runtime/UX not deployed; six privacy checks, migration and regression pending.']
    except Exception as exc:
        report['failure'] = type(exc).__name__+': '+str(exc)
        raise
    finally:
        report['finished_at'] = time.time()
        output.write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report,indent=2))
    return 0


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--project-root',type=Path,default=DEFAULT_ROOT)
    parser.add_argument('--validate',action='store_true')
    args = parser.parse_args()
    if args.validate:
        validate(args.project_root)
        print('VALIDATED: immutable sources and saved guest scripts; no VM mutation')
        return 0
    if sys.platform != 'darwin':
        parser.error('execution requires the admitted Thales worker')
    return prepare(args.project_root)

if __name__ == '__main__':
    sys.exit(main())
