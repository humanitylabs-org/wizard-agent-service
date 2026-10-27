"""Synthetic metadata/content only. No running Docker daemon or real agent is used."""
import io,json,os,sqlite3,subprocess,sys,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
from incognito_runtime import IncognitoManager,EXPORT,SNAPSHOT,INSTALL,POLICY,BOOT,TOTAL_LIMIT,stream_copy
class Failure(Exception):
 def __init__(self,code,status):self.code=code;self.status=status;super().__init__(code)
class Rig:
 def __init__(self):
  self.calls=[];self.transfers=[];self.time=0;self.names=[];self.source=metadata();self.install={};self.fail=False
  self.driver=SimpleNamespace(agents=object(),project=lambda id:'agent-'+id)
 def docker(self,args,input_text=None,**kw):
  self.calls.append((args,input_text));out=''
  if args[:2]==['inspect','synthetic-source']:out=json.dumps([self.source])
  elif args[:2]==['ps','-aq']:out='\n'.join(self.names)
  elif args[:2]==['inspect','--format']:out=args[-1]
  elif args[:2]==['rm','-f']:
   if args[-1] in self.names:self.names.remove(args[-1])
  elif args[:2]==['port',self.names[-1] if self.names else '']:out='127.0.0.1:19999'
  elif args[0]=='create':self.names.append(args[args.index('--name')+1])
  elif args[:2]==['exec','-i'] and args[-1]==INSTALL:
   self.install=json.loads(input_text);out='{"history_search":"available"}'
  return SimpleNamespace(returncode=1 if self.fail and args[0]=='start' else 0,stdout=out,stderr='secret-error-must-not-leak')
 def transfer(self,a,b,limit):self.transfers.append((a,b,limit));return 10240
 def manager(self):return IncognitoManager(self.driver,docker=self.docker,failure=Failure,image='ignored-default',proxy_image='ignored-proxy',container_for=lambda *_:'synthetic-source',background=False,ready=lambda *_:None,transfer=self.transfer,clock=lambda:self.time)
def metadata():
 return {'Image':'sha256:synthetic-exact-image','Config':{'User':'1000:1000','Env':['TINFOIL_API_KEY=synthetic-secret','HTTPS_PROXY=http://synthetic-egress:3128','HERMES_UID=1000']},'HostConfig':{'NetworkMode':'synthetic-uplink'},'NetworkSettings':{'Networks':{'synthetic-uplink':{},'synthetic-sandbox':{}}},'Mounts':[{'Destination':'/opt/data','Source':'/synthetic/home','RW':True},{'Destination':'/run/agent-gateway','Source':'/synthetic/gateway','RW':True}]}
