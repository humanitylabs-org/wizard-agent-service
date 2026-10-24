"""Additional exact-target acceptance steps, disposable pp-rig only."""
from pathlib import Path
import os,sys,json,subprocess,urllib.request,urllib.error,time,hashlib
assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers' and os.geteuid()==1000
R=Path('/home/rig/pp-launch-3');O=Path('/home/rig/.wizard-os');A=O/'agents'
proof=(O/'agent-runtime/owner-proof').read_text().strip()
def req(path,body=None,method=None):
 q=urllib.request.Request('http://127.0.0.1:8787'+path,json.dumps(body).encode() if body is not None else None,{'Content-Type':'application/json','x-wizard-owner-proof':proof},method=method)
 try:
  with urllib.request.urlopen(q,timeout=180) as f:return f.status,json.load(f)
 except urllib.error.HTTPError as e:return e.code,json.load(e)
def run(args,timeout=240):
 p=subprocess.run(args,capture_output=True,timeout=timeout)
 if p.returncode:
  (R/'extra-command.log').write_bytes(p.stdout+p.stderr);(R/'extra-command.log').chmod(0o600)
  raise RuntimeError('synthetic command failed; output withheld')
 return p.stdout
def save(name,data):
 p=R/(name+'.json');p.write_text(json.dumps(data,indent=2)+'\n');p.chmod(0o600);print(name,json.dumps(data),flush=True)
def running(aid):
 for _ in range(90):
  c,b=req('/wizard/v1/agents/'+aid)
  if c==200 and b['agent']['status']=='running':return
  time.sleep(2)
 raise RuntimeError('agent readiness failed: '+aid)
def containers():
 ids=run(['docker','ps','-aq']).decode().split()
 return json.loads(run(['docker','inspect',*ids])) if ids else []
def hermes(aid):
 docs=containers();selected=[c for c in docs if c['State']['Running'] and any(m.get('Source')==str(A/aid/'home') and m.get('Destination')=='/opt/data' for m in c['Mounts'])];assert len(selected)==1
 return selected[0]
phase=sys.argv[1]
if phase=='verify-migrated':
 aid='pp-test-legacy';running(aid)
 checkpoint=json.loads((R/'legacy-checkpoint.json').read_text());d=A/aid;st=(d/'home').stat();record=json.loads((d/'agent.json').read_text())
 assert [st.st_uid,st.st_gid]==[1000,1000] and st.st_ino==checkpoint['inode'] and record['runtime']['uid']==record['runtime']['gid']==1000 and record['runtime']['private_client'] is True
 session=json.loads((R/('chat-'+aid+'.json')).read_text())['session_id'];c,b=req('/wizard/hermes/api/sessions/'+session+'/messages?agent='+aid);assert c==200 and 'PP_OK' in json.dumps(b)
 main=hermes(aid);assert main['Config']['User']=='1000:1000';assert all(not e.startswith('TINFOIL_API_KEY=') for e in main['Config']['Env'])
 networks=main['NetworkSettings']['Networks'];assert networks
 for n in networks:assert json.loads(run(['docker','network','inspect',n]))[0]['Internal'] is True
 clients=[x for x in containers() if (x['Config'].get('Labels') or {}).get('com.docker.compose.service')=='agent-'+aid+'-client' and x['State']['Running']];assert len(clients)==1
 for n in clients[0]['NetworkSettings']['Networks']:assert json.loads(run(['docker','network','inspect',n]))[0]['Internal'] is True
 run(['python3',str(R/'probe-guest.py'),aid],timeout=420)
 # A completed EHBP inference requires the client attestation gate; retain route/topology evidence.
 save('d-verified',{'home_inode_retained':True,'uid':1000,'gid':1000,'history_readback':True,'completed_migrated_request':True,'internal_networks_only':True,'no_legacy_key':True,'client_image':clients[0]['Config']['Image']})
elif phase=='regression':
 aid='pp-test-other'
 c,b=req('/wizard/v1/agents',{'label':aid,'harness':'hermes','permissions':{'preset':'standard','read_standard_chats':False},'model':{'provider':'wizard-tinfoil','model':'glm-5-3','allowed_models':['glm-5-3','deepseek-v4-1-flash'],'fallback':False}},'POST');assert c==201 and b['agent']['id']==aid
 running(aid);run(['python3',str(R/'probe-guest.py'),aid],timeout=420)
 main=hermes(aid);config=(A/aid/'home/config.yaml').read_text();assert 'auxiliary:\n  vision:\n    provider: custom\n    model: "deepseek-v4-1-flash"' in config and config.count('base_url: "http://agent-'+aid+'-client:3301/v1"')==2
 assert 'TINFOIL_API_KEY' not in config
 code="""import asyncio,json,os\nfrom pathlib import Path\nfrom PIL import Image\nfrom tools.vision_tools import vision_analyze_tool\np=Path('/opt/data/pp-red.png');Image.new('RGB',(64,64),(255,0,0)).save(p)\nr=json.loads(asyncio.run(vision_analyze_tool(str(p),'What is the dominant solid colour? Reply with the colour name only.')))\nassert r.get('success') is True and 'red' in str(r.get('analysis','')).lower(), 'vision result not verified'\nprint(json.dumps({'success':True,'colour':'red','route':'configured auxiliary.vision'}))\n"""
 result=json.loads(run(['docker','exec','-w','/opt/hermes',main['Id'],'/opt/hermes/.venv/bin/python','-c',code],timeout=240));assert result['success']
 save('f-verified',{'other_agent_chat_completed':True,'vision_helper_completed':True,'vision_model':'deepseek-v4-1-flash','vision_route':'same in-seal client','colour':'red'})
elif phase=='remove':
 sys.path.insert(0,'/opt/pp-rig/src/wam');from wam import cli,registry
 from local_projection import projection
 rt=cli.Config().runtipi();urn='wizard-tinfoil_private:wizardapps';rt.uninstall(urn);assert rt.wait_status(urn,{'missing'},timeout=180)=='missing'
 cli.write_registry(cli.Config(),rt)
 assert not any(a.get('id')=='wizard-tinfoil' for a in json.loads((O/'apps.json').read_text()).get('apps',[]))
 aid='pp-test-legacy';c,b=req('/wizard/hermes/api/sessions?agent='+aid,{'source':'wizard-mobile'},'POST');assert c==503 and b.get('error')=='private_provider_unavailable',(c,b)
 c,status=req('/wizard/v1/agents/'+aid);assert c==200 and status['agent'].get('status_detail')=='private_provider_unavailable',status
 record=json.loads((A/aid/'agent.json').read_text());assert record['runtime']['private_client'] is True
 docs=containers();assert not any((x['Config'].get('Labels') or {}).get('com.docker.compose.service')=='agent-'+aid+'-tinfoil' for x in docs)
 for x in docs:
  if (x['Config'].get('Labels') or {}).get('com.docker.compose.service','').startswith('agent-'+aid):assert all(not y.startswith('TINFOIL_API_KEY=') for y in x['Config']['Env'])
 save('e-verified',{'uninstalled':True,'session_http':503,'error':'private_provider_unavailable','visible_status':status['agent']['status_detail'],'sealed_marker_retained':True,'no_plaintext_fallback':True})
else:raise RuntimeError('unknown acceptance phase')
