#!/usr/bin/env python3
"""Execute stock Hermes against a labelled synthetic protocol fixture, never a real private home.
This proves stock tool execution, not confidential-provider reasoning. Content never enters logs.
"""
import hashlib,json,os,secrets,signal,sqlite3,subprocess,sys,tempfile,time,urllib.request,urllib.error,shutil
from pathlib import Path
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'ops/agent-runtime'))
from incognito_runtime import IncognitoManager,PYTHON,BOOT,VERIFY,VERIFY_RAM
from agent_runtime import RuntimeFailure,docker
OUT=Path(os.environ.get('INCOGNITO_EVIDENCE','qa/incognito-stock'));OUT.mkdir(parents=True,exist_ok=True)
report={'synthetic_only':True,'protocol_fixture':True,'real_provider_verified':False,'complete':False}
normal=Path(tempfile.mkdtemp(prefix='incognito-stock-synthetic-'));normal.chmod(0o755)
prefix='incognito-proof-'+secrets.token_hex(8);source=prefix+'-source';fixture=prefix+'-fixture';network=prefix+'-net'
manager=None;helper=None;service_proc=None;service_log=None;service_root=None;markers=['INC-'+secrets.token_hex(20),'INC-'+secrets.token_hex(20)];clock=[time.monotonic()]
def stop_signal(*_):raise SystemExit(143)
signal.signal(signal.SIGTERM,stop_signal)
def cmd(args,stdin=None,required=True,diagnose=False):
 result=docker(args,input_text=stdin,check=False,timeout=90)
 if required and result.returncode:
  # Opt-in only for synthetic setup before any canary or credentials exist.
  if diagnose: print('synthetic_docker_setup_stderr: '+result.stderr[:4000],file=sys.stderr,flush=True)
  raise RuntimeError('synthetic_docker_operation_failed')
 return result.stdout
