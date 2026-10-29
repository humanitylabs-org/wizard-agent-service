"""Pure setup contracts for the disposable Round11 follow-up (no Docker at import)."""
from pathlib import Path
import hashlib
import json
import os
import subprocess


def unique_images(images):
    """Preserve order, importing/keeping an aliased edge/key image only once."""
    return list(dict.fromkeys(images))


def node_environment(node, expected_sha256, inherited):
    path = Path(node)
    if not path.is_absolute() or not path.is_file():
        raise RuntimeError('pinned_node_missing')
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != expected_sha256:
        raise RuntimeError('pinned_node_hash_mismatch')
    env = {**inherited, 'PATH':str(path.parent) + os.pathsep + inherited.get('PATH', '')}
    # Test the actual builtin and the PATH used by npm/vitest's /usr/bin/env shebang.
    code = "import { DatabaseSync } from 'node:sqlite';const d=new DatabaseSync(':memory:');d.exec('select 1');d.close();console.log(JSON.stringify({version:process.versions.node,execPath:process.execPath}))"
    probe = subprocess.run(['node', '--input-type=module', '-e', code], env=env,
                           capture_output=True, text=True, timeout=15)
    if probe.returncode:
        raise RuntimeError('pinned_node_sqlite_unavailable')
    info = json.loads(probe.stdout)
    if not Path(info['execPath']).samefile(path):
        raise RuntimeError('node_path_not_pinned')
    version = tuple(int(v) for v in info['version'].split('.')[:2])
    if version < (22, 5):
        raise RuntimeError('pinned_node_below_service_engine')
    return env, {**info, 'sha256':actual, 'sqlite_builtin':True}


def socket_temp_contract(root):
    """Budget the actual sealed gateway fixture BEFORE Docker can auto-mkdir a missing bind."""
    root = Path(root)
    if not root.is_absolute() or root.is_symlink():
        raise RuntimeError('synthetic_socket_temp_root_unsafe')
    candidate = root / 'r10-sealed-gw-XXXXXX/agents/sealed/gateway/gateway.sock'
    size = len(os.fsencode(candidate))
    if size > 103:
        raise RuntimeError('synthetic_socket_path_too_long:' + str(size))
    return {'socket_path_bytes':size, 'max_bytes':103, 'temp_root':str(root)}


def manager_layout(state):
    """Exact selected daemon Compose shape: APP_DATA_PATH is its parent, cache is separate."""
    state = Path(state)
    directories = ('media', 'state', 'apps', 'repos', 'logs', 'user-config', 'traefik', 'backups', 'app-data', 'cache', 'catalog')
    mounts = [(state / name, '/data/' + name) for name in directories if name not in ('app-data', 'cache', 'catalog')]
    mounts += [(state / 'app-data', '/app-data'), (state / 'cache', '/cache'),
               (state / '.env', '/data/.env'), (state / 'docker-compose.yml', '/data/docker-compose.yml')]
    return directories, mounts, str(state)


def stock_launch(home, python, net, api_key, uid, gid):
    if min(uid, gid) < 1:
        raise RuntimeError('synthetic_stock_requires_nonroot_owner')
    # Deliberately keep the official image ENTRYPOINT and writable init root.
    # /init owns PID1, stage2 remaps/chowns, main-wrapper drops to hermes.
    flags = ['--network', net, '--tmpfs', '/tmp', '--log-driver', 'none',
             '--workdir', '/opt/data', '-v', f'{home}:/opt/data',
             '-e', f'HERMES_UID={uid}', '-e', f'HERMES_GID={gid}',
             '-e', 'HOME=/opt/data', '-e', 'HERMES_HOME=/opt/data', '-e', 'HERMES_WORKDIR=/opt/data',
             '-e', 'API_SERVER_ENABLED=true', '-e', 'API_SERVER_HOST=0.0.0.0',
             '-e', 'API_SERVER_PORT=8642', '-e', 'API_SERVER_KEY=' + api_key]
    return [python, '-c', STOCK_BOOT], flags


