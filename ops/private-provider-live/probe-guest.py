#!/usr/bin/env python3
"""Synthetic rig request adapter: completed=0, visible provider closure=42."""
import json,sys,time,urllib.request,urllib.error,re
from pathlib import Path
assert Path('/etc/pp-rig').read_text().strip()=='pp-private-providers'
H=Path('/home/rig');R=H/'pp-launch-3';O=H/'.wizard-os';agent=sys.argv[1];assert agent.startswith('pp-test-')
proof=(O/'agent-runtime/owner-proof').read_text().strip()
stage='session';c=0;b={}
def fail(rc):
 error=b.get('error','')
 if isinstance(error,dict):error={k:v for k,v in error.items() if k in ['code','field']}
 doc={'stage':stage,'http':c,'exit':rc,'error':error,'state':b.get('status') or b.get('state')}
 # Only synthetic route/error metadata; never request or model response bodies.
 text=json.dumps(doc)
 assert not re.search('TINFOIL_API_KEY|Bearer ',text)
 (R/('probe-failure-'+agent+'.json')).write_text(text+'\n')
 print('PROBE_FAILURE',text,flush=True);sys.exit(rc)
def req(path,body=None):
 q=urllib.request.Request('http://127.0.0.1:8787'+path,json.dumps(body).encode() if body is not None else None,{'Content-Type':'application/json','x-wizard-owner-proof':proof},method='POST' if body is not None else 'GET')
 try:
  with urllib.request.urlopen(q,timeout=120) as f:return f.status,json.load(f)
 except urllib.error.HTTPError as e:
  try:data=json.load(e)
  except:data={}
  return e.code,data
codeword=(R/'codeword').read_text().strip()
c,b=req('/wizard/hermes/api/sessions?agent='+agent,{'source':'wizard-mobile','title':'Synthetic privacy '+__import__('uuid').uuid4().hex})
if c==503 and b.get('error')=='private_provider_unavailable':sys.exit(42)
if c not in [200,201]:fail(7)
session=(b.get('session') or b).get('id') or b.get('session_id')
if not session:fail(8)
stage='run-admission'
c,b=req('/wizard/hermes/v1/runs?agent='+agent,{'session_id':session,'agent':agent,'input':'Reply with only PP_OK. Do not use tools. Unique test codeword to ignore: '+codeword})
if c==503 and b.get('error')=='private_provider_unavailable':sys.exit(42)
if c not in [200,202]:fail(1)
rid=b.get('run_id') or b.get('id')
if not rid:fail(2)
stage='run-poll'
for _ in range(180):
 c,b=req('/wizard/hermes/v1/runs/'+rid+'?agent='+agent)
 if c!=200:fail(3)
 state=b.get('status') or b.get('state')
 if state in ['completed','done','succeeded']:
  if 'PP_OK' not in json.dumps(b):
   c,m=req('/wizard/hermes/api/sessions/'+session+'/messages?agent='+agent)
   if c!=200 or 'PP_OK' not in json.dumps(m):fail(4)
  (R/('trigger-'+agent+'.json')).write_text(json.dumps({'completed':True,'session_id':session,'run_id':rid})+'\n');sys.exit(0)
 if state in ['failed','error','cancelled']:
  fail(42 if 'private_provider_unavailable' in json.dumps(b) else 5)
 time.sleep(2)
fail(6)
