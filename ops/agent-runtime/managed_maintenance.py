"""Durable external admission/retirement for the owned Mac guest.
The lease is the authority; process samples are only used AFTER launch admission
has closed. Never kill an unmanaged or standalone interactive session.
"""
import contextlib,fcntl,json,os,re,subprocess,time,uuid
from pathlib import Path
STOCK='sha256:666d6c659574fa09c1ea47b7ec5f03e8d2c35a8aa8055fe60c1e2fe3d3e03e9b'
class MaintenanceError(RuntimeError):pass
class ManagedMaintenance:
 def __init__(self,root='/var/lib/wizard/managed'):
  self.root=Path(root);self.root.mkdir(parents=True,exist_ok=True)
  (self.root/'launch').mkdir(exist_ok=True)
  (self.root/'operations').mkdir(exist_ok=True)
  for p in [self.root,self.root/'launch',self.root/'operations']:os.chown(p,1000,1000);os.chmod(p,0o700)
  for name in ['admission.lock','operation.lock']:
   p=self.root/name;p.touch(exist_ok=True);os.chown(p,1000,1000);os.chmod(p,0o600)
 @contextlib.contextmanager
 def lock(self,name):
  with (self.root/name).open('r+') as f:
   fcntl.flock(f,fcntl.LOCK_EX);yield
 def read(self):
  try:return json.loads((self.root/'lease.json').read_text())
  except FileNotFoundError:return None
  except Exception:raise MaintenanceError('maintenance_state_unknown')
 def save(self,data):
  p=self.root/'lease.new'
  with p.open('w') as f:json.dump(data,f);f.flush();os.fsync(f.fileno())
  os.chmod(p,0o600);os.chown(p,1000,1000);p.replace(self.root/'lease.json');self.sync()
 def sync(self):
  fd=os.open(self.root,os.O_RDONLY);os.fsync(fd);os.close(fd)
 def run(self,args,stdin=None,timeout=30):
  p=subprocess.run(args,input=stdin,text=True,capture_output=True,timeout=timeout)
  if p.returncode:raise MaintenanceError('runtime_control_failed')
  return p.stdout
 def containers(self):
  ids=self.run(['docker','ps','-aq']).split()
  if not ids:raise MaintenanceError('runtime_inventory_unknown')
  all_=json.loads(self.run(['docker','inspect',*ids]));found=[]
  for c in all_:
   label=c['Config'].get('Labels') or {};service=label.get('com.docker.compose.service','')
   managed=label.get('ai.wizards.managed-launch')=='1'
   # The shipped Parakeet worker reuses this image for Python/ffmpeg, not Hermes.
   # Its immutable, audited entrypoint has no agent launch path. Keep its existing
   # no-new-privileges/cap-drop sandbox; never replace it with the Hermes launcher.
   if service=='transcriber-engine' and c['Image']==STOCK and c['Config'].get('Entrypoint')==['sh','/voice/start.sh']:
    expected=['4ebecc27d764040668699455e35793bb58f7c556f1283ca0275a7bc9e623f514','fa03c1ec7cbb7cf25fb855c41f5963af1ecee557046e49aaf86bf65908ea5955']
    hashes=self.run(['docker','exec','-u','1000',c['Id'],'sha256sum','/voice/engine.py','/voice/start.sh']).splitlines() if c['State']['Running'] else []
    if [x.split()[0] for x in hashes]==expected:continue
   # Includes stock secondary runtimes (e.g. transcriber), not only the main agent.
   candidate=managed or c['Image']==STOCK or service in ['hermes-agent-engine','transcriber-engine'] or (service.startswith(('wizard-agent-','agent-')) and not service.endswith('-tinfoil')) or 'hermes' in c['Config'].get('Image','')
   if candidate:found.append({'id':c['Id'],'name':c['Name'].lstrip('/'),'hostname':c['Config']['Hostname'],'managed':managed,'image':c['Image'],'running':c['State']['Running']})
  if not found:raise MaintenanceError('runtime_inventory_unknown')
  return found
 def reservations(self):
  return {name for c in self.containers() if c['managed'] and c['running'] for name in self.control(c,'snapshot')['reservations']}
 def control(self,c,action,**kw):
  # private interpreter is root-only; normal Docker exec/CLI uses the guard.
  # Original stock uv interpreter is index zero in the pinned two-inode image.
  args=['docker','exec','-i','-u','0','-e','PYTHONPATH=/opt/hermes:/opt/hermes/.venv/lib/python3.13/site-packages',c['id'],'/opt/wizard-managed/private/0/bin/python3.13','/opt/wizard-managed/control.py']
  proc=subprocess.run(args,input=json.dumps({'action':action,**kw}),text=True,capture_output=True,timeout=30)
  try:result=json.loads(proc.stdout)
  except ValueError:raise MaintenanceError('runtime_control_failed')
  if 'error' in result:raise MaintenanceError(result['error'])
  if proc.returncode:raise MaintenanceError('runtime_control_failed')
  return result
 def acquire(self,token):
  if not re.fullmatch(r'[a-fA-F0-9-]{36}',token or ''):raise MaintenanceError('invalid_maintenance_token')
  with self.lock('operation.lock'):
   with self.lock('admission.lock'):
    old=self.read()
    if old:
     if old['token']!=token:raise MaintenanceError('maintenance_token_mismatch')
     if old['phase']=='held':return self.receipt(old)
     # An interrupted acquiring/releasing transaction is never guessed complete.
     raise MaintenanceError('maintenance_recovery_required_cancel_with_same_token')
    for p in (self.root/'operations').iterdir():
     with p.open() as f:
      try:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
      except BlockingIOError:raise MaintenanceError('runtime_operation_in_flight')
    lease={'token':token,'phase':'acquiring','created':time.time(),'runtimes':[],'containers':[]}
    self.save(lease)
   try:
    cs=self.containers();lease['containers']=cs;self.save(lease)
    for c in cs:
     if not c['managed']:
      if c['running']:
       raise MaintenanceError('unmanaged_session_busy_close_Hermes_sessions_and_retry' if c['image']==STOCK else 'unknown_runtime_fail_closed')
      continue
     if not c['running']:continue
     rows=self.control(c,'snapshot')['processes']
     for r in rows:
      if not r['managed']:raise MaintenanceError('unmanaged_session_busy_close_Hermes_sessions_and_retry')
      if r['role']=='session':raise MaintenanceError('standalone_session_busy_close_CLI_or_TUI_and_retry')
      lease['runtimes'].append({'container':c,**r})
    daemon_reservations={r['container']['hostname']+'-'+str(r['pid']) for r in lease['runtimes']}
    if self.reservations()-daemon_reservations:
     raise MaintenanceError('standalone_session_busy_close_CLI_or_TUI_and_retry')
    self.save(lease)
    # Drain every gateway before any irreversible backend commit or process stop.
    for r in lease['runtimes']:
     if r['role']=='gateway':self.control(r['container'],'gateway',runtime=r,verb='drain')
    for r in lease['runtimes']:
     if r['role']!='gateway':continue
     for _ in range(30):
      status=self.control(r['container'],'gateway',runtime=r,verb='status')
      if status.get('answering_pid')!=r['pid']:raise MaintenanceError('gateway_identity_unknown')
      if status.get('active_agents',-1)!=0:raise MaintenanceError('agent_busy_finish_current_work_and_retry')
      if status.get('gateway_state')=='draining':break
      time.sleep(.1)
     else:raise MaintenanceError('gateway_drain_ack_unknown')
     r['drainAcknowledged']=True;self.save(lease)
    for r in lease['runtimes']:
     if r['role']!='backend':continue
     result=self.control(r['container'],'backend',verb='prepare')
     if result.get('ok') is not True or not result.get('token'):raise MaintenanceError('backend_busy_or_unknown')
     r['permit']=result['token'];self.save(lease)
    for r in lease['runtimes']:
     if r['role']=='backend':
      result=self.control(r['container'],'backend',verb='commit',body={'token':r['permit']})
      if result.get('ok') is not True:raise MaintenanceError('backend_retirement_failed')
      r['committed']=True;self.save(lease)
    for r in lease['runtimes']:
     if r['role']=='gateway':
      ack=self.control(r['container'],'gateway',runtime=r,verb='pause-for-update')
      if ack.get('pid')!=r['pid'] or not (ack.get('pausing') or ack.get('already_stopping')):raise MaintenanceError('gateway_stop_ack_unknown')
     else:self.control(r['container'],'stop-backend',runtime=r)
    for _ in range(100):
     rows=[r for c in cs if c['running'] for r in self.control(c,'snapshot')['processes']]
     if not rows and not self.reservations():break
     time.sleep(.1)
    else:raise MaintenanceError('runtime_did_not_retire')
    lease['phase']='held';self.save(lease);return self.receipt(lease)
   except Exception:
    # Compensation is token-owned; if any step fails the durable fence stays closed.
    self._release(token)
    raise
 def receipt(self,lease):
  return {'token':lease['token'],'phase':lease['phase'],'agents':[c['name'] for c in lease['containers']],'known':True,'active':0}
 def release(self,token):
  with self.lock('operation.lock'):return self._release(token)
 def _release(self,token):
  lease=self.read();resume=self.root/'resume.json'
  if lease is None:
   if not resume.exists():return {'ok':True}
   lease=json.loads(resume.read_text())
  if lease['token']!=token:raise MaintenanceError('maintenance_token_mismatch')
  current={c['name']:c for c in self.containers()}
  for r in lease['runtimes']:
   name=r['container']['name']
   if name not in current or not current[name]['managed']:raise MaintenanceError('runtime_replacement_unknown')
   r['container']=current[name]
  if self.read():
   lease['phase']='releasing';self.save(lease)
   for r in lease['runtimes']:
    c=r['container']
    if not c['running']:raise MaintenanceError('runtime_restart_required_before_release')
    if r['role']=='gateway':self.control(c,'clear-drain',home=r['home'])
    elif r.get('permit'):
     if not self.control(c,'alive',runtime=r)['alive']:continue
     if r.get('committed'):
      # Commit cannot be cancelled; replace this proven-idle backend.
      self.control(c,'stop-backend',runtime=r)
     else:self.control(c,'backend',verb='cancel',body={'token':r['permit']})
   with resume.open('w') as f:json.dump(lease,f);f.flush();os.fsync(f.fileno())
   os.chmod(resume,0o600);self.sync()
   # The sole reopening edge: explicit token release, never restart or expiry.
   with self.lock('admission.lock'):
    (self.root/'lease.json').unlink();self.sync()
  # Persist restoration intent across a lost response or helper restart. Do not
  # guess that a container replacement has the old PID or its old retirement token.
  for r in lease['runtimes']:
   if r['role']!='gateway' or not r.get('drainAcknowledged'):continue
   c=r['container']
   for attempt in range(30):
    rows=self.control(c,'snapshot')['processes']
    if any(x['role']=='gateway' and x['home']==r['home'] for x in rows):break
    if attempt in [2,8,16]:
     subprocess.run(['docker','exec','-u','hermes','-e','HERMES_HOME='+r['home'],c['id'],'hermes','gateway','start'],capture_output=True,timeout=15)
    time.sleep(1)
   else:raise MaintenanceError('runtime_resume_pending_retry_release')
  if resume.exists():resume.unlink();self.sync()
  return {'ok':True}
 def enter(self):
  with self.lock('admission.lock'):
   if self.read():raise MaintenanceError('maintenance_active')
   p=self.root/'operations'/str(uuid.uuid4());f=p.open('w+')
   fcntl.flock(f,fcntl.LOCK_EX);return f
