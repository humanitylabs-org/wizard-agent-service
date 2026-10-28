#!/usr/bin/env python3
"""Bounded synthetic-only forum proof. No live containers or homes are inspected.

Provider key accepted ONLY on stdin and retained ONLY in synthetic tmpfs. The
receipt explicitly refuses to equate the legacy topology with the old six-check
provider/client contract (notably provider-key location and relay capture).
"""
import datetime
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import urllib.request
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'ops/agent-runtime'))
import agent_runtime as ar
from incognito_runtime import IncognitoManager, PYTHON, VERIFY_RAM
from test_private_seal import fixture

OUT = Path(os.environ.get('PRIVATE_SEAL_EVIDENCE', ROOT / 'qa/private-seal'))
OUT.mkdir(parents=True, exist_ok=True)
PROJECT = 'r9bseal'
FILE = OUT / 'synthetic-compose.json'
AGENT_IMAGE = 'ghcr.io/humanitylabs-org/hermes-agent:v2026.9.24-wizard2'
agent = fixture()
agent['runtime']['port'] = 19650
source = PROJECT + '-agent-synthetic-1'
receipt = {'synthetic_only': True, 'live_touched': False, 'phase': 'setup', 'checks': {},
           'six_privacy_checks': {
               'a_relay_ehbp_capture': {'status': 'not_run', 'reason': 'Official proxy encrypts EHBP inside TLS; legacy package has no old authenticated relay port 8090. No packet/header proof claimed.'},
               'b_hermes_seal_client_reachability': {'status': 'not_run'},
               'c_client_topology_egress': {'status': 'not_run'},
               'd_provider_key_location': {'status': 'blocked', 'reason': 'Round9A legacy stock configuration requires provider bearer in Hermes. Network-only changes cannot meet old provider-only-key contract.'},
               'e_stopped_provider_fail_closed': {'status': 'not_run'},
               'f_provider_logs_data_codeword_scan': {'status': 'not_run'},
           }}
manager = None
key = sys.stdin.read().strip()
assert not key or '\n' not in key
marker = 'SYNTHETIC-R9B-' + secrets.token_hex(16)


def run(args, stdin=None, check=True, timeout=90):
    p = subprocess.run(args, input=stdin, text=True, capture_output=True, timeout=timeout)
    if check and p.returncode:
        if receipt['phase'] == 'setup':
            receipt['setup_diagnostic'] = p.stderr[:4000]
        raise RuntimeError('synthetic_command_failed_' + args[0])
    return p


def compose(*args):
    return run(['docker', 'compose', '-p', PROJECT, '-f', str(FILE), *args], timeout=150)


def exec_py(code, payload=None, timeout=90, container=source):
    p = run(['docker', 'exec', '-i', container, PYTHON, '-c', code], stdin=payload, timeout=timeout)
    return json.loads(p.stdout)


