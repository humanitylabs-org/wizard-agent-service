#!/usr/bin/env python3
"""Synthetic-only next-proof runner. Parent submits on forum; never migration admission.

No credential handoff: all keys and images sent here are generated fixtures. The
selected daemon is run unchanged inside a disposable nested Docker engine. A
known UI bypass is measured, not hidden by a driver-only guard or watchdog.
"""
from __future__ import annotations
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import struct
import sys
import time
import urllib.error
import urllib.request
import zlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'ops/agent-runtime'))
sys.path.insert(0, str(ROOT / 'deps/wam-current'))
import agent_runtime as ar
import private_seal as seal
seal.EDGE_IMAGE = os.environ['R11_EDGE_IMAGE']
seal.KEY_IMAGE = os.environ['R11_KEY_IMAGE']
from test_private_seal import fixture
from wam.runtipi import Runtipi
from incognito_runtime import PYTHON
from private_seal_round11_setup import unique_images, stock_config, stock_launch, stock_sessions_ready, manager_layout
from private_seal_round11_protocol import nested_docker_argv, manager_health_ready, queues_ready, catalog_build_context
PREFLIGHT = sys.argv[1:] == ['--preflight-only']
MANAGER_ONLY = sys.argv[1:] == ['--manager-only']
if sys.argv[1:] and not (PREFLIGHT or MANAGER_ONLY): raise SystemExit('unknown_round11_argument')
OUT = ROOT / ('qa/round11d-manager' if MANAGER_ONLY else 'qa/round11c-preflight' if PREFLIGHT else 'qa/round11c')
WORK = ROOT / ('work-round11d-manager' if MANAGER_ONLY else 'work-round11c-preflight' if PREFLIGHT else 'work-round11c')
OWNER = 'wizard.qa.round11=' + os.environ['R11_SOURCE_HEAD'][:12]
DAEMON = 'wizard-app-manager:grants-fix-fead192e9fb2-amd64'
DAEMON_ID = 'sha256:908ba820e904091ddd38402404fdde212ca2f14b61b33c621dfe134d635f8ce9'
DAEMON_MANIFEST = 'sha256:f2e1be459cf8e8ffc41225a3a676c7a704db6fd96c857a5e2b774c8eee6446d4'
STOCK = ar.DEFAULT_IMAGE
DIND = 'r11-disposable-engine'
KEY = 'SYNTHETIC-R11-' + secrets.token_hex(24)
APIKEY = 'synthetic-api-' + secrets.token_hex(24)
SECRET_VALUES = [KEY, APIKEY]
receipt = {'schema': 1, 'synthetic_only': True, 'live_touched': False, 'preflight_only':PREFLIGHT,
           'source_head': os.environ['R11_SOURCE_HEAD'], 'phase': 'setup', 'checks': {},
           'not_claimed': ['live migration', 'credential rotation / old-backup retirement',
                           'decrypted EHBP framing', 'Tinfoil multimodal semantic success',
                           'full selected-source composition or owner-data parity']}
owned = []
owned_networks = []


def run(args, *, check=True, timeout=180, data=None):
    p = subprocess.run([str(a) for a in args], input=data, text=True, capture_output=True, timeout=timeout)
    if check and p.returncode:
        # Never print generic container output; all artifacts still scrub fixture secrets.
        receipt['last_synthetic_command_failure'] = {'program':str(args[0]), 'exit_code':p.returncode,
                                                    'stderr_tail':p.stderr[-1600:]}
        raise RuntimeError('command_failed:' + str(args[0]) + ':' + str(p.returncode))
    return p


def save(name, value):
    text = json.dumps(value, indent=2, sort_keys=True)
    for token in SECRET_VALUES: text = text.replace(token, '[SYNTHETIC-SECRET]')
    (OUT / name).write_text(text + '\n')


def docker(*args, **kw): return run(['docker', *args], **kw)
def nd(*args, **kw): return run(nested_docker_argv(DIND, list(args), kw.get('data')), **kw)


def wait(fn, seconds=120):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            result = fn()
            if result: return result
        except (OSError, ValueError, RuntimeError): pass
        time.sleep(1)
    raise RuntimeError('readiness_deadline')


def container(name, image, args=(), flags=()):
    docker('run', '-d', '--name', name, '--label', OWNER, *flags, image, *args)
    owned.append(name)
    return name


def json_http(url, value=None, method=None, headers=None, timeout=10):
    req = urllib.request.Request(url, None if value is None else json.dumps(value).encode(),
        {'Content-Type': 'application/json', **(headers or {})}, method=method)
    return json.load(urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=timeout))


