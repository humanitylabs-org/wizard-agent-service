"""Six owner-run privacy checks. Only attempt-owned probe containers are read.

No sudo, agent-directory traversal, Private prompt, or Private container-data read.
The relay capture helper joins ONLY the throwaway client's network namespace and
has NET_RAW but no data mounts; only capture counters leave its process.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import time
from types import SimpleNamespace
import urllib.error
import urllib.request
import uuid

CAPTURE=r'''import json,select,socket,struct,sys,threading
word=sys.argv[1].encode();stop=threading.Event();threading.Thread(target=lambda:(sys.stdin.buffer.read(),stop.set()),daemon=True).start()
s=socket.socket(socket.AF_PACKET,socket.SOCK_RAW,socket.htons(3));s.settimeout(1);flows={};packets=0
print('READY',flush=True)
while not stop.is_set():
 try:b=s.recv(65535)
 except socket.timeout:continue
 packets+=1
 if len(b)<54 or b[12:14]!=b'\x08\x00':continue
 ip=b[14:];ihl=(ip[0]&15)*4
 if ip[9]!=6 or len(ip)<ihl+20:continue
 tcp=ip[ihl:];thl=(tcp[12]>>4)*4;payload=tcp[thl:]
 if not payload:continue
 flow=(ip[12:16],ip[16:20],tcp[:4]);seq=int.from_bytes(tcp[4:8],'big');flows.setdefault(flow,{})[seq]=payload
recv,drops=struct.unpack('II',s.getsockopt(263,6,8));s.close();header=False;streams=0
for chunks in flows.values():
 data=bytearray();end=None
 for seq,payload in sorted(chunks.items()):
  if end is None:end=seq
  assert seq<=end,'capture TCP gap'
  skip=end-seq
  if skip<len(payload):data.extend(payload[skip:]);end=seq+len(payload)
 assert word not in data,'codeword escaped seal'
 header|=b'ehbp-encapsulated-key:' in data.lower();streams+=1
assert drops==0 and packets and streams and header,'incomplete or missing EHBP capture'
print(json.dumps({'packets':packets,'drops':drops,'streams':streams,'ehbp_header':header,'codeword_absent':True}),flush=True)
'''
SCAN=r'''import sys,os,json
from pathlib import Path
needle=sys.stdin.buffer.read();assert needle
count=0;matches=0
for d,dirs,names in os.walk(sys.argv[1],followlinks=False):
 for n in names:
  p=Path(d)/n
  if p.is_symlink() and not p.is_file():continue
  if not p.is_file():continue
  count+=1;over=b''
  with p.open('rb') as f:
   while chunk:=f.read(1048576):
    chunk=over+chunk;matches+=int(needle in chunk);over=chunk[-max(64,len(needle)):]
print(json.dumps({'files':count,'matches':matches}))
'''

def run(argv,timeout=180,input=None):
    p=subprocess.run(argv,capture_output=True,input=input,timeout=timeout)
    if p.returncode:raise RuntimeError('acceptance command failed: '+argv[0]+' (output withheld)')
    return p.stdout

def cid(project,service):
    ids=run(['docker','ps','-q','--filter','label=com.docker.compose.project='+project,'--filter','label=com.docker.compose.service='+service]).decode().split()
    if len(ids)!=1:raise RuntimeError('acceptance container identity ambiguous')
    return ids[0]

class Owner:
    def __init__(self,home,origin,proof_file,root,attempt):
        self.home=Path(home);self.origin=origin.rstrip('/');self.proof=Path(proof_file).read_text().strip();self.root=Path(root);self.attempt=attempt
        self.prefix='pp-live-'+attempt[:8]+'-';self.probe=self.prefix+'probe';self.other=self.prefix+'other';self.word='PP_CIPHER_'+uuid.uuid4().hex
    def request(self,path,body=None,method=None):
        q=urllib.request.Request(self.origin+path,json.dumps(body).encode() if body is not None else None,{'Content-Type':'application/json','x-wizard-owner-proof':self.proof},method=method)
        try:
            with urllib.request.urlopen(q,timeout=240) as f:return f.status,json.load(f)
        except urllib.error.HTTPError as e:
            try:reply=json.load(e)
            except ValueError:reply={}
            return e.code,reply
    def require(self,path,body=None,method=None,allowed=(200,)):
        code,result=self.request(path,body,method)
        if code not in allowed:raise RuntimeError('owner API rejected '+path.split('?')[0]+' HTTP '+str(code))
        return result
    def ready(self,aid):
        deadline=time.monotonic()+180
        while time.monotonic()<deadline:
            code,_=self.request('/wizard/hermes/api/sessions?agent='+aid)
            if code==200:return
            time.sleep(1)
        raise RuntimeError('canonical history readiness timed out')
    def create(self,kind='probe'):
        aid=self.prefix+kind
        before=self.require('/wizard/v1/agents').get('agents',[])
        if any(a.get('id')==aid for a in before):raise RuntimeError('foreign throwaway agent collision')
        data=self.require('/wizard/v1/agents',{'label':aid,'harness':'hermes','permissions':{'preset':'private' if kind=='probe' else 'standard','read_standard_chats':False},'model':{'provider':'wizard-tinfoil','model':'glm-5-3','allowed_models':['glm-5-3','deepseek-v4-1-flash'],'fallback':False}},'POST',(201,))
        if data['agent']['id']!=aid:raise RuntimeError('throwaway agent identity changed')
        self.ready(aid);return aid
    def chat(self,aid):
        if not aid.startswith(self.prefix):raise RuntimeError('production inference is limited to attempt-owned throwaway agents')
        code,body=self.request('/wizard/hermes/api/sessions?agent='+aid,{'source':'wizard-mobile','title':'Private provider proof '+uuid.uuid4().hex},'POST')
        if code==503 and body.get('error')=='private_provider_unavailable':return {'failed_closed':True}
        if code not in (200,201):raise RuntimeError('synthetic session admission failed')
        session=(body.get('session') or body).get('id') or body.get('session_id')
        if not session:raise RuntimeError('synthetic canonical session absent')
        code,body=self.request('/wizard/hermes/v1/runs?agent='+aid,{'session_id':session,'input':'Reply exactly PP_OK. No tools. Ignore this unique codeword: '+self.word},'POST')
        if code==503 and body.get('error')=='private_provider_unavailable':return {'failed_closed':True}
        if code!=202:raise RuntimeError('synthetic run admission failed')
        rid=body['run_id'];deadline=time.monotonic()+240
        while time.monotonic()<deadline:
            code,body=self.request('/wizard/hermes/v1/runs/'+rid+'?agent='+aid)
            state=body.get('status') or body.get('state')
            if code==200 and state in ['done','succeeded','completed']:
                messages=self.require('/wizard/hermes/api/sessions/'+session+'/messages?agent='+aid)
                if 'PP_OK' not in json.dumps(messages):raise RuntimeError('synthetic completed reply not verified')
                return {'completed':True,'session_id':session,'run_id':rid}
            if state in ['failed','error','cancelled']:
                if 'private_provider_unavailable' in json.dumps(body):return {'failed_closed':True}
                raise RuntimeError('synthetic terminal inference failure')
            time.sleep(1)
        raise RuntimeError('synthetic inference timeout')
    def ids(self,aid):
        if not aid.startswith(self.prefix):raise RuntimeError('container data scope rejected')
        return cid('agent-'+aid,'agent'),cid('agent-'+aid,'agent-'+aid+'-client')
    def privacy(self,check_file,source_file):
        self.create();main,client=self.ids(self.probe);provider=cid('wizard-tinfoil_private_wizardapps','wizard-tinfoil')
        spec=importlib.util.spec_from_file_location('acceptance_checks',check_file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        a=SimpleNamespace(agent=self.probe,provider_app='wizard-tinfoil',hermes_container=main,client_container=client,provider_container=[provider],relay_port=8090,deny_url=[])
        m.hermes(a);m.client(a)
        image=run(['docker','image','inspect','restricted-agent-sidecars:local','--format','{{.Id}}']).decode().strip()
        cap=subprocess.Popen(['docker','run','--rm','-i','--read-only','--cap-drop','ALL','--cap-add','NET_RAW','--network','container:'+client,'--user','0:0','--entrypoint','python3',image,'-u','-c',CAPTURE,self.word],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            import select
            if not select.select([cap.stdout],[],[],20)[0] or cap.stdout.readline().strip()!=b'READY':raise RuntimeError('private capture helper not ready')
            completed=self.chat(self.probe)
            if not completed.get('completed'):raise RuntimeError('capture request did not complete')
        finally:
            cap.stdin.close();cap.stdin=None
            out,err=cap.communicate(timeout=30)
        if cap.returncode:raise RuntimeError('private relay capture did not verify')
        capture=json.loads(out)
        source=''
        for line in Path(source_file).read_text().splitlines():
            if line.startswith('TINFOIL_API_KEY='):source=line.split('=',1)[1].strip().strip('\"\'')
        if not source:raise RuntimeError('host legacy source missing')
        shared=[]
        candidates=[self.home/'.hermes/config.yaml',self.home/'.hermes/.env',self.home/'.wizard-os/apps.json']
        for folder in [self.home/'.wizard-os/agent-runtime',self.home/'.wizard-os/agent-clients']:
            if folder.exists():candidates.extend(p for p in folder.rglob('*') if p.is_file() and not p.is_symlink())
        for path in candidates:
            if not path.is_file() or path.resolve()==Path(source_file).resolve():continue
            shared.append(path)
            overlap=b''
            with path.open('rb') as f:
                while chunk:=f.read(1048576):
                    chunk=overlap+chunk
                    if source.encode() in chunk:raise RuntimeError('credential bytes reached shared Hermes/client configuration')
                    overlap=chunk[-max(64,len(source)):]
        # Read only THIS throwaway home and its client. No host agents/ scan.
        scan=json.loads(run(['docker','exec','-i',main,'/opt/hermes/.venv/bin/python','-c',SCAN,'/opt/data'],input=source.encode()))
        if scan['matches']:raise RuntimeError('credential bytes reached throwaway home')
        for ident in [main,client]:
            doc=run(['docker','inspect',ident])
            if source.encode() in doc:raise RuntimeError('credential bytes reached throwaway metadata')
        provider_scan=json.loads(run(['docker','exec','-i',provider,'python','-c',SCAN,'/data'],input=source.encode()))
        if provider_scan['matches']<1:raise RuntimeError('provider credential location unproven')
        # Provider canary scans use provider-owned data and docker logs only; no
        # Private-container data or unrelated app-data is touched.
        logs=run(['docker','logs',provider])
        if self.word.encode() in logs:raise RuntimeError('codeword in provider logs')
        word_scan=json.loads(run(['docker','exec','-i',provider,'python','-c',SCAN,'/data'],input=self.word.encode()))
        if word_scan['matches']:raise RuntimeError('codeword in provider data')
        baseline=self.chat(self.probe)
        if not baseline.get('completed'):raise RuntimeError('fail-closed baseline request failed')
        try:
            run(['docker','stop','--time','10',provider],timeout=60)
            closed=self.chat(self.probe)
            if not closed.get('failed_closed'):raise RuntimeError('stopped provider did not fail closed')
        finally:run(['docker','start',provider],timeout=60)
        deadline=time.monotonic()+90
        while time.monotonic()<deadline:
            try:
                with urllib.request.urlopen('http://127.0.0.1:18804/api/connection',timeout=3) as f:
                    if json.load(f).get('status')=='connected':break
            except Exception:pass
            time.sleep(1)
        recovery=self.chat(self.probe)
        if not recovery.get('completed'):raise RuntimeError('provider restart did not recover probe')
        return {'checks_passed':6,'checks':dict.fromkeys(['hermes','client','relay','key-location','codeword','stop-provider'],'passed'),'capture':capture,'completed_request':completed,'recovered_request':recovery,'private_home_read':False,'shared_configuration_files_scanned':len(shared)}
    def regression(self):
        aid=self.create('other');chat=self.chat(aid)
        if not chat.get('completed'):raise RuntimeError('other synthetic agent chat failed')
        main,_=self.ids(aid)
        code="import asyncio,json;from pathlib import Path;from PIL import Image;from tools.vision_tools import vision_analyze_tool\np=Path('/opt/data/pp-red.png');Image.new('RGB',(64,64),(255,0,0)).save(p)\nr=json.loads(asyncio.run(vision_analyze_tool(str(p),'What is the dominant solid colour? Reply with the colour name only.')))\nassert r.get('success') and 'red' in str(r.get('analysis','')).lower();print(json.dumps({'success':True,'colour':'red'}))"
        vision=json.loads(run(['docker','exec','-w','/opt/hermes',main,'/opt/hermes/.venv/bin/python','-c',code],timeout=240))
        return {'other_agent_chat_completed':True,'vision_helper_completed':vision.get('success') is True,'colour':vision['colour'],'vision_model':'deepseek-v4-1-flash'}
    def cleanup(self):
        rows=self.require('/wizard/v1/agents').get('agents',[])
        for aid in [self.probe,self.other]:
            if any(a.get('id')==aid for a in rows):self.require('/wizard/v1/agents/'+aid,method='DELETE',allowed=(200,204))
            left=run(['docker','ps','-aq','--filter','label=com.docker.compose.project=agent-'+aid]).decode().split()
            if left:raise RuntimeError('throwaway runtime survived owner DELETE')
        return {'remaining_synthetic_containers':[],'owner_delete_readback':True}
