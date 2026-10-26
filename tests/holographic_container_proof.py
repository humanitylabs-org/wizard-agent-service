"""Opt-in isolated stock-Hermes proof. Run on a Linux Docker worker, not a live box.

Creates only randomly named containers/volumes, no host home/config/socket mounts.
Exercises stock agent memory initialization, fact_store, prefetch, restart, native
SQLite-safe backup/import, then Wizard import wiring and recall in a second home.
No model/inference credentials or network are used by the test agents.
"""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / 'ops/agent-runtime/hermes-lock.json').read_text())
IMAGE = os.environ.get('WIZARD_MEMORY_TEST_IMAGE', LOCK['runtime_image'])
PYTHON = '/opt/hermes/.venv/bin/python'
FACT = 'The throwaway cobalt canary prefers turquoise notebooks.'


def run(argv, **kwargs):
    result = subprocess.run(argv, text=True, capture_output=True, timeout=180, **kwargs)
    if result.returncode:
        raise RuntimeError(f'{argv[:3]} failed: {result.stdout[-2000:]} {result.stderr[-4000:]}')
    return result.stdout


def docker(*args, **kwargs):
    return run(['docker', *args], **kwargs)


def healthy(name):
    # API readiness, not merely `docker start` returning successfully.
    docker('exec', name, PYTHON, '-c', '''import json,time,urllib.request
for attempt in range(60):
 try:
  req=urllib.request.Request('http://127.0.0.1:8642/health',headers={'Authorization':'Bearer synthetic-memory-test-key-not-a-credential'})
  with urllib.request.urlopen(req,timeout=2) as response:
   assert response.status==200
  break
 except Exception:
  if attempt==59: raise
  time.sleep(0.5)
''')


# Use the same stock initializer as the real API agent, not a hand-constructed
# HolographicMemoryProvider that could conceal a missing configuration selection.
PROBE = '''import json,os
from pathlib import Path
from types import SimpleNamespace
from hermes_cli.config import load_config
from agent.agent_init import _init_memory
class Probe(SimpleNamespace):
 def __getattr__(self,name): return None
cfg=load_config()
a=Probe(enabled_toolsets=['memory'],disabled_toolsets=cfg.get('agent',{}).get('disabled_toolsets',[]),tools=[],valid_tool_names=set(),session_id='cobalt-proof',session_cwd=os.environ['HERMES_HOME'])
_init_memory(a,cfg,False,'api_server')
m=a._memory_manager
assert m is not None and m.get_provider('holographic'), 'configured provider did not activate'
assert {'fact_store','fact_feedback'} <= a.valid_tool_names, 'provider tools not injected'
assert a._memory_enabled and a._user_profile_enabled
mode=__import__('sys').argv[1]
fact=__import__('sys').argv[2]
try:
 if mode=='add':
  added=json.loads(m.handle_tool_call('fact_store',{'action':'add','content':fact}))
  assert added.get('status')=='added', added
 result=json.loads(m.handle_tool_call('fact_store',{'action':'search','query':'cobalt canary','limit':5}))
 assert any(r['content']==fact for r in result['results']), result
 assert fact in m.prefetch_all('cobalt canary',session_id='cobalt-proof'), 'prefetch failed'
 assert Path(os.environ['HERMES_HOME'],'memory_store.db').is_file()
 print(json.dumps({'mode':mode,'provider':'holographic','tools_injected':True,'fact_recalled':True,'prefetch_recalled':True,'store_in_own_home':True}))
finally: m.shutdown_all()
'''


