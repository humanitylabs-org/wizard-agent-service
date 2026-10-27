"""Disposable stock Hermes homes. Content travels only over bounded anonymous pipes."""
import json
import logging
import os
import re
import secrets
import subprocess
import threading
import time
import urllib.request

LABEL = 'wizard.incognito=1'
# A full working home fits in the 512 MiB RAM home; oversized history alone is skipped.
TOTAL_LIMIT = 192 * 1024 * 1024
PYTHON = '/opt/hermes/.venv/bin/python'

# Docker 26 rejects the mount-level 'noswap' option. The supported container-wide
# boundary is MemorySwap == Memory, enforced by cgroup v2 memory.swap.max=0.
# Never transfer a seed if the kernel boundary or any RAM mount is unverifiable.
VERIFY_RAM = r'''from pathlib import Path
assert Path('/sys/fs/cgroup/memory.swap.max').read_text().strip() == '0', 'incognito_swap_not_disabled'
mounts={}
for line in Path('/proc/self/mountinfo').read_text().splitlines():
 left,right=line.split(' - ',1); fields=left.split(); mounts[fields[4]]=(fields[5].split(','),right.split()[0])
for dest in ['/opt/data','/tmp','/var/log']:
 options,kind=mounts.get(dest,([],''))
 assert kind=='tmpfs' and {'rw','nosuid','nodev'} <= set(options), 'incognito_ram_mount_missing'
'''