def assert_startup_preflight(returncode, value):
    required = ('stock_setup_ready', 'manager_setup_ready', 'owned_resources_cleaned', 'synthetic_secret_work_removed')
    if (returncode != 0 or value.get('preflight_only') is not True
            or value.get('synthetic_only') is not True or value.get('live_touched') is not False
            or value.get('errors') or value.get('admission', {}).get('required_unmet') != []
            or any(value.get('checks', {}).get(k) is not True for k in required)):
        raise RuntimeError('startup_preflight_failed')
    return True


def stock_config():
    # Match the already-proved stock fixture's mapping shape and API mode.
    # Only the synthetic home receives this config; never selected Private state.
    return {
        'model':{'default':'synthetic-vision', 'provider':'custom',
                 'api_key':'unused-synthetic-client-bearer', 'base_url':'http://provider:8000/v1',
                 'api_mode':'chat_completions'},
        'fallback_providers':[],
        'toolsets':{'api_server':[]}, 'platform_toolsets':{'api_server':[]},
        'agent':{'max_iterations':2}, 'plugins':{'enabled':[]},
        'terminal':{'cwd':'/opt/data'},
        'gateway':{'platforms':{'api_server':{'enabled':True}}},
        'platforms':{'api_server':{'enabled':True}},
    }


# Capture only this generated fixture's startup output inside its own writable
# home; Docker logging remains disabled. Never used with an owner home.
STOCK_BOOT = r'''import os,sys,runpy,traceback,json,pathlib
os.chdir('/opt/data')
sys.path.insert(0,'/opt/hermes')
stream=open('/opt/data/synthetic-startup.log','w',buffering=1)
os.dup2(stream.fileno(),1);os.dup2(stream.fileno(),2)
try:
 import yaml
 c=yaml.safe_load(pathlib.Path('/opt/data/config.yaml').read_text())
 assert isinstance(c['toolsets'],dict), 'stock_toolsets_must_be_mapping'
 assert c['model']['api_mode']=='chat_completions', 'stock_api_mode_missing'
 assert os.getuid()!=0, 'synthetic_stock_gateway_must_not_be_root'
 assert os.getuid()==int(os.environ['HERMES_UID']), 'synthetic_stock_uid_mismatch'
 assert os.getgid()==int(os.environ['HERMES_GID']), 'synthetic_stock_gid_mismatch'
 assert pathlib.Path('/opt/data').stat().st_uid==os.getuid(), 'synthetic_stock_home_owner_mismatch'
 assert pathlib.Path('/opt/data/config.yaml').stat().st_uid==os.getuid(), 'synthetic_stock_config_owner_mismatch'
 assert os.getpid()!=1, 'synthetic_stock_missing_init'
 assert not os.environ.get('HERMES_ALLOW_ROOT_GATEWAY'), 'synthetic_root_bypass_forbidden'
 pathlib.Path('/opt/data/synthetic-preflight.json').write_text(json.dumps({'writable_home':True,'cwd':os.getcwd(),'toolsets_mapping':True,'explicit_api_mode':True,'uid':os.getuid(),'gid':os.getgid(),'home_uid':pathlib.Path('/opt/data').stat().st_uid,'config_uid':pathlib.Path('/opt/data/config.yaml').stat().st_uid,'pid':os.getpid(),'parent_pid':os.getppid(),'root_bypass':False}))
 sys.argv=['hermes','gateway','run']
 runpy.run_module('hermes_cli.main',run_name='__main__')
except BaseException:
 traceback.print_exc()
 raise
'''


def stock_sessions_ready(value):
    # The stock endpoint's list envelope is ready even when data is empty.
    if not isinstance(value, dict) or value.get('object') != 'list' or not isinstance(value.get('data'), list):
        raise RuntimeError('synthetic_stock_sessions_schema')
    return True