def scope_parity(kind, config):
    """Stock main/profile home semantics in disposable containers, not live host routing."""
    home = {'main': '/opt/data/.hermes', 'host-profile': '/opt/data/.hermes/profiles/proof', 'container': '/opt/data'}[kind]
    name = f'wizard-memory-{kind}-' + secrets.token_hex(5)
    volume = name + '-home'
    try:
        docker('volume', 'create', volume)
        docker('run', '--rm', '--network', 'none', '--user', '0:0', '--entrypoint', 'chown', '-v', volume + ':/opt/data', IMAGE, '10000:10000', '/opt/data')
        docker('run', '--rm', '-i', '--network', 'none', '--user', '10000:10000', '-v', volume + ':/opt/data', '--entrypoint', PYTHON, IMAGE, '-c',
               "import sys; from pathlib import Path; p=Path(sys.argv[1]); p.mkdir(parents=True,exist_ok=True); (p/'config.yaml').write_text(sys.stdin.read())", home, input=config)
        docker('run', '-d', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
               '--security-opt', 'no-new-privileges:true', '--user', '10000:10000', '--memory', '1g', '--pids-limit', '128',
               '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777', '-v', volume + ':/opt/data',
               '-e', 'HOME=/opt/data', '-e', 'HERMES_HOME=' + home, '-e', 'API_SERVER_ENABLED=true',
               '-e', 'API_SERVER_HOST=127.0.0.1', '-e', 'API_SERVER_KEY=synthetic-memory-test-key-not-a-credential',
               '--entrypoint', '/opt/hermes/.venv/bin/hermes', IMAGE, 'gateway', 'run')
        healthy(name)
        before = json.loads(docker('exec', name, PYTHON, '-c', PROBE, 'add', FACT).strip().splitlines()[-1])
        first = json.loads(docker('inspect', name))[0]['State']['StartedAt']
        docker('restart', '--time', '20', name)
        healthy(name)
        assert first != json.loads(docker('inspect', name))[0]['State']['StartedAt']
        after = json.loads(docker('exec', name, PYTHON, '-c', PROBE, 'recall', FACT).strip().splitlines()[-1])
        return {'kind': kind, 'hermes_home': home, 'before_restart': before, 'after_restart': after, 'restart_verified': True,
                'evidence_scope': 'stock runtime home/tool behavior; not live Wizard transport'}
    finally:
        subprocess.run(['docker', 'rm', '-f', name], capture_output=True)
        subprocess.run(['docker', 'volume', 'rm', volume], capture_output=True)
        assert name not in docker('ps', '-a', '--format', '{{.Names}}').splitlines()
        assert volume not in docker('volume', 'ls', '--format', '{{.Name}}').splitlines()