# Runs INSIDE the source container. No source writes, no host archive, no links.
# state.db is transferred separately using SQLite's backup API (including its WAL).
EXPORT = r'''import os,stat,subprocess
root='/opt/data'
skip={'logs','sessions','cache','caches','.cache','cron','response_store.db','state.db','state.db-wal','state.db-shm','.ready','.lease','.incognito-meta.json'}
names=[]
for base,dirs,files in os.walk(root,followlinks=False):
 dirs[:]=[d for d in dirs if d not in skip and not os.path.islink(os.path.join(base,d))]
 for name in files:
  path=os.path.join(base,name)
  if name in skip or name.startswith('response_store.db-') or name.endswith(('.log','.pyc')) or '__pycache__' in path.split('/'): continue
  if stat.S_ISREG(os.lstat(path).st_mode): names.append(os.path.relpath(path,root))
p=subprocess.Popen(['tar','-c','-C',root,'--null','--verbatim-files-from','-T','-'],stdin=subprocess.PIPE)
p.communicate(b''.join(n.encode()+b'\0' for n in names))
raise SystemExit(p.returncode)
'''
SNAPSHOT = r'''import os,sqlite3,sys
p='/opt/data/state.db'
if not os.path.exists(p): raise SystemExit(0)
src=sqlite3.connect('file:'+p+'?mode=ro',uri=True,timeout=5)
dst=sqlite3.connect(':memory:')
def progress(status,remaining,total):
 if total*src.execute('PRAGMA page_size').fetchone()[0] > LIMIT: raise OverflowError()
try:
 src.backup(dst,pages=256,progress=progress)
 data=dst.serialize()
 if len(data)<=LIMIT: sys.stdout.buffer.write(data)
except OverflowError: pass
finally: dst.close();src.close()
'''
RESTORE = "import sys;f=open('/opt/data/state.db','wb');n=0\nwhile True:\n b=sys.stdin.buffer.read(65536)\n if not b:break\n f.write(b);n+=len(b)\nf.close()\nif not n:__import__('os').unlink('/opt/data/state.db')"
BOOT = '''import os,time,runpy,sys,threading
# A helper crash during seed/verification must not leave an unleased RAM home.
startup_deadline=time.monotonic()+300
while not os.path.exists('/opt/data/.ready'):
 if time.monotonic()>=startup_deadline: os._exit(0)
 time.sleep(.1)
# Secret values are read only from tmpfs, never Docker environment metadata.
import json
os.environ.update(json.load(open('/opt/data/.incognito-environment.json')))
def expire():
 while True:
  try: age=time.time()-os.stat('/opt/data/.lease').st_mtime
  except OSError: age=91
  if age>90: os._exit(0)
  time.sleep(1)
threading.Thread(target=expire,daemon=True).start()
os.chdir('/opt/data')
sys.path.insert(0,'/opt/hermes')
sys.argv=['hermes','gateway','run']
runpy.run_module('hermes_cli.main',run_name='__main__')
'''
# All secrets arrive through stdin, then stay in the disposable home. Never argv/env/logs.
INSTALL = r'''import os,json,sys,pathlib,yaml
p=json.load(sys.stdin); home=pathlib.Path('/opt/data');os.umask(0o077)
c=yaml.safe_load((home/'config.yaml').read_text()) or {}
c.setdefault('agent',{})['disabled_toolsets']=list(dict.fromkeys(c.get('agent',{}).get('disabled_toolsets',[])+['cronjob','kanban','delegation','send_message','wizard-schedule','wizard-heavy']))
c.setdefault('cron',{})['allow_agent_scheduling']=False
# No platform listeners, restores or cross-platform sends from copied bot credentials.
# Explicit disabled markers override legacy gateway.json and token-based auto-admission.
sys.path.insert(0,'/opt/hermes')
from gateway.config import Platform
names={x.value for x in Platform} | set(c.get('platforms',{})) | set(c.get('gateway',{}).get('platforms',{}))
for name in names:
 enabled=name=='api_server'
 c.setdefault('platforms',{}).setdefault(name,{})['enabled']=enabled
 c.setdefault('gateway',{}).setdefault('platforms',{}).setdefault(name,{})['enabled']=enabled
 if isinstance(c['gateway'].get(name),dict): c['gateway'][name]['enabled']=enabled
c.setdefault('gateway',{}).setdefault('api_server',{})['max_concurrent_runs']=1
plugins=c.setdefault('plugins',{});enabled=plugins.setdefault('enabled',[])
if 'wizard-incognito-policy' not in enabled: enabled.append('wizard-incognito-policy')
# Keep provider, fallbacks, MCP, toolsets, memory backend, skills and plugins untouched.
(home/'config.yaml').write_text(yaml.safe_dump(c,sort_keys=False))
from dotenv import dotenv_values
os.environ.update(p['environment'])
values={**p['environment'],**dict(dotenv_values(home/'.env'))}
values.update(HOME='/opt/data',HERMES_HOME='/opt/data',HERMES_WORKDIR='/opt/data',XDG_CACHE_HOME='/opt/data/.cache',API_SERVER_ENABLED='true',API_SERVER_HOST='0.0.0.0',API_SERVER_PORT='8642',API_SERVER_KEY=p['key'])
# Gateway env overrides must not re-enable a copied messaging platform.
for name in names:
 if name!='api_server': values[name.upper().replace('-','_')+'_ENABLED']='false'
(home/'.incognito-environment.json').write_text(json.dumps({k:str(v) for k,v in values.items() if v is not None}))
(home/'.env').write_text(''.join(k+'='+json.dumps(str(v))+'\n' for k,v in values.items() if v is not None))
folder=home/'plugins/wizard-incognito-policy';folder.mkdir(parents=True,exist_ok=True)
(folder/'plugin.yaml').write_text('name: wizard-incognito-policy\nversion: 1.0.0\ndescription: Block durable orchestration in temporary chats\n')
(folder/'__init__.py').write_text(p['policy'])
meta={'history_search':'available' if (home/'state.db').exists() else 'unavailable'}
(home/'.incognito-meta.json').write_text(json.dumps(meta))
# Installation is not launch admission: policy verification must finish first.
print(json.dumps(meta))
'''
POLICY = '''import re
def block(tool_name, args=None, **kw):
 name=tool_name.split('__')[-1]
 persistent = r'(?:^|_)(?:wizard_schedule|kanban|wizard_heavy|delegate|send_message)(?:_|$)'
 exact = r'(?:^|_)(?:cron|cronjob|supervisor_report|supervisor_ask|supervisor_answer|supervisor_build|supervisor_close|session_history_write|session_history_append)$'
 if re.search(persistent,name) or re.search(exact,name):
  return {'action':'block','message':'This durable operation is unavailable in Incognito.'}
 # MCP wrappers can multiplex names; inspect their requested action as well.
 for key in ('name','tool','tool_name'):
  nested=(args or {}).get(key)
  if isinstance(nested,str) and nested!=tool_name:
   if block(nested,{}): return {'action':'block','message':'This durable operation is unavailable in Incognito.'}
 for call in (args or {}).get('calls',[]) if isinstance((args or {}).get('calls',[]),list) else []:
  if isinstance(call,dict) and block(str(call.get('name','')),call.get('arguments') if isinstance(call.get('arguments'),dict) else {}):
   return {'action':'block','message':'This durable operation is unavailable in Incognito.'}
 return None
def register(ctx):
 ctx.register_hook('pre_tool_call',block)
'''
VERIFY = "import sys;sys.path.insert(0,'/opt/hermes');from hermes_cli.plugins import discover_plugins,get_pre_tool_call_directive;discover_plugins();assert get_pre_tool_call_directive('wizard_schedule',{})[0]=='block';assert get_pre_tool_call_directive('memory',{})[0] is None"


