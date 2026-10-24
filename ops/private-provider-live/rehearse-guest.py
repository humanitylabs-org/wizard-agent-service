#!/usr/bin/env python3
"""pp-rehearsal-3; never usable outside the disposable guest."""
import os,sys,json,time,subprocess,urllib.request,urllib.error,hashlib,shutil
from pathlib import Path
assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers'
H=Path('/home/rig'); R=H/'pp-launch-3'; S=R/'service'; T=R/'tinfoil'; W=Path('/opt/pp-rig/src/wam'); O=H/'.wizard-os'; A=O/'agents'
R.mkdir(exist_ok=True)
step=sys.argv[1]
def run(args,**kw):
 p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,**kw)
 if p.returncode:
  (R/'last-command.log').write_bytes(p.stdout);(R/'last-command.log').chmod(0o600)
  raise RuntimeError('command failed: '+str(args[:3])+'; output withheld')
 return p.stdout

def req(path,body=None,method=None,base='http://127.0.0.1:8787'):
 headers={'Content-Type':'application/json','x-wizard-owner-proof':(O/'agent-runtime/owner-proof').read_text().strip()}
 q=urllib.request.Request(base+path,json.dumps(body).encode() if body is not None else None,headers,method=method)
 try:
  with urllib.request.urlopen(q,timeout=180) as f:return f.status,json.load(f)
 except urllib.error.HTTPError as e:
  try:b=json.load(e)
  except:b={}
  return e.code,b

def save(name,data):
 (R/(name+'.json')).write_text(json.dumps(data,indent=2)+'\n'); print(name,json.dumps(data),flush=True)

def wait(path):
 for _ in range(90):
  try:
   if req(path)[0]==200:return
  except Exception:pass
  time.sleep(2)
 raise RuntimeError('readiness timeout '+path)