def main():
    suffix = secrets.token_hex(5)
    names = [f'wizard-memory-proof-{suffix}', f'wizard-memory-import-{suffix}']
    volumes = [name + '-home' for name in names]
    report = {'image': IMAGE, 'test_agents': names, 'paid_inference': False, 'host_home_mounted': False}
    try:
        docker('pull', IMAGE)
        with tempfile.TemporaryDirectory(prefix='memory-proof-', dir=os.environ.get('TMPDIR')) as temp:
            temp = Path(temp)
            # Fresh config comes directly from the managed harness generator.
            config = run(['node', '--input-type=module', '-e', '''import {hermesConfigYaml,PRESETS} from './server/agents.mjs';
console.log(hermesConfigYaml({id:'cobalt-proof',privacy:'standard',model:{provider:'openai',model:'test-only',fallback:false},permissions:{...PRESETS[0].permissions,outside_tools:[],wizard_apps:[],agent_apps:[]}}))'''], cwd=ROOT)
            (temp / 'config.yaml').write_text(config)
            for volume in volumes:
                docker('volume', 'create', volume)
                docker('run', '--rm', '--network', 'none', '--user', '0:0', '--entrypoint', 'chown', '-v', volume + ':/opt/data', IMAGE, '10000:10000', '/opt/data')
            for name, volume in zip(names, volumes):
                docker('create', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                       '--security-opt', 'no-new-privileges:true', '--user', '10000:10000', '--memory', '1g', '--pids-limit', '128',
                       '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777', '-v', volume + ':/opt/data',
                       '-e', 'HOME=/opt/data', '-e', 'HERMES_HOME=/opt/data', '-e', 'API_SERVER_ENABLED=true',
                       '-e', 'API_SERVER_HOST=127.0.0.1', '-e', 'API_SERVER_KEY=synthetic-memory-test-key-not-a-credential',
                       '--entrypoint', '/opt/hermes/.venv/bin/hermes', IMAGE, 'gateway', 'run')
            docker('run', '--rm', '-i', '--network', 'none', '--user', '10000:10000', '-e', 'HOME=/opt/data', '-e', 'HERMES_HOME=/opt/data', '-v', volumes[0] + ':/opt/data', '--entrypoint', PYTHON, IMAGE, '-c', "import sys; from pathlib import Path; Path('/opt/data/config.yaml').write_text(sys.stdin.read())", input=config)
            docker('start', names[0])
            healthy(names[0])
            def probe(name, mode):
                value = docker('exec', '-i', name, PYTHON, '-c', PROBE, mode, FACT)
                return json.loads(value.strip().splitlines()[-1])
            report['before_restart'] = probe(names[0], 'add')
            first = json.loads(docker('inspect', names[0]))[0]
            docker('restart', '--time', '20', names[0])
            healthy(names[0])
            second = json.loads(docker('inspect', names[0]))[0]
            assert first['State']['StartedAt'] != second['State']['StartedAt']
            report['restart_verified'] = True
            report['after_restart'] = probe(names[0], 'recall')
            docker('exec', names[0], PYTHON, '-c', "from pathlib import Path; from hermes_cli.backup import _write_full_zip_backup; assert _write_full_zip_backup(Path('/opt/data/backups/facts.zip'),Path('/opt/data'))")
            docker('cp', names[0] + ':/opt/data/backups/facts.zip', str(temp / 'facts.zip'))
            import zipfile
            with zipfile.ZipFile(temp / 'facts.zip') as archive:
                assert 'memory_store.db' in archive.namelist()
            report['native_backup_contains_facts_db'] = True
            # The second home starts from the native backup, not a hand-copied DB.
            docker('cp', str(temp / 'facts.zip'), names[1] + ':/opt/data/facts.zip')
            docker('run', '--rm', '-i', '--network', 'none', '--user', '10000:10000', '-e', 'HOME=/opt/data', '-e', 'HERMES_HOME=/opt/data', '-v', volumes[1] + ':/opt/data', '--entrypoint', PYTHON, IMAGE, '-c', "import sys; from pathlib import Path; Path('/opt/data/config.yaml').write_text(sys.stdin.read())", input=config)
            docker('start', names[1])
            healthy(names[1])
            docker('exec', names[1], PYTHON, '-c', "from types import SimpleNamespace; from hermes_cli.backup import run_import; run_import(SimpleNamespace(zipfile='/opt/data/facts.zip',force=True))")
            # Exercise Wizard's real import transformer on the restored config.
            sys.path.insert(0, str(ROOT / 'ops/agent-runtime'))
            import hermes_import as importer
            stage = temp / 'staging'
            stage.mkdir()
            (stage / 'config.yaml').write_text(config)
            plan = {'source': '/source/.hermes', 'path_preserving': False, 'mode': 'paused',
                    'gateway_url': 'http://edge:8923/wizard/mcp', 'outside_tools': [], 'approved_plugins': []}
            importer.wire(stage, plan, 'synthetic-api-key', 'synthetic-gateway-key')
            docker('exec', '-i', names[1], PYTHON, '-c', "import sys; from pathlib import Path; Path('/opt/data/config.yaml').write_text(sys.stdin.read())", input=(stage / 'config.yaml').read_text())
            report['after_native_import_and_wizard_wiring'] = probe(names[1], 'recall')
            mounts = second['Mounts']
            assert all((m['Type']=='volume' and m['Name']==volumes[0]) or (m['Type']=='tmpfs' and m['Destination']=='/tmp') for m in mounts)
            assert second['HostConfig']['ReadonlyRootfs'] and second['Config']['User']=='10000:10000'
            report['isolated_nonroot_readonly_container'] = True
            report['runtime_kinds'] = {'restricted': {'before_restart': report['before_restart'], 'after_restart': report['after_restart'], 'restart_verified': True}}
            for kind in ('main', 'host-profile', 'container'):
                report['runtime_kinds'][kind] = scope_parity(kind, config)
            assert set(report['runtime_kinds']) == {'main', 'host-profile', 'container', 'restricted'}
    finally:
        for name in names:
            subprocess.run(['docker', 'rm', '-f', name], capture_output=True)
        for volume in volumes:
            subprocess.run(['docker', 'volume', 'rm', volume], capture_output=True)
        remaining = docker('ps', '-a', '--format', '{{.Names}}').splitlines()
        remaining_volumes = docker('volume', 'ls', '--format', '{{.Name}}').splitlines()
        assert not (set(names) & set(remaining)) and not (set(volumes) & set(remaining_volumes))
        report['test_containers_and_volumes_removed'] = True
    print(json.dumps(report, sort_keys=True, indent=2))


if __name__ == '__main__':
    main()
