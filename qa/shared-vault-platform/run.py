#!/usr/bin/env python3
"""Parent-submitted Forum staging rig. NEVER run on the VPS or a serving checkout.
This is an unexecuted worker gate, not a receipt. Uses real Service, Broker, edge,
RestrictedDriver, pinned full Hermes and native tool dispatcher; only provider CLI
responses and the owner auth session are synthetic. No model/provider inference.
"""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parents[1]
sys.path.insert(0, str(SOURCE / 'ops/agent-runtime'))
import agent_runtime as ar


def run(argv, *, cwd=None, data=None, timeout=1800):
    p = subprocess.run([str(a) for a in argv], cwd=cwd, input=data, capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError(f'worker command failed: {argv[0]} ({p.returncode}): {p.stderr[-2000:]}')
    return p.stdout


def put(path, value, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value) if not isinstance(value, str) else value); path.chmod(mode)


def wait(check, label):
    for _ in range(120):
        try:
            if check(): return
        except (OSError, ValueError, subprocess.SubprocessError): pass
        time.sleep(.5)
    raise RuntimeError('staging readiness failed: ' + label)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--forum-staging', action='store_true', required=True)
    ap.add_argument('--source-sha', required=True)
    ap.add_argument('--vault-source', type=Path, required=True)
    ap.add_argument('--vault-sha', required=True)
    ap.add_argument('--output', type=Path, required=True)
    args = ap.parse_args()
    root = args.output.resolve(); vault = args.vault_source.resolve()
    if os.geteuid() == 0 or not str(root).startswith('/srv/work/') or not str(SOURCE).startswith('/srv/work/') or not str(vault).startswith('/srv/work/') or root.exists():
        raise SystemExit('Fresh isolated /srv/work source/output and nonroot Forum operator required')
    if any(os.environ.get(k) for k in ('BW_SESSION', 'BW_CLIENTSECRET', 'CLAUDE_CODE_OAUTH_TOKEN')):
        raise SystemExit('No inherited provider authority permitted')
    if args.vault_sha != json.loads((HERE/'dependencies.json').read_text())['vaultCommit']:
        raise SystemExit('Unreviewed or superseded app dependency: update the explicit source lock first')
    for source, sha in ((SOURCE, args.source_sha), (vault, args.vault_sha)):
        if len(sha) != 40 or run(['git', '-C', source, 'rev-parse', 'HEAD']).strip() != sha or run(['git', '-C', source, 'status', '--porcelain']).strip():
            raise SystemExit('Exact clean pushed source required')
    root.mkdir(mode=0o700)
    stamp = secrets.token_hex(5); prefix = 'svstage-' + stamp
    image = prefix + ':service'
    names = []; proxy = None; drivers = []
    try:
        run(['docker', 'build', '-t', image, SOURCE])
        # Fail fast on the previously failing positive login/task, using the exact
        # repaired app package and its own locked Playwright, independently offline.
        app_image = prefix + ':vault'
        run(['docker','build','-f',vault/'app/Dockerfile','-t',app_image,vault])
        raw_workflow = run(['docker','run','--rm','--network','none','--read-only','--user','1000:1000',
            '--tmpfs','/tmp:mode=1777','--shm-size','256m','--cap-drop','ALL','--security-opt','no-new-privileges:true',
            '--memory','1g','-e','QA_PLAYWRIGHT=/opt/pw/node_modules/playwright','-e','WORKFLOW_REPORT=/tmp/workflow-result.json',
            '-e','PYTHONPATH=/app/app','-v',f'{vault}/qa/workflow_fixture.py:/qa/workflow_fixture.py:ro',
            '--entrypoint','python3',app_image,'/qa/workflow_fixture.py'],timeout=300)
        workflow_result = json.loads(raw_workflow.splitlines()[-1])
        assert any(c['case']=='ok' and c['passed'] and c['malicious_requests']==0 for c in workflow_result['cases'])
        assert workflow_result['passed'] == len(workflow_result['cases'])
        put(root/'positive-private-browser-workflow.json', workflow_result)
        hashes = {str(p.relative_to(SOURCE)): hashlib.sha256(p.read_bytes()).hexdigest() for p in
                  (SOURCE/'package-lock.json', HERE/'package-lock.json', SOURCE/'ops/agent-runtime/hermes-lock.json',
                   SOURCE/'server/vendor/shared-vault/service_owner_route.mjs', SOURCE/'ops/agent-runtime/app-sockets/shared-vault/__init__.py',
                   HERE/'closed-egress.yml')}
        for p in (vault/'package-lock.json', vault/'browser/package-lock.json', vault/'app/pinned_https.cjs', vault/'ops/provision.py'):
            if not p.is_file(): raise RuntimeError('Fixed exact-head app dependency/source is missing')
            hashes['vault/' + str(p.relative_to(vault))] = hashlib.sha256(p.read_bytes()).hexdigest()
        put(root/'sources.json', {'service_commit': args.source_sha, 'vault_commit': args.vault_sha, 'sha256': hashes,
                                  'service_image_id': json.loads(run(['docker','image','inspect',image]))[0]['Id'], 'vault_image_id': json.loads(run(['docker','image','inspect',app_image]))[0]['Id'], 'hermes_image': ar.DEFAULT_IMAGE})
        for d in ('broker', 'edge-a/private', 'edge-a/public', 'edge-b/private', 'edge-b/public', 'service-private', 'os', 'agents'):
            (root/d).mkdir(parents=True, exist_ok=True, mode=0o700)
        proof = secrets.token_urlsafe(48); session = secrets.token_urlsafe(48)
        owner = 'synthetic-owner-token-only-for-tests-000'
        tokens = {'agent-a': 'synthetic-agent-token-only-for-tests-000', 'agent-b': 'synthetic-other-token-only-for-tests-000'}
        put(root/'service-private/proof', proof); put(root/'service-private/session', session); put(root/'service-private/token', owner)
        for suffix, principal in [('a','agent-a'),('b','agent-b')]:
            folder = root / ('edge-' + suffix)
            put(folder/'private/token', tokens[principal])
            put(folder/'private/config.json', {'agent_uid': 10000, 'broker_uid': 10002, 'endpoint': 'http://127.0.0.1:8799/mcp',
                'socket': str(folder/'public/agent.sock'), 'token_file': str(folder/'private/token')})
        # Explicit offline ownership provisioning only. No long-running container runs as root.
        setup = "import os,pathlib; r=pathlib.Path(" + repr(str(root)) + "); os.chown(r/'broker',10002,10002);\n"
        setup += "for n in ('a','b'):\n p=r/('edge-'+n); os.chown(p/'public',10003," + str(os.getegid()) + "); os.chmod(p/'public',0o710); os.chown(p/'private',10003,10000);\n for f in (p/'private').iterdir(): os.chown(f,10003,10000)\n"
        init_mounts = [v for d in ('broker','edge-a','edge-b') for v in ('-v', f'{root/d}:{root/d}')]
        run(['docker','run','--rm','--network','none','--read-only','--user','0:0','--cap-drop','ALL','--cap-add','CHOWN','--cap-add','FOWNER','--cap-add','DAC_OVERRIDE','--security-opt','no-new-privileges:true', *init_mounts, '--entrypoint','python3',image,'-c',setup])
        common = ['--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:rw,nosuid,nodev,size=128m']
        broker_mounts = ['-v',f'{vault}:/fixture/vault:ro','-v',f'{HERE}/broker.py:/fixture/broker.py:ro','-v',f'{root}/broker:{root}/broker','-e',f'SV_STAGE_ROOT={root}']
        run(['docker','run','--rm','--network','none','--user','10002:10002',*common,*broker_mounts,'--entrypoint','python3',image,'/fixture/broker.py','--init'])
        broker = prefix + '-broker'; names.append(broker)
        run(['docker','run','-d','--name',broker,'--network','none','--user','10002:10002',*common,*broker_mounts,'--entrypoint','python3',image,'/fixture/broker.py'])
        # Install the pinned app's actual web publication into a DISPOSABLE registry only.
        view = root / ('os/views/shared-vault/builds/' + args.vault_sha)
        shutil.copytree(vault/'web', view); put(view/'.ok', '')
        put(view.parent.parent/'view.json', {'active': True, 'mode': 'own', 'serving': args.vault_sha})
        put(root/'os/apps.json', {'apps': [{'id':'shared-vault','name':'Shared Vault','view':{'url':'/shared-vault/'},'status':'running'}]})
        ids = run(['docker','network','ls','-q']).split()
        records = json.loads(run(['docker','network','inspect',*ids])) if ids else []
        used = [ipaddress.ip_network(c['Subnet']) for r in records for c in (r.get('IPAM',{}).get('Config') or []) if c.get('Subnet')]
        pairs = []
        for up, sandbox in reversed(list(zip(ar.UPLINK_POOL.subnets(new_prefix=28), ar.SANDBOX_POOL.subnets(new_prefix=28)))):
            if not any(up.overlaps(n) or sandbox.overlaps(n) for n in used if n.version == 4):
                pairs.append((str(up),str(sandbox))); used += [up,sandbox]
                if len(pairs) == 2: break
        if len(pairs) != 2: raise RuntimeError('No free isolated fixture subnet pairs')
        agents = []
        for index, name in enumerate(('agent-a','agent-b'), 1):
            folder = root/'agents'/name
            agent = {'schema':1,'id':name,'label':name,'harness':'hermes','privacy':'private','model':{'provider':'openrouter','model':'fixture-only','allowed_models':[]},
                     'permissions':{'preset':'private','files':'own','outside_tools':[],'wizard_apps':[],'agent_apps':[],'other_agents':'none','shared_with_agents':False},
                     'runtime':{'kind':'container','isolation':'restricted','app_id':prefix+'-'+name,'port':18650+index,
                                'network':{'uplink':pairs[index-1][0],'sandbox':pairs[index-1][1]}}}
            put(folder/'agent.json', agent); put(folder/'runtime.key', secrets.token_urlsafe(36)); put(folder/'gateway.key', secrets.token_urlsafe(36))
            put(folder/'managed/.env', 'API_SERVER_ENABLED=true\n'); put(folder/'managed/config.yaml', 'model:\n  provider: openrouter\n  default: fixture-only\n')
            (folder/'home').mkdir(mode=0o700); agents.append(agent)
        run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost',
             '-keyout',root/'service-private/key.pem','-out',root/'service-private/cert.pem'])
        proxy = subprocess.Popen(['node', str(HERE/'owner-session.mjs'), str(root)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        wait(lambda: (root/'proxy-ready.json').exists(), 'owner session')
        origin = json.loads((root/'proxy-ready.json').read_text())['origin']
        put(root/'service-private/owner.json', {'publicOrigin':origin,'brokerOrigin':'http://127.0.0.1:8799','ownerTokenFile':str(root/'service-private/token')})
        service = prefix + '-service'; names.append(service)
        mounts = [v for d in ('agents','os','service-private') for v in ('-v',f'{root/d}:{root/d}')]
        run(['docker','run','-d','--name',service,'--network','container:'+broker,'--user',f'{os.geteuid()}:{os.getegid()}',*common,*mounts,
             '-v',f'{HERE}/service.mjs:/app/qa/shared-vault-platform/service.mjs:ro','-e',f'SV_STAGE_ROOT={root}',image,'node','/app/qa/shared-vault-platform/service.mjs'])
        for suffix in ('a','b'):
            folder = root/('edge-'+suffix); name=prefix+'-edge-'+suffix; names.append(name)
            run(['docker','run','-d','--name',name,'--network','container:'+broker,'--user','10003:10000',*common,
                 '-v',f'{vault}:/fixture/vault:ro','-v',f'{folder}/private:{folder}/private:ro','-v',f'{folder}/public:{folder}/public',
                 '-e',f'SHARED_VAULT_EDGE_CONFIG={folder}/private/config.json','--entrypoint','python3',image,'/fixture/vault/app/agent_edge.py'])
        wait(lambda: all((root/('edge-'+s)/'public/agent.sock').exists() for s in ('a','b')), 'application sockets')
        wait(lambda: all((root/'agents'/a['id']/'gateway/gateway.sock').exists() for a in agents), 'Service agent sockets')
        grants = {'schema':1,'agents':{a['id']:{'app':'shared-vault','socket':str(root/('edge-'+s)/'public/agent.sock'),'broker_uid':10002,'edge_uid':10003,'agent_uid':10000} for a,s in zip(agents,('a','b'))}}
        put(root/'service-private/grants.json',grants)
        # Use the CURRENT socket runtime stack; fixture overlay only removes egress.
        native_docker = ar.docker
        ar.SIDECAR_IMAGE = prefix + ':sidecars'
        def closed_docker(argv, **kw):
            if argv and argv[0]=='compose':
                pos = next(i for i,x in enumerate(argv) if x in ('stop','up','down','ps','config'))
                argv = [*argv[:pos],'-f',str(HERE/'closed-egress.yml'),*argv[pos:]]
            return native_docker(argv, **kw)
        ar.docker = closed_docker
        for key in ('AGENT_SYSTEM_SKILLS_VOLUME','COMPOSE_ENV_FILES','EGRESS_PASSTHROUGH_HOSTS'):
            os.environ.pop(key, None)
        driver = ar.RestrictedDriver(ar.Agents(root/'agents',None), ar.RESTRICTED_DIR, ar.DEFAULT_IMAGE, root/'service-private/grants.json')
        # Dedicated named projects, never the ordinary agent-* names.
        driver.project = lambda agent_id: prefix+'-'+agent_id
        for agent in agents:
            drivers.append((driver,agent)); driver.apply(agent)
        run(['npm','ci','--ignore-scripts','--no-audit','--no-fund'],cwd=HERE)
        run([HERE/'node_modules/.bin/playwright','install','chromium'],cwd=HERE)
        def phase(name, revoked=False):
            run(['node',HERE/'browser.mjs',root,name],cwd=HERE)
            handles=json.loads((root/'handles.json').read_text())
            for agent in agents:
                cid=ar.container_for(driver.project(agent['id']),'agent')
                driver.verify_app_socket_runtime(agent,grants['agents'][agent['id']])
                other='agent-b' if agent['id']=='agent-a' else 'agent-a'
                peer_record = json.loads(run(['docker','inspect',ar.container_for(driver.project(other),'agent')]))[0]
                peer_ip = next(iter(peer_record['NetworkSettings']['Networks'].values()))['IPAddress']
                denied=[str(root/'service-private/token'),str(root/'edge-a/private/token'),str(root/'edge-b/private/token'),'/var/run/docker.sock',str(root/'agents'/other/'home/config.yaml')]
                raw=run(['docker','exec','-i','-e',f'SV_OWN_HANDLE={handles[agent["id"]]}','-e',f'SV_OTHER_HANDLE={handles[other]}','-e',f'SV_DENIED_PATHS={json.dumps(denied)}','-e',f'SV_PEER_IP={peer_ip}','-e',f'SV_PHASE={name}','-e',f'SV_REVOKED={int(revoked and agent["id"]=="agent-a")}',cid,'/opt/hermes/.venv/bin/python','-'],data=(HERE/'in_agent.py').read_text(),timeout=180)
                for secret in (owner,proof,session,*tokens.values(),'SYNTHETIC_SHARED_PASSWORD_DO_NOT_RETURN_98','SYNTHETIC_PERSONAL_PASSWORD_DO_NOT_RETURN_67'):
                    if secret in raw: raise RuntimeError('secret boundary failed')
                result=json.loads(raw.splitlines()[-1]); assert result['passed']; put(root/(name+'-'+agent['id']+'.json'),result)
            for name, uid in [(broker,'10002:10002'),(prefix+'-edge-a','10003:10000'),(prefix+'-edge-b','10003:10000')]:
                record=json.loads(run(['docker','inspect',name]))[0]
                assert record['Config']['User']==uid
                assert record['HostConfig']['NetworkMode']=='none' or record['HostConfig']['NetworkMode'].startswith('container:')
            # Broker is not reachable even by a directly invoked container-side caller without authority.
            deny="import urllib.request,urllib.error;\ntry: urllib.request.urlopen('http://127.0.0.1:8799/api/status'); raise Exception('backend allowed')\nexcept urllib.error.HTTPError as e: assert e.code==403"
            run(['docker','exec',broker,'python3','-c',deny])
        phase('initial')
        # Stop writers first. Restart broker/edges/Service, retain their isolated state,
        # remove ONLY stopped fixture socket inodes, then recreate exact-file agent binds.
        for driver,agent in drivers: driver.stop(agent)
        run(['docker','stop',service,prefix+'-edge-a',prefix+'-edge-b',broker])
        unlink = "import pathlib,stat; r=pathlib.Path("+repr(str(root))+");\nfor n in ('a','b'):\n p=r/('edge-'+n)/'public/agent.sock'; assert stat.S_ISSOCK(p.lstat().st_mode); p.unlink()\n"
        run(['docker','run','--rm','--network','none','--read-only','--user','0:0','--cap-drop','ALL','--cap-add','DAC_OVERRIDE','--security-opt','no-new-privileges:true',*init_mounts,'--entrypoint','python3',image,'-c',unlink])
        run(['docker','start',broker,prefix+'-edge-a',prefix+'-edge-b',service])
        wait(lambda: all((root/('edge-'+s)/'public/agent.sock').exists() for s in ('a','b')), 'restarted application sockets')
        wait(lambda: (root/'service-private/service.sock').exists(), 'service restart')
        for driver,agent in drivers: driver.start(agent)
        phase('restart'); phase('revoke')
        for driver,agent in drivers: driver.start(agent)
        phase('revoked',True)
        put(root/'result.json', {'passed':True,'synthetic_only':True,'provider_consent':False,'useful_login_task_end_to_end':False,
            'wam_install_lifecycle':False,'production_activation':False,'note':'Owner grant/revoke and isolated installed-runtime tools only; useful private browser task remains a separate acceptance gate.'})
    finally:
        for driver,agent in reversed(drivers):
            try: driver._compose(agent,'down','-v','--remove-orphans',timeout=180)
            except Exception: pass
        for name in reversed(names):
            subprocess.run(['docker','rm','-f',name],capture_output=True,timeout=30)
        if proxy:
            proxy.terminate()
            try: proxy.wait(timeout=5)
            except subprocess.TimeoutExpired: proxy.kill(); proxy.wait()
        # A hard teardown assertion, scoped by our random fixture prefix only.
        leftovers = run(['docker','ps','-a','-q','--filter','name='+prefix]).strip()
        remnants = {}
        for driver, agent in drivers:
            project = driver.project(agent['id'])
            for kind, command in [('networks',['network','ls']), ('volumes',['volume','ls'])]:
                remnants[project + '-' + kind] = run(['docker',*command,'-q','--filter','label=com.docker.compose.project='+project]).strip()
        put(root/'teardown.json', {'containers_remaining':bool(leftovers),'resources_remaining':remnants,'prefix':prefix})
        if leftovers or any(remnants.values()): raise RuntimeError('staging resources remain; parent must remove only named fixture resources')


if __name__ == '__main__': main()
