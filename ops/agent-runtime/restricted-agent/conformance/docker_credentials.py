#!/usr/bin/env python3
"""Offline real-image regression: production dispatcher, never in_agent.py.

Synthetic credential only. Prove the old env delivery leaks (positive control),
then the production tmpfs-config grant does not. All resources are labelled,
throwaway and cleaned in finally. No network or inference request.
"""
import json
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
IMAGE = 'ghcr.io/humanitylabs-org/hermes-agent:v2026.9.24-wizard2'
# Credential-shaped but intentionally fake; exercises stock sk- prefix matching.
SYNTHETIC = 'sk-ant-oat01-SYNTHETIC-ROUND4-NOT-A-REAL-CREDENTIAL-0123456789'
PROBE = r'''
import json, os, pathlib, sys, time
sys.path.insert(0, '/opt/hermes')
sys.path.insert(0, '/opt/hermes/plugins/model-providers/claude-subscription-directsdk-experimental')
import directsdk_setup
# Same harness field the Service writes; no token/env/output pre-scrubbing.
pathlib.Path('/opt/data/config.yaml').write_text('security:\n  redact_secrets: true\n')
from model_tools import handle_function_call
config = pathlib.Path('/run/claude-login/.credentials.json')
for _ in range(100):
    if config.is_file(): break
    time.sleep(.1)
assert os.getuid() == 10000
assert next(l.split()[1] for l in pathlib.Path('/proc/self/status').read_text().splitlines()
            if l.startswith('CapEff:')) == '0000000000000000', 'agent capabilities not dropped'
# No credential env pre-removal. Precisely the normal production tool path.
result = json.loads(handle_function_call('terminal', {
    'command': 'printf snapshot-ok', 'timeout': 10}, task_id='claude-credential-regression'))
assert result.get('exit_code') == 0 and result.get('output') == 'snapshot-ok', 'dispatcher failed'
auth = json.loads(config.read_text())['claudeAiOauth']
assert 'refreshToken' not in auth
assert not pathlib.Path('/claude-app').exists(), 'raw app login reached agent'
try:
    with config.open('a'): pass
except OSError:
    pass
else:
    raise AssertionError('agent projection must be read-only')
token = auth['accessToken'].encode()
files = list(pathlib.Path('/opt/data').rglob('*'))
assert any(p.name.startswith('hermes-snap-') for p in files), 'snapshot control missing'
status = directsdk_setup.setup_status()
assert status['available'] and status['logged_in'], 'plugin cannot use config login'
empty = pathlib.Path('/tmp/empty-claude-config'); empty.mkdir()
negative_env = dict(os.environ, CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR=str(empty))
negative_env.pop('CLAUDE_CODE_OAUTH_TOKEN', None)
assert not directsdk_setup.setup_status(env=negative_env)['logged_in'], 'login negative control failed'
# Persist the UNCHANGED ordinary dispatcher result, not a synthesized result.
read_result = handle_function_call('terminal', {
    'command': 'cat /run/claude-login/.credentials.json', 'timeout': 10}, task_id='claude-credential-regression')
assert json.loads(read_result)['exit_code'] == 0
redaction_enabled = os.getenv('HERMES_REDACT_SECRETS', 'true') != 'false'
assert (token not in read_result.encode()) == redaction_enabled, 'stock OAuth redaction mismatch'
from run_agent import AIAgent
from hermes_state import SessionDB
db = SessionDB()
agent = AIAgent(model='offline-regression', provider='openai', base_url='https://offline.invalid/v1',
    api_key='synthetic-no-network', session_db=db, session_id='claude-redaction-regression',
    save_trajectories=True, skip_context_files=True, skip_background_review=True, quiet_mode=True)
messages = [{'role': 'user', 'content': 'Run local auth diagnostics.'},
    {'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'credential-read', 'type': 'function',
        'function': {'name': 'terminal', 'arguments': json.dumps({'command': 'cat /run/claude-login/.credentials.json'})}}]},
    {'role': 'tool', 'name': 'terminal', 'tool_call_id': 'credential-read', 'content': read_result},
    {'role': 'assistant', 'content': 'Diagnostics completed.'}]
agent._persist_session(messages)
agent._save_trajectory(messages, 'Run local auth diagnostics.', True)
saved = [m for m in db.get_messages('claude-redaction-regression') if m['role'] == 'tool']
assert len(saved) == 1 and saved[0]['content'] == read_result, 'session altered tool result'
db.close()
reopened = SessionDB()
assert len([m for m in reopened.get_messages('claude-redaction-regression') if m['role'] == 'tool']) == 1
reopened.close()
assert pathlib.Path('/opt/data/state.db').is_file()
assert pathlib.Path('/opt/data/trajectory_samples.jsonl').is_file()
# Scan AFTER real session/trajectory writes and DB close/reopen, including snapshots.
found = [str(p) for p in pathlib.Path('/opt/data').rglob('*') if p.is_file() and token in p.read_bytes()]
print(json.dumps({'dispatcher_ok': True, 'snapshot_created': True,
                 'redaction_enabled': redaction_enabled, 'cat_token_redacted': token not in read_result.encode(),
                 'session_saved_reopened': True, 'trajectory_saved': True,
                 'token_in_gateway_env': 'CLAUDE_CODE_OAUTH_TOKEN' in os.environ,
                 'matching_home_files': found, 'plugin_login_usable': status['logged_in'],
                 'login_negative_control': True, 'uid10000_no_caps': True}))
'''