if step=='setup':
 assert os.geteuid()==1000
 prior=R/'pids.json'
 if prior.is_file():
  import signal
  for pid in json.loads(prior.read_text()).values():
   try:os.kill(pid,signal.SIGTERM)
   except ProcessLookupError:pass
  time.sleep(2)
 for n in ['user-config','app-data','apps','state']:assert (H/'runtipi'/n).stat().st_uid==0
 for row in json.loads((H/'pp-launch-2/live-ownership.json').read_text())['rows']:
  p=H/'runtipi'/row['path']
  if row.get('absent'):assert not p.exists();continue
  st=p.stat();assert (st.st_uid,st.st_gid,st.st_mode&0o7777,os.access(p,os.W_OK))==(row['uid'],row['gid'],row['mode'],row['writable'])
 cached=[]
 for tag,ctx,extra,cwd in [('wizard-provider-egress:local','ops/agent-runtime',['-f','ops/agent-runtime/Dockerfile.provider-egress'],S),('restricted-agent-sidecars:local','ops/agent-runtime/restricted-agent/sidecars',[],S),('pp-test-tinfoil:launch3','.', ['-f','app/Dockerfile'],T)]:
  if tag.startswith('restricted-'):
   files={f'/srv/{n}':cwd/ctx/n for n in ['egress.py','upstream_dns.py','hostname_policy.py','edge.py','home-init.sh','claude-init.py']}
  elif tag.startswith('wizard-provider-'):
   files={f'/app/{n}':cwd/ctx/n for n in ['provider-connect-proxy.py','provider-ingress.py']}
  else:
   files={'/app/'+str(p.relative_to(T)):p for sub in ['app','web'] for p in (T/sub).rglob('*') if p.is_file() and '__pycache__' not in str(p)}
   files.update({'/app/'+n:T/n for n in ['openapi.json','requirements.lock']})
  expected={n:hashlib.sha256(p.read_bytes()).hexdigest() for n,p in files.items()}
  check=subprocess.run(['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','--entrypoint','python3',tag,'-c','import json,hashlib,sys;from pathlib import Path; expected=json.loads(sys.argv[1]);assert all(hashlib.sha256(Path(p).read_bytes()).hexdigest()==h for p,h in expected.items());print("SOURCE_HASHES_MATCH")',json.dumps(expected)],capture_output=True)
  if check.returncode==0:cached.append(tag);continue
  run(['docker','build','-t',tag,*extra,ctx],cwd=cwd)
 save('images',{'source_verified_cached':cached})
 pin='ghcr.io/humanitylabs-org/wizard-private-client:0.1.0@sha256:c562bef2166e6e1054be8eed34229cf0ead4574002da28f8fe5d4f09ad0e6631'
 run(['docker','pull',pin]); run(['npm','ci','--omit=dev','--no-audit','--no-fund'],cwd=S)
 env=dict(os.environ,HOME=str(H),RUNTIPI_ROOT=str(H/'runtipi'),WIZARD_OS_HOME=str(O))
 for l in Path('/opt/pp-rig/service.env').read_text().splitlines():
  if l and not l.startswith('#') and '=' in l:
   k,v=l.split('=',1);env[k]=v.strip().strip('\"\'')
 env.pop('WIZARD_AGENT_ISOLATION',None)
 for k in ['WIZARD_AGENT_HOST','WIZARD_AGENT_PORT']:env.pop(k,None)
 env.update(WIZARD_AGENT_RUNTIME_URL='http://127.0.0.1:7795')
 commands={'runtime':['python3',str(S/'ops/agent-runtime/agent_runtime.py'),'--driver','runtipi','--wam',str(W),'--agents-dir',str(A),'--token-file',str(O/'agent-runtime/token'),'--home-mount','alongside','--client-image',pin,'--apps-json',str(O/'apps.json'),'--tinfoil-key-file',str(R/'legacy-key.env')], 'service':['/usr/local/bin/node',str(S/'server/index.mjs')]}
 pids={}
 for n,cmd in commands.items():
  with (R/(n+'.log')).open('w') as f:p=subprocess.Popen(cmd,cwd=S,env=env,stdin=subprocess.DEVNULL,stdout=f,stderr=f,start_new_session=True)
  pids[n]=p.pid
 (R/'pids.json').write_text(json.dumps(pids));wait('/wizard/health');save('setup',{'uid':os.geteuid(),'running':True,'client_image':pin})
elif step=='key':
 assert os.geteuid()==1000
 raw=sys.stdin.read(); value=''
 for l in raw.splitlines():
  if l.startswith('TINFOIL_API_KEY='):value=l.split('=',1)[1].strip().strip('\"\'')
 assert value and len(value)>10
 p=R/'legacy-key.env';p.write_text('TINFOIL_API_KEY='+value+'\n');p.chmod(0o600)
 (R/'key-sha256').write_text(hashlib.sha256(value.encode()).hexdigest())
 print('KEY_STAGED_GUEST_ONLY',flush=True)
elif step=='baseline-prepare':
 c,b=req('/wizard/v1/agents/pp-test-legacy',{},'PATCH');assert c==200,(c,b)
 for _ in range(90):
  c,b=req('/wizard/v1/agents/pp-test-legacy')
  if c==200 and b['agent'].get('status')=='running':break
  time.sleep(2)
 else:raise RuntimeError('legacy product apply did not become running: '+str(b['agent'].get('status_detail')))
 save('baseline-prepared',{'status':'running'})
elif step=='baseline':
 assert os.geteuid()==1000
 # Product creation, no installed provider, legacy TCP+sidecar path (not owner data).
 assert not json.loads((O/'apps.json').read_text()).get('apps',[])
 c,b=req('/wizard/v1/agents',{'label':'pp-test-legacy','harness':'hermes','permissions':{'preset':'private','read_standard_chats':False},'model':{'provider':'tinfoil','model':'glm-5-3','allowed_models':['glm-5-3','deepseek-v4-1-flash'],'fallback':False}},'POST');assert c==201,(c,b)
 assert b['agent']['id']=='pp-test-legacy'
 agent=json.loads((A/'pp-test-legacy/agent.json').read_text());assert agent['model']['provider']=='tinfoil' and not agent['runtime'].get('private_client') and not agent['runtime'].get('isolation')
 save('baseline-start',{'status':c,'product_create':True,'legacy_route':True})