try:
    doc = json.loads(ar.compose_doc(agent, image=AGENT_IMAGE, proxy_image=ar.DEFAULT_PROXY_IMAGE,
                                   home_source='/unused-synthetic', uid=1000, gid=1000, ports=True))
    client = doc['services']['agent-synthetic']
    client.update({'entrypoint': [PYTHON], 'command': ['-c', 'import http.server;http.server.HTTPServer(("0.0.0.0",8642),http.server.BaseHTTPRequestHandler).serve_forever()'],
                   'init': True, 'read_only': True, 'logging': {'driver': 'none'},
                   'tmpfs': ['/opt/data:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700', '/tmp:rw,nosuid,nodev,size=128m,mode=1777'],
                   'user': '1000:1000', 'cap_add': [], 'volumes': [],
                   'mem_limit': '1g', 'memswap_limit': '1g'})
    client['environment'].update({'HOME': '/opt/data', 'HERMES_HOME': '/opt/data', 'HERMES_WORKDIR': '/opt/data', 'PYTHONDONTWRITEBYTECODE': '1'})
    FILE.write_text(json.dumps(doc, indent=2))
    compose('up', '-d')
    receipt['phase'] = 'attestation'
    # Only public attestation metadata. No credential or marker sent yet.
    verify = '''import json,urllib.request,time
out={}
for port in (3301,3302):
 for i in range(30):
  try:
   d=json.load(urllib.request.urlopen('http://agent-synthetic-tinfoil:'+str(port)+'/verification-document',timeout=2))
   if d.get('securityVerified') is not True:raise ValueError('unverified')
   out[str(port)]={k:d.get(k) for k in ('configRepo','enclaveHost','releaseTag','releaseDigest','securityVerified','steps')};break
  except Exception:time.sleep(1)
print(json.dumps(out))
'''
    attestation = exec_py(verify, timeout=90)
    receipt['attestation'] = attestation
    receipt['checks']['both_official_proxies_attested'] = set(attestation) == {'3301', '3302'}
    if not receipt['checks']['both_official_proxies_attested']:
        # No confidential values have entered any container at this phase.
        receipt['unauthenticated_startup_logs'] = {}
        for name in ['agent-synthetic-tinfoil', 'agent-synthetic-search']:
            p = run(['docker', 'logs', PROJECT + '-' + name + '-1'], check=False)
            receipt['unauthenticated_startup_logs'][name] = (p.stdout+p.stderr)[-5000:]
        raise RuntimeError('sealed_attestation_failed')
    receipt['phase'] = 'network_boundary'
    probe = '''import json,socket,urllib.request,urllib.error
out={}
for name,address,port in [('internet_ip','1.1.1.1',443),('edge_connect','10.246.91.4',3128),('edge_ingress','10.246.91.4',8642),('host_bridge','172.17.0.1',443),('provider_egress','10.247.91.3',3128)]:
 try:
  with socket.create_connection((address,port),timeout=2):out[name]=False
 except OSError:out[name]=True
try:
 urllib.request.build_opener(urllib.request.ProxyHandler({})).open('https://example.com',timeout=3);out['example_com']=False
except urllib.error.URLError as e:
 out['example_com']=not isinstance(e,urllib.error.HTTPError)
print(json.dumps(out))
'''
    boundary = exec_py(probe)
    receipt['network_refusals'] = boundary
    receipt['checks']['direct_internet_ip_refused'] = boundary['internet_ip']
    receipt['checks']['example_com_refused'] = boundary['example_com']
    curl = run(['docker','exec',source,'curl','--noproxy','*','--connect-timeout','3','--max-time','5','https://example.com'],check=False)
    receipt['checks']['curl_example_com_failed_inside_agent'] = curl.returncode in (5,6,7,28)
    receipt['curl_example_com_exit_code'] = curl.returncode
    receipt['checks']['no_edge_or_provider_egress_listener_from_agent'] = all(boundary.values())
    meta = json.loads(run(['docker', 'inspect', source]).stdout)[0]
    networks = [json.loads(run(['docker','network','inspect', n]).stdout)[0] for n in meta['NetworkSettings']['Networks']]
    receipt['checks']['agent_internal_only_without_bridge_address'] = len(networks)==1 and all(n['Internal'] and n['Options'].get('com.docker.network.bridge.inhibit_ipv4')=='true' for n in networks)
    receipt['six_privacy_checks']['b_hermes_seal_client_reachability'] = {'status': 'passed' if all(receipt['checks'].values()) else 'failed', 'method': 'Actual stock-image synthetic agent, internal-only metadata, direct public-IP/host/CONNECT refusal and both attested listeners reachable.'}
    provider = json.loads(run(['docker','inspect',PROJECT+'-agent-synthetic-tinfoil-1']).stdout)[0]
    pnetworks = [json.loads(run(['docker','network','inspect',n]).stdout)[0] for n in provider['NetworkSettings']['Networks']]
    receipt['checks']['provider_has_only_internal_networks'] = len(pnetworks)==2 and all(n['Internal'] for n in pnetworks)
    # Test denied declared-host CONNECT from the provider namespace, not the agent.
    denied = run(['docker','run','--rm','--network','container:'+PROJECT+'-agent-synthetic-tinfoil-1','--entrypoint',PYTHON,AGENT_IMAGE,'-c',
                  "import socket; s=socket.create_connection(('10.247.91.3',3128),timeout=3);s.sendall(b'CONNECT example.com:443 HTTP/1.1\\r\\nHost: example.com:443\\r\\n\\r\\n');print(s.recv(100).decode().splitlines()[0])"])
    receipt['checks']['undeclared_connect_refused'] = denied.stdout.strip() == 'HTTP/1.1 403 Forbidden'
    receipt['six_privacy_checks']['c_client_topology_egress'] = {'status': 'passed' if receipt['checks']['provider_has_only_internal_networks'] and receipt['checks']['undeclared_connect_refused'] else 'failed', 'method': 'Official in-seal proxy has two internal networks, no uplink. CONNECT edge denies example.com.'}
    if not key:
        receipt['phase'] = 'credential_required'; raise RuntimeError('stdin_key_required_for_paid_synthetic_tests')
    receipt['phase'] = 'synthetic_seed'
    # This is a generated round9A synthetic config, NOT a copy of any live home.
    config = Path(os.environ['PRIVATE_SEAL_SYNTHETIC_CONFIG']).read_text()
    exec_py('''import json,sys,pathlib
p=json.load(sys.stdin);h=pathlib.Path('/opt/data');(h/'config.yaml').write_text(p['config']);(h/'.env').write_text('TINFOIL_API_KEY='+p['key']+'\\n');(h/'memories').mkdir(exist_ok=True);(h/'memories/MEMORY.md').write_text('Synthetic test only.\\n');print('{}')
''', json.dumps({'key':key,'config':config}))
    receipt['phase'] = 'incognito_start'
    driver = SimpleNamespace(agents=object(),project=lambda _:PROJECT)
    def synthetic_docker(args, **kwargs):
        p = ar.docker(args, **kwargs)
        if p.returncode and args[:1] == ['exec']:
            # Exclusively synthetic containers/config; never generic/live stderr.
            receipt['synthetic_exec_failure'] = (p.stderr[-4000:]).replace(key,'[REDACTED]').replace(marker,'[SYNTHETIC]')
        return p
    manager = IncognitoManager(driver,docker=synthetic_docker,failure=ar.RuntimeFailure,image=AGENT_IMAGE,proxy_image=ar.DEFAULT_PROXY_IMAGE,container_for=lambda *_:source,background=False,owner='r9b-synthetic')
    sid='incog_'+secrets.token_hex(16)
    state=manager.start(agent,sid);target=manager.sessions[('synthetic',sid)]['name']
    receipt['checks']['incognito_start'] = True
    receipt['checks']['incognito_outbound_refused'] = all(exec_py(probe,container=target).values())
    tmeta=json.loads(run(['docker','inspect',target]).stdout)[0]
    receipt['checks']['incognito_no_uplink_no_disk_no_logs'] = list(tmeta['NetworkSettings']['Networks'])==list(meta['NetworkSettings']['Networks']) and tmeta['HostConfig']['LogConfig']['Type']=='none' and not tmeta['Mounts']
    def api(path,method='GET',value=None):
        body=None if value is None else json.dumps(value).encode()
        request=urllib.request.Request(state['origin']+path,data=body,method=method,headers={'Authorization':'Bearer '+state['key'],'Content-Type':'application/json'})
        return json.load(urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request,timeout=15))
    api('/api/sessions','POST',{'id':sid})
    today=datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    prompt=f'Use web search. Find a news article published today {today}; reply with its headline and cited URL. Include this synthetic receipt marker exactly once: '+marker
    admitted=api('/v1/runs','POST',{'session_id':sid,'input':prompt})
    for _ in range(180):
        result=api('/v1/runs/'+admitted['run_id'])
        if result.get('status') in ('completed','failed','cancelled'): break
        manager.lease('synthetic',sid);time.sleep(1)
    receipt['checks']['incognito_send_completed']=result.get('status')=='completed'
    text=json.dumps(result)
    receipt['checks']['incognito_reply_has_citation']=result.get('status')=='completed' and 'http' in text
    # The public run response is not assumed to include tool trace; inspect only
    # this synthetic RAM home's stock session data for the invoked native tool.
    receipt['checks']['native_search_tool_called']=exec_py('''import json,pathlib
h=pathlib.Path('/opt/data');data=b'\\n'.join(p.read_bytes() for p in h.rglob('*') if p.is_file());print(json.dumps(b'mcp__tinfoil_search__search' in data))
''',container=target)
    receipt['phase']='provider_stop'
    compose('stop','agent-synthetic-tinfoil','agent-synthetic-search')
    failure=exec_py('''import json,urllib.request
try:urllib.request.urlopen('http://agent-synthetic-tinfoil:3301/v1/models',timeout=3);print('false')
except Exception:print('true')
''',container=target)
    receipt['checks']['stopped_provider_unreachable']=failure
    failed_admission=api('/v1/runs','POST',{'session_id':sid,'input':'Reply only OK, without using tools.'})
    failed_run={}
    for _ in range(30):
        failed_run=api('/v1/runs/'+failed_admission['run_id'])
        if failed_run.get('status') in ('completed','failed','cancelled'):break
        manager.lease('synthetic',sid);time.sleep(1)
    receipt['stopped_provider_stock_run_status']=failed_run.get('status')
    receipt['checks']['stopped_provider_no_completed_answer']=failed_run.get('status')!='completed'
    if failed_run.get('status') not in ('completed','failed','cancelled'):
        api('/v1/runs/'+failed_admission['run_id']+'/stop','POST',{})
        for _ in range(30):
            cancelled=api('/v1/runs/'+failed_admission['run_id'])
            if cancelled.get('status') in ('failed','cancelled','completed'):break
            manager.lease('synthetic',sid);time.sleep(1)
    compose('start','agent-synthetic-tinfoil','agent-synthetic-search')
    recovery=exec_py(verify,container=target,timeout=90)
    receipt['checks']['provider_recovered_attested']=set(recovery)=={'3301','3302'}
    restored=api('/v1/runs','POST',{'session_id':sid,'input':'Reply with only RECOVERED, without using tools.'})
    recovered={}
    for _ in range(90):
        recovered=api('/v1/runs/'+restored['run_id'])
        if recovered.get('status') in ('completed','failed','cancelled'):break
        manager.lease('synthetic',sid);time.sleep(1)
    receipt['checks']['provider_restore_real_run_succeeds']=recovered.get('status')=='completed' and 'RECOVERED' in json.dumps(recovered)
    receipt['six_privacy_checks']['e_stopped_provider_fail_closed']={'status':'passed' if failed_run.get('status')=='failed' and receipt['checks']['provider_restore_real_run_succeeds'] else 'partial','reason':'Both listeners unreachable, no completed stock answer while stopped, fallback_providers empty. If stock remains retrying after 30s, cancel explicitly before restoring; a terminal provider-failure result is not claimed.'}
    receipt['phase']='close_and_scan'
    manager.stop('synthetic',sid)
    receipt['checks']['incognito_close_removes_exact_sibling']=run(['docker','inspect',target],check=False).returncode!=0
    receipt['checks']['incognito_close_removes_own_edge']=not run(['docker','ps','-aq','--filter','label=wizard.incognito.owner=r9b-synthetic']).stdout.strip()
    logs=''
    for name in ('agent-synthetic-tinfoil','agent-synthetic-search','agent-synthetic-edge'):
        p=run(['docker','logs',PROJECT+'-'+name+'-1'],check=False);logs+=p.stdout+p.stderr
    receipt['checks']['marker_and_key_absent_proxy_logs']=marker not in logs and key not in logs
    receipt['six_privacy_checks']['f_provider_logs_data_codeword_scan']={'status':'partial','reason':'Official proxy stdout/stderr scanned, marker/key absent; read-only proxies have no durable mounts. Not the old provider-app data-volume scanner.'}
    receipt['phase']='complete'