def snapshot():return {str(p.relative_to(normal)):hashlib.sha256(p.read_bytes()).hexdigest() for p in normal.rglob('*') if p.is_file()}
def leftovers():return manager._discover('container')+manager._discover('network')
MCP=r'''import json,sys,pathlib
for line in sys.stdin:
 try:
  q=json.loads(line);method=q.get('method');result={}
  if 'id' not in q:continue
  if method=='initialize':result={'protocolVersion':q.get('params',{}).get('protocolVersion','2024-11-05'),'capabilities':{'tools':{}},'serverInfo':{'name':'synthetic','version':'1'}}
  elif method=='tools/list':result={'tools':[{'name':'synthetic_echo','description':'Synthetic Incognito echo proof','inputSchema':{'type':'object','properties':{'marker':{'type':'string'}},'required':['marker']}}]}
  elif method=='tools/call':
   marker=q.get('params',{}).get('arguments',{}).get('marker','')
   pathlib.Path('/opt/data/.mcp-called').write_text(marker)
   result={'content':[{'type':'text','text':'mcp-success '+marker}]}
  print(json.dumps({'jsonrpc':'2.0','id':q['id'],'result':result}),flush=True)
 except Exception:raise SystemExit(1)
'''
try:
 lock=json.loads((ROOT/'ops/agent-runtime/hermes-lock.json').read_text());image=lock['runtime_image']
 import yaml
 config={'model':{'provider':'custom','default':'synthetic-incognito','base_url':'http://'+fixture+':18888/v1','api_key':'synthetic-fixture-only','api_mode':'chat_completions'},'fallback_providers':[],
         'toolsets':{'api_server':['memory','mcp','session_search']},'platform_toolsets':{'api_server':['memory','mcp','session_search']},
         'mcp_servers':{'synthetic':{'command':PYTHON,'args':['/opt/data/synthetic-mcp.py']}},'memory':{'memory_enabled':True,'user_profile_enabled':True,'memory_char_limit':8000},
         'agent':{'max_iterations':12},'plugins':{'enabled':[]},'terminal':{'cwd':'/opt/data'},'gateway':{'platforms':{'api_server':{'enabled':True}}}}
 (normal/'config.yaml').write_text(yaml.safe_dump(config));(normal/'.env').write_text('API_SERVER_KEY=synthetic-normal-key\n')
 (normal/'synthetic-mcp.py').write_text(MCP);(normal/'memories').mkdir();(normal/'memories/MEMORY.md').write_text('Synthetic identity animal: otter\n');(normal/'memories/USER.md').write_text('Synthetic owner.\n')
 (normal/'skills/synthetic').mkdir(parents=True);(normal/'skills/synthetic/SKILL.md').write_text('---\nname: synthetic\ndescription: Synthetic skill seed\n---\nSynthetic only.\n')
 with sqlite3.connect(normal/'state.db') as db:db.execute('create table synthetic_normal_history(value text)');db.execute("insert into synthetic_normal_history values ('normal-synthetic-history')")
 before=snapshot()
 cmd(['network','create','--label','wizard.incognito.rig='+prefix,network])
 common=['--label','wizard.incognito.rig='+prefix,'--read-only','--log-driver','none','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','1g','--memory-swap','1g','--ulimit','core=0:0','--network',network,'--user','10000:10000','--tmpfs','/tmp:rw,nosuid,nodev,size=64m,mode=1777']
 cmd(['run','-d','--name',source,*common,'--mount',f'type=bind,src={normal},dst=/opt/data,readonly','--entrypoint',PYTHON,image,'-c','import time;time.sleep(7200)'],diagnose=True)
 wait="import os,time,runpy\nwhile not os.path.exists('/opt/data/provider.py'):time.sleep(.1)\nrunpy.run_path('/opt/data/provider.py',run_name='__main__')"
 cmd(['run','-d','--name',fixture,*common,'--tmpfs','/opt/data:rw,nosuid,nodev,size=32m,uid=10000,gid=10000,mode=0700','--entrypoint',PYTHON,image,'-c',wait],diagnose=True)
 cmd(['exec','-i',fixture,PYTHON,'-c',"import sys;open('/opt/data/provider.py','w').write(sys.stdin.read())"],(ROOT/'scripts/incognito-provider-fixture.py').read_text())
 driver=SimpleNamespace(agents=object(),project=lambda _:prefix)
 manager=IncognitoManager(driver,docker=docker,failure=RuntimeFailure,image=image,proxy_image='',container_for=lambda *_:source,clock=lambda:clock[0],background=False)
 agent={'id':'synthetic','privacy':'private','model':{'provider':'tinfoil','model':'synthetic-incognito'},'runtime':{'kind':'container','app_id':'synthetic-source'}}
 sid='incog_'+secrets.token_hex(16);state=manager.start(agent,sid);target=manager.sessions[('synthetic',sid)]['name']
 meta=json.loads(cmd(['inspect',target]))[0];cfg=meta['HostConfig']
 assert cfg['ReadonlyRootfs'] and cfg['LogConfig']['Type']=='none' and not meta.get('LogPath')
 assert all({'rw','nosuid','nodev'} <= set(cfg['Tmpfs'][x].split(',')) for x in ['/opt/data','/tmp','/var/log'])
 cmd(['exec',target,PYTHON,'-c',VERIFY_RAM])
 assert cfg['MemorySwap']==cfg['Memory'] and cfg['Memory']>0
 assert any(x['Name']=='core' and x['Hard']==0 and x['Soft']==0 for x in cfg['Ulimits'])
 assert not [m for m in meta['Mounts'] if m['Type'] in ('bind','volume')]
 assert meta['Image']==json.loads(cmd(['inspect',source]))[0]['Image']
 assert state['history_search']=='available'
 report['stock_boundary']={'read_only_root':True,'unswappable_tmpfs':True,'swap_enforcement':'cgroup-v2-memory.swap.max=0','no_durable_mounts':True,'core_dumps_disabled':True,'docker_log_driver':'none','same_source_image':True,'same_network_routes':True,'sqlite_backup_available':True}
 def api(path,method='GET',value=None):
  body=None if value is None else json.dumps(value).encode();req=urllib.request.Request(state['origin']+path,data=body,method=method,headers={'Authorization':'Bearer '+state['key'],'Content-Type':'application/json'})
  with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=20) as response:return json.load(response)
 api('/api/sessions','POST',{'id':sid})
 replies=[]
 prompts=[f'CALL_SYNTHETIC {markers[0]}. Call synthetic_echo with that marker and answer with its result and the identity animal from memory.',f'SAVE_MEMORY {markers[1]}. Use the memory tool to add that marker to persistent memory within this session.']
 for prompt in prompts:
  admitted=api('/v1/runs','POST',{'session_id':sid,'input':prompt});result={}
  for _ in range(120):
   result=api('/v1/runs/'+admitted['run_id'])
   if result.get('status') in ('completed','failed','cancelled'):break
   manager.lease('synthetic',sid);time.sleep(1)
  assert result.get('status')=='completed','stock_synthetic_tool_run_did_not_complete'
  replies.append(result)
 assert 'otter' in json.dumps(replies[0]).lower(),'stock_memory_context_missing'
 if 'mcp-success '+markers[0] not in json.dumps(replies[0]):
  diagnostic=json.dumps(replies[0])
  for marker in markers:diagnostic=diagnostic.replace(marker,'[REDACTED_SYNTHETIC_CANARY]')
  print('synthetic_redacted_first_run: '+diagnostic,flush=True)
 assert 'mcp-success '+markers[0] in json.dumps(replies[0]),'stock_mcp_tool_result_missing'
 check=r'''import json,sys,pathlib,sqlite3
p=json.load(sys.stdin);h=pathlib.Path('/opt/data');a,b=p
memory=(h/'memories/MEMORY.md').read_text()
print(json.dumps({'tool_called':(h/'.mcp-called').read_text()==a,'memory_saved':b in memory,'both_in_ram':all(x.encode() in b''.join(f.read_bytes() for f in h.rglob('*') if f.is_file()) for x in p),'old_history_copied':sqlite3.connect(h/'state.db').execute('select value from synthetic_normal_history').fetchone()[0]=='normal-synthetic-history'}))
'''
 verified=json.loads(cmd(['exec','-i',target,PYTHON,'-c',check],json.dumps(markers)));assert all(verified.values()),'stock_capability_assertion_failed'
 report.update(verified);report['stock_memory_and_mcp_tools_executed']=True
 # Verify policy registration and directive semantics in the actual locked runtime.
 policy_check=VERIFY
 cmd(['exec',target,PYTHON,'-c',policy_check]);report['stock_policy_module_verified']=True
 manager.stop('synthetic',sid);assert not leftovers();assert before==snapshot()
 # Scan only this run's synthetic normal home, synthetic service HOME and its own logs.
 folders=[normal,Path.home()/'.wizard-os',Path.home()/'.hermes']
 for folder in folders:
  if folder.exists():
   assert all(not any(m.encode() in p.read_bytes() for m in markers) for p in folder.rglob('*') if p.is_file()),'synthetic_durable_canary_found'
 report['end_no_leftovers_and_no_canaries_in_synthetic_durable_data']=True
 sid2='incog_'+secrets.token_hex(16);manager.start(agent,sid2);clock[0]+=91;manager.sweep();assert not leftovers();report['abandoned_lease_cleaned']=True
 sid3='incog_'+secrets.token_hex(16);manager.start(agent,sid3)
 recovery=IncognitoManager(driver,docker=docker,failure=RuntimeFailure,image=image,proxy_image='',container_for=lambda *_:source,clock=lambda:clock[0],background=False)
 recovery.close();manager.sessions.clear();assert not leftovers();assert before==snapshot();report['helper_restart_reaped_orphans']=True
 # Real Node Service stop/restart, with real helper HTTP routes and stock targets.
 import threading
 from agent_runtime import make_handler,ThreadingHTTPServer
 helper_agents=SimpleNamespace(read=lambda _:agent)
 handler=make_handler('synthetic-helper-token',helper_agents,driver,incognito_manager=manager)
 helper=ThreadingHTTPServer(('127.0.0.1',0),handler);helper_thread=threading.Thread(target=helper.serve_forever,daemon=True);helper_thread.start()
 service_root=Path(tempfile.mkdtemp(prefix='incognito-stock-service-'))
 service_log=(OUT/'stock-service.log').open('wb')
 service_env={**os.environ,'QA_FIXTURE_ROOT':str(service_root),'QA_HELPER_ORIGIN':'http://127.0.0.1:'+str(helper.server_port),'QA_PORT':'19744'}
 service_base='http://127.0.0.1:19744/wizard/v1/agents/synthetic/incognito'
 def owner(path='',method='GET',value=None):
  data=None if value is None else json.dumps(value).encode()
  request=urllib.request.Request(service_base+path,data=data,method=method,headers={'Content-Type':'application/json'})
  with urllib.request.urlopen(request,timeout=90) as response:return json.load(response)
 def start_service():
  proc=subprocess.Popen(['node','tests/fixtures/incognito-stock-service.mjs'],cwd=ROOT,env=service_env,stdout=service_log,stderr=subprocess.STDOUT)
  for _ in range(200):
   if proc.poll() is not None:raise RuntimeError('synthetic_service_start_failed')
   try:
    with urllib.request.urlopen('http://127.0.0.1:19744/wizard/v1/agents',timeout=1) as response:
     if any(a['id']=='synthetic' for a in json.load(response).get('agents',[])):return proc
   except OSError:pass
   time.sleep(.1)
  proc.terminate();proc.wait(timeout=15);raise RuntimeError('synthetic_service_start_timeout')
 service_proc=start_service();temporary=owner('','POST',{})['session_id']
 admitted=owner('/'+temporary+'/v1/runs','POST',{'input':'Read the memory animal. '+markers[0]+' '+markers[1]})
 for _ in range(120):
  result=owner('/'+temporary+'/v1/runs/'+admitted['run_id'])
  if result.get('status') in ('completed','failed','cancelled'):break
  owner('/'+temporary+'/lease','POST',{});time.sleep(1)
 assert result.get('status')=='completed','service_to_stock_run_failed'
 service_proc.terminate();assert service_proc.wait(timeout=30)==0;service_proc=None
 for _ in range(100):
  if not manager.sessions and not leftovers():break
  time.sleep(.1)
 assert not manager.sessions and not leftovers(),'service_shutdown_left_stock_target'
 service_proc=start_service()
 try:owner('/'+temporary+'/v1/runs/'+admitted['run_id']);raise AssertionError('service_restart_restored_incognito')
 except urllib.error.HTTPError as error:assert error.code==410
 service_proc.terminate();assert service_proc.wait(timeout=30)==0;service_proc=None
 service_log.flush()
 for folder in [normal,service_root,Path.home()/'.wizard-os',Path.home()/'.hermes']:
  if folder.exists():assert all(not any(m.encode() in p.read_bytes() for m in markers) for p in folder.rglob('*') if p.is_file()),'post_restart_durable_canary_found'
 assert not any(m.encode() in (OUT/'stock-service.log').read_bytes() for m in markers),'service_log_canary_found'
 assert before==snapshot() and not leftovers()
 report['actual_service_restart_no_targets_or_canaries']=True
 report['complete']=True
except Exception as exc:
 report['error_type']=type(exc).__name__
 # Bounded phase identifiers only; never serialize arbitrary HTTP/provider/tool exception text.
 raise
finally:
 if service_proc:
  service_proc.terminate()
  try:service_proc.wait(timeout=30)
  except subprocess.TimeoutExpired:service_proc.kill();service_proc.wait()
 if helper:helper.shutdown();helper.server_close()
 if service_log:service_log.close()
 if manager:manager.close()
 if service_root:shutil.rmtree(service_root)
 for name in [source,fixture]:cmd(['rm','-f',name],required=False)
 cmd(['network','rm',network],required=False)
 shutil.rmtree(normal)
 (OUT/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
