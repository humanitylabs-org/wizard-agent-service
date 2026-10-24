from pathlib import Path
import sys,json,subprocess,urllib.request,urllib.error
assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers'
R=Path('/home/rig/pp-launch-3');O=Path('/home/rig/.wizard-os');A=O/'agents/pp-test-legacy'
# Product-created legacy fixture, no inference.
if not A.exists():
 p=subprocess.run(['python3',str(R/'guest.py'),'baseline'],capture_output=True); print('BASELINE',p.returncode); assert p.returncode==0
key=(A/'runtime.key').read_text().strip()
record=json.loads((A/'agent.json').read_text());print('RECORD',json.dumps({k:record.get(k) for k in ['id','runtime','model']}))
import time
for _ in range(60):
 try:
  with urllib.request.urlopen('http://127.0.0.1:'+str(record['runtime']['port'])+'/health',timeout=2) as f: print('HEALTH',f.status);break
 except:time.sleep(2)
for path in ['/api/sessions','/api/sessions/wizard_pp_missing','/v1/models']:
 q=urllib.request.Request('http://127.0.0.1:'+str(record['runtime']['port'])+path,headers={'Authorization':'Bearer '+key})
 try:
  with urllib.request.urlopen(q,timeout=10) as f: print(path,f.status,f.read(1000).decode())
 except urllib.error.HTTPError as e:print(path,e.code,e.read(1000).decode())
 except Exception as e:print(path,type(e).__name__,str(e))
proof=(O/'agent-runtime/owner-proof').read_text().strip()
def service(path,body):
 q=urllib.request.Request('http://127.0.0.1:8787'+path,json.dumps(body).encode(),{'Content-Type':'application/json','x-wizard-owner-proof':proof},method='POST')
 try:
  with urllib.request.urlopen(q,timeout=60) as f:return f.status,json.load(f)
 except urllib.error.HTTPError as e:return e.code,json.load(e)
for label,body in [('fabricated',{'id':'wizard_pp_diagnose_missing','source':'wizard-mobile'}),('server-minted',{'source':'wizard-mobile','title':'pp-legacy-fix synthetic history'})]:
 c,b=service('/wizard/hermes/api/sessions?agent=pp-test-legacy',body); print('SESSION',label,c,json.dumps(b)[:1000])
 if label=='fabricated':assert c==503 and b.get('error')=='agent_unavailable' and b.get('check')=='agent.history'
 if label=='server-minted':
  assert c in [200,201] and (b.get('session') or b).get('id');(R/'minted-session.json').write_text(json.dumps(b))
ids=subprocess.check_output(['docker','ps','-aq','--filter','label=com.docker.compose.service=agent-pp-test-legacy'],text=True).split()
if ids:
 c=json.loads(subprocess.check_output(['docker','inspect',ids[0]]))[0];print('CONTAINER',json.dumps({'name':c['Name'],'image':c['Config']['Image'],'ports':c['NetworkSettings']['Ports'],'user':c['Config']['User'],'mounts':[{k:m.get(k) for k in ['Type','Source','Destination','RW']} for m in c['Mounts']],'env_names':[e.split('=')[0] for e in c['Config']['Env']]}))