except BaseException as exc:
    receipt['error_class']=type(exc).__name__
    if isinstance(exc,ar.RuntimeFailure):receipt['runtime_failure_code']=exc.code
finally:
    if manager:manager.close()
    if receipt['phase'] == 'setup':
        receipt['unauthenticated_setup_logs'] = {}
        for name in ('agent-synthetic-tinfoil','agent-synthetic-search'):
            p = run(['docker','logs',PROJECT+'-'+name+'-1'],check=False)
            receipt['unauthenticated_setup_logs'][name] = (p.stdout+p.stderr)[-5000:]
    if FILE.exists():
        p=run(['docker','compose','-p',PROJECT,'-f',str(FILE),'down','--remove-orphans'],check=False,timeout=90)
    receipt['cleanup_no_project_containers']=not run(['docker','ps','-aq','--filter','label=com.docker.compose.project='+PROJECT],check=False).stdout.strip()
    receipt['cleanup_no_project_networks']=not run(['docker','network','ls','-q','--filter','label=com.docker.compose.project='+PROJECT],check=False).stdout.strip()
    (OUT/'receipt.json').write_text(json.dumps(receipt,indent=2))
    print(json.dumps(receipt,indent=2))
    if receipt['phase']!='complete' or not all(receipt['checks'].values()):sys.exit(1)
