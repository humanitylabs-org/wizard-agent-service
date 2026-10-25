#!/usr/bin/env python3
"""Credential/container cleanup for pp-rehearsal-3; pp-rig only, under worker lock."""
import importlib.util
import json
from pathlib import Path

ROOT=Path('/Volumes/ThalesMedia/AI-Wizards/private-providers')
LIVE=ROOT/'pp-launch/live'
spec=importlib.util.spec_from_file_location('prepare',LIVE/'rig-prepare.py')
assert spec and spec.loader
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
rig=module.Rig(ROOT)
result=json.loads(rig.python(r'''
from pathlib import Path
import json,os,signal,subprocess,shutil,sys,time
assert os.geteuid()==0 and Path('/etc/pp-rig').read_text().strip()=='pp-private-providers'
h=Path('/home/rig');r=h/'pp-launch-3';os.environ['HOME']=str(h)
sys.path.insert(0,'/opt/pp-rig/src/wam')
from wam import cli
rt=cli.Config().runtipi()
installed=rt.installed()
urns=[str((row.get('info') or {}).get('urn','')) for row in installed]
selected=[u for u in urns if u.split(':')[0].startswith('agent-pp-test-') or u in ['wizard-tinfoil_private:wizardapps','wizard-tinfoil:wizardapps'] or u.split(':')[0].startswith('agent-pp-live-')]
for urn in selected:
 rt.uninstall(urn,remove_backups=True)
 assert rt.wait_status(urn,{'missing'},timeout=180)=='missing'
pids=json.loads((r/'pids.json').read_text()) if (r/'pids.json').exists() else {}
for pid in pids.values():
 proc=Path('/proc')/str(pid)
 try:cmd=proc.joinpath('cmdline').read_text()
 except FileNotFoundError:continue
 assert str(r/'service') in cmd,'refusing an unowned PID'
 os.kill(pid,signal.SIGTERM)
time.sleep(2)
ids=subprocess.check_output(['docker','ps','-aq'],text=True).split()
docs=json.loads(subprocess.check_output(['docker','inspect',*ids])) if ids else []
def synthetic(doc):
 labels=doc['Config'].get('Labels') or {}
 return labels.get('com.docker.compose.project') in {p for aid in ['pp-test-legacy','pp-test-probe','pp-test-other'] for p in ['agent-'+aid,'agent-'+aid+'_wizardapps']} or labels.get('com.docker.compose.service','').startswith(('agent-pp-test-','agent-pp-live-')) or any(m.get('Source','').startswith(('/home/rig/.wizard-os/agents/pp-test-','/home/rig/.wizard-os/agents/pp-live-')) for m in doc.get('Mounts',[]))
remove=[doc['Id'] for doc in docs if synthetic(doc) or (doc['Config'].get('Labels') or {}).get('com.docker.compose.service')=='wizard-tinfoil']
if remove:subprocess.run(['docker','rm','-f',*remove],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
volumes=[n for n in subprocess.check_output(['docker','volume','ls','--format','{{.Name}}'],text=True).splitlines() if 'tinfoil' in n]
for volume in volumes:subprocess.run(['docker','volume','rm',volume],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
roots=[h/'.wizard-os/agents',h/'runtipi/apps',h/'runtipi/app-data',h/'runtipi/user-config',h/'runtipi/user-config/wizardapps',h/'runtipi/app-data/wizardapps',h/'runtipi/apps/wizardapps',h/'runtipi/repos/wizardapps/apps']
for base in roots:
 if not base.exists():continue
 for target in base.iterdir():
  if target.name.startswith(('pp-test-','agent-pp-test-','pp-live-','agent-pp-live-')) or target.name in ['wizard-tinfoil_private','wizard-tinfoil_private:wizardapps','wizard-tinfoil','wizard-tinfoil:wizardapps']:
   assert target.parent==base
   if target.is_symlink():target.unlink()
   elif target.is_dir():shutil.rmtree(target)
   else:target.unlink()
for path in [r/'legacy-key.env',r/'key-sha256',h/'.wizard-os/agent-runtime/tinfoil.env']:
 path.unlink(missing_ok=True)
# Packet captures contain relay bearer tokens; retain only sanitized checker logs.
for path in (r/'privacy-evidence').glob('*.pcap'):
 assert path.parent==r/'privacy-evidence';path.unlink()
code="from wam import cli; c=cli.Config();cli.write_registry(c,c.runtipi())"
registry_reset=subprocess.run(['sudo','-u','rig','env','HOME=/home/rig','PYTHONPATH=/opt/pp-rig/src/wam','python3','-c',code],capture_output=True)
if registry_reset.returncode:
 log=r/'reset-registry.log';log.write_bytes(registry_reset.stdout+registry_reset.stderr);log.chmod(0o600)
 errors=[x for x in registry_reset.stderr.decode(errors='replace').splitlines() if x.startswith(('ImportError:','ModuleNotFoundError:','PermissionError:','FileNotFoundError:','AttributeError:','TypeError:','ValueError:'))]
 raise RuntimeError('registry reset failed: '+(errors[-1] if errors else 'see private reset-registry.log'))
key_paths=[r/'legacy-key.env',h/'.wizard-os/agent-runtime/tinfoil.env']
remaining=[n for n in subprocess.check_output(['docker','volume','ls','--format','{{.Name}}'],text=True).splitlines() if 'tinfoil' in n]
apps=json.loads((h/'.wizard-os/apps.json').read_text()).get('apps',[])
ids=subprocess.check_output(['docker','ps','-aq'],text=True).split()
docs=json.loads(subprocess.check_output(['docker','inspect',*ids])) if ids else []
key_in_env=any(any(item.startswith('TINFOIL_API_KEY=') and item.split('=',1)[1] for item in doc['Config'].get('Env',[])) for doc in docs)
result={'provider_key_present':any(p.exists() for p in key_paths) or key_in_env,'provider_volumes':remaining,'apps':len(apps),'remaining_synthetic_agent_dirs':[p.name for p in list((h/'.wizard-os/agents').glob('pp-test-*'))+list((h/'.wizard-os/agents').glob('pp-live-*'))],'remaining_synthetic_containers':[d['Name'] for d in docs if synthetic(d)],'reset_scope':'pp-rig / pp-rehearsal-3'}
assert result['provider_key_present'] is False and result['provider_volumes']==[] and result['apps']==0 and not result['remaining_synthetic_agent_dirs'] and not result['remaining_synthetic_containers'],result
p=r/'reset.json';p.write_text(json.dumps(result,indent=2)+'\n');p.chmod(0o600)
print(json.dumps(result))
''',root=True,timeout=600))
# Exact target readback, separately from the cleanup write.
readback=json.loads(rig.python("from pathlib import Path;assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers';print(Path('/home/rig/pp-launch-3/reset.json').read_text())",root=True))
assert readback==result
(LIVE/'RESET-FULL.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
