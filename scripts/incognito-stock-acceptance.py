#!/usr/bin/env python3
"""Actual stock-image synthetic-agent proof; never reads an existing agent/home.
Optional INCOGNITO_PROVIDER_KEY_CONTAINER names a credential-only tmpfs container; its value
is read through Docker stdout into memory and never printed, persisted, or put in Docker argv/env.
"""
import hashlib, json, os, secrets, signal, sqlite3, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
# Allow worker timeouts to unwind the disposable-runtime cleanup below.
def terminate(*_): raise SystemExit(143)
signal.signal(signal.SIGTERM, terminate)
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'ops/agent-runtime'))
from incognito_runtime import IncognitoRuntime  # pyright: ignore[reportMissingImports]
from agent_runtime import RuntimeFailure  # pyright: ignore[reportMissingImports]

OUT = Path(os.environ.get('INCOGNITO_EVIDENCE', 'qa/incognito-stock')); OUT.mkdir(parents=True, exist_ok=True)
report: dict[str, object] = {'synthetic_only': True, 'real_provider_verified': False, 'complete': False}
clock = [time.monotonic()]
normal = Path(tempfile.mkdtemp(prefix='incognito-stock-synthetic-'))
(normal/'MEMORY.md').write_text('Synthetic identity memory: the test animal is an otter.\n')
(normal/'USER.md').write_text('Synthetic owner only. Never use any real owner data.\n')
with sqlite3.connect(normal/'state.db') as db:
    db.execute('create table synthetic_normal_history(value text)')
    db.execute('insert into synthetic_normal_history values (?)', ('synthetic-normal-private-thread',))

def snapshot(): return {str(p.relative_to(normal)): hashlib.sha256(p.read_bytes()).hexdigest() for p in normal.rglob('*') if p.is_file()}
before = snapshot()
markers = ['INC-' + secrets.token_hex(20), 'INC-' + secrets.token_hex(20)]
real_key = os.environ.get('INCOGNITO_REAL_PROVIDER_KEY', '')
if not real_key and os.environ.get('INCOGNITO_PROVIDER_KEY_CONTAINER'):
    holder = os.environ['INCOGNITO_PROVIDER_KEY_CONTAINER']
    meta = json.loads(subprocess.check_output(['docker','inspect',holder], text=True))[0]
    assert meta['HostConfig']['LogConfig']['Type'] == 'none'
    assert any(m.get('Destination') == '/run/credentials' and m.get('Type') == 'tmpfs' for m in meta['Mounts'])
    real_key = subprocess.check_output(['docker','exec',holder,'python','-c',"from pathlib import Path; print(Path('/run/credentials/provider').read_text(),end='')"], text=True).strip()
class Agents:
    def home(self, _): return normal
    def tinfoil_key(self): return real_key or 'synthetic-invalid-provider-key'
