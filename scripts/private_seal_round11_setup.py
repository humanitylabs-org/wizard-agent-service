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
 pathlib.Path('/opt/data/synthetic-preflight.json').write_text(json.dumps({'writable_home':True,'cwd':os.getcwd(),'toolsets_mapping':True,'explicit_api_mode':True}))
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
