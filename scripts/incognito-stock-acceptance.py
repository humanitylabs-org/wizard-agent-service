#!/usr/bin/env python3
"""Actual stock-container boundary proof on a disposable isolated-Linux synthetic agent.
No live/private homes are accessed. Synthetic key default DOES NOT verify a provider response.
Optional INCOGNITO_PROVIDER_KEY_CONTAINER names a credential-only tmpfs container; its value
is read through Docker stdout into memory and never printed, persisted, or put in Docker argv/env.
"""
import hashlib, json, os, secrets, signal, sqlite3, subprocess, sys, tempfile, time, urllib.request
# Let the worker timeout unwind cleanup rather than leaving disposable containers behind.
def terminate(*_): raise SystemExit(143)
signal.signal(signal.SIGTERM, terminate)
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'ops/agent-runtime'))
import agent_runtime as ar
from incognito_runtime import IncognitoManager
OUT = Path(os.environ.get('INCOGNITO_EVIDENCE', ROOT/'qa/incognito-stock')); OUT.mkdir(parents=True, exist_ok=True)
report = {'mode': 'real-stock-synthetic-agent', 'real_provider_verified': False, 'checks': [], 'complete': False}
def check(value, name):
    if not value: raise AssertionError(name)
    report['checks'].append({'check': name, 'pass': True})
def docker(args, **kwargs): return ar.docker(args, **kwargs)
def api(target, path, body=None):
    request = urllib.request.Request(target['origin']+path, data=None if body is None else json.dumps(body).encode(), headers={'Authorization':'Bearer '+target['key'], 'Content-Type':'application/json'})
    with urllib.request.urlopen(request, timeout=20) as response: return json.load(response)
