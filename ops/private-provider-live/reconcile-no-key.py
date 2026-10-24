"""No-key provider reconciliation with a redacted host exception channel."""
import sys,json
from pathlib import Path
assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers'
R=Path('/home/rig/pp-launch-3');O=Path('/home/rig/.wizard-os')
assert not (R/'legacy-key.env').exists()
sys.path.insert(0,str(R/'service/ops/agent-runtime'))
import provider_egress,provider_container,http.client,io
original_run=provider_container.subprocess.run
def diagnostic_run(args,*a,**kw):
 result=original_run(args,*a,**kw)
 if args==['docker','system','dial-stdio']:
  class Socket:
   def makefile(self,*a):return io.BytesIO(result.stdout)
  try:
   response=http.client.HTTPResponse(Socket());response.begin()
   if response.status!=201:print('ValueError: DockerHTTP '+str(response.status)+' '+response.read().decode(errors='replace'),flush=True)
  except Exception as exc:print(type(exc).__name__+': Engine response parse failed',flush=True)
 return result
provider_container.subprocess.run=diagnostic_run
from agent_runtime import Agents
original=provider_egress.engine_create

def diagnostic_create(*args,**kwargs):
 try:return original(*args,**kwargs)
 except Exception as exc:
  print(type(exc).__name__+': '+str(exc),flush=True)
  raise
provider_egress.engine_create=diagnostic_create
failures=Agents(O/'agents',apps_path=O/'apps.json').providers.reconcile_installed()
print('RECONCILE_CODES '+json.dumps(failures),flush=True)
assert not failures,failures
