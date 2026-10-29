#!/usr/bin/env python3
"""Round 10 synthetic sealed-runtime runner (forum native amd64, heavy lane).

SYNTHETIC ONLY. No real provider key, no live agent/home/Runtipi. The provider
bearer is a generated synthetic value written by the Service-owned migration
(Agents.add_provider_keys) into a scratch agents root; the provider rejects it,
which is the point: the request must reach the attested enclave carrying the
injected key while Hermes holds only the public placeholder.

Part A  six-check evidence: EHBP/TLS capture, key location, bounded
        stopped-provider fail-closed (transport), provider log/data scan.
Part B  installed-Runtipi recipe lifecycle with the bundled docker-compose
        v2.40.0 (from wizard-app-manager:grants-fix-fead192e9fb2-amd64):
        install, restart, upgrade, catalog/user-config persistence, rollback,
        and the unsealed negatives (user config disabled / edited).
Writes JSON evidence to $R10_EVIDENCE (default <worktree>/qa/round10).
"""
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'ops/agent-runtime'))
import agent_runtime as ar  # noqa: E402
import private_seal as seal  # noqa: E402
from incognito_runtime import PYTHON  # noqa: E402

OUT = Path(os.environ.get('R10_EVIDENCE', ROOT / 'qa/round10')); OUT.mkdir(parents=True, exist_ok=True)
WORK = Path(os.environ.get('R10_WORK', ROOT / 'r10-work'))
DC = os.environ.get('R10_COMPOSE', str(ROOT / 'bin/docker-compose'))
AGENT_IMAGE = 'ghcr.io/humanitylabs-org/hermes-agent:v2026.9.24-wizard2'
KEY = 'SYNTHETIC-TINFOIL-KEY-R10-' + secrets.token_hex(16)
MARKER = 'SYNTHETIC-R10-MARKER-' + secrets.token_hex(16)
KEYSRC = ['']
INERT = ['-c', 'import http.server;http.server.HTTPServer(("0.0.0.0",8642),http.server.BaseHTTPRequestHandler).serve_forever()']
receipt = {'synthetic_only': True, 'live_touched': False, 'real_provider_key_used': False, 'phase': 'setup',
           'compose_binary': None, 'six_privacy_checks': {}, 'checks': {}, 'timings_ms': {}}


def run(args, stdin=None, check=True, timeout=180):
    p = subprocess.run([str(a) for a in args], input=stdin, text=True, capture_output=True, timeout=timeout)
    if check and p.returncode:
        receipt.setdefault('diagnostics', []).append({'cmd': [str(a) for a in args][:6], 'rc': p.returncode,
                                                      'stderr': scrub(p.stderr[-1500:])})
        raise RuntimeError('synthetic_command_failed')
    return p


def scrub(text):
    return text.replace(KEY, '<synthetic-key>').replace(MARKER, '<marker>')


def ms(start):
    return round((time.monotonic() - start) * 1000)


