#!/usr/bin/env python3
"""pp-legacy-fix: guarded guest script driver, shared lock supplied by caller."""
import importlib.util,sys
from pathlib import Path
L=Path('/Volumes/ThalesMedia/AI-Wizards/private-providers/pp-launch/live')
s=importlib.util.spec_from_file_location('prep',L/'rig-prepare.py');assert s and s.loader
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
p=L/sys.argv[1];assert p.parent==L
args=[str(p.name),*[a for a in sys.argv[2:] if a!='--root']]
# Preserve failures privately: Rig.run intentionally withholds guest stderr.
code='import sys;sys.argv='+repr(args)+'\n'+p.read_text()
wrapper="""import subprocess,sys,os,json
from pathlib import Path
r=Path('/home/rig/pp-launch-3');assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers'
source=r/"""+repr('run-'+p.name)+""";source.write_text("""+repr(code)+""");source.chmod(0o600)
p=subprocess.run(['python3',str(source)],input=sys.stdin.buffer.read(),capture_output=True)
log=r/"""+repr(p.name+'.log')+""";log.write_bytes(p.stdout+p.stderr);log.chmod(0o600)
print(p.stdout.decode() if p.returncode==0 else 'FAILED; private guest log: '+str(log))
print('RETURN_CODE='+str(p.returncode))
"""
output=m.Rig(L.parents[1]).python(wrapper,root='--root' in sys.argv,payload=sys.stdin.buffer.read(),timeout=1800)
text,sep,rc=output.rpartition('RETURN_CODE=');print(text,flush=True);assert sep
sys.exit(int(rc.strip()))