agent = {'id':'synthetic','privacy':'private','model':{'provider':'tinfoil','model':os.environ.get('INCOGNITO_MODEL','kimi-k2-6')},'runtime':{'kind':'container'}}
manager = None
try:
    manager = IncognitoRuntime(Agents(), runtime_error=RuntimeFailure, clock=lambda:clock[0], container_for=lambda _: '')
    sid = 'incog_' + secrets.token_hex(16)
    state = manager.start(agent, sid)
    meta = json.loads(subprocess.check_output(['docker','inspect',state['hermes']], text=True))[0]
    cfg = meta['HostConfig']
    assert cfg['ReadonlyRootfs'] and cfg['LogConfig']['Type'] == 'none' and not meta.get('LogPath')
    assert set(cfg['Tmpfs']) >= {'/opt/data','/tmp','/var/log'}
    assert all('noswap' in cfg['Tmpfs'][p].split(',') for p in ['/opt/data','/tmp','/var/log'])
    assert cfg['MemorySwap'] == cfg['Memory'] and cfg['Memory'] > 0
    assert any(x['Name'] == 'core' and x['Hard'] == 0 and x['Soft'] == 0 for x in cfg['Ulimits'])
    assert not [m for m in meta['Mounts'] if m['Type'] == 'bind']
    report['stock_boundary'] = {'read_only_root': True, 'tmpfs_home_and_caches': True, 'tmpfs_no_swap':True, 'memory_swap_disabled':True, 'core_dumps_disabled':True, 'no_bind_mounts':True, 'docker_log_driver':'none','stock_image':meta['Config']['Image']}
    report['tools_disabled_verified_before_admission'] = True
    def api(path, method='GET', value=None):
        data = None if value is None else json.dumps(value).encode()
        req = urllib.request.Request(state['origin']+path, data=data, method=method, headers={'Authorization':'Bearer '+state['key'],'Content-Type':'application/json'})
        with urllib.request.urlopen(req, timeout=20) as r: return json.load(r)
    api('/api/sessions','POST',{'id':sid})
    replies=[]
    prompts=[f'Synthetic RAM-only canary {markers[0]}. Please save that marker in long-term memory. What is the animal in MEMORY.md?', f'Second RAM-only canary {markers[1]}. Repeat both markers from this chat, then the animal from MEMORY.md.']
    for prompt in prompts:
        run=api('/api/v1/runs','POST',{'session_id':sid,'input':prompt})
        result={}
        for _ in range(120):
            result=api('/api/v1/runs/'+run['run_id'])
            if result.get('status') in ['completed','failed','cancelled']: break
            time.sleep(1)
        assert result.get('status') in ['completed','failed','cancelled'], 'synthetic run did not terminate'
        replies.append(result)
    report['two_synthetic_turns_admitted'] = True
    report['memory_save_request_admitted_only_to_ram'] = True
    if real_key and all(r.get('status') == 'completed' for r in replies):
        payload=json.dumps(replies[-1])
        assert all(m in payload for m in markers), 'real model did not retain both temporary turns'
        assert 'otter' in payload.lower(), 'read-only synthetic identity memory missing'
        report['real_provider_verified'] = True
        report['identity_context_verified'] = True
    else:
        report['real_provider_blocker'] = 'No successful real confidential-provider turns; bootstrap and RAM boundary proof are not model-reasoning proof.'
    # Inspect only this disposable synthetic tmpfs, returning a boolean, never its transcript.
    scan = "from pathlib import Path; import json,sys; q=json.load(sys.stdin); b=b''.join(p.read_bytes() for p in Path('/opt/data').rglob('*') if p.is_file()); print(json.dumps({'present':all(m.encode() in b for m in q)}))"
    present = manager._docker(['exec','-i',state['hermes'],'python','-c',scan],stdin=json.dumps(markers).encode())
    assert json.loads(present['stdout'])['present']
    report['both_canaries_seen_only_in_disposable_tmpfs'] = True
    manager.stop('synthetic',sid)
    assert not manager._discover()[0] and not manager._discover()[1]
    assert before == snapshot()
    assert all(not any(m.encode() in p.read_bytes() for m in markers) for p in normal.rglob('*') if p.is_file())
    report['teardown_and_normal_store_unchanged'] = True
    sid2='incog_'+secrets.token_hex(16); manager.start(agent,sid2); clock[0]+=91; manager.sweep()
    assert not manager.sessions and not manager._discover()[0] and not manager._discover()[1]
    report['abandoned_lease_cleaned'] = True
    sid3='incog_'+secrets.token_hex(16); manager.start(agent,sid3)
    recovery=IncognitoRuntime(Agents(),runtime_error=RuntimeFailure,clock=lambda:clock[0],container_for=lambda _: '')
    recovery.close(); manager.sessions.clear()
    assert not manager._discover()[0] and not manager._discover()[1]
    report['helper_restart_reaped_orphans'] = True
    report['complete'] = report['real_provider_verified']
except Exception as exc:
    report['error_type']=type(exc).__name__
    raise
finally:
    if manager: manager.close()
    (OUT/'report.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report))
