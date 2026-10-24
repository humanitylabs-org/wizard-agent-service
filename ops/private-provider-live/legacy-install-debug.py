"""No-key diagnostic and real install attempt on pp-rig under one lease."""
from pathlib import Path
import importlib.util,subprocess,sys,json
L=Path('/Volumes/ThalesMedia/AI-Wizards/private-providers/pp-launch/live')
s=importlib.util.spec_from_file_location('prep',L/'rig-prepare.py');assert s and s.loader;m=importlib.util.module_from_spec(s);s.loader.exec_module(m);r=m.Rig(L.parents[1])
try:
 raw=r.python("from pathlib import Path;assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers';assert not Path('/home/rig/pp-launch-3/legacy-key.env').exists();p=Path('/home/rig/pp-launch-3/phase-install.log');print(p.read_text() if p.exists() else '')")
 print('PREVIOUS_INSTALL',m.redact_diagnostic(raw),flush=True)
 try:
  print(r.python("from pathlib import Path;import sys,json;sys.path.insert(0,'/opt/pp-rig/src/wam');from wam import cli;rt=cli.Config().runtipi();v=rt.req('GET','/user-config/wizard-tinfoil_private:wizardapps');print(json.dumps({'compose_template':v.get('dockerCompose'),'app_env_names':[x.split('=',1)[0] for x in (v.get('appEnv') or '').splitlines() if x.strip() and not x.lstrip().startswith('#')]}))"),flush=True)
 except Exception as e:print('PRIOR_CONFIG_UNAVAILABLE',m.redact_diagnostic(type(e).__name__+': '+str(e)),flush=True)
 p=subprocess.run([sys.executable,str(L/'rig-rehearse-3.py'),'install'],capture_output=True)
 print('NO_KEY_INSTALL_EXIT',p.returncode,flush=True)
 if p.returncode:
  raw=r.python("from pathlib import Path;p=Path('/home/rig/pp-launch-3/phase-install.log');print(p.read_text() if p.exists() else '')")
  print(m.redact_diagnostic(raw),flush=True)
 else:print(p.stdout.decode(),flush=True)
finally:subprocess.run([sys.executable,str(L/'rig-reset-3.py')],check=True)