def inspect(name): return json.loads(docker(['inspect', name]).stdout)[0]
def digest_tree(root): return {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}
def scan(root, marker): return sum(marker in p.read_bytes() for p in root.rglob('*') if p.is_file())
manager = None
try:
    with tempfile.TemporaryDirectory(prefix='incognito-stock-', dir=os.environ.get('TMPDIR')) as scratch:
        root = Path(scratch); agents = ar.Agents(root/'agents', None); home = agents.home('synthetic')
        (home/'memories').mkdir(parents=True)
        (home/'AGENTS.md').write_text('You are a synthetic private test agent. Your existing identity is Cedar.\n')
        (home/'memories/MEMORY.md').write_text('Read-only test memory: favourite animal is a silver otter.\n')
        db = sqlite3.connect(home/'state.db'); db.execute('CREATE TABLE messages(content TEXT)'); db.execute("INSERT INTO messages VALUES ('Normal private fixture history remains durable')"); db.commit(); db.close()
        before = digest_tree(home)
        credential_container = os.environ.get('INCOGNITO_PROVIDER_KEY_CONTAINER')
        provider_key = docker(['exec', credential_container, '/opt/hermes/.venv/bin/python', '-c', "import pathlib;print(pathlib.Path('/secret/tinfoil').read_text(),end='')"]).stdout if credential_container else 'synthetic-unusable-provider-key'
        agents.tinfoil_key = lambda: provider_key
        driver = ar.ComposeDriver(agents, ar.DEFAULT_IMAGE, ar.DEFAULT_PROXY_IMAGE)
        agent = {'schema':1,'id':'synthetic','label':'Synthetic private','privacy':'private','model':{'provider':'tinfoil','model':'glm-5-3'},'runtime':{'kind':'container','port':18642,'app_id':'agent-synthetic'}}
        manager = IncognitoManager(driver, docker=docker, failure=ar.RuntimeFailure, image=ar.DEFAULT_IMAGE, proxy_image=ar.DEFAULT_PROXY_IMAGE, container_for=lambda *a: 'does-not-exist-synthetic-only')
        sid = 'incog_'+secrets.token_hex(16); target = manager.start(agent, sid); state = manager.sessions[('synthetic',sid)]
        md = inspect(state['name']); proxy = inspect(state['proxy'])
        check(md['HostConfig']['ReadonlyRootfs'] and proxy['HostConfig']['ReadonlyRootfs'], 'both roots read-only')
        check(md['HostConfig']['LogConfig']['Type']=='none' and proxy['HostConfig']['LogConfig']['Type']=='none', 'Docker logging disabled')
        check(not md['HostConfig'].get('Binds') and all(m['Type']=='tmpfs' for m in md.get('Mounts',[])), 'no binds/volumes/persistent mounts')
        check('/opt/data' in md['HostConfig']['Tmpfs'] and 'noswap' in md['HostConfig']['Tmpfs']['/opt/data'], 'Hermes home is noswap tmpfs')
        check(md['HostConfig']['MemorySwap']==md['HostConfig']['Memory'], 'container swap disabled')
        check(all(target['key'] not in x and provider_key not in x for x in md['Config']['Env'] + md['Config']['Cmd']), 'keys absent from Docker metadata')
        check(set(md['NetworkSettings']['Networks'])=={state['net']}, 'session has only internal network')
        net=json.loads(docker(['network','inspect',state['net']]).stdout)[0]; check(net['Internal'], 'session network marked internal')
        tools = api(target, '/v1/toolsets'); check(not any(t.get('enabled') for t in tools['data']), 'real stock API exposes no enabled tools')
        marker=('INC-REAL-'+secrets.token_hex(16)).encode()
        api(target, '/api/sessions', {'id':sid})
        admitted=api(target, '/v1/runs', {'session_id':sid,'input':marker.decode()+': what animal is in your existing read-only memory? Reply briefly.'})
        run=admitted.get('run_id') or admitted['id']; result={}
        for _ in range(120):
            result=api(target,'/v1/runs/'+run)
            if result.get('status') in ['completed','failed','cancelled','interrupted','expired']: break
            manager.lease('synthetic',sid); time.sleep(1)
        check(scan(home,marker)==0 and digest_tree(home)==before, 'real admitted canary never changes normal private home')
        inside = docker(['exec',state['name'],'/opt/hermes/.venv/bin/python','-c', "import pathlib,sys; b=sys.stdin.buffer.read();print(sum(b in p.read_bytes() for p in pathlib.Path('/opt/data').rglob('*') if p.is_file()))"], input_text=marker.decode()).stdout
        check(int(inside.strip())>0, 'positive control: admitted canary exists in temporary Hermes state')
        if credential_container:
            check(result.get('status')=='completed' and 'otter' in str(result.get('output','')).lower(), 'real confidential-provider memory-seed reply')
            admitted2=api(target,'/v1/runs',{'session_id':sid,'input':'What marker began my last message? Repeat it exactly.'})
            run2=admitted2.get('run_id') or admitted2['id']; result2={}
            for _ in range(120):
                result2=api(target,'/v1/runs/'+run2)
                if result2.get('status') in ['completed','failed','cancelled','interrupted','expired']: break
                manager.lease('synthetic',sid);time.sleep(1)
            check(result2.get('status')=='completed' and marker.decode() in str(result2.get('output','')), 'real confidential-provider multi-turn context')
            report['real_provider_verified']=True
        else:
            report['provider_not_checked']='No real credential supplied. Synthetic unusable key exercises failed-run storage only; no reply is claimed.'
        # Independent watchdog, not a mocked clock: a missing lease terminates stock Hermes even if helper dies.
        docker(['exec',state['name'],'/opt/hermes/.venv/bin/python','-c', "import os;os.utime('/opt/data/.lease',(0,0))"])
        for _ in range(30):
            if not inspect(state['name'])['State']['Running']: break
            time.sleep(.2)
        check(not inspect(state['name'])['State']['Running'], 'in-container lost-helper watchdog terminates session')
        manager.stop('synthetic',sid)
        remaining=docker(['ps','-aq','--filter','label=wizard.incognito=1']).stdout.strip()
        networks=docker(['network','ls','-q','--filter','label=wizard.incognito=1']).stdout.strip()
        check(not remaining and not networks, 'close removes every Incognito container and network')
        check(scan(home,marker)==0 and digest_tree(home)==before, 'post-cleanup canary absent and normal history/seed unchanged')
        report['complete']=True
except Exception as exc:
    # Never emit arbitrary provider, Docker or seed text. The exact safe code/check identifies the blocker.
    report['error_type']=type(exc).__name__
    report['error']=str(exc) if isinstance(exc,AssertionError) else getattr(exc,'code','runtime_acceptance_failed')
    raise
finally:
    if manager: manager.close()
    (OUT/'stock-boundary.json').write_text(json.dumps(report,indent=2))
