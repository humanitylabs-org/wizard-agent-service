#!/usr/bin/env python3
"""Long-lived synthetic preview dependency, launched by a uniquely named unit.

The SSH parent supplies the provider bearer on stdin; it is never written on
host disk or argv. All model prompts/state live in synthetic source/sibling
RAM. Not a live-agent deployment tool.
"""
import http.server
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
from types import SimpleNamespace

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'ops/agent-runtime'))
import agent_runtime as ar
from incognito_runtime import IncognitoManager, PYTHON
from test_private_seal import fixture

project='r9bpreview'; source=project+'-agent-synthetic-1'
key=sys.stdin.read().strip();assert key and '\n' not in key
agent=fixture();agent['runtime']['port']=19651
agent['runtime']['sealed_networks']={'agent':'10.246.92.0/28','provider':'10.247.92.0/28'}
image='ghcr.io/humanitylabs-org/hermes-agent:v2026.9.24-wizard2'
state=ROOT/'preview-state';state.mkdir(exist_ok=True)
file=state/'compose.json'
config=Path(os.environ['PRIVATE_SEAL_SYNTHETIC_CONFIG']).read_text()
doc=json.loads(ar.compose_doc(agent,image=image,proxy_image=ar.DEFAULT_PROXY_IMAGE,home_source='/unused-synthetic',uid=1000,gid=1000,ports=True))
client=doc['services']['agent-synthetic']
client.update({'entrypoint':[PYTHON],'command':['-c','import time\nwhile True: time.sleep(3600)'],
 'init':True,'read_only':True,'logging':{'driver':'none'},'user':'1000:1000','cap_add':[], 'volumes':[],
 'tmpfs':['/opt/data:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700','/tmp:rw,nosuid,nodev,size=128m,mode=1777'],
 'mem_limit':'1g','memswap_limit':'1g'})
client['environment'].update({'HOME':'/opt/data','HERMES_HOME':'/opt/data','HERMES_WORKDIR':'/opt/data','PYTHONDONTWRITEBYTECODE':'1'})
file.write_text(json.dumps(doc,indent=2))

def compose(*args):
 p=subprocess.run(['docker','compose','-p',project,'-f',str(file),*args],capture_output=True,timeout=120)
 if p.returncode:raise RuntimeError('synthetic_compose_failed')

def stop(*_):raise KeyboardInterrupt()
for sig in (signal.SIGINT,signal.SIGTERM,signal.SIGHUP):signal.signal(sig,stop)
manager=None;service=None;helper=None
try:
 compose('up','-d')
 p=subprocess.run(['docker','exec','-i',source,PYTHON,'-c',
 "import json,sys,pathlib;p=json.load(sys.stdin);h=pathlib.Path('/opt/data');(h/'config.yaml').write_text(p['config']);(h/'.env').write_text('TINFOIL_API_KEY='+p['key']+'\\n');(h/'memories').mkdir(exist_ok=True);(h/'memories/MEMORY.md').write_text('Isolated synthetic preview; no owner data.\\n')"],
 input=json.dumps({'key':key,'config':config}),text=True,capture_output=True,timeout=30)
 assert p.returncode==0,'synthetic_seed_failed'
 key=None
 registry=SimpleNamespace(read=lambda ident:agent if ident=='synthetic' else (_ for _ in ()).throw(ar.RuntimeFailure('not_found',404)))
 driver=SimpleNamespace(agents=registry,project=lambda _:project)
 manager=IncognitoManager(driver,docker=ar.docker,failure=ar.RuntimeFailure,image=image,proxy_image=ar.DEFAULT_PROXY_IMAGE,container_for=lambda *_:source,owner='r9b-preview')
 handler=ar.make_handler('synthetic-helper-token',registry,driver,incognito_manager=manager)
 helper=http.server.ThreadingHTTPServer(('127.0.0.1',19755),handler)
 threading.Thread(target=helper.serve_forever,daemon=True).start()
 env=dict(QA_HELPER_ORIGIN='http://127.0.0.1:19755',QA_PORT='19756',QA_FIXTURE_ROOT='/state/incognito-stock-service-preview',PRIVATE_SEAL_SERVICE_MODULE='/service/server/service.mjs')
 args=['docker','run','--rm','--name','r9b-preview-service','--user',f'{os.getuid()}:{os.getgid()}','--network','host','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--log-driver','none',
       '-v',str(ROOT/'service')+':/service:ro','-v',str(ROOT/'service/node_modules')+':/service/node_modules:ro','-v',str(ROOT/'scripts')+':/scripts:ro','-v',str(state)+':/state:rw','--tmpfs','/tmp:rw,nosuid,nodev']
 for name,value in env.items():args+=['-e',name+'='+value]
 service=subprocess.Popen([*args,'node:24-bookworm-slim','node','/scripts/private-seal-preview-service.mjs'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 print(json.dumps({'synthetic_only':True,'ready':True,'service_port':19756}),flush=True)
 while service.poll() is None:threading.Event().wait(5)
except KeyboardInterrupt:
 pass
finally:
 if helper:helper.shutdown();helper.server_close()
 if service and service.poll() is None:
  service.terminate()
  try:service.wait(timeout=30)
  except subprocess.TimeoutExpired:service.kill();service.wait()
 if manager:manager.close()
 compose('down','--remove-orphans')