elif step=='chat':
 aid=sys.argv[2];assert aid.startswith('pp-test-')
 pending=R/('run-'+aid+'.json')
 if pending.exists():
  accepted=json.loads(pending.read_text());session=accepted['session_id'];rid=accepted['run_id']
 else:
  c,b=req('/wizard/hermes/api/sessions?agent='+aid,{'source':'wizard-mobile','title':'Private provider synthetic rehearsal'},'POST');assert c in [200,201],(c,b)
  session=(b.get('session') or b).get('id') or b.get('session_id');assert session,'canonical session response missing id'
  c,b=req('/wizard/hermes/v1/runs?agent='+aid,{'session_id':session,'input':'Reply with only PP_OK. Do not use tools.'},'POST');assert c==202,(c,b)
  rid=b['run_id'];pending.write_text(json.dumps({'session_id':session,'run_id':rid}));pending.chmod(0o600)
 for _ in range(180):
  c,b=req('/wizard/hermes/v1/runs/'+rid+'?agent='+aid)
  state=b.get('status') or b.get('state')
  if state in ['completed','done','succeeded']:
   assert 'PP_OK' in json.dumps(b);save('chat-'+aid,{'completed':True,'session_id':session});break
  if state in ['failed','error','cancelled']:raise RuntimeError('terminal run failure; details withheld')
  time.sleep(2)
 else:raise RuntimeError('chat timeout')
