#!/usr/bin/env python3
"""Generate the parent-only plan from local artifacts and read-only unit discovery."""
import argparse,hashlib,json,os
from pathlib import Path
from production_adapter import runtime_argv
from production_readiness import code_hashes

def main():
 p=argparse.ArgumentParser(__doc__);p.add_argument('--root',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();root=a.root.resolve();tools=Path(__file__).parent
 assets=json.loads((root/'assets-2/assets.json').read_text());argv=runtime_argv()
 def flag(name,default=None):return argv[argv.index(name)+1] if name in argv else default
 plan={**assets,'schema':1,'home':str(Path.home()),'no_drain':True,'migration_agent':'private','rollback_scope':'attempt','python_only_wam':True,'runtipi_daemon_unchanged':True,'service_origin':'http://127.0.0.1:8923','owner_proof_file':str(Path.home()/'.config/private-gateway/owner-proof'),'runtime_origin':'http://127.0.0.1:'+flag('--port','7795'),'runtime_auth_file':flag('--token-file'),'legacy_source':flag('--tinfoil-key-file'),'check_file':str(root.parent/'service/ops/private-provider-rig/checks/check.py'),'tooling_sha256':code_hashes(tools)}
 for name in ['wam','provider','provider_image']:
  src=root/'assets-2'/Path(plan[name+'_archive']).name
  assert src.is_file() and hashlib.sha256(src.read_bytes()).hexdigest()==plan[name+'_archive_sha256'],'local artifact does not match receipt'
  plan[name+'_archive']=str(src)
 required=('snapshot','stage','deploy','install','privacy','regression','migrate','verify','rollback')
 plan['commands']={op:['/usr/bin/python3',str(tools/('stage-candidate.py' if op=='stage' else 'production_adapter.py'))]+([] if op=='stage' else [op]) for op in required}
 assert plan['runtime_auth_file'] and plan['legacy_source']
 a.output.write_text(json.dumps(plan,indent=2)+'\n');a.output.chmod(0o600);print(json.dumps({'plan':str(a.output),'sha256':hashlib.sha256(a.output.read_bytes()).hexdigest(),'python_only_wam':True,'runtipi_daemon_unchanged':True}))
if __name__=='__main__':main()