AGENT={'schema':1,'id':'synthetic','privacy':'private','model':{'provider':'tinfoil','model':'synthetic-model'},'runtime':{'kind':'container','port':18001,'app_id':'agent-synthetic'}}
SID='incog_'+'a'*32
class Tests(unittest.TestCase):
 def test_full_home_stream_preserves_routes_image_and_socket_grants(self):
  r=Rig();m=r.manager();result=m.start(AGENT,SID)
  args=next(a for a,_ in r.calls if a[0]=='create')
  self.assertIn('sha256:synthetic-exact-image',args);self.assertIn('synthetic-uplink',args)
  self.assertIn('type=bind,src=/synthetic/gateway,dst=/run/agent-gateway',args)
  self.assertNotIn('/synthetic/home',' '.join(args));self.assertNotIn('synthetic-secret',' '.join(args))
  self.assertIn('synthetic-secret',r.install['environment'].values())
  self.assertEqual(result['history_search'],'available');self.assertEqual(len(r.transfers),2)
  self.assertEqual(r.transfers[0][0][1],'synthetic-source');self.assertEqual(r.transfers[0][1][-4:],['tar','-x','--no-same-owner','-C','/opt/data'][-4:])
  self.assertEqual(r.transfers[1][2],TOTAL_LIMIT-10240)
  self.assertTrue(any(a[:3]==['network','connect','synthetic-sandbox'] for a,_ in r.calls));m.close()
 def test_no_swap_log_core_or_writable_root(self):
  r=Rig();m=r.manager();m.start(AGENT,SID);a=next(a for a,_ in r.calls if a[0]=='create')
  for flag in ['--read-only','--cap-drop','--security-opt','--ulimit']:self.assertIn(flag,a)
  self.assertEqual(a[a.index('--log-driver')+1],'none');self.assertIn('core=0:0',a)
  self.assertEqual(a[a.index('--memory')+1],a[a.index('--memory-swap')+1])
  self.assertTrue(all('noswap' in a[i+1] for i,x in enumerate(a) if x=='--tmpfs'));m.close()
 def test_shared_network_and_live_agent_never_removed(self):
  r=Rig();m=r.manager();m.start(AGENT,SID);m.stop('synthetic',SID)
  removed=[a for a,_ in r.calls if a[0]=='rm'];self.assertEqual(len(removed),1);self.assertTrue(removed[0][-1].startswith('wizard-incognito-'))
  self.assertFalse(any(a[:2]==['network','rm'] for a,_ in r.calls));m.close()
 def test_leases_and_startup_errors_cleanup(self):
  r=Rig();m=r.manager();m.start(AGENT,SID);r.time=91;m.sweep();self.assertFalse(m.sessions)
  r.fail=True
  with self.assertRaises(Failure) as err:m.start(AGENT,SID)
  self.assertEqual(str(err.exception),'incognito_runtime_failed');m.close()
 def test_private_and_mount_scope_fail_closed(self):
  for field,value in [('privacy','standard'),('imported',True)]:
   r=Rig();m=r.manager()
   with self.assertRaises(Failure):m.start({**AGENT,field:value},SID)
   self.assertFalse(r.transfers);m.close()
  r=Rig();r.source['Mounts'].append({'Destination':'/host','Source':'/','RW':True});m=r.manager()
  with self.assertRaises(Failure):m.start(AGENT,SID)
  self.assertFalse(r.transfers);m.close()
 def test_policy_allows_memory_facts_skills_apps_but_blocks_durable_orchestration(self):
  ns={};exec(POLICY,ns)
  for tool in ['memory','skill_manage','fact_store','mcp__wizard__notes_update','mcp__wizard__messenger_send','session_search','supervisor_lessons']:
   self.assertIsNone(ns['block'](tool,{}),tool)
  for tool in ['cronjob','wizard_schedule','wizard_schedule_list','kanban_add','delegate_task','wizard_heavy_submit','send_message','mcp__wizard__wizard_schedule','mcp_wizard_wizard_schedule_cancel','mcp_wizard_supervisor_report','mcp_wizard_session_history_write']:
   self.assertEqual(ns['block'](tool,{})['action'],'block',tool)
  self.assertEqual(ns['block']('tool_call',{'name':'wizard_heavy_submit'})['action'],'block')
  self.assertEqual(ns['block']('tool_call',{'calls':[{'name':'mcp_wizard_wizard_schedule','arguments':{}}]})['action'],'block')
 def test_export_copies_entire_synthetic_home_except_durable_transcripts_caches_and_links(self):
  with tempfile.TemporaryDirectory() as d,tempfile.TemporaryDirectory() as out:
   root=Path(d)
   for name in ['config.yaml','.env','skills/test/SKILL.md','plugins/test/__init__.py','memories/MEMORY.md','memory/facts.db','auth.json','state.db','logs/x','sessions/x','response_store.db','cache/x','cron/output/x']:
    p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('synthetic')
   (root/'escape').symlink_to('/etc/passwd')
   archive=subprocess.check_output([sys.executable,'-c',EXPORT.replace("root='/opt/data'",'root='+repr(d))])
   subprocess.run(['tar','-x','-C',out],input=archive,check=True)
   files={str(p.relative_to(out)) for p in Path(out).rglob('*') if p.is_file()}
   self.assertEqual(files,{'config.yaml','.env','skills/test/SKILL.md','plugins/test/__init__.py','memories/MEMORY.md','memory/facts.db','auth.json'})
 def test_sqlite_backup_includes_wal_and_skips_only_oversize_history(self):
  with tempfile.TemporaryDirectory() as d:
   path=Path(d)/'state.db'
   with sqlite3.connect(path) as db:
    db.execute('pragma journal_mode=wal');db.execute('create table x(value)');db.execute("insert into x values ('synthetic-history')");db.commit()
    script=SNAPSHOT.replace("p='/opt/data/state.db'",'p='+repr(str(path)))
    data=subprocess.check_output([sys.executable,'-c','LIMIT=1000000\n'+script]);(Path(d)/'copy.db').write_bytes(data);copy=sqlite3.connect(Path(d)/'copy.db')
    self.assertEqual(copy.execute('select value from x').fetchone()[0],'synthetic-history')
    self.assertEqual(subprocess.check_output([sys.executable,'-c','LIMIT=1\n'+script]),b'')
 def test_install_preserves_configuration_and_enables_policy_in_ram(self):
  import yaml
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'config.yaml').write_text(yaml.safe_dump({'toolsets':['all'],'mcp_servers':{'synthetic':{'command':'synthetic'}},'model':{'provider':'tinfoil','fallbacks':['local']},'plugins':{'enabled':['synthetic']}}));(root/'.env').write_text('AUTH=synthetic\n')
   script=INSTALL.replace("pathlib.Path('/opt/data')",'pathlib.Path('+repr(d)+')').replace('from gateway.config import Platform',"from types import SimpleNamespace\nPlatform=[SimpleNamespace(value=x) for x in ['api_server','telegram']]")
   result=subprocess.check_output([sys.executable,'-c',script],input=json.dumps({'key':'synthetic-new','environment':{},'policy':POLICY}).encode())
   cfg=yaml.safe_load((root/'config.yaml').read_text());self.assertEqual(cfg['toolsets'],['all']);self.assertIn('synthetic',cfg['mcp_servers']);self.assertEqual(cfg['model']['fallbacks'],['local'])
   self.assertIn('synthetic',cfg['plugins']['enabled']);self.assertIn('wizard-incognito-policy',cfg['plugins']['enabled']);self.assertEqual(json.loads(result)['history_search'],'unavailable')
 def test_stream_copy_is_bounded_binary_pipe_not_archive_file(self):
  with patch('incognito_runtime._docker_command',lambda a:a):
   result=stream_copy([sys.executable,'-c',"import sys;sys.stdout.buffer.write(b'x'*4096)"],[sys.executable,'-c','import sys;assert len(sys.stdin.buffer.read())==4096'],8192)
   self.assertEqual(result,4096)
   with self.assertRaises(ValueError):stream_copy([sys.executable,'-c',"print('x'*4096)"],[sys.executable,'-c','import sys;sys.stdin.buffer.read()'],100)
 def test_concurrent_start_and_orphan_recovery_remain_single_session(self):
  import threading
  r=Rig();r.names.append('synthetic-orphan');m=r.manager();self.assertFalse(r.names)
  successes=[];errors=[]
  def start():
   try:successes.append(m.start(AGENT,SID))
   except Failure as err:errors.append(err.code)
  workers=[threading.Thread(target=start) for _ in range(2)]
  for worker in workers:worker.start()
  for worker in workers:worker.join()
  self.assertEqual(len(successes),1);self.assertEqual(errors,['incognito_already_active'])
  r.names.append('synthetic-late-orphan');m.sweep();self.assertEqual(len(r.names),1);m.close();self.assertFalse(r.names)
 def _http_routes(self,runtipi=False):
  import agent_runtime as runtime,threading,http.client,types
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);agents=runtime.Agents(root,None);(root/'synthetic').mkdir();(root/'synthetic/agent.json').write_text(json.dumps(AGENT))
   if runtipi:
    wam=types.ModuleType('wam');wam.cli=object();wam.private=object()
    with patch.dict(sys.modules,{'wam':wam}),patch.object(sys,'path',list(sys.path)):
     driver=runtime.RuntipiDriver(agents,runtime.DEFAULT_IMAGE,runtime.DEFAULT_PROXY_IMAGE,root/'fake-wam','alongside')
   else:driver=runtime.ComposeDriver(agents,runtime.DEFAULT_IMAGE,runtime.DEFAULT_PROXY_IMAGE)
   rig=Rig();rig.driver=driver;m=rig.manager();handler=runtime.make_handler('test-token',agents,driver,incognito_manager=m)
   server=runtime.ThreadingHTTPServer(('127.0.0.1',0),handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
   try:
    with patch.object(driver,'apply',side_effect=AssertionError('must not restart normal agent')):
     for action in ('start','lease','stop','stop'):
      conn=http.client.HTTPConnection(*server.server_address);conn.request('POST','/agents/synthetic/incognito/'+action,json.dumps({'session_id':SID}),{'Authorization':'Bearer test-token','Content-Type':'application/json'});response=conn.getresponse();value=json.loads(response.read());self.assertEqual(response.status,200,value);self.assertTrue(value['ok']);conn.close()
     self.assertFalse(rig.names)
   finally:server.shutdown();m.close();server.server_close();thread.join(timeout=2)
 def test_real_compose_driver_http_routes(self):self._http_routes()
 def test_real_runtipi_driver_http_routes(self):self._http_routes(True)
 def test_protocol_fixture_never_invents_memory_or_tool_results(self):
  import ast
  path=Path(__file__).resolve().parents[2]/'scripts/incognito-provider-fixture.py'
  tree=ast.parse(path.read_text());tree.body.pop();ns={};exec(compile(tree,str(path),'exec'),ns)
  def answer(messages,tools=[]):
   handler=object.__new__(ns['Handler']);body=json.dumps({'messages':messages,'tools':tools}).encode();handler.headers={'content-length':str(len(body))};handler.rfile=io.BytesIO(body);handler.wfile=io.BytesIO();handler.send_response=lambda *_:None;handler.send_header=lambda *_:None;handler.end_headers=lambda:None
   handler.do_POST();return json.loads(handler.wfile.getvalue())['choices'][0]['message']
  result=answer([{'role':'user','content':'what is my animal?'}]);self.assertEqual(result['content'],'MEMORY_NOT_PRESENT\n')
  result=answer([{'role':'system','content':'Synthetic identity animal: otter'},{'role':'user','content':'CALL_SYNTHETIC INC-'+'a'*40}],tools=[{'type':'function','function':{'name':'mcp_synthetic_echo','parameters':{}}}]);self.assertEqual(result['tool_calls'][0]['function']['name'],'mcp_synthetic_echo')
  result=answer([{'role':'system','content':'Synthetic identity animal: otter'},{'role':'user','content':'read only'},{'role':'tool','content':'real synthetic tool output'}]);self.assertEqual(result['content'],'otter\nreal synthetic tool output')
if __name__=='__main__':unittest.main()
