"""No-key diagnostic and real install attempt on pp-rig under one lease."""
from pathlib import Path
import importlib.util,subprocess,sys,json,hashlib
L=Path('/Volumes/ThalesMedia/AI-Wizards/private-providers/pp-launch/live')
s=importlib.util.spec_from_file_location('prep',L/'rig-prepare.py');assert s and s.loader;m=importlib.util.module_from_spec(s);s.loader.exec_module(m);r=m.Rig(L.parents[1])
receipt={'lane':'pp-install-fix','mode':'no-key-install','status':'blocked','key_supplied':False,'wam_cli_archive_sha256':hashlib.sha256((L/'wam-cli.tar').read_bytes()).hexdigest()}
receipt['service_engine_fix']=json.loads((L/'SERVICE-ENGINE-FIX.json').read_text())
try:
 r.python("from pathlib import Path;assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers';assert not Path('/home/rig/pp-launch-3/legacy-key.env').exists()")
 subprocess.run([sys.executable,str(L/'rig-rehearse-3.py'),'setup-resume'],check=True)
 p=subprocess.run([sys.executable,str(L/'rig-rehearse-3.py'),'install'],capture_output=True)
 receipt['install_exit_code']=p.returncode;print('NO_KEY_INSTALL_EXIT',p.returncode,flush=True)
 if p.returncode:
  raw=r.python("from pathlib import Path;p=Path('/home/rig/pp-launch-3/phase-install.log');print(p.read_text() if p.exists() else '')")
  receipt['diagnostic']=m.redact_diagnostic(raw);print(receipt['diagnostic'],flush=True)
  raw=r.python("import subprocess;p=subprocess.run(['docker','logs','--since','4m','runtipi'],capture_output=True);print((p.stdout+p.stderr).decode(errors='replace'))")
  for line in raw.splitlines():
   if any(x in line.lower() for x in ['error','failed','wizard-tinfoil']):print(m.redact_diagnostic('RuntimeError: '+line),flush=True)
 else:
  print(p.stdout.decode(),flush=True)
  raw=r.python("import json;from pathlib import Path;r=Path('/home/rig/pp-launch-3');print(json.dumps({n:json.loads((r/(n+'.json')).read_text()) for n in ['install','install-api-template']}))")
  receipt['evidence']=json.loads(raw)
  r.python((L/'reconcile-no-key.py').read_text())
  receipt['reconciliation_passed']=True;receipt['status']='passed'
except Exception as e:
 receipt['diagnostic']=m.redact_diagnostic(type(e).__name__+': '+str(e));print(receipt['diagnostic'],flush=True)
finally:
 p=subprocess.run([sys.executable,str(L/'rig-reset-3.py')],capture_output=True)
 print(p.stdout.decode() if not p.returncode else m.redact_diagnostic(p.stdout+p.stderr),flush=True)
 if p.returncode:receipt['status']='blocked';receipt['reset_error']=m.redact_diagnostic(p.stdout+p.stderr)
 else:receipt['reset']=json.loads((L/'RESET-3.json').read_text())
 (L/'NO-KEY-INSTALL.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt,indent=2),flush=True)
sys.exit(0 if receipt['status']=='passed' else 1)
