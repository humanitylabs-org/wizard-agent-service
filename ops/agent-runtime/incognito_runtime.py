"""RAM-only, fail-closed stock Hermes siblings. No durable session registry."""
import base64
import json
import os
import re
import secrets
import stat
import threading
import time
import urllib.request

LABEL = 'wizard.incognito=1'
SEEDS = ('AGENTS.md', 'SOUL.md', 'memories/MEMORY.md', 'memories/USER.md')
FILE_LIMIT = 128 * 1024
TOTAL_LIMIT = 384 * 1024
PYTHON = '/opt/hermes/.venv/bin/python'


def read_seed(home):
    """Open every path component without following links; never enumerate a home."""
    root = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    result = {}
    try:
        for part in os.path.abspath(home).split('/')[1:]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
            os.close(root)
            root = nxt
        total = 0
        for name in SEEDS:
            fd = os.dup(root)
            try:
                parts = name.split('/')
                for part in parts[:-1]:
                    nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    os.close(fd)
                    fd = nxt
                leaf = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                with os.fdopen(leaf, 'rb') as source:
                    info = os.fstat(source.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_size > FILE_LIMIT:
                        raise ValueError('unsafe_seed')
                    data = source.read(FILE_LIMIT + 1)
                total += len(data)
                if len(data) > FILE_LIMIT or total > TOTAL_LIMIT:
                    raise ValueError('seed_too_large')
                result[name] = base64.b64encode(data).decode('ascii')
            except FileNotFoundError:
                pass
            finally:
                os.close(fd)
    finally:
        os.close(root)
    return result


# Same bounded reader runs read-only in the normal container only when its uid
# prevents the helper from reading the source. Its stdout goes directly to memory.
import inspect
SEED_SCRIPT = ('import os,stat,base64,json\nSEEDS=' + repr(SEEDS) +
               '\nFILE_LIMIT=' + str(FILE_LIMIT) + '\nTOTAL_LIMIT=' + str(TOTAL_LIMIT) + '\n' +
               inspect.getsource(read_seed) + '\nprint(json.dumps(read_seed("/opt/data")))')

BOOT = '''import os,time,runpy,sys,threading
while not os.path.exists('/opt/data/.ready'): time.sleep(.1)
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
INSTALL = '''import os,json,base64,sys
p=json.load(sys.stdin)
os.umask(0o077)
for name,data in p['files'].items():
 path='/opt/data/'+name
 os.makedirs(os.path.dirname(path),mode=0o700,exist_ok=True)
 with open(path,'xb') as f: f.write(base64.b64decode(data,validate=True))
with open('/opt/data/.lease','x'): pass
with open('/opt/data/.ready','x'): pass
'''


class IncognitoManager:
    def __init__(self, driver, *, docker, failure, image, proxy_image, container_for,
                 clock=time.monotonic, background=True, ready=None):
        self.driver, self.agents = driver, driver.agents
        self.docker, self.failure = docker, failure
        self.image, self.proxy_image = image, proxy_image
        self.container_for, self.clock = container_for, clock
        self.ready = ready or self._ready
        self.lock = threading.RLock()
        self.sessions = {}
        self.closed = False
        self.wake = threading.Event()
        self.sweep(startup=True)  # Recovery must finish before serving requests.
        self.thread = None
        if background:
            self.thread = threading.Thread(target=self._loop, name='incognito-reaper', daemon=True)
            self.thread.start()

    def _docker(self, args, *, input_text=None, required=True):
        # Never let the general docker wrapper log captured seed/errors.
        result = self.docker(args, input_text=input_text, timeout=90, check=False)
        if required and result.returncode:
            raise self.failure('incognito_runtime_failed', 502)
        return result

    def _discover(self, kind):
        command = ['ps', '-aq'] if kind == 'container' else ['network', 'ls', '-q']
        return self._docker([*command, '--filter', 'label=' + LABEL]).stdout.split()

    def _remove(self, state):
        for args in (["rm", "-f", state['name']], ["rm", "-f", state['proxy']],
                     ["network", "rm", state['net']], ["network", "rm", state['egress']]):
            try:
                self._docker(args, required=False)
            except Exception:
                pass  # Label-based sweeps retry every resource independently.

    def sweep(self, startup=False):
        with self.lock:
            now = self.clock()
            for key, state in list(self.sessions.items()):
                if now >= state['lease'] or now >= state['deadline']:
                    self._remove(state)
                    del self.sessions[key]
            # Discover IDs together with names, so active resources are excluded
            # without trusting session IDs, names supplied by callers or files.
            active = {s[k] for s in self.sessions.values() for k in ('name', 'proxy', 'net', 'egress')}
            for kind in ('container', 'network'):
                for ident in self._discover(kind):
                    fmt = '{{.Name}}'
                    args = ['inspect', '--format', fmt, ident] if kind == 'container' else ['network', 'inspect', '--format', fmt, ident]
                    name = self._docker(args).stdout.strip().lstrip('/')
                    if startup or name not in active:
                        self._docker(['rm', '-f', ident] if kind == 'container' else ['network', 'rm', ident], required=startup)

    def _loop(self):
        while not self.wake.wait(10):
            try:
                self.sweep()
            except Exception:
                pass  # Retry on the next sweep; never log provider/seed output.

    def _seed(self, agent):
        try:
            return read_seed(self.agents.home(agent['id']))
        except PermissionError:
            cid = self.container_for(self.driver.project(agent['id']),
                                     'agent' if (agent.get('runtime') or {}).get('isolation') == 'restricted'
                                     else agent['runtime']['app_id'])
            result = self._docker(['exec', '-u', ('10000:10000' if (agent.get('runtime') or {}).get('isolation') == 'restricted' else 'hermes'), cid, PYTHON, '-c', SEED_SCRIPT])
            if len(result.stdout) > 2 * TOTAL_LIMIT:
                raise self.failure('incognito_seed_invalid', 409)
            seeds = json.loads(result.stdout)
            if not isinstance(seeds, dict) or set(seeds) - set(SEEDS):
                raise self.failure('incognito_seed_invalid', 409)
            total = 0
            for data in seeds.values():
                size = len(base64.b64decode(data, validate=True))
                total += size
                if size > FILE_LIMIT or total > TOTAL_LIMIT:
                    raise self.failure('incognito_seed_invalid', 409)
            return seeds
        except (OSError, ValueError):
            raise self.failure('incognito_seed_invalid', 409) from None

    def start(self, agent, session_id):
        self._validate(session_id)
        with self.lock:
            if self.closed:
                raise self.failure('incognito_unavailable', 503)
            if agent.get('privacy') != 'private':
                raise self.failure('incognito_private_only', 409)
            model = agent.get('model') or {}
            if model.get('provider') != 'tinfoil' or not isinstance(model.get('model'), str) or not model['model']:
                raise self.failure('incognito_tinfoil_required', 409)
            if agent.get('imported') or not hasattr(self.driver, 'project'):
                raise self.failure('incognito_unsupported_runtime', 409)
            if any(k[0] == agent['id'] for k in self.sessions):
                raise self.failure('incognito_already_active', 409)
            provider_key = self.agents.tinfoil_key()
            if not provider_key or '\n' in provider_key or '\r' in provider_key:
                raise self.failure('provider_not_configured', 503)
            seeds = self._seed(agent)
            prefix = 'wizard-incognito-' + secrets.token_hex(12)
            state = dict(name=prefix, proxy=prefix+'-proxy', net=prefix+'-net', egress=prefix+'-egress')
            api_key = secrets.token_hex(32)
            try:
                for name, internal in ((state['net'], True), (state['egress'], False)):
                    self._docker(['network', 'create', '--label', LABEL, *(['--internal'] if internal else []), name])
                common = ['--label', LABEL, '--restart', 'no', '--read-only', '--log-driver', 'none',
                          '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '256', '--memory', '1g', '--memory-swap', '1g', '--ulimit', 'core=0:0']
                self._docker(['create', '--name', state['proxy'], *common, '--network', state['egress'],
                              '--tmpfs', '/tmp:rw,nosuid,nodev,noswap,size=64m', '--tmpfs', '/root/.cache:rw,nosuid,nodev,noswap,size=64m',
                              self.proxy_image, '--bind', '0.0.0.0', '--port', '3301', '--allowed-host', state['proxy']])
                self._docker(['network', 'connect', state['net'], state['proxy']])
                self._docker(['start', state['proxy']])
                self._docker(['run', '-d', '--name', state['name'], *common, '--network', state['net'],
                              '--user', '10000:10000', '--tmpfs', '/opt/data:rw,nosuid,nodev,noswap,size=512m,uid=10000,gid=10000,mode=0700',
                              '--tmpfs', '/tmp:rw,nosuid,nodev,noswap,size=128m,mode=1777', '-p', '127.0.0.1::8642',
                              '-e', 'HOME=/opt/data', '-e', 'HERMES_HOME=/opt/data', '-e', 'HERMES_WORKDIR=/opt/data',
                              '-e', 'XDG_CACHE_HOME=/opt/data/.cache', '-e', 'PYTHONDONTWRITEBYTECODE=1',
                              '--workdir', '/opt/data', '--entrypoint', PYTHON, self.image, '-c', BOOT])
                config = {'model': {'provider': 'custom', 'default': model['model'],
                                   'base_url': 'http://' + state['proxy'] + ':3301/v1', 'api_key': provider_key},
                          'fallback_model': None, 'fallback_providers': [], 'toolsets': {'api_server': []},
                          'platform_toolsets': {'api_server': []}, 'mcp_servers': {},
                          'plugins': {'enabled': [], 'auto_update': False}, 'memory': {'provider': 'none'},
                          'cron': {'allow_agent_scheduling': False},
                          'gateway': {'platforms': {'api_server': {'enabled': True}}, 'api_server': {'max_concurrent_runs': 1}},
                          'terminal': {'cwd': '/opt/data'},
                          'agent': {'max_iterations': 10, 'disabled_toolsets': [
                              'all', 'terminal', 'file', 'code_execution', 'web', 'search', 'browser',
                              'x_search', 'vision', 'video', 'image_gen', 'video_gen', 'tts',
                              'delegation', 'connections', 'homeassistant', 'spotify', 'memory',
                              'skills', 'skill_manager', 'cronjob', 'todo', 'clarify', 'session_search',
                              'send_message', 'execute_code', 'mcp']}}
                env = 'API_SERVER_ENABLED=true\nAPI_SERVER_HOST=0.0.0.0\nAPI_SERVER_PORT=8642\nAPI_SERVER_KEY='+api_key+'\nTINFOIL_API_KEY='+provider_key+'\n'
                files = {**seeds, 'config.yaml': base64.b64encode(json.dumps(config).encode()).decode(),
                         '.env': base64.b64encode(env.encode()).decode()}
                self._docker(['exec', '-i', state['name'], PYTHON, '-c', INSTALL], input_text=json.dumps({'files': files}))
                # Assert the stock resolver honors the no-tools boundary before admitting owner text.
                verify = ("import sys;sys.path.insert(0,'/opt/hermes');"
                          "from hermes_cli.config import load_config;"
                          "from hermes_cli.tools_config import _get_platform_tools;"
                          "from model_tools import get_tool_definitions;"
                          "c=load_config();t=sorted(_get_platform_tools(c,'api_server'));"
                          "d=get_tool_definitions(enabled_toolsets=t,disabled_toolsets=c['agent']['disabled_toolsets'],quiet_mode=True);"
                          "sys.exit(0 if not t and not d else 42)")
                self._docker(['exec', state['name'], PYTHON, '-c', verify])
                port = self._docker(['port', state['name'], '8642/tcp']).stdout.strip()
                if not re.fullmatch(r'127\.0\.0\.1:[0-9]{1,5}', port) or not 1 <= int(port.split(':')[1]) <= 65535:
                    raise self.failure('incognito_port_invalid', 502)
                origin = 'http://' + port
                self.ready(origin, api_key)
                now = self.clock()
                state.update(lease=now+90, deadline=now+7200)
                self.sessions[(agent['id'], session_id)] = state
                return {'ok': True, 'origin': origin, 'key': api_key}
            except BaseException:
                self._remove(state)
                raise

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