def save(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def agent_fixture(n, app_id):
    return {'id': 'synthetic', 'privacy': 'private', 'model': {'provider': 'tinfoil'},
            'runtime': {'app_id': app_id, 'port': 19600 + n, 'network_policy': seal.POLICY, 'provider_key_location': 'provider',
                        'sealed_networks': {'agent': f'10.246.{n}.0/28', 'provider': f'10.247.{n}.0/28', 'keyed': f'10.248.{n}.0/28'}}}


def prepare_home(root):
    """Scratch agents root + Service-owned SYNTHETIC key migration (no real key anywhere)."""
    if root.exists():
        shutil.rmtree(root)
    home = root / 'agents' / 'synthetic' / 'home'; home.mkdir(parents=True)
    (home / '.env').write_text('API_SERVER_KEY=synthetic-r10\nTINFOIL_API_KEY=' + KEY + '\n')  # legacy shape being migrated
    (home / 'memories').mkdir(); (home / 'memories' / 'MEMORY.md').write_text('Synthetic test only.\n')
    (home / 'SOUL.md').write_text('Synthetic identity R10.\n')
    import sqlite3
    db = sqlite3.connect(home / 'state.db'); db.execute('create table messages(id integer primary key, body text)')
    db.executemany('insert into messages(body) values (?)', [('synthetic history %d' % i,) for i in range(50)]); db.commit(); db.close()
    service = root / 'service'; service.mkdir(mode=0o700)
    keyfile = service / 'tinfoil.key'; keyfile.write_text(KEY + '\n'); keyfile.chmod(0o600)
    agents = ar.Agents(root / 'agents', keyfile)
    return agents, home


def identity(home):
    import sqlite3
    db = sqlite3.connect(f'file:{home / "state.db"}?mode=ro', uri=True)
    rows = db.execute('select count(*), group_concat(body, "|") from messages').fetchone(); db.close()
    return {'messages': rows[0], 'history_sha256': hashlib.sha256(rows[1].encode()).hexdigest(),
            'soul': digest(home / 'SOUL.md'), 'memory': digest(home / 'memories' / 'MEMORY.md')}


def backup_scan(root):
    """Backup/export scope: a tar of the whole agents root (what a host or agent backup captures)."""
    import io, tarfile
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w') as tar:
        tar.add(root / 'agents', arcname='agents')
    data = buf.getvalue()
    return {'agents_tree_tar_bytes': len(data), 'key_in_agents_tree_backup': KEY.encode() in data}


def sealed_doc(agent, home, *, ports):
    doc = json.loads(ar.compose_doc(agent, image=AGENT_IMAGE, proxy_image=ar.DEFAULT_PROXY_IMAGE,
                                    home_source=str(home), uid=os.getuid(), gid=os.getgid(), ports=ports,
                                    key_source=KEYSRC[0]))
    main = doc['services'][agent['runtime']['app_id']]
    # Topology/lifecycle stand-in: stock image, inert server; same user/mounts/networks.
    main.update({'entrypoint': [PYTHON], 'command': INERT, 'init': True})
    return doc


def attached(project):
    ids = run(['docker', 'ps', '-q', '--filter', f'label=com.docker.compose.project={project}']).stdout.split()
    out = {}
    if ids:
        rows = run(['docker', 'inspect', '--format', '{{index .Config.Labels "com.docker.compose.service"}} {{json .NetworkSettings.Networks}}', *ids]).stdout
        for row in rows.splitlines():
            service, _, nets = row.partition(' ')
            out[service] = {n[len(project) + 1:] if n.startswith(project + '_') else '!' + n for n in json.loads(nets or '{}')}
    return out


def agent_py(container, code, payload=None, timeout=120):
    p = run(['docker', 'exec', '-i', container, PYTHON, '-c', code], stdin=json.dumps(payload or {}), timeout=timeout)
    return json.loads(p.stdout)


REQUEST = r'''import json,sys,time,urllib.request,urllib.error,socket
p=json.load(sys.stdin);out={}
def call(name,url,bearer,body):
  t=time.monotonic()
  r=urllib.request.Request(url,data=json.dumps(body).encode() if body is not None else None,method='POST' if body is not None else 'GET',headers={'Authorization':'Bearer '+bearer,'Content-Type':'application/json','Accept':'application/json, text/event-stream'})
  try:
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(r,timeout=p.get('timeout',60)) as h:
      code,hdrs,data=h.status,dict(h.headers),h.read()
  except urllib.error.HTTPError as e: code,hdrs,data=e.code,dict(e.headers),e.read()
  except Exception as e: code,hdrs,data='error:'+type(e).__name__,{},b''
  text=data.decode('utf-8','replace')
  err=None
  try: err=json.loads(text).get('error')
  except Exception: pass
  out[name]={'status':code,'ms':round((time.monotonic()-t)*1000),'header_names':sorted(k.lower() for k in hdrs),'error':err if isinstance(err,str) else (type(err).__name__ if err else None),'marker_echoed':p['m'] in text,'key_echoed':p['k'] in text,'bytes':len(data)}
for name,url,bearer,body in p['calls']:call(name,url,bearer,body)
for name,host,port in p.get('connects',[]):
  try: socket.create_connection((host,port),timeout=3).close();out[name]='connected'
  except Exception as e: out[name]='refused:'+type(e).__name__
print(json.dumps(out))'''

SNIFF = r'''import json,os,re,select,socket,struct,sys,time
p=json.loads(sys.stdin.readline());m=p['m'].encode();k=p['k'].encode();ph=p['p'].encode()
s=socket.socket(socket.AF_PACKET,socket.SOCK_RAW,socket.ntohs(3))
names={}
for n in os.listdir('/sys/class/net'):
  try:names[int(open('/sys/class/net/%s/ifindex'%n).read())]=n
  except Exception:pass
st={};buf={}
print('ready',flush=True)
end=time.time()+p['t']
while time.time()<end:
  if not select.select([s],[],[],0.5)[0]:continue
  data,addr=s.recvfrom(65535)
  if addr[2]==socket.PACKET_OUTGOING and names.get(addr[1])=='lo':continue
  n=names.get(addr[1],str(addr[1]))
  if len(data)<34 or data[12:14]!=b'\x08\x00':continue
  ip=data[14:];ihl=(ip[0]&15)*4
  if ip[9]!=6:continue
  src,dst=socket.inet_ntoa(ip[12:16]),socket.inet_ntoa(ip[16:20]);tcp=ip[ihl:];sp,dp=struct.unpack('!HH',tcp[:4]);pay=tcp[(tcp[12]>>4)*4:]
  d=st.setdefault(n,{'frames':0,'payload_bytes':0,'pairs':{},'tls_client_hello_sni':[],'tls_app_records':0,'http_requests':0})
  d['frames']+=1;d['payload_bytes']+=len(pay)
  key='%s>%s:%d'%(src,dst,dp) if dp<sp else '%s:%d>%s'%(src,sp,dst)
  d['pairs'][key]=d['pairs'].get(key,0)+1
  if pay[:1]==b'\x16' and len(pay)>5 and pay[5]==1:
    for h in re.findall(rb'[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:sh|dev|com)',pay):
      h=h.decode()
      if h not in d['tls_client_hello_sni']:d['tls_client_hello_sni'].append(h)
  if pay[:3]==b'\x17\x03\x03':d['tls_app_records']+=1
  if re.match(rb'(GET|POST|DELETE) /',pay):d['http_requests']+=1
  b=buf.setdefault(n,bytearray())
  if len(b)<4000000:b.extend(pay)
for n,b in buf.items():
  st[n].update({'marker_seen':m in b,'synthetic_key_seen':k in b,'placeholder_seen':ph in b,'key_in_authorization':(b'Bearer '+k) in b})
print(json.dumps(st))'''


def part_a():
    receipt['phase'] = 'a_setup'
    n, app = 93, 'agent-synthetic'
    agent = agent_fixture(n, app)
    root = WORK / 'a'
    agents, home = prepare_home(root)
    KEYSRC[0] = agents.key_source(); keyfile = Path(KEYSRC[0])
    id0 = identity(home); pre_backup = backup_scan(root)
    t = time.monotonic(); agents.add_provider_keys(agent); receipt['timings_ms']['a_service_key_migration'] = ms(t)
    env = (home / '.env').read_text()
    migration = {'pre_migration_backup_held_key': pre_backup['key_in_agents_tree_backup'],
                 'home_env_has_synthetic_key': KEY in env, 'home_env_has_placeholder': ('TINFOIL_API_KEY=' + seal.PLACEHOLDER_KEY) in env,
                 'home_env_other_lines_kept': 'API_SERVER_KEY=synthetic-r10' in env, 'post_migration_backup': backup_scan(root),
                 'service_key_mode': oct(keyfile.stat().st_mode & 0o777), 'service_key_outside_agents_tree': not keyfile.is_relative_to(root / 'agents'),
                 'identity_preserved': identity(home) == id0}
    # Forced post-migration rollback, then re-migration: bearer returns to the home only; history/identity unchanged.
    t = time.monotonic(); legacy = json.loads(json.dumps(agent)); legacy['runtime']['provider_key_location'] = ''
    agents.add_provider_keys(legacy)
    migration['rollback'] = {'ms': ms(t), 'home_env_has_synthetic_key': KEY in (home / '.env').read_text(),
                             'identity_preserved': identity(home) == id0}
    agents.add_provider_keys(agent)
    migration['remigrated'] = {'home_env_has_synthetic_key': KEY in (home / '.env').read_text(), 'backup': backup_scan(root),
                               'identity_preserved': identity(home) == id0}
    project = 'r10seal'
    doc = sealed_doc(agent, home, ports=True)
    file = OUT / 'a-compose.json'; file.write_text(json.dumps(doc, indent=2))
    dc = [DC, '-p', project, '-f', file]
    agent_c, proxy_c, key_c = f'{project}-{app}-1', f'{project}-{app}-tinfoil-1', f'{project}-{app}-key-1'
    try:
        t = time.monotonic(); run([*dc, 'up', '-d'], timeout=300); receipt['timings_ms']['a_up'] = ms(t)
        receipt['phase'] = 'a_attestation'
        ph = seal.PLACEHOLDER_KEY
        att = agent_py(agent_c, r'''import json,sys,time,urllib.request
p=json.load(sys.stdin);out={}
for port in (3301,3302):
 for i in range(60):
  try:
   r=urllib.request.Request('http://agent-synthetic-tinfoil:%d/verification-document'%port,headers={'Authorization':'Bearer '+p['p']})
   d=json.load(urllib.request.build_opener(urllib.request.ProxyHandler({})).open(r,timeout=3))
   out[str(port)]={k:d.get(k) for k in ('configRepo','enclaveHost','releaseTag','securityVerified')};out[str(port)]['steps_ok']=all(s.get('status')=='success' for s in d.get('steps',[])) if isinstance(d.get('steps'),list) else None;break
  except Exception:time.sleep(1)
print(json.dumps(out))''', {'p': ph}, timeout=150)
        receipt['attestation_via_injector'] = att
        receipt['checks']['both_attested_via_injector'] = set(att) == {'3301', '3302'} and all(v.get('securityVerified') is True for v in att.values())
        receipt['phase'] = 'a_capture'
        sniff = subprocess.Popen(['docker', 'run', '--rm', '-i', '--name', 'r10sniff', '--network', 'container:' + proxy_c, '--user', '0',
                                  '--cap-drop', 'ALL', '--cap-add', 'NET_RAW', '--entrypoint', 'python', seal.KEY_IMAGE, '-c', SNIFF],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        sniff.stdin.write(json.dumps({'m': MARKER, 'k': KEY, 'p': ph, 't': 40}) + '\n'); sniff.stdin.flush()
        assert sniff.stdout.readline().strip() == 'ready'
        keyed_ip = str(seal.networks(agent)[2][2])
        body = {'model': 'llama3-3-70b', 'messages': [{'role': 'user', 'content': MARKER}], 'max_tokens': 8}
        mcp = {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': MARKER, 'version': '0'}}}
        calls = agent_py(agent_c, REQUEST, {'m': MARKER, 'k': KEY, 'calls': [
            ['placeholder_inference', 'http://agent-synthetic-tinfoil:3301/v1/chat/completions', ph, body],
            ['placeholder_search_mcp', 'http://agent-synthetic-tinfoil:3302/mcp', ph, mcp],
            ['agent_presents_provider_key', 'http://agent-synthetic-tinfoil:3301/v1/chat/completions', KEY, body],
            ['agent_presents_other_bearer', 'http://agent-synthetic-tinfoil:3301/v1/chat/completions', 'other', body]],
            'connects': [['agent_to_official_proxy_direct', keyed_ip, 3301], ['agent_to_internet_ip', '1.1.1.1', 443]]}, timeout=200)
        out, err = sniff.communicate(timeout=90)
        capture = json.loads(out.strip().splitlines()[-1])
        receipt['agent_calls'] = calls; save('a-capture.json', capture)
        keyed_if = [i for i, d in capture.items() if any(p.startswith(f'10.248.{n}.') or f'>10.248.{n}.' in p for p in d['pairs'])]
        prov_if = [i for i, d in capture.items() if any(p.startswith(f'10.247.{n}.') or f'>10.247.{n}.' in p for p in d['pairs'])]
        kd = capture[keyed_if[0]] if keyed_if else {}; pd = capture[prov_if[0]] if prov_if else {}
        reached_provider = isinstance(calls['placeholder_inference']['status'], int) and calls['placeholder_inference']['error'] not in (
            'provider_unavailable', 'agent_must_not_hold_provider_key', 'request_refused', 'provider_key_unavailable')
        receipt['six_privacy_checks']['a_relay_ehbp_capture'] = {
            'status': 'passed' if (kd.get('key_in_authorization') and pd.get('tls_client_hello_sni') and pd.get('tls_app_records', 0) > 0
                                   and not pd.get('marker_seen') and not pd.get('synthetic_key_seen') and not pd.get('placeholder_seen')) else 'failed',
            'scope': 'Raw AF_PACKET capture in the official proxy network namespace. Keyed internal hop: plaintext HTTP from the Service injector carrying the injected bearer. Provider hop to the edge/enclave: TLS only; marker, synthetic key and placeholder absent from every byte. EHBP body framing rides inside that TLS and is not independently decrypted (no TLS key log in tinfoil-go v0.15).',
            'keyed_interface': {k: kd.get(k) for k in ('http_requests', 'key_in_authorization', 'marker_seen', 'placeholder_seen')},
            'provider_interface': {k: pd.get(k) for k in ('tls_client_hello_sni', 'tls_app_records', 'marker_seen', 'synthetic_key_seen', 'placeholder_seen', 'http_requests')},
            'provider_answered_status': calls['placeholder_inference']['status'], 'evidence': str(OUT / 'a-capture.json')}
        receipt['phase'] = 'a_key_location'
        inside = agent_py(agent_c, r'''import json,os,sys,pathlib
p=json.load(sys.stdin);k=p['k'];hits=[]
for base in ('/opt/data','/tmp','/proc/self/environ','/proc/1/environ'):
  path=pathlib.Path(base);files=[path] if path.is_file() else [f for f in path.rglob('*') if f.is_file()] if path.exists() else []
  for f in files:
    try:
      if k.encode() in f.read_bytes():hits.append(str(f))
    except Exception:pass
print(json.dumps({'key_hits_inside_agent':hits,'env_has_tinfoil_var':'TINFOIL_API_KEY' in os.environ}))''', {'k': KEY})
        envs = {}
        for c in run(['docker', 'ps', '-a', '--format', '{{.Names}}', '--filter', f'label=com.docker.compose.project={project}']).stdout.split():
            envs[c] = KEY in run(['docker', 'inspect', '--format', '{{json .Config.Env}}{{json .Mounts}}', c]).stdout
        mounts = {c: [m['Source'] for m in json.loads(run(['docker', 'inspect', '--format', '{{json .Mounts}}', c]).stdout)] for c in envs}
        key_mounted_in = sorted(c for c, srcs in mounts.items() if KEYSRC[0] in srcs)
        receipt['six_privacy_checks']['d_provider_key_location'] = {
            'status': 'passed' if (not migration['home_env_has_synthetic_key'] and migration['home_env_has_placeholder'] and not inside['key_hits_inside_agent']
                                   and not migration['post_migration_backup']['key_in_agents_tree_backup'] and migration['identity_preserved']
                                   and migration['rollback']['home_env_has_synthetic_key'] and migration['rollback']['identity_preserved']
                                   and not migration['remigrated']['home_env_has_synthetic_key'] and not migration['remigrated']['backup']['key_in_agents_tree_backup']
                                   and key_mounted_in == [key_c] and not any(envs.values()) and calls['agent_presents_provider_key']['status'] == 401
                                   and calls['agent_to_official_proxy_direct'].startswith('refused') and reached_provider) else 'failed',
            'method': 'Service-owned SYNTHETIC migration (Agents.add_provider_keys, provider_key_location=provider): bearer removed from the Hermes home; the injector alone mounts the Service key file read-only (no per-agent copy). Agents-tree backup tar scanned before/after; forced rollback and re-migration with synthetic history/identity hashes. Agent scanned from inside (home, /tmp, process environments); every container env/mount inspected. Old pre-migration backups still hold the bearer: live retirement needs provider-key rotation.',
            'migration': migration, 'inside_agent': inside, 'key_in_container_config': envs, 'key_dir_mounted_in': key_mounted_in,
            'agent_with_key_refused': calls['agent_presents_provider_key'], 'placeholder_reached_provider': reached_provider}
        receipt['phase'] = 'a_stop_provider'
        t = time.monotonic(); run(['docker', 'stop', '-t', '5', proxy_c]); receipt['timings_ms']['a_provider_stop'] = ms(t)
        stopped = agent_py(agent_c, REQUEST, {'m': MARKER, 'k': KEY, 'timeout': 30, 'calls': [
            ['inference_while_stopped', 'http://agent-synthetic-tinfoil:3301/v1/chat/completions', ph, body],
            ['search_while_stopped', 'http://agent-synthetic-tinfoil:3302/mcp', ph, mcp]],
            'connects': [['edge_connect_from_agent', str(seal.networks(agent)[0][4]), 3128]]})
        t = time.monotonic(); run(['docker', 'rm', '-f', proxy_c]); receipt['timings_ms']['a_provider_removed'] = ms(t)
        removed = agent_py(agent_c, REQUEST, {'m': MARKER, 'k': KEY, 'timeout': 30, 'calls': [
            ['inference_after_removal', 'http://agent-synthetic-tinfoil:3301/v1/chat/completions', ph, body]]})
        stopped.update(removed)
        bound_ms = 5000
        fail_closed = all(stopped[k]['status'] == 502 and stopped[k]['error'] == 'provider_unavailable' and stopped[k]['ms'] < bound_ms
                          for k in ('inference_while_stopped', 'search_while_stopped', 'inference_after_removal'))
        t = time.monotonic(); run([*dc, 'up', '-d'], timeout=300); receipt['timings_ms']['a_provider_restore'] = ms(t)
        restored = agent_py(agent_c, REQUEST, {'m': MARKER, 'k': KEY, 'timeout': 90, 'calls': [
            ['inference_after_restore', 'http://agent-synthetic-tinfoil:3301/v1/chat/completions', ph, body]]}, timeout=150)
        receipt['six_privacy_checks']['e_stopped_provider_fail_closed'] = {
            'status': 'passed_transport' if fail_closed else 'failed',
            'bound_ms': bound_ms, 'while_stopped': stopped, 'after_restore': restored,
            'scope': 'Transport layer: with the official proxy stopped the injector answers 502 provider_unavailable within the bound; no alternative route (edge CONNECT from agent is still denied by the edge allowlist). Stock-Hermes run classification is NOT re-measured here: round 9B observed stock Hermes still retrying during the bounded window, then cancelled explicitly. Retrying is not reported as terminal failure.'}
        receipt['phase'] = 'a_other_agent'
        seal_ip, key_ip = str(seal.networks(agent)[0][2]), str(seal.networks(agent)[0][3])
        probe = "import socket,json,sys\nout={}\nfor n,h,p in json.loads(sys.argv[1]):\n try: socket.create_connection((h,p),timeout=3).close();out[n]='connected'\n except Exception as e: out[n]='refused:'+type(e).__name__\nprint(json.dumps(out))"
        targets = json.dumps([['injector', key_ip, 3301], ['agent_api', seal_ip, 8642], ['official_proxy', keyed_ip, 3301], ['host_published_api', '172.17.0.1', agent['runtime']['port']]])
        run(['docker', 'network', 'create', '--internal', '--subnet', f'10.246.{n + 50}.0/28', 'r10-other-seal'], check=False)
        other = {}
        for label, net in (('other_sealed_agent', 'r10-other-seal'), ('standard_agent_bridge', 'bridge')):
            r = run(['docker', 'run', '--rm', '--network', net, '--entrypoint', PYTHON, AGENT_IMAGE, '-c', probe, targets], check=False, timeout=120)
            other[label] = json.loads(r.stdout or '{}')
        run(['docker', 'network', 'rm', 'r10-other-seal'], check=False)
        receipt['other_agent_isolation'] = other
        receipt['checks']['other_agents_cannot_reach_seal'] = all(
            v.startswith('refused') for lbl, res in other.items() for k, v in res.items() if k != 'host_published_api') and bool(other['other_sealed_agent'])
        receipt['checks']['other_sealed_agent_cannot_reach_host_api'] = other['other_sealed_agent'].get('host_published_api', '').startswith('refused')
        receipt['phase'] = 'a_scan'
        scan = {}
        for c in envs:
            logs = run(['docker', 'logs', c], check=False)
            text = logs.stdout + logs.stderr
            diff = run(['docker', 'diff', c], check=False).stdout.split('\n')
            changed = [line[2:] for line in diff if line[:1] in ('A', 'C') and line[2:]]
            hits = []
            for path in changed[:400]:
                tar = subprocess.run(['docker', 'cp', f'{c}:{path}', '-'], capture_output=True, timeout=60)
                if MARKER.encode() in tar.stdout or KEY.encode() in tar.stdout:
                    hits.append(path)
            scan[c] = {'log_bytes': len(text), 'log_unreadable_driver_none': 'logging driver' in logs.stderr and logs.returncode != 0,
                       'marker_in_logs': MARKER in text, 'key_in_logs': KEY in text, 'changed_paths': len(changed), 'changed_paths_with_marker_or_key': hits}
        host = []
        for f in root.rglob('*'):
            if f.is_file() and f != keyfile:
                data = f.read_bytes()
                if MARKER.encode() in data or KEY.encode() in data:
                    host.append(str(f.relative_to(root)))
        volumes = run(['docker', 'volume', 'ls', '-q', '--filter', f'label=com.docker.compose.project={project}']).stdout.split()
        clean = not host and not volumes and all(not v['marker_in_logs'] and not v['key_in_logs'] and not v['changed_paths_with_marker_or_key'] for v in scan.values())
        receipt['six_privacy_checks']['f_provider_logs_data_codeword_scan'] = {
            'status': 'passed' if clean else 'failed', 'containers': scan, 'host_mount_hits_outside_key_file': host, 'project_volumes': volumes,
            'scope': 'Every project container: stdout/stderr logs, every added/changed filesystem path (docker diff + docker cp), the synthetic agents root (home, provider-key, gateway dirs) and project volumes, for the run marker and the synthetic key. The Service-owned key file and its source are the only expected key locations.'}
        save('a-receipt.json', {k: receipt[k] for k in ('six_privacy_checks', 'attestation_via_injector', 'agent_calls', 'timings_ms')})
    finally:
        subprocess.run(['docker', 'rm', '-f', 'r10sniff'], capture_output=True)
        run([*dc, 'down', '-v', '--remove-orphans', '-t', '5'], check=False, timeout=300)


# ---- Part B: installed Runtipi recipe lifecycle ----

def runtipi_generate(package, app, store, subnet):
    """Reproduces the app-manager bundle's getDockerCompose/buildService effects that matter to the seal
    (bundle fragments: `if(D)G.networks[`${A}_${J}_network`]`, `if(Z.is_main||Z.add_to_main_network)
    G.networks.tipi_main_network`, `G.ports.push(`\\${APP_PORT}:...`)`, `restart=unless-stopped`,
    `Q.networks.tipi_main_network={name:W,external:!0}`): lossy service copy + Runtipi bridges + port."""
    keep = ('image', 'command', 'entrypoint', 'environment', 'volumes', 'depends_on', 'network_mode', 'user')
    services = {}
    for name, svc in package['services'].items():
        g = {k: v for k, v in svc.items() if k in keep}
        if 'network_mode' not in svc:
            g['networks'] = {f'{app}_{store}_network': {'gw_priority': 0}}
            if name == app:
                g['networks']['tipi_main_network'] = {'gw_priority': 1}
                g['ports'] = ['${APP_PORT}:8642']
        g['labels'] = {'runtipi.managed': 'true', 'runtipi.appurn': f'{app}:{store}', 'traefik.enable': 'false'}
        g['restart'] = 'unless-stopped'
        services[name] = g
    return {'services': services, 'networks': {'tipi_main_network': {'name': 'r10_tipi_main_network', 'external': True},
                                               f'{app}_{store}_network': {'ipam': {'config': [{'subnet': subnet}]}}}}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest() if Path(path).exists() else None


def part_b():
    receipt['phase'] = 'b_setup'
    n, app, store = 94, 'agent-r10', 'wizardapps'
    urn, project = f'{app}:{store}', f'{app}_{store}'
    agent = agent_fixture(n, app); agent['id'] = 'synthetic'
    root = WORK / 'b'
    agents, home = prepare_home(root)
    KEYSRC[0] = agents.key_source()
    tipi = root / 'runtipi'
    catalog = tipi / 'repos' / store / 'apps' / app
    installed = tipi / 'apps' / store / app
    user = tipi / 'user-config' / store / app
    appdata = tipi / 'app-data' / store / app
    for d in (catalog, installed, user, appdata):
        d.mkdir(parents=True, exist_ok=True)
    (appdata / 'app.env').write_text(f'APP_PORT=19694\nROOT_FOLDER_HOST={root}\n')
    (user / 'app.env').write_text('')
    run(['docker', 'network', 'create', 'r10_tipi_main_network'], check=False)
    life = {'steps': [], 'scope': 'Runtipi generator effects reproduced (see runtipi_generate docstring); merge, up/down, restart and network creation by the docker-compose binary bundled in the Runtipi app-manager image. Not a full Runtipi API/database instance.'}

    def render(version):
        a = json.loads(json.dumps(agent)); a['runtime']['version'] = version
        doc = sealed_doc(a, home, ports=False)
        doc['services'][app].setdefault('environment', {})['WIZARD_RECIPE_VERSION'] = version
        (catalog / 'config.json').write_text(json.dumps({'id': app, 'version': version, 'tipi_version': int(version.split('.')[-1]) + 1}))
        (catalog / 'docker-compose.yml').write_text(json.dumps(doc, indent=2))
        (installed / 'docker-compose.yml').write_text(json.dumps(runtipi_generate(doc, app, store, f'10.128.{n}.0/24'), indent=2))
        (installed / 'config.json').write_text((catalog / 'config.json').read_text())
        text = seal.runtipi_override(doc, urn)
        (user / 'docker-compose.yml').write_text(text)
        return doc

    def dc(*args, files=None, timeout=300):
        files = files or [installed / 'docker-compose.yml', user / 'docker-compose.yml']
        cmd = [DC, '--env-file', appdata / 'app.env', '-p', project]
        for f in files:
            cmd += ['-f', f]
        return run([*cmd, *args], timeout=timeout)

    def state():
        return {'catalog_config': digest(catalog / 'config.json'), 'catalog_compose': digest(catalog / 'docker-compose.yml'),
                'user_compose': digest(user / 'docker-compose.yml'), 'user_env': digest(user / 'app.env'),
                'app_env': digest(appdata / 'app.env'), 'home_env': digest(home / '.env'),
                'key_file': digest(KEYSRC[0]), 'identity': identity(home),
                'user_has_mark': (user / 'docker-compose.yml').read_text().startswith(seal.RUNTIPI_MARK)}

    def verify(step, doc, t0, **extra):
        merged = json.loads(dc('config', '--format', 'json').stdout)
        merged_problems = seal.runtime_violations(doc, {s: set((v.get('networks') or {}).keys()) for s, v in merged['services'].items()})
        live = attached(project)
        problems = seal.runtime_violations(doc, live)
        ports = run(['docker', 'ps', '--filter', f'label=com.docker.compose.project={project}', '--format', '{{.Ports}}']).stdout.split()
        att = agent_py(f'{project}-{app}-1', REQUEST, {'m': MARKER, 'k': KEY, 'timeout': 90, 'calls': [
            ['verification', f'http://{app}-tinfoil:3301/verification-document', seal.PLACEHOLDER_KEY, None]],
            'connects': [['internet_ip', '1.1.1.1', 443]]}, timeout=150)
        ids = run(['docker', 'ps', '-q', '--filter', f'label=com.docker.compose.project={project}']).stdout.split()
        row = {'step': step, 'ms': ms(t0), 'merged_config_violations': merged_problems, 'running_violations': problems,
               'published_ports': ports, 'verification_status': att['verification']['status'], 'agent_internet': att['internet_ip'],
               'containers': len(ids), 'state': state(), **extra}
        row['ok'] = (not merged_problems and not problems and not ports and att['verification']['status'] == 200
                     and att['internet_ip'].startswith('refused') and row['state']['user_has_mark'])
        life['steps'].append(row)
        return row

    try:
        t = time.monotonic(); agents.add_provider_keys(agent); doc = render('0.1.0')
        dc('up', '-d', timeout=400); v1 = verify('install_0.1.0', doc, t)
        t = time.monotonic(); dc('stop', '-t', '5'); dc('up', '-d')
        r = verify('restart', doc, t); r['persisted'] = r['state'] == v1['state']
        t = time.monotonic(); dc('down', '-t', '5'); agents.add_provider_keys(agent); doc2 = render('0.1.1'); dc('up', '-d', timeout=400)
        u = verify('upgrade_0.1.1', doc2, t)
        u['catalog_changed'] = u['state']['catalog_config'] != v1['state']['catalog_config']
        u['user_config_rerendered'] = u['state']['user_compose'] != v1['state']['user_compose']
        u['app_env_persisted'] = u['state']['app_env'] == v1['state']['app_env'] and u['state']['user_env'] == v1['state']['user_env']
        u['key_persisted'] = u['state']['key_file'] == v1['state']['key_file'] and u['state']['home_env'] == v1['state']['home_env']
        t = time.monotonic(); dc('stop', '-t', '5'); dc('up', '-d')
        r2 = verify('restart_after_upgrade', doc2, t); r2['persisted'] = r2['state'] == u['state']
        t = time.monotonic(); dc('down', '-t', '5'); doc1 = render('0.1.0'); dc('up', '-d', timeout=400)
        rb = verify('rollback_0.1.0', doc1, t); rb['state_equals_install'] = rb['state'] == v1['state']
        # Negatives (config only, never started): Runtipi user config disabled, or owner-edited override.
        unsealed = json.loads(dc('config', '--format', 'json', files=[installed / 'docker-compose.yml']).stdout)
        neg_disabled = seal.runtime_violations(doc1, {s: set((v.get('networks') or {}).keys()) for s, v in unsealed['services'].items()})
        edited = (user / 'docker-compose.yml').read_text().replace(f'"{app}": !override', f'"{app}":', 1)
        (user / 'docker-compose.yml').write_text(edited)
        merged = json.loads(dc('config', '--format', 'json').stdout)
        neg_edited = seal.runtime_violations(doc1, {s: set((v.get('networks') or {}).keys()) for s, v in merged['services'].items()})
        life['negatives'] = {'user_config_disabled_violations': neg_disabled, 'override_tag_removed_violations': neg_edited,
                             'both_detected': bool(neg_disabled) and bool(neg_edited)}
        steps_ok = all(s['ok'] for s in life['steps'])
        life['passed'] = (steps_ok and r['persisted'] and r2['persisted'] and u['catalog_changed'] and u['user_config_rerendered']
                          and u['app_env_persisted'] and u['key_persisted'] and rb['state_equals_install'] and life['negatives']['both_detected'])
        receipt['checks']['runtipi_lifecycle_passed'] = life['passed']
    finally:
        save('b-runtipi-lifecycle.json', life)
        dcmd = [DC, '--env-file', appdata / 'app.env', '-p', project, '-f', installed / 'docker-compose.yml', '-f', user / 'docker-compose.yml']
        run([*dcmd, 'down', '-v', '--remove-orphans', '-t', '5'], check=False, timeout=300)
        run(['docker', 'network', 'rm', 'r10_tipi_main_network'], check=False)


try:
    receipt['compose_binary'] = scrub(run([DC, 'version']).stdout.strip())
    receipt['compose_binary_sha256'] = digest(DC)
    receipt['source_head'] = run(['git', '-C', ROOT, 'rev-parse', 'HEAD'], check=False).stdout.strip() or os.environ.get('R10_SOURCE_HEAD')
    receipt['images'] = {i: run(['docker', 'image', 'inspect', '--format', '{{.Id}} {{json .RepoDigests}}', i], check=False).stdout.strip()
                         for i in (AGENT_IMAGE, ar.DEFAULT_PROXY_IMAGE, seal.EDGE_IMAGE, seal.KEY_IMAGE)}
    part_a()
    part_b()
    receipt['phase'] = 'complete'
except Exception as error:  # noqa: BLE001
    receipt['error_class'] = type(error).__name__
    receipt['error'] = scrub(str(error))[:400]
finally:
    leftovers = run(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=r10seal'], check=False).stdout.split() + \
        run(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=agent-r10_wizardapps'], check=False).stdout.split()
    receipt['leftover_containers'] = len(leftovers)
    shutil.rmtree(WORK, ignore_errors=True)
    text = scrub(json.dumps(receipt, indent=2, sort_keys=True))
    (OUT / 'receipt.json').write_text(text + '\n')
    for f in OUT.glob('*.json'):
        f.write_text(scrub(f.read_text()))
    print(json.dumps({'phase': receipt['phase'], 'checks': receipt['checks'],
                      'six': {k: v.get('status') for k, v in receipt['six_privacy_checks'].items()}}))
    sys.exit(0 if receipt['phase'] == 'complete' else 1)