def synthetic_image_request(model):
    def chunk(kind, data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data))
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR',struct.pack('>IIBBBBB',1,1,8,6,0,0,0)) + chunk(b'IDAT',zlib.compress(b'\0\0\0\0\xff')) + chunk(b'IEND',b'')
    return {'model':model,'messages':[{'role':'user','content':[{'type':'text','text':'Synthetic one-pixel image.'},
            {'type':'image_url','image_url':{'url':'data:image/png;base64,'+base64.b64encode(png).decode()}}]}]}


def import_image(image):
    # Pipe between engines on forum; no image archives or owner paths in the daemon.
    a = subprocess.Popen(['docker', 'save', image], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        b = subprocess.run(['docker', 'exec', '-i', DIND, 'docker', 'load'], stdin=a.stdout,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=600)
        a.stdout.close()
        assert a.wait(timeout=30) == b.returncode == 0
    finally:
        if a.poll() is None: a.kill(); a.wait()


def manager_phase():
    """Real Nest/Runtipi API + queue + Postgres + generator + bundled Compose.

    The selected daemon image is immutable. The unsafe negative has only a
    synthetic sleeping client and a generated invalid key; it is stopped again
    before recording the result. A successful direct start is a FAILED gate.
    """
    receipt['phase'] = 'installed_manager'
    assert docker('image', 'inspect', '--format', '{{.Id}}', DAEMON).stdout.strip() == DAEMON_ID
    state = WORK / 'manager'; state.mkdir(parents=True)
    engine = WORK / 'engine'; engine.mkdir()
    container(DIND, 'docker:28-dind', ['--host=unix:///var/run/docker.sock'],
              ['--privileged', '-e', 'DOCKER_TLS_CERTDIR=', '-v', f'{ROOT}:{ROOT}',
               '-v', f'{engine}:/var/lib/docker'])
    wait(lambda: nd('info', check=False).returncode == 0, 90)
    images = (DAEMON, 'python:3.12-slim') if PREFLIGHT else (DAEMON, STOCK, ar.DEFAULT_PROXY_IMAGE, seal.EDGE_IMAGE, seal.KEY_IMAGE, 'python:3.12-slim')
    for image in unique_images(images):
        import_image(image)
        # Runtipi may `down --rmi all` during install/update; retain exact imported
        # images so that no unpublished daemon or scratch edge is pulled by tag.
        nd('create', '--name', 'r11-keeper-' + hashlib.sha256(image.encode()).hexdigest()[:12],
           '--entrypoint', '/bin/true', image)
    for image in ('postgres:14', 'rabbitmq:4-alpine'):
        nd('pull', image, timeout=600)
    nd('network', 'create', 'runtipi_tipi_main_network')
    shared = ['--network', 'runtipi_tipi_main_network']
    nd('run', '-d', '--name', 'runtipi-db', *shared, '-e', 'POSTGRES_USER=tipi', '-e', 'POSTGRES_DB=tipi',
       '-e', 'POSTGRES_PASSWORD=synthetic-password', 'postgres:14')
    nd('run', '-d', '--name', 'runtipi-queue', *shared, '-e', 'RABBITMQ_DEFAULT_USER=tipi',
       '-e', 'RABBITMQ_DEFAULT_PASS=synthetic-password', 'rabbitmq:4-alpine')
    # The selected daemon only retries initial queue failure a bounded number
    # of times. Ready its real dependencies before starting the immutable image.
    wait(lambda: nd('exec','runtipi-db','pg_isready','-U','tipi','-d','tipi',check=False).returncode == 0, 90)
    wait(lambda: nd('exec','runtipi-queue','rabbitmq-diagnostics','-q','check_running',check=False).returncode == 0
         and nd('exec','runtipi-queue','rabbitmq-diagnostics','-q','check_port_connectivity',check=False).returncode == 0, 120)
    directories, mounts, app_data_parent = manager_layout(state)
    for directory in directories:
        (state / directory).mkdir(mode=0o755)
        (state / directory).chmod(0o755)
    catalog = state / 'catalog'
    run(['git', 'init', '-q', catalog]); (catalog / '.keep').write_text('Synthetic catalogue.\n')
    run(['git', '-C', catalog, 'add', '-A'])
    run(['git', '-C', catalog, '-c', 'user.name=Synthetic QA', '-c', 'user.email=qa@example.invalid', 'commit', '-qm', 'empty synthetic catalogue'])
    catalog_image = os.environ.get('R11_CATALOG_IMAGE', 'round11-synthetic-catalog:' + os.environ['R11_SOURCE_HEAD'][:12])
    if 'R11_CATALOG_IMAGE' not in os.environ:
        context = catalog_build_context(ROOT, OUT/'catalog-build')
        docker('build','--pull=false','-t',catalog_image,str(context),timeout=600)
    import_image(catalog_image)
    nd('run', '-d', '--name', 'r11-catalog', *shared, '-v', f'{state}:/www:ro',
       catalog_image)
    jwt_secret = secrets.token_hex(32)
    SECRET_VALUES.append(jwt_secret)
    env = dict(POSTGRES_HOST='runtipi-db', POSTGRES_DBNAME='tipi', POSTGRES_USERNAME='tipi', POSTGRES_PASSWORD='synthetic-password',
               POSTGRES_PORT='5432', RABBITMQ_HOST='runtipi-queue', RABBITMQ_USERNAME='tipi', RABBITMQ_PASSWORD='synthetic-password',
               ARCHITECTURE='amd64', INTERNAL_IP='127.0.0.1', TIPI_VERSION='v4.10.2', JWT_SECRET=jwt_secret,
               APPS_REPO_ID='r11synthetic', APPS_REPO_URL='http://r11-catalog:8080/catalog/.git', DOMAIN='synthetic.invalid',
               LOCAL_DOMAIN='synthetic.local', DNS_IP='9.9.9.9', RUNTIPI_APP_DATA_PATH=app_data_parent,
               RUNTIPI_FORWARD_AUTH_URL='http://runtipi:3000/api/auth/traefik', DEMO_MODE='false', GUEST_DASHBOARD='false',
               ALLOW_ERROR_MONITORING='false', ALLOW_AUTO_THEMES='false', PERSIST_TRAEFIK_CONFIG='true', TZ='UTC',
               ROOT_FOLDER_HOST=str(state), NGINX_PORT='80', NGINX_PORT_SSL='443', ADVANCED_SETTINGS='true',
               THEME_BASE='dark', THEME_COLOR='blue', MAX_BACKUPS='0', EXPERIMENTAL_INSECURE_COOKIE='true',
               NODE_ENV='production', LOG_LEVEL='warn')
    (state / '.env').write_text(''.join(f'{k}={v}\n' for k, v in env.items())); (state / '.env').chmod(0o600)
    (state / 'docker-compose.yml').write_text('services: {}\n')
    mount_flags = [item for source, target in mounts for item in ('-v', f'{source}:{target}')]
    nd('run', '-d', '--name', 'runtipi', *shared, '--env-file', state / '.env', *mount_flags,
       '-v', '/var/run/docker.sock:/var/run/docker.sock:ro', '-p', '127.0.0.1:3000:3000', DAEMON)
    # All authenticated HTTP is executed inside the nested engine namespace.
    class NestedRuntipi(Runtipi):
        def req(self, method, path, body=None, timeout=60):
            from wam.runtipi import cli_token
            code = "import urllib.request,json;v=json.loads(input());r=urllib.request.Request('http://runtipi:3000/api'+v['path'],None if v['body'] is None else json.dumps(v['body']).encode(),{'Authorization':'Bearer '+v['token'],'Content-Type':'application/json'},method=v['method']);h=urllib.request.urlopen(r,timeout=120);raw=h.read();print(raw.decode() if raw else '{}')"
            p = nd('exec', '-i', 'r11-api', 'python3', '-c', code,
                   data=json.dumps({'path': path, 'method': method, 'body': body, 'token': cli_token(jwt_secret)}), timeout=timeout + 10)
            return json.loads(p.stdout)
    nd('run', '-d', '--name', 'r11-api', *shared, 'python:3.12-slim', 'python3', '-c', 'import time;time.sleep(3000)')
    transport_probe = nd('exec','-i','r11-api','python3','-c','import json;print(json.dumps(json.loads(input())))',data='{"synthetic_stdin_roundtrip":true}')
    assert json.loads(transport_probe.stdout) == {'synthetic_stdin_roundtrip':True}
    receipt['checks']['nested_stdin_roundtrip'] = True
    def manager_ready():
        status = json.loads(nd('inspect', '--format', '{{json .State}}', 'runtipi').stdout)
        if not status.get('Running'): raise AssertionError('synthetic_manager_exited_before_readiness')
        p = nd('exec', 'r11-api', 'python3', '-c', "import urllib.request,json;print(urllib.request.urlopen('http://runtipi:3000/api/health',timeout=3).read().decode())", check=False)
        if p.returncode or not manager_health_ready(json.loads(p.stdout)): return False
        q = nd('exec', 'runtipi-queue', 'rabbitmqctl', '-q', 'list_queues', 'name', 'consumers', '--formatter', 'json')
        return queues_ready(json.loads(q.stdout))
    wait(manager_ready, 120)
    # /cache is mandatory in the selected daemon (CacheService uses node:sqlite).
    cache_probe = nd('exec', 'runtipi', 'node', '--input-type=module', '-e',
        "import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync('/cache/cache.sqlite');const tables=d.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r=>r.name);d.close();console.log(JSON.stringify({uid:process.getuid(),cache_uid:fs.statSync('/cache').uid,cache_mode:fs.statSync('/cache').mode&511,tables,app_data_parent:process.env.RUNTIPI_APP_DATA_PATH}))")
    cache_info = json.loads(cache_probe.stdout)
    assert 'keyv' in cache_info['tables'] and cache_info['app_data_parent'] == str(state)
    assert cache_info['uid'] == 0 and cache_info['cache_uid'] == os.getuid() and cache_info['cache_mode'] == 0o755
    save('manager-setup.json', {'cache':cache_info,'mounts':[[str(s),t] for s,t in mounts],
                              'health_ready':True,'queue_health_up':True,'all_queue_consumers_ready':True,
                              'database_ready_before_daemon':True,'rabbitmq_ready_before_daemon':True})
    receipt['checks']['manager_setup_ready'] = True
    if PREFLIGHT: return
    # Fresh synthetic operator only; never read or copy a real login.
    synthetic_password = secrets.token_urlsafe(32); SECRET_VALUES.append(synthetic_password)
    nd('exec', '-i', 'r11-api', 'python3', '-c', "import json,urllib.request;urllib.request.urlopen(urllib.request.Request('http://runtipi:3000/api/auth/register',input().encode(),{'Content-Type':'application/json'}),timeout=30)",
       data=json.dumps({'username': 'synthetic-round11@example.invalid', 'password': synthetic_password}))
    rt = NestedRuntipi('', jwt_secret)
    agent = fixture(); agent['label'] = 'Synthetic Round11'; app = 'agent-synthetic'; agent['runtime']['provider_key_location'] = 'provider'
    agent['runtime']['sealed_networks'] = {'agent': '10.246.96.0/28', 'provider': '10.247.96.0/28', 'keyed': '10.248.96.0/28'}
    keyfile = state / 'synthetic-service' / 'tinfoil.key'
    keyfile.parent.mkdir(mode=0o700); keyfile.write_text(KEY + '\n'); keyfile.chmod(0o600)
    agents = ar.Agents(state / 'synthetic-agents', keyfile); home = agents.home('synthetic'); home.mkdir(parents=True)
    (home / '.env').write_text('SYNTHETIC_HISTORY_PRESERVED=true\n')
    (home / 'history.txt').write_text('Synthetic continuity fixture.\n')
    doc = json.loads(ar.compose_doc(agent, image=STOCK, proxy_image=ar.DEFAULT_PROXY_IMAGE,
                                    home_source=str(home), uid=1000, gid=1000, ports=False, key_source=str(agents.key_source())))
    # Installed-lifecycle fixture does not start a harness or send owner prompts.
    client = doc['services'][app]
    client.update(entrypoint=[PYTHON], command=['-c', 'import time;time.sleep(3000)'], healthcheck={'disable': True})
    catalog = state / 'catalog'; pkg = catalog / 'apps' / app; pkg.mkdir(parents=True)
    def catalog_version(version, recipe_version=None):
        doc['services'][app]['environment']['SYNTHETIC_RECIPE_VERSION'] = str(recipe_version or version)
        cfg = json.loads(ar.config_doc(agent, version=f'0.11.{version}')); cfg['tipi_version'] = 1100 + version
        (pkg / 'config.json').write_text(json.dumps(cfg)); (pkg / 'docker-compose.yml').write_text(json.dumps(doc))
        (pkg / 'metadata').mkdir(exist_ok=True); (pkg / 'metadata/description.md').write_text('Synthetic fixture only.\n')
        run(['git', '-C', catalog, 'add', '-A'])
        run(['git', '-C', catalog, '-c', 'user.name=Synthetic QA', '-c', 'user.email=qa@example.invalid', 'commit', '-qm', f'fixture {version}'])

    run(['git', 'init', '-q', catalog]); catalog_version(1)
    url = 'http://r11-catalog:8080/catalog/.git'
    store = next((s['slug'] for s in rt.stores() if s.get('url') == url), None)
    if store is None: store = rt.ensure_store('r11synthetic', url)['slug']
    urn = f'{app}:{store}'; project = f'{app}_{store}'
    catalog_proofs = []
    def pull_catalog_version(version):
        pulled = rt.pull()
        assert pulled.get('success') is True, 'synthetic_catalog_pull_not_successful'
        # Canonical discovery plus exact cloned bytes prove smart HTTP update,
        # not just a health response or a store row.
        wait(lambda: (rt.app(urn).get('metadata') or {}).get('latestVersion') == 1100 + version, 60)
        cloned = state/'repos'/store/'apps'/app/'docker-compose.yml'
        assert cloned.read_bytes() == (pkg/'docker-compose.yml').read_bytes(), 'synthetic_catalog_clone_bytes_mismatch'
        catalog_proofs.append({'version':version,'compose_sha256':hashlib.sha256(cloned.read_bytes()).hexdigest()})
        save('manager-store-protocol.json',{'transport':'real Git smart HTTP upload-pack','cloned_versions':catalog_proofs})
    pull_catalog_version(1)
    receipt['checks']['manager_store_protocol_ready'] = True
    override = seal.runtipi_override(doc, urn)
    rt.req('PUT', f'/user-config/{urn}', {'dockerCompose': override, 'appEnv': ''})
    assert rt.req('GET', f'/user-config/{urn}')['isEnabled'] is True
    life = {'daemon_image_config': DAEMON_ID, 'selected_daemon_manifest':DAEMON_MANIFEST,
            'daemon_revision': 'fead192e9fb2d560fd3b875d092819b32e7189b6', 'steps': []}
    original_home_hash = hashlib.sha256((home/'history.txt').read_bytes()).hexdigest()
    original_key_hash = hashlib.sha256(keyfile.read_bytes()).hexdigest()
    def status(want):
        return wait(lambda: (rt.app(urn).get('app') or {}).get('status') in want, 240)
    def inspect(step):
        ids = nd('ps', '-q', '--filter', 'label=com.docker.compose.project=' + project).stdout.split()
        rows = json.loads(nd('inspect', *ids).stdout) if ids else []
        attached = {r['Config']['Labels']['com.docker.compose.service']: {n[len(project)+1:] if n.startswith(project+'_') else '!'+n for n in r['NetworkSettings']['Networks']} for r in rows}
        violations = seal.runtime_violations(doc, attached)
        result = {'step': step, 'networks': {k: sorted(v) for k, v in attached.items()}, 'violations': violations,
                  'home_sha256': hashlib.sha256((home/'history.txt').read_bytes()).hexdigest(), 'running_services': len(rows),
                  'key_sha256':hashlib.sha256(keyfile.read_bytes()).hexdigest(),
                  'recipe_versions':[[v for v in r['Config'].get('Env',[]) if v.startswith('SYNTHETIC_RECIPE_VERSION=')] for r in rows if r['Config']['Labels']['com.docker.compose.service']==app]}
        config = rt.req('GET', f'/user-config/{urn}')
        result['override_enabled'] = config.get('isEnabled') is True
        result['override_sha256'] = hashlib.sha256((config.get('dockerCompose') or '').rstrip('\n').encode()).hexdigest()
        expected_override = seal.runtipi_override(doc,urn)
        expected_recipe = 'SYNTHETIC_RECIPE_VERSION=' + doc['services'][app]['environment']['SYNTHETIC_RECIPE_VERSION']
        life['steps'].append(result); save('installed-manager.json', life)
        return (not violations and result['home_sha256']==original_home_hash and result['key_sha256']==original_key_hash
                and result['recipe_versions']==[[expected_recipe]] and result['override_enabled']
                and result['override_sha256']==hashlib.sha256(expected_override.rstrip('\n').encode()).hexdigest())
    rt.install(urn); status({'running'}); life['install'] = inspect('install')
    # A real image-content request through the actual attested Tinfoil path,
    # carrying an INVALID GENERATED key. Auth rejection is not vision success.
    source_id = nd('ps','-q','--filter','label=com.docker.compose.project='+project,
                   '--filter','label=com.docker.compose.service='+app).stdout.strip()
    image_probe = '''import json,urllib.request,urllib.error,time,hashlib
v=json.loads(input());docs={}
for port in (3301,3302):
 end=time.monotonic()+150
 while time.monotonic()<end:
  try:
   d=json.load(urllib.request.urlopen('http://agent-synthetic-tinfoil:'+str(port)+'/verification-document',timeout=5))
   if d.get('securityVerified') is True:docs[str(port)]={k:d.get(k) for k in ('securityVerified','configRepo','releaseDigest')};break
  except (OSError,ValueError):pass
  time.sleep(2)
 if str(port) not in docs:raise RuntimeError('attestation_readiness_deadline')
raw=json.dumps(v).encode();r=urllib.request.Request('http://agent-synthetic-tinfoil:3301/v1/chat/completions',raw,{'Content-Type':'application/json'})
try:h=urllib.request.urlopen(r,timeout=60)
except urllib.error.HTTPError as e:h=e
print(json.dumps({'attestation':docs,'http_status':h.status,'request_sha256':hashlib.sha256(raw).hexdigest(),'image_content_sent':True,'auth_key_is_generated_invalid_fixture':True,'vision_semantic_success':False}))
'''
    try:
        probe = nd('exec','-i',source_id,PYTHON,'-c',image_probe,data=json.dumps(synthetic_image_request('glm-5-3')),timeout=390)
        life['tinfoil_image_request'] = json.loads(probe.stdout)
        receipt['checks']['attested_tinfoil_image_content_request_auth_rejected'] = life['tinfoil_image_request']['http_status'] in (401,403)
    except Exception as exc:
        life['tinfoil_image_request'] = {'error_class':type(exc).__name__,'vision_semantic_success':False}
        receipt['checks']['attested_tinfoil_image_content_request_auth_rejected'] = False
    save('installed-manager.json',life)
    rt.restart(urn); status({'running'}); life['restart'] = inspect('restart')
    # Actual app-manager process restart, not a Compose-only reenactment.
    nd('restart', 'runtipi'); wait(manager_ready, 180)
    wait(lambda: isinstance(rt.req('GET', '/apps/installed').get('installed'),list), 60)
    rt.stop(urn); status({'stopped'}); rt.start(urn); status({'running'}); life['daemon_restart_start'] = inspect('daemon_restart_start')
    catalog_version(2); pull_catalog_version(2)
    rt.req('PUT', f'/user-config/{urn}', {'dockerCompose':seal.runtipi_override(doc,urn),'appEnv':''})
    rt.update(urn, perform_backup=False); status({'running'}); life['catalog_update'] = inspect('catalog_update')
    rt.stop(urn); status({'stopped'})
    rt.req('POST', f'/user-config/{urn}/disable', {})
    life['disabled_readback'] = rt.req('GET', f'/user-config/{urn}')['isEnabled'] is False
    # Measure the exact driver readback guard without opening the global admission gate.
    driver = object.__new__(ar.RuntipiDriver); driver.agents = agents; driver.image = STOCK; driver.proxy_image = ar.DEFAULT_PROXY_IMAGE
    driver.urn = lambda _: urn; driver._sealed_doc = lambda _: doc
    try:
        driver._sealed_override(agent, rt); life['driver_refuses_disabled_override'] = False
    except ar.RuntimeFailure as exc:
        life['driver_refuses_disabled_override'] = exc.code == 'sealed_override_unverified'
    # This direct lifecycle endpoint is the UI bypass. Synthetic-only observation,
    # with no prompts and no valid provider key; never a proposed live operation.
    try:
        rt.start(urn); status({'running', 'stopped', 'failed'})
    except Exception as exc:
        life['disabled_start_note'] = 'A generic startup error is not evidence of a security-policy refusal; inspect containers even after an API error.'
        life['disabled_start_error_class'] = type(exc).__name__
    try:
        life['disabled_direct_start_stayed_sealed'] = inspect('disabled_direct_start')
        last = life['steps'][-1]
        extra_client_networks = set(last['networks'].get(app, [])) - set(doc['services'][app].get('networks', {}))
        life['override_disable_security_vulnerability_demonstrated'] = bool(extra_client_networks)
        life['disabled_client_extra_networks'] = sorted(extra_client_networks)
        if extra_client_networks:
            receipt['security_vulnerability'] = 'Selected unchanged manager starts synthetic client with seal override disabled on extra forbidden networks; driver guard does not protect direct lifecycle.'
    except Exception as exc:
        life['disabled_direct_start_stayed_sealed'] = False
        life['disabled_inspection_error_class'] = type(exc).__name__
    save('installed-manager.json', life)
    rt.stop(urn); status({'stopped'})
    rt.req('POST', f'/user-config/{urn}/enable', {})
    assert rt.req('GET', f'/user-config/{urn}')['isEnabled'] is True
    # Fresh forward-version rollback envelope carries recipe v1. This does not
    # pretend that Runtipi supports a catalog-version downgrade or backup restore.
    catalog_version(3, recipe_version=1); pull_catalog_version(3)
    rt.req('PUT', f'/user-config/{urn}', {'dockerCompose':seal.runtipi_override(doc,urn),'appEnv':''})
    rt.update(urn, perform_backup=False); status({'running'})
    life['rollback'] = inspect('rollback')
    receipt['checks']['real_manager_installed_lifecycle'] = all(life.get(k) is True for k in ('install','restart','daemon_restart_start','catalog_update','rollback'))
    receipt['checks']['disabled_user_config_cannot_bypass_seal'] = life['disabled_readback'] and life['driver_refuses_disabled_override'] and life['disabled_direct_start_stayed_sealed']
    save('installed-manager.json', life)


def stock_phase():
    receipt['phase'] = 'stock_hermes'
    net = 'r11-stock-internal'; docker('network', 'create', '--internal', '--opt', 'com.docker.network.bridge.inhibit_ipv4=true', '--label', OWNER, net)
    owned_networks.append(net)
    state = WORK / 'stock'; state.mkdir(); home = state / 'home'; home.mkdir()
    # Model/provider config is synthetic only. No real selected agent is changed.
    # JSON is valid YAML; use the already-proved stock fixture's mapping and
    # explicit chat-completions shape, only inside this generated home.
    (home / 'config.yaml').write_text(json.dumps(stock_config()))
    (home / '.env').write_text('OPENAI_API_KEY=' + KEY + '\nOPENAI_BASE_URL=http://provider:8000/v1\n')
    mock = ROOT / 'scripts/ci/round11-openai-fixture.py'
    flags = ['--network', net, '--network-alias', 'provider', '--read-only', '--tmpfs', '/tmp', '--log-driver', 'none', '-v', f'{mock}:/fixture.py:ro', '-v', f'{state}:/state']
    container('r11-stock-provider', 'python:3.12-slim', ['python3', '/fixture.py'], flags)
    args, flags = stock_launch(home, PYTHON, net, APIKEY, os.getuid(), os.getgid())
    container('r11-stock-client', STOCK, args, flags)
    def api(path, value=None):
        code = "import json,urllib.request;v=json.loads(input());r=urllib.request.Request('http://127.0.0.1:8642'+v['path'],None if v['value'] is None else json.dumps(v['value']).encode(),{'Authorization':'Bearer '+v['key'],'Content-Type':'application/json'});h=urllib.request.urlopen(r,timeout=10);print(h.read().decode())"
        return json.loads(docker('exec', '-i', 'r11-stock-client', PYTHON, '-c', code,
                                 data=json.dumps({'path':path,'value':value,'key':APIKEY})).stdout)
    # Retain bounded synthetic startup diagnostics instead of swallowing the
    # failure for 120 seconds; fail immediately if the stock process exits.
    startup: dict[str, object] = {'last_api_error':None}
    def ready():
        status = json.loads(docker('inspect','--format','{{json .State}}','r11-stock-client').stdout)
        startup['container_state'] = status
        if not status.get('Running'):
            raise AssertionError('synthetic_stock_exited_before_readiness')
        try:
            return stock_sessions_ready(api('/api/sessions'))
        except Exception as exc:
            startup['last_api_error'] = {'class':type(exc).__name__, 'reason':str(exc)[:160]}
            return False
    try:
        wait(ready, 90)
    finally:
        preflight = home / 'synthetic-preflight.json'
        log = home / 'synthetic-startup.log'
        startup['preflight'] = json.loads(preflight.read_text()) if preflight.exists() else None
        startup['startup_tail'] = log.read_text(errors='replace')[-6000:] if log.exists() else 'startup_output_absent'
        save('stock-startup.json', startup)
    boot = startup['preflight']
    assert isinstance(boot, dict), 'synthetic_stock_boot_assertions_missing'
    assert boot.get('uid') == boot.get('home_uid') == boot.get('config_uid') == os.getuid() != 0
    assert boot.get('gid') == os.getgid() != 0 and boot.get('pid') != 1 and boot.get('root_bypass') is False
    receipt['checks']['stock_setup_ready'] = True
    if PREFLIGHT: return
    sid = 'synthetic-r11-' + secrets.token_hex(8); api('/api/sessions', {'id':sid})
    terminal = {'failed','completed','cancelled'}
    def wait_run(run_id, seconds):
        end = time.monotonic() + seconds; seen = []; result = {}
        while time.monotonic() < end:
            result = api('/v1/runs/' + run_id); status = result.get('status'); seen.append(status)
            if status in terminal: break
            time.sleep(1)
        return result, list(dict.fromkeys(seen))
    initial = api('/v1/runs', {'session_id':sid,'input':'Synthetic fixture only: reply SYNTHETIC_RECOVERED without tools.'})
    good, states = wait_run(initial['run_id'], 90)
    assert good.get('status') == 'completed', 'synthetic_initial_run_not_completed'
    docker('stop', '-t', '2', 'r11-stock-provider')
    start = time.monotonic(); admitted = api('/v1/runs', {'session_id':sid,'input':'Synthetic stopped-provider probe: reply SYNTHETIC_RECOVERED without tools.'})
    stopped, stopped_states = wait_run(admitted['run_id'], 65)
    observed = stopped.get('status')
    check = {'initial_status':good.get('status'), 'initial_states':states, 'stopped_status':observed,
             'stopped_states':stopped_states, 'observed_seconds':round(time.monotonic()-start,3),
             'terminal_provider_failure_measured':observed == 'failed',
             'classification':'terminal_failure' if observed=='failed' else 'retrying_not_terminal' if observed not in terminal else observed,
             'scope':'Actual unchanged stock Hermes API, sealed synthetic OpenAI fixture; NOT an attested Tinfoil completion.'}
    receipt['checks']['stock_stopped_provider_no_completion'] = observed != 'completed'
    if observed not in terminal:
        api('/v1/runs/' + admitted['run_id'] + '/stop', {})
        cancelled, _ = wait_run(admitted['run_id'], 30); check['cancelled_status'] = cancelled.get('status')
        assert cancelled.get('status') in {'failed','cancelled'}
    docker('start', 'r11-stock-provider')
    recovered_id = api('/v1/runs', {'session_id':sid,'input':'Synthetic recovery: reply SYNTHETIC_RECOVERED without tools.'})['run_id']
    recovered, recovery_states = wait_run(recovered_id, 90)
    check['recovered_status'] = recovered.get('status'); check['recovery_states'] = recovery_states
    receipt['checks']['stock_provider_recovery_completed'] = recovered.get('status') == 'completed' and 'SYNTHETIC_RECOVERED' in json.dumps(recovered)
    # Actual PNG image content request from the stock container; not model IDs.
    body = synthetic_image_request('synthetic-vision')
    code = "import urllib.request,json;v=json.loads(input());r=urllib.request.Request('http://provider:8000/v1/chat/completions',json.dumps(v).encode(),{'Content-Type':'application/json'});print(urllib.request.urlopen(r,timeout=10).status)"
    p = docker('exec', '-i', 'r11-stock-client', PYTHON, '-c', code, data=json.dumps(body))
    image_evidence = json.loads((state / 'image-receipt.json').read_text())
    receipt['checks']['synthetic_image_content_request'] = p.stdout.strip()=='200' and image_evidence.get('png_signature_valid') is True
    check['image_request'] = image_evidence
    check['image_request_scope'] = 'PNG validated by synthetic OpenAI fixture only. Not Tinfoil vision model support or a Hermes attachment-UI proof.'
    save('stock-hermes.json', check)


def main():
    if OUT.exists() or WORK.exists(): raise SystemExit('refuse_existing_round11_evidence_or_work')
    OUT.mkdir(parents=True); WORK.mkdir()
    try:
        # Focused startup only has no prompts, lifecycle operations or inference.
        for name, fn in ([('manager', manager_phase)] if MANAGER_ONLY else [('stock', stock_phase), ('manager', manager_phase)]):
            try: fn()
            except Exception as exc:
                receipt.setdefault('errors', {})[name] = {'class':type(exc).__name__, 'reason':str(exc)[:240]}
                if name == 'manager' and DIND in owned:
                    logs = {}
                    for service in ('runtipi','r11-catalog','runtipi-queue','runtipi-db'):
                        log = nd('logs','--tail','50',service,check=False)
                        logs[service] = (log.stdout+log.stderr)[-6000:]
                    save('manager-error.json', {'error':receipt['errors'][name], 'synthetic_log_tails':logs})
        receipt['phase'] = 'complete'
    finally:
        # Every resource here is owned by this runner. No prune, no unrelated VM.
        for name in reversed(owned): docker('rm', '-f', name, check=False, timeout=120)
        for name in reversed(owned_networks): docker('network', 'rm', name, check=False)
        remaining = docker('ps','-aq','--filter','label='+OWNER).stdout.split()
        receipt['leftover_containers'] = len(remaining)
        receipt['checks']['owned_resources_cleaned'] = not remaining
        needed = ['manager_setup_ready','manager_store_protocol_ready','real_manager_installed_lifecycle','disabled_user_config_cannot_bypass_seal',
                  'attested_tinfoil_image_content_request_auth_rejected','owned_resources_cleaned'] if MANAGER_ONLY else ['stock_setup_ready','manager_setup_ready','owned_resources_cleaned'] if PREFLIGHT else ['real_manager_installed_lifecycle','disabled_user_config_cannot_bypass_seal',
                  'stock_stopped_provider_no_completion','stock_provider_recovery_completed',
                  'synthetic_image_content_request','attested_tinfoil_image_content_request_auth_rejected','owned_resources_cleaned']
        unmet = [k for k in needed if receipt['checks'].get(k) is not True]
        if receipt.get('errors'): unmet.extend('phase_error:' + k for k in receipt['errors'])
        receipt['admission'] = {'required_unmet':unmet,'scope':'Synthetic next-proof only. Never migration admission.'}
        save('receipt.json', receipt)
        # Nested engine files are root-owned. Cleanup is confined to this exact
        # disposable bind, after the owned daemon has been removed.
        if not remaining:
            cleanup = docker('run', '--rm', '--network', 'none', '--read-only', '--log-driver', 'none',
                '-v', f'{WORK}:/cleanup', 'python:3.12-slim', 'python3', '-c',
                "import pathlib,shutil; p=pathlib.Path('/cleanup'); [(shutil.rmtree(x) if x.is_dir() and not x.is_symlink() else x.unlink()) for x in p.iterdir()]", check=False)
            receipt['checks']['synthetic_secret_work_removed'] = cleanup.returncode == 0
            if cleanup.returncode: receipt['admission']['required_unmet'].append('synthetic_secret_work_removed')
            save('receipt.json', receipt)
            if cleanup.returncode == 0: WORK.rmdir()
        print(json.dumps({'phase':receipt['phase'],'checks':receipt['checks'],'admission':receipt['admission']}))
    return 2 if receipt['admission']['required_unmet'] else 0


if __name__ == '__main__': sys.exit(main())