def docker(*args, **kwargs):
    run = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=90, **kwargs)
    if run.returncode:
        # Do not propagate potentially credential-bearing container output.
        raise RuntimeError('Docker credential regression failed (output suppressed)')
    return run.stdout


def main():
    tag = 'claude-grant-' + uuid.uuid4().hex[:12]
    volume = tag + '-config'
    names = [tag + '-init', tag + '-legacy', tag + '-redaction-off', tag + '-fixed']
    try:
        docker('volume', 'create', '--label', 'claude-app-grant-test', '--label', 'fixture=' + tag,
               '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt',
               'o=size=4m,uid=10000,gid=10000,mode=0700,nosuid,nodev,noexec', volume)
        assert json.loads(docker('volume', 'inspect', volume))[0]['Options']['type'] == 'tmpfs'
        with tempfile.TemporaryDirectory(prefix='claude-credential-') as folder:
            login = Path(folder) / 'claude'; login.mkdir(mode=0o700)
            secret = login / '.credentials.json'
            def write_login(token=SYNTHETIC):
                replacement = login / 'new'
                replacement.write_text(json.dumps({'claudeAiOauth': {'accessToken': token,
                    'refreshToken': 'SYNTHETIC-REFRESH-NEVER-GRANTED', 'expiresAt': time.time()*1000+3600000,
                    'scopes': ['user:inference','user:profile'], 'subscriptionType': 'max'}}))
                replacement.chmod(0o600); replacement.replace(secret)
            write_login()
            before = (secret.read_bytes(), secret.stat().st_mode, secret.stat().st_uid)
            assert login.stat().st_uid == 1000 and login.stat().st_mode & 0o777 == 0o700
            # Same production seeder, isolated from the home and all networks.
            docker('run', '--rm', '-d', '--name', names[0], '--label', 'claude-app-grant-test',
                   '--label', 'fixture=' + tag, '--network', 'none', '--read-only', '--user', '0:0',
                   '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--cap-add', 'DAC_OVERRIDE',
                   '--security-opt', 'no-new-privileges:true', '--memory', '64m', '--pids-limit', '32',
                   '--mount', f'type=bind,src={login},dst=/claude-app,readonly',
                   '-v', volume + ':/run/claude-login', '--entrypoint', '/opt/hermes/.venv/bin/python',
                   IMAGE, '-c', (ROOT / 'sidecars/claude-init.py').read_text())
            def wait_check(expected):
                for _ in range(50):
                    check = subprocess.run(['docker','exec', names[0], '/opt/hermes/.venv/bin/python','-c',
                        (ROOT/'sidecars/claude-init.py').read_text(), '--check'], capture_output=True, timeout=10)
                    projected = subprocess.run(['docker','exec', names[0], 'test','-f','/run/claude-login/.credentials.json'],
                                               capture_output=True, timeout=10)
                    if (check.returncode == 0) == expected and (projected.returncode == 0) == expected:
                        return
                    time.sleep(0.2)
                raise AssertionError('projection readiness timeout')
            wait_check(True)
            receipts = {}
            for mode, name in zip(('legacy', 'redaction-off', 'fixed'), names[1:]):
                legacy = mode == 'legacy'
                env_args = ['-e', 'CLAUDE_CODE_OAUTH_TOKEN=' + SYNTHETIC] if legacy else []
                if mode == 'redaction-off': env_args += ['-e', 'HERMES_REDACT_SECRETS=false']
                raw = docker('run', '--rm', '-i', '--name', name, '--label', 'claude-app-grant-test',
                    '--label', 'fixture=' + tag, '--network', 'none', '--read-only', '--user', '10000:10000',
                    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                    '--memory', '768m', '--pids-limit', '128',
                    '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m,mode=1777',
                    '--tmpfs', '/opt/data:rw,nosuid,nodev,size=64m,uid=10000,gid=10000,mode=700',
                    '-v', volume + ':/run/claude-login:ro', '-e', 'HOME=/opt/data', '-e', 'HERMES_HOME=/opt/data',
                    '-e', 'HERMES_YOLO_MODE=1', '-e', 'CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR=/run/claude-login',
                    *env_args, '--workdir', '/opt/data', '--entrypoint', '/opt/hermes/.venv/bin/python',
                    IMAGE, '-', input=PROBE)
                receipt = json.loads(raw.splitlines()[-1])
                assert bool(receipt['matching_home_files']) == (mode != 'fixed')
                if mode == 'redaction-off':
                    assert any('state.db' in p for p in receipt['matching_home_files'])
                    assert any('trajectory_samples.jsonl' in p for p in receipt['matching_home_files'])
                assert receipt['token_in_gateway_env'] == legacy
                receipts[mode] = receipt
            assert before == (secret.read_bytes(), secret.stat().st_mode, secret.stat().st_uid), 'app login changed'
            # Rotation of the source inode must be observed without seeder restart.
            write_login(SYNTHETIC + '-rotated')
            time.sleep(2.5)
            rotated = json.loads(docker('run','--rm','-i','--name',names[-1], '--label','claude-app-grant-test',
                '--label','fixture='+tag, '--network','none','--read-only','--user','10000:10000','--cap-drop','ALL',
                '--security-opt','no-new-privileges:true','--memory','768m','--pids-limit','128',
                '--tmpfs','/tmp:rw,nosuid,nodev,size=64m,mode=1777',
                '--tmpfs','/opt/data:rw,nosuid,nodev,size=64m,uid=10000,gid=10000,mode=700',
                '-v',volume+':/run/claude-login:ro','-e','HOME=/opt/data','-e','HERMES_HOME=/opt/data',
                '-e','HERMES_YOLO_MODE=1','-e','CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR=/run/claude-login',
                '--workdir','/opt/data','--entrypoint','/opt/hermes/.venv/bin/python',IMAGE,'-',input=PROBE).splitlines()[-1])
            assert not rotated['matching_home_files']
            receipts['rotated'] = rotated
            secret.unlink(); wait_check(False)
            assert docker('inspect',names[0],'--format','{{.State.Running}}').strip() == 'true'
            write_login(); wait_check(True)
            receipts['source_unchanged_uid1000_modes'] = True
            receipts['rotation_logout_reconnect_without_restart'] = True
            print(json.dumps(receipts, indent=2))
    finally:
        for name in reversed(names):
            subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=20)
        subprocess.run(['docker', 'volume', 'rm', '-f', volume], capture_output=True, timeout=20)
        for args in (['ps', '-a'], ['network', 'ls'], ['volume', 'ls']):
            assert not docker(*args, '-q', '--filter', 'label=fixture=' + tag).strip(), 'fixture cleanup failed'


if __name__ == '__main__':
    main()