elif step=='install':
 assert os.geteuid()==1000
 sys.path.insert(0,str(W));import yaml
 from wam import cli, wizardmd
 c=cli.Config();rt=c.runtipi();urn='wizard-tinfoil_private:wizardapps'; lid='wizard-tinfoil_private'
 assert not any((x.get('info') or {}).get('urn')==urn for x in rt.installed())
 dst=c.runtipi_root/'repos/wizardapps/apps'/lid;assert not dst.exists();(dst/'metadata').mkdir(parents=True)
 text=(T/'wizard.md').read_text();doc=wizardmd.front_matter(text);comp=yaml.safe_load((T/'runtipi/docker-compose.yml').read_text())
 cfg=json.loads((T/'runtipi/config.json').read_text());cfg.update(id=lid,source='local:'+lid)
 svc=comp['services']['wizard-tinfoil'];svc.update(image='pp-test-tinfoil:launch3',pull_policy='never',ports=['127.0.0.1:${APP_PORT}:18804'])
 # WAM's portable-volume compiler deliberately rejects fixed names. Declare this
 # provider-only credential volume in the owner API override, never app-data.
 assert comp.pop('volumes')=={'tinfoil-private-data':{'name':'wizard-tinfoil-private-data'}},'unexpected provider volume recipe'
 assert svc.pop('volumes')==['tinfoil-private-data:/data'],'unexpected provider data mount'
 # Immutable app source is built into this image; source provenance is exact pinned archive.
 (dst/'wizard.md').write_text(text);(dst/'config.json').write_text(json.dumps(cfg));(dst/'docker-compose.yml').write_text(yaml.safe_dump(comp,sort_keys=False))
 shutil.copy2(T/'runtipi/metadata/logo.jpg',dst/'metadata/logo.jpg');(dst/'metadata/description.md').write_text('Private relay-only provider rehearsal\n')
 (dst/'.wizard-commit').write_text('07eca5e30ca7873ab8cfda503175768fc55f66d4\n');(dst/'.wizard-source').write_text(json.dumps({'repo':'local:'+lid,'private':True}))
 prior=rt.req('GET','/user-config/'+urn)
 save('install-api-template',{'compose_null':prior.get('dockerCompose') is None,'env_null':prior.get('appEnv') is None,'compose_noncomment_lines':sum(bool(x.strip()) and not x.lstrip().startswith('#') for x in (prior.get('dockerCompose') or '').splitlines()),'app_env_names':[x.split('=',1)[0] for x in (prior.get('appEnv') or '').splitlines() if x.strip() and not x.lstrip().startswith('#')]})
 override='services:\n  wizard-tinfoil:\n    networks: !override\n      - provider-bootstrap\n    volumes:\n      - tinfoil-private-data:/data\nvolumes:\n  tinfoil-private-data:\n    name: wizard-tinfoil-private-data\n'
 old_compose=prior.get('dockerCompose') or '';old_env=prior.get('appEnv') or ''
 # Fresh Runtipi GET returns commented templates, not necessarily empty strings.
 assert not any(l.strip() and not l.lstrip().startswith('#') for l in old_env.splitlines()),'unexpected provider env override'
 assert old_compose.rstrip('\n')==override.rstrip('\n') or yaml.safe_load(old_compose) in [None,{}, {'services':{}}, {'services':None}],'unexpected compose override'
 rt.req('PUT','/user-config/'+urn,{'dockerCompose':override,'appEnv':old_env});after=rt.req('GET','/user-config/'+urn);assert after['dockerCompose'].rstrip('\n')==override.rstrip('\n') and (after.get('appEnv') or '').rstrip('\n')==old_env.rstrip('\n'),'provider override API readback mismatch'
 rt.install(urn,{'openPort':False,'exposed':False,'exposedLocal':False,'port':18804,'WIZARD_TRUSTED_HOSTS':'127.0.0.1:18804,localhost:18804','WIZARD_TRUSTED_ORIGINS':'http://127.0.0.1:18804','HERMES_DASHBOARD_BASIC_AUTH_PASSWORD':'relay-only-unused-local-value'});status=rt.wait_status(urn,{'running','stopped'},timeout=180);assert status=='running',status
 reg=cli.write_registry(c,rt)
 assert any(x.get('private_inference') and x.get('urn')==urn for x in reg['apps'] if x.get('id')=='wizard-tinfoil')
 save('install',{'urn':urn,'source':'local:'+lid,'status':status,'override_api_readback':True,'uid':os.geteuid()})
elif step=='connect':
 assert os.geteuid()==1000
 sys.path.insert(0,str(S/'ops/agent-runtime'));from agent_runtime import Agents
 failures=Agents(A,apps_path=O/'apps.json').providers.reconcile_installed();assert not failures,failures
 key=(R/'legacy-key.env').read_text().split('=',1)[1].strip()
 q=urllib.request.Request('http://127.0.0.1:18804/api/connect',json.dumps({'apiKey':key}).encode(),{'Content-Type':'application/json','Origin':'http://127.0.0.1:18804','X-Wizard-Request':'1'},method='POST')
 with urllib.request.urlopen(q,timeout=180) as f:data=json.load(f)
 assert data.get('connected') is True or data.get('status') in ['connected','ready'],{k:v for k,v in data.items() if k in ['status','connected','error']}
 save('provider-connected',{'connected':True,'models':len(data.get('models',[]))})
elif step=='create-probe':
 c,b=req('/wizard/v1/agents',{'label':'pp-test-probe','harness':'hermes','permissions':{'preset':'private','read_standard_chats':False},'model':{'provider':'wizard-tinfoil','model':'glm-5-3','allowed_models':['glm-5-3','deepseek-v4-1-flash'],'fallback':False}},'POST')
 assert c==201,(c,b);aid=b['agent']['id'];assert aid=='pp-test-probe';save('probe-created',{'agent':aid,'created':True})
