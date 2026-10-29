"""Worker-only probe inside the full pinned Hermes runtime. Normal tool dispatcher,
not ctx stubs; no model/provider request. Host evaluates returned canary evidence.
"""
import json
import os
import sys
sys.path.insert(0, '/opt/hermes')
os.environ['HERMES_YOLO_MODE'] = '1'
assert os.geteuid() == 10000
from hermes_cli.plugins import discover_plugins
discover_plugins()
from model_tools import handle_function_call
own = os.environ.pop('SV_OWN_HANDLE')
other = os.environ.pop('SV_OTHER_HANDLE')
paths = json.loads(os.environ.pop('SV_DENIED_PATHS'))
phase = os.environ.pop('SV_PHASE')
peer_ip = os.environ.pop('SV_PEER_IP')
revoked = os.environ.pop('SV_REVOKED') == '1'

def call(tool, args):
    value = handle_function_call(tool, args, task_id='shared-vault-' + phase)
    try: return json.loads(value)
    except (ValueError, TypeError): return {'raw': value}

results = {}
results['status'] = call('shared_vault_status', {})
results['handles'] = call('shared_vault_handles', {})
handles = results['handles'].get('handles')
assert isinstance(handles, list), 'Native plugin discovery/dispatcher did not expose Shared Vault'
assert {h['handle'] for h in handles} == (set() if revoked else {own})
results['other_handle_run'] = call('shared_vault_run', {'handle': other})
assert results['other_handle_run'].get('error') == 'shared_vault_unavailable'
results['shell'] = call('terminal', {'command': 'id; printf SHELL_OK; env; printf PROC_BOUNDARY; for p in /proc/[0-9]*/environ; do test -r "$p" && tr "\\0" "\\n" < "$p"; done', 'timeout': 15})
assert 'SHELL_OK' in results['shell'].get('output', '')
results['mounts'] = call('read_file', {'path': '/proc/self/mountinfo'})
results['paths'] = [call('read_file', {'path': p}) for p in paths]
results['socket_override'] = call('terminal', {'command': "SHARED_VAULT_SOCKET=/run/shared-vault/agent-b.sock python3 -c \"import socket;s=socket.socket(socket.AF_UNIX);s.settimeout(2);s.connect('/run/shared-vault/agent-b.sock')\"", 'timeout': 5})
assert results['socket_override'].get('exit_code', 1) != 0
results['mount_attempt'] = call('terminal', {'command': 'command -v mount && mkdir -p /tmp/sv-mount-attempt && mount -t tmpfs tmpfs /tmp/sv-mount-attempt', 'timeout': 5})
assert results['mount_attempt'].get('exit_code') not in (None, 0, 127)
results['network'] = call('terminal', {'command': "python3 -c \"import socket; hits=[]; targets=[('" + peer_ip + "',8642),('127.0.0.1',8799),('127.0.0.1',8923),('10.250.0.1',8787),('169.254.169.254',80),('1.1.1.1',443)]; [(lambda s,t: (s.settimeout(.5), hits.append(t) if s.connect_ex(t)==0 else None,s.close()))(socket.socket(),t) for t in targets]; print(hits); assert not hits\"", 'timeout': 8})
assert results['network'].get('exit_code') == 0
print(json.dumps({'phase': phase, 'passed': True, 'dispatcher': 'stock-model_tools', 'results': results}))