def _docker_command(args):
 # Match the runtime helper's Docker group fallback. Never invoke a shell with content.
 import shlex
 if os.access('/var/run/docker.sock',os.W_OK): return ['docker',*args]
 return ['sg','docker','-c',shlex.join(['docker',*args])]


class SeedCopyError(ValueError):
 """Content-free seed failure: a fixed reason and the two process exit codes only."""
 def __init__(self, reason, source_rc, destination_rc):
  super().__init__(reason);self.reason=reason;self.source_rc=source_rc;self.destination_rc=destination_rc


def stream_copy(source, destination, limit):
 """Relay binary content without capture, logging, a host file, or a secret env."""
 a=b=None;count=0
 try:
  a=subprocess.Popen(_docker_command(source),stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
  b=subprocess.Popen(_docker_command(destination),stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  deadline=time.monotonic()+90
  import select
  while True:
   if time.monotonic()>deadline: raise TimeoutError()
   if not select.select([a.stdout],[],[],1)[0]: continue
   data=os.read(a.stdout.fileno(),65536)
   if not data: break
   count+=len(data)
   if count>limit: raise SeedCopyError('seed_too_large',None,None)
   b.stdin.write(data);b.stdin.flush()
  b.stdin.close()
  ra=a.wait(timeout=10);rb=b.wait(timeout=10)
  if ra or rb: raise SeedCopyError('seed_failed',ra,rb)
  return count
 finally:
  for proc in (a,b):
   if proc and proc.poll() is None: proc.kill();proc.wait()


class IncognitoManager:
    def __init__(self, driver, *, docker, failure, image, proxy_image, container_for,
                 clock=time.monotonic, background=True, ready=None, transfer=None):
        self.driver, self.agents = driver, driver.agents
        self.docker, self.failure = docker, failure
        self.image, self.proxy_image = image, proxy_image
        self.container_for, self.clock = container_for, clock
        self.ready = ready or self._ready
        self.transfer = transfer or stream_copy
        self.lock = threading.RLock()
        self.sessions = {}
        self.closed = False
        self.wake = threading.Event()
        self.sweep(startup=True)
        self.thread = None
        if background:
            self.thread = threading.Thread(target=self._loop, name='incognito-reaper', daemon=True)
            self.thread.start()

    def _docker(self, args, *, input_text=None, required=True):
        result = self.docker(args, input_text=input_text, timeout=90, check=False)
        if required and result.returncode:
            raise self.failure('incognito_runtime_failed', 502)
        return result

    def _discover(self, kind):
        command = ['ps', '-aq'] if kind == 'container' else ['network', 'ls', '-q']
        return self._docker([*command, '--filter', 'label=' + LABEL]).stdout.split()

    def _remove(self, state):
        # Shared source networks/sidecars are never labeled, stopped or removed.
        try: self._docker(['rm','-f',state['name']],required=False)
        except Exception: pass  # Label sweeps retry orphan cleanup; never expose Docker diagnostics.

    def sweep(self, startup=False):
        with self.lock:
            now = self.clock()
            for key, state in list(self.sessions.items()):
                if now >= state['lease'] or now >= state['deadline']:
                    self._remove(state); del self.sessions[key]
            active = {s['name'] for s in self.sessions.values()}
            for kind in ('container', 'network'):
                for ident in self._discover(kind):
                    args = ['inspect', '--format', '{{.Name}}', ident] if kind == 'container' else ['network', 'inspect', '--format', '{{.Name}}', ident]
                    name = self._docker(args).stdout.strip().lstrip('/')
                    if startup or name not in active:
                        self._docker(['rm','-f',ident] if kind=='container' else ['network','rm',ident],required=startup)

    def _loop(self):
        while not self.wake.wait(10):
            try: self.sweep()
            except Exception: pass

    def start(self, agent, session_id):
        self._validate(session_id)
        with self.lock:
            if self.closed: raise self.failure('incognito_unavailable',503)
            if agent.get('privacy')!='private': raise self.failure('incognito_private_only',409)
            if (agent.get('model') or {}).get('provider')!='tinfoil': raise self.failure('incognito_tinfoil_required',409)
            if agent.get('imported') or not hasattr(self.driver,'project'): raise self.failure('incognito_unsupported_runtime',409)
            if any(k[0]==agent['id'] for k in self.sessions): raise self.failure('incognito_already_active',409)
            service='agent' if (agent.get('runtime') or {}).get('isolation')=='restricted' else agent['runtime']['app_id']
            source=self.container_for(self.driver.project(agent['id']),service)
            # Docker metadata only. Env values are held in memory, never in args or diagnostics.
            meta=json.loads(self._docker(['inspect',source]).stdout)[0]
            networks=list(meta['NetworkSettings']['Networks'])
            if not networks or meta['HostConfig'].get('NetworkMode') in ('host','none'):
                raise self.failure('incognito_unsupported_runtime',409)
            environment=dict(v.split('=',1) for v in meta['Config'].get('Env',[]) if '=' in v)
            uid=meta['Config'].get('User') or environment.get('HERMES_UID','10000')+':'+environment.get('HERMES_GID','10000')
            if not re.fullmatch(r'[0-9]+(?::[0-9]+)?',uid) or uid.split(':')[0]=='0':
                raise self.failure('incognito_unsupported_runtime',409)
            state={'name':'wizard-incognito-'+secrets.token_hex(12)}
            key=secrets.token_hex(32)
            step = 'create'
            try:
                args=['create','--name',state['name'],'--label',LABEL,'--restart','no','--read-only','--log-driver','none',
                      '--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','256',
                      '--memory','1g','--memory-swap','1g','--ulimit','core=0:0','--network',networks[0],
                      '--user',uid,'--tmpfs',f'/opt/data:rw,nosuid,nodev,size=512m,uid={uid.split(":")[0]},gid={uid.split(":")[-1]},mode=0700',
                      '--tmpfs','/tmp:rw,nosuid,nodev,size=128m,mode=1777',
                      '--tmpfs','/var/log:rw,nosuid,nodev,size=16m,mode=1777',
                      '-p','127.0.0.1::8642','-e','HOME=/opt/data','-e','HERMES_HOME=/opt/data',
                      '-e','HERMES_WORKDIR=/opt/data','-e','PYTHONDONTWRITEBYTECODE=1','--workdir','/opt/data']
                for host in meta['HostConfig'].get('ExtraHosts') or []: args+=['--add-host',host]
                for dns in meta['HostConfig'].get('Dns') or []: args+=['--dns',dns]
                for domain in meta['HostConfig'].get('DnsSearch') or []: args+=['--dns-search',domain]
                for option in meta['HostConfig'].get('SecurityOpt') or []:
                    if not option.startswith('no-new-privileges'): args+=['--security-opt',option]
                for mount in meta.get('Mounts',[]):
                    dest=mount['Destination']
                    if dest=='/opt/data' or (mount.get('Type')=='tmpfs' and dest in ('/tmp','/var/log')): continue
                    if mount.get('Type')=='tmpfs':
                        # New RAM, never another container's tmpfs or a persistent substitute.
                        args+=['--tmpfs',dest+':rw,nosuid,nodev,size=64m,mode=1777'];continue
                    # Preserve scoped app gateway/socket mounts, not source data or host authority.
                    if not dest.startswith('/run/') or ',' in mount['Source'] or ',' in dest:
                        raise self.failure('incognito_unsupported_mount',409)
                    args+=['--mount',f'type=bind,src={mount["Source"]},dst={dest}'+(',readonly' if not mount.get('RW') else '')]
                args+=['--entrypoint',PYTHON,meta['Image'],'-c',BOOT]
                self._docker(args)
                step = 'network_connect'
                for net in networks[1:]: self._docker(['network','connect',net,state['name']])
                step = 'container_start'
                self._docker(['start',state['name']])
                step = 'verify_ram'
                self._docker(['exec',state['name'],PYTHON,'-c',VERIFY_RAM])
                step = 'seed_home'
                total=self.transfer(['exec',source,PYTHON,'-c',EXPORT],['exec','-i',state['name'],'tar','-x','--no-same-owner','-C','/opt/data'],TOTAL_LIMIT)
                step = 'seed_history'
                self.transfer(['exec',source,PYTHON,'-c','LIMIT='+str(TOTAL_LIMIT-total)+'\n'+SNAPSHOT],
                              ['exec','-i',state['name'],PYTHON,'-c',RESTORE],TOTAL_LIMIT-total)
                step = 'install'
                installed=self._docker(['exec','-i',state['name'],PYTHON,'-c',INSTALL],input_text=json.dumps({'key':key,'environment':environment,'policy':POLICY}))
                metadata=json.loads(installed.stdout)
                step = 'verify_policy'
                self._docker(['exec',state['name'],PYTHON,'-c',VERIFY])
                step = 'resolve_port'
                port=self._docker(['port',state['name'],'8642/tcp']).stdout.strip()
                if not re.fullmatch(r'127\.0\.0\.1:[0-9]{1,5}',port) or not 1<=int(port.split(':')[1])<=65535:
                    raise self.failure('incognito_port_invalid',502)
                origin='http://'+port
                # Do not spend the 90-second gateway lease on policy imports.
                # BOOT is released only after all installation checks complete.
                step = 'boot_release'
                self._docker(['exec',state['name'],PYTHON,'-c',
                              "from pathlib import Path;p=Path('/opt/data');(p/'.lease').touch();(p/'.ready').touch()"])
                step = 'api_ready'
                self.ready(origin,key)
                step = 'lease_admit'
                self._docker(['exec',state['name'],PYTHON,'-c',
                              "import os;os.utime('/opt/data/.lease',None)"])
                now=self.clock();state.update(lease=now+90,deadline=now+7200)
                self.sessions[(agent['id'],session_id)]=state
                return {'ok':True,'origin':origin,'key':key,**metadata}
            except BaseException as exc:
                # Fixed phase + bounded class only. Never exception text, argv,
                # container output, environment, seed, URL or session identifiers.
                kind = re.sub(r'[^A-Za-z0-9_]', '', type(exc).__name__)[:64] or 'Exception'
                detail = {'step': step, 'exception_class': kind}
                if isinstance(exc, SeedCopyError):
                    detail.update(reason=exc.reason, source_rc=exc.source_rc, destination_rc=exc.destination_rc)
                logging.getLogger(__name__).warning('incognito_start_failed %s', json.dumps(detail, sort_keys=True))
                self._remove(state)
                error = self.failure('incognito_runtime_failed',502)
                error.detail = detail
                raise error from None

    def _validate(self, sid):
        if not isinstance(sid, str) or not re.fullmatch(r'incog_[0-9a-f]{32}', sid):
            raise self.failure('invalid_session_id', 400)

    def stop(self, agent_id, sid):
        self._validate(sid)
        with self.lock:
            state = self.sessions.pop((agent_id, sid), None)
            if state:
                self._remove(state)
        return {'ok': True}

    def lease(self, agent_id, sid):
        self._validate(sid)
        with self.lock:
            state = self.sessions.get((agent_id, sid))
            now = self.clock()
            if not state or now >= state['lease'] or now >= state['deadline']:
                if state:
                    self.stop(agent_id, sid)
                raise self.failure('incognito_expired', 410)
            self._docker(['exec', state['name'], PYTHON, '-c', "import os;os.utime('/opt/data/.lease',None)"])
            state['deadline'] = now+7200  # Service owns the two-hour user-activity idle limit.
            state['lease'] = now+90
        return {'ok': True}

    def close(self):
        self.wake.set()
        with self.lock:
            self.closed = True
            for state in self.sessions.values():
                self._remove(state)
            self.sessions.clear()
        if self.thread:
            self.thread.join(timeout=1)

    def _ready(self, origin, key):
        deadline = time.monotonic()+60
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        while time.monotonic() < deadline:
            try:
                request = urllib.request.Request(origin+'/health', headers={'Authorization': 'Bearer '+key})
                with opener.open(request, timeout=2) as response:
                    if response.status == 200:
                        return
            except OSError:
                time.sleep(.25)
        raise self.failure('incognito_start_timeout', 502)