elif step=='quarantine-legacy-key':
 assert os.geteuid()==1000
 # The old fixture remains reversible and its home/history are not discarded.
 aid='pp-test-legacy';d=A/aid
 session=json.loads((R/('chat-'+aid+'.json')).read_text())['session_id'];code,body=req('/wizard/hermes/api/sessions/'+session+'/messages?agent='+aid);assert code==200,'legacy canonical history unavailable'
 messages=body.get('messages',body.get('data'));assert isinstance(messages,list) and messages,'legacy canonical history empty'
 canonical_history={'session_id':session,'message_count':len(messages),'sha256':hashlib.sha256(json.dumps(messages,sort_keys=True,separators=(',',':')).encode()).hexdigest()}
 ids=run(['docker','ps','-aq','--filter','label=com.docker.compose.service=agent-'+aid]).decode().split();assert len(ids)==1
 inspect=json.loads(run(['docker','inspect',ids[0]]))[0];env=dict(x.split('=',1) for x in inspect['Config']['Env'] if '=' in x);u=inspect['Config'].get('User','')
 pair=[env.get('HERMES_UID'),env.get('HERMES_GID')] if u in ['', 'root','0','0:0'] else u.split(':');assert [int(x) for x in pair]==[1000,1000]
 record=json.loads((d/'agent.json').read_text());record['runtime'].update(uid=1000,gid=1000);(d/'agent.json').write_text(json.dumps(record))
 c,b=req('/wizard/v1/agents/'+aid+'/stop',{},'POST');assert c==202,(c,b)
 # Remove stopped containers carrying the legacy key, retaining the data mount.
 names=run(['docker','ps','-aq','--filter','label=com.docker.compose.project=agent-'+aid]).decode().split()
 if not names:
  allids=run(['docker','ps','-aq']).decode().split();docs=json.loads(run(['docker','inspect',*allids])) if allids else []
  names=[x['Id'] for x in docs if (x['Config'].get('Labels') or {}).get('com.docker.compose.service') in ['agent-'+aid,'agent-'+aid+'-tinfoil']]
 if names:run(['docker','rm','-f',*names])
 p=d/'home/.env'
 if p.exists():p.write_text('\n'.join(l for l in p.read_text().splitlines() if not l.startswith('TINFOIL_API_KEY='))+'\n')
 (R/'legacy-key.env').unlink()
 history={str(p.relative_to(d/'home')):hashlib.sha256(p.read_bytes()).hexdigest() for p in (d/'home').rglob('*') if p.is_file() and p.name.endswith(('.db','.sqlite','.sqlite3'))}
 home=(d/'home').stat();save('legacy-checkpoint',{'uid':home.st_uid,'gid':home.st_gid,'inode':home.st_ino,'history':history,'canonical_history':canonical_history,'recorded_identity':[1000,1000],'legacy_key_quarantined':True})
elif step=='migrate':
 assert os.geteuid()==1000
 checkpoint=json.loads((R/'legacy-checkpoint.json').read_text());d=A/'pp-test-legacy';before=(d/'home').stat()
 c,b=req('/wizard/v1/agents/pp-test-legacy',{'migrate_private_provider':True},'PATCH');assert c==200,(c,b)
 record=json.loads((d/'agent.json').read_text());assert record['runtime']['private_client'] is True and record['runtime']['uid']==record['runtime']['gid']==1000
 after=(d/'home').stat();assert (before.st_ino,before.st_uid,before.st_gid)==(after.st_ino,after.st_uid,after.st_gid)
 assert checkpoint['history'] and checkpoint['canonical_history']['message_count']>0
 raw_hashes_unchanged=all(hashlib.sha256((d/'home'/n).read_bytes()).hexdigest()==h for n,h in checkpoint['history'].items())
 save('migration',{'product_path':'PATCH migrate_private_provider','home_inode_retained':True,'uid':after.st_uid,'gid':after.st_gid,'raw_sqlite_hashes_unchanged':raw_hashes_unchanged,'canonical_history_verification':'required by verify-migrated'})
else:raise RuntimeError('unknown phase')
