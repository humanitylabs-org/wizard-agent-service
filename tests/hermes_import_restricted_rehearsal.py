#!/usr/bin/env python3
"""Explicit owner-run restricted rehearsal; no production cutover or service restart.

WIZARD_IMPORT_REHEARSAL_{SOURCE,ROOT,WIZARD_HOME,SERVICE,IMAGE,WORKSPACE,CONTEXT}
plus WIZARD_IMPORT_RESTRICTED_EVIDENCE are required. The existing GitHub OAuth file
is an explicit owner-approved per-file grant (2026-10-22), not a Private-seal grant.
Declared TCP is fail-closed and requires a prebuilt matching sidecar image.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import select
import shlex
import shutil
import sqlite3
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops/agent-runtime'))
import hermes_import as h
import restricted_import as restricted
import hermes_import_rehearsal as legacy
import hermes_import_canary as canary

PREFIX = 'WIZARD_IMPORT_REHEARSAL_'
COMMENT = 'wizard-import-archimedes-rehearsal'
AGENT = 'archimedes-rehearsal'
LOG = None


def emit(**value):
    text = json.dumps(value, sort_keys=True)
    print(text, flush=True)
    if LOG:
        with LOG.open('a') as f:
            f.write(text + '\n')


def section(title):
    print(title, flush=True)
    if LOG:
        with LOG.open('a') as f:
            f.write('\n## ' + title + '\n\n')


def command(argv, *, check=False, input=None, timeout=60, log=True):
    r = subprocess.run(argv, input=input, capture_output=True, text=True, timeout=timeout)
    # gh masks tokens, but do not even preserve its token lines.
    output = '\n'.join(x for x in (r.stdout + r.stderr).splitlines() if not re.search(r'token\s*:', x, re.I))
    if log:
        emit(command=shlex.join(argv), exit_code=r.returncode, output=output[:5000])
    if check:
        h.require(r.returncode == 0, 'rehearsal_command_failed_' + Path(argv[0]).name)
    return r


def access_only(value):
    if isinstance(value, dict):
        return {k: access_only(v) for k, v in value.items() if 'refresh' not in k.lower()}
    if isinstance(value, list):
        return [access_only(v) for v in value]
    return value


def remote_key(host, public=None):
    # Preserve unrelated authorized_keys bytes; the fresh grant is restrict-only.
    code = '''import sys,pathlib,json,os,secrets
p=pathlib.Path.home()/'.ssh/authorized_keys'
comment=sys.argv[1]; new=sys.stdin.read().strip()
original=p.read_text() if p.exists() else ''
rows=original.splitlines(keepends=True)
matching=[x for x in rows if x.rstrip().endswith(' '+comment)]
if new:
 assert not matching and new.endswith(' '+comment)
 text=original+('' if not original or original.endswith('\\n') else '\\n')+'restrict '+new+'\\n'
else:
 text=''.join(x for x in rows if not x.rstrip().endswith(' '+comment))
tmp=p.with_name('.wizard-import-key-'+secrets.token_hex(8))
try:
 fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as f: f.write(text); f.flush(); os.fsync(f.fileno())
 assert (p.read_text() if p.exists() else '')==original
 os.replace(tmp,p)
finally:
 if tmp.exists(): tmp.unlink()
readback=[x for x in p.read_text().splitlines() if x.endswith(' '+comment)]
assert len(readback)==(1 if new else 0)
if new: assert readback[0]=='restrict '+new
print(json.dumps({'thales_rehearsal_key_lines':len(readback),'restrict':bool(new),'authorized_keys_readback':True}))
'''
    out = command(['ssh', '-o', 'BatchMode=yes', host, 'python3 -c ' + shlex.quote(code) + ' ' + shlex.quote(COMMENT)],
                  input=public or '', timeout=30, check=True, log=False)
    emit(remote_key=json.loads(out.stdout))


def model_exercise(service, cid, model, fact):
    host = os.environ[PREFIX + 'BUILD_HOST']
    session = 'wizard_import_restricted_' + secrets.token_hex(6)
    # This helper does POST, PATCH hidden, GET and asserts true before returning.
    canary.hidden_session(service, AGENT, session)
    readback = canary.call(service, '/wizard/hermes/api/sessions/' + session + '?agent_id=' + AGENT)
    hidden = (readback.get('session') or readback).get('hidden')
    h.require(hidden is True or hidden == 1, 'session_not_hidden_fail_closed')
    emit(session=session, hidden_readback=hidden, before_message=True,
         fact_sha256=hashlib.sha256(fact.encode()).hexdigest())
    required_commands = ['gh auth status', 'ssh -o BatchMode=yes ' + shlex.quote(host) + ' true',
                         'git -C ' + shlex.quote(os.environ[PREFIX + 'WORKSPACE'] + '/wizard-os') + ' fetch --dry-run']
    prompt = ('This is a single authorized hidden restricted-agent import rehearsal. Do not load skills. '
              'Run these as three separate terminal calls, exactly:\n' + '\n'.join(required_commands) + '\n'
              'Do not join commands or add echo/pipe. A per-file GitHub credential and exactly one declared '
              'TCP build-host grant are approved. Report failures honestly; never bypass the proxy/firewall or edit configuration. '
              'Use fact_store action=search to recall this existing Thales fact: ' + fact + '\n'
              'Reply IMPORT_RESTRICTED_CHECK with the literal terminal exit codes and the recalled fact. '
              'Do not print credentials or do other work.')
    req = {'session_id': session, 'agent_id': AGENT, 'input': prompt, 'model': model['default'], 'provider': model['provider']}
    response = canary.call(service, '/wizard/hermes/v1/runs', 'POST', req, headers={'Idempotency-Key': session})
    run_id = response.get('run_id') or response.get('id') or (response.get('run') or {}).get('id')
    h.require(run_id, 'model_no_run_id')
    emit(run_id=run_id, requested_model=model)
    end = time.monotonic() + 180
    status = {}
    while time.monotonic() < end:
        status = canary.call(service, '/wizard/hermes/v1/runs/' + str(run_id) + '?agent_id=' + AGENT)
        state = status.get('status', (status.get('run') or {}).get('status'))
        if state in {'completed', 'failed', 'cancelled', 'error'}:
            break
        time.sleep(2)
    # Read canonical messages only through the uid-10000 container, never by
    # opening/unsealing its home on the host. Capture, redact, then emit proofs.
    code = '''import sys,json
from pathlib import Path
sys.path.insert(0,'/opt/hermes')
from hermes_state import SessionDB
db=SessionDB(Path('/opt/data/state.db'),read_only=True)
try:
 session=db.get_session(sys.argv[1]) or {}
 messages=db.get_messages(sys.argv[1])
 print(json.dumps({'session':session,'messages':messages},default=lambda v:v.decode('utf-8','replace') if isinstance(v,bytes) else str(v)))
finally: db.close()
'''
    emit(service_run_terminal_status=status.get('status', (status.get('run') or {}).get('status')), status_keys=sorted(status))
    raw = command(['docker', 'exec', cid, '/opt/hermes/.venv/bin/python', '-c', code, session], log=False)
    if raw.returncode:
        emit(canonical_read_exit_code=raw.returncode, canonical_read_error=raw.stderr[-1800:])
    h.require(raw.returncode == 0, 'canonical_read_failed')
    canonical = json.loads(raw.stdout)
    row = canonical['session']
    messages = canonical['messages']
    calls, results = [], {}
    for msg in messages:
        if msg.get('tool_calls'):
            item = msg['tool_calls']
            calls.extend(json.loads(item) if isinstance(item, str) else item)
        if msg['role'] == 'tool':
            try:
                results[msg.get('tool_call_id')] = json.loads(msg.get('content') or '{}')
            except ValueError:
                results[msg.get('tool_call_id')] = {'text': msg.get('content')}
    terminals, fact_ok = [], False
    for call in calls:
        fn = call.get('function', call)
        args = fn.get('arguments') or {}
        if isinstance(args, str):
            args = json.loads(args)
        result = results.get(call.get('id'), {})
        if fn.get('name') == 'terminal':
            out = str(result.get('output') or '') if isinstance(result, dict) else ''
            out = '\n'.join(x for x in out.splitlines() if not re.search(r'token\s*:', x, re.I))
            terminals.append({'command': args.get('command'), 'exit_code': result.get('exit_code'), 'output': out[:2500]})
        if fn.get('name') == 'fact_store' and args.get('action') == 'search':
            fact_ok = fact in json.dumps(result, ensure_ascii=False)
    reply = '\n'.join(str(x.get('content', '')) for x in messages if x['role'] == 'assistant')
    model_config = row.get('model_config') or {}
    if isinstance(model_config, str):
        model_config = json.loads(model_config)
    observed_provider = row.get('billing_provider') or row.get('provider') or model_config.get('provider')
    passed = (status.get('status', (status.get('run') or {}).get('status')) == 'completed'
              and row.get('model') == model['default'] and observed_provider == model['provider']
              and sorted(t['command'] for t in terminals) == sorted(required_commands)
              and all(t['exit_code'] == 0 for t in terminals) and fact_ok
              and 'IMPORT_RESTRICTED_CHECK' in reply and fact in reply)
    emit(service_run_status=status.get('status', (status.get('run') or {}).get('status')),
         canonical_model=row.get('model'), canonical_provider=observed_provider,
         canonical_tool_results=terminals, fact_store_existing_fact_verified=fact_ok,
         reply_marker='IMPORT_RESTRICTED_CHECK' in reply, reply_fact_verified=fact in reply,
         model_gate_pass=passed)
    return passed


def main():
    global LOG
    h.require(sys.argv[1:] == ['--confirm-reduced-restricted-rehearsal'], 'explicit_confirmation_required')
    get = lambda key: os.environ[PREFIX + key]
    source, root, wizard = [Path(get(k)).absolute() for k in ['SOURCE', 'ROOT', 'WIZARD_HOME']]
    service, image = get('SERVICE'), get('IMAGE')
    workspace, context = Path(get('WORKSPACE')), Path(get('CONTEXT'))
    host = get('BUILD_HOST')
    h.require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', host), 'build_host_invalid')
    LOG = Path(os.environ['WIZARD_IMPORT_RESTRICTED_EVIDENCE'])
    section('0. Preloaded sidecar and immutable source prerequisites')
    h.require(not root.exists() and not (wizard / 'agents' / AGENT).exists(), 'rehearsal_target_exists')
    before_hash = h.file_hash(source / 'config.yaml')
    h.require(before_hash == get('CONFIG_SHA256'), 'live_config_hash_mismatch')
    # Refuse an old image before any source copy, key installation or registry change.
    expected_egress = h.file_hash(restricted.rt.RESTRICTED_DIR / 'sidecars/egress.py')
    image_probe = command(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                           '--user', '65534:65534', '--security-opt', 'no-new-privileges:true',
                           '--entrypoint', 'python3', restricted.rt.SIDECAR_IMAGE, '-c',
                           'import hashlib; print(hashlib.sha256(open("/srv/egress.py","rb").read()).hexdigest())'], check=True)
    h.require(image_probe.stdout.strip() == expected_egress, 'declared_tcp_image_mismatch')
    declaration = {'alias': host, 'address': get('BUILD_ADDRESS'), 'port': 22,
                   'relay_port': int(get('BUILD_RELAY_PORT'))}
    restricted.declared_egress.validate([declaration])
    before_free = shutil.disk_usage(source).free
    before_agents = sorted(a['id'] for a in canary.call(service, '/wizard/v1/agents')['agents'])
    root.mkdir(mode=0o700, parents=True)
    home = root / 'source-owner/.hermes'
    home.mkdir(mode=0o700, parents=True)
    journal = wizard / 'imports' / AGENT / 'journal.json'
    key_added = False
    relay = None
    fw_scope = None
    firewall = Path(__file__).resolve().parents[1] / 'ops/agent-runtime/agent-firewall.sh'
    try:
        section('1. Read-only source snapshot and reduced copy')
        emit(config_sha256_before=before_hash, free_bytes_before=before_free, baseline_agents=before_agents)
        names = ['config.yaml', '.env', 'auth.json', 'SOUL.md', 'AGENTS.md', 'memories', 'skills', 'plugins', 'scripts']
        for name in names:
            src = source / name
            if src.is_dir():
                shutil.copytree(src, home / name, symlinks=True, ignore=shutil.ignore_patterns('__pycache__', '.git', 'node_modules', '.venv', '*.lock', '*.pid', 'output', 'logs'))
            elif src.is_file() and not src.is_symlink():
                shutil.copy2(src, home / name)
        (home / 'cron').mkdir()
        if (source / 'cron/jobs.json').is_file():
            shutil.copy2(source / 'cron/jobs.json', home / 'cron/jobs.json')
        h.dump(home / 'auth.json', access_only(json.loads((home / 'auth.json').read_text())))
        for name in ['memory_store.db', 'shared-state.db']:
            if (source / name).is_file():
                legacy.snapshot_small_db(source / name, home / name)
        stats = legacy.reduced_db(source / 'state.db', home / 'state.db')
        with contextlib.closing(sqlite3.connect(home / 'state.db')) as db:
            db.execute('UPDATE sessions SET hidden=1'); db.commit()
        with contextlib.closing(sqlite3.connect(home / 'memory_store.db')) as db:
            facts = db.execute("select content from facts where content like '%Thales%' limit 30").fetchall()
            fact = min((x[0] for x in facts), key=len)
        inode = (home / 'state.db').stat().st_ino
        copy_bytes = sum(p.stat().st_size for p in home.rglob('*') if p.is_file() and not p.is_symlink())
        h.require(copy_bytes < 2_000_000_000 and (home / 'state.db').stat().st_size < 500_000_000, 'reduced_copy_size_exceeded')
        emit(reduced_db=stats, copied_roots=names + ['cron/jobs.json', 'memory_store.db', 'shared-state.db'],
             small_copy_bytes=copy_bytes, full_home_acceptance=False, refresh_grants_removed=True)
        section('2. Per-item owner-approved GitHub grant and fresh declared-host key')
        scoped = root / 'scoped-ssh'; scoped.mkdir(mode=0o700)
        command(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', COMMENT, '-f', str(scoped / 'id_ed25519')], check=True)
        cfg = command(['ssh', '-G', host], check=True, log=False)
        fields = dict(x.split(' ', 1) for x in cfg.stdout.splitlines() if ' ' in x)
        address, user = fields['hostname'], fields['user']
        h.require(address == declaration['address'] and fields.get('port') == '22', 'declared_build_host_mismatch')
        known = command(['ssh-keygen', '-F', address, '-f', str(source.parent / '.ssh/known_hosts')], check=True, log=False)
        line = next(x.split() for x in known.stdout.splitlines() if not x.startswith('#') and ' ssh-ed25519 ' in x)
        (scoped / 'known_hosts').write_text(host + ' ' + ' '.join(line[1:]) + '\n')
        shutil.copy2(Path(__file__).resolve().parents[1] / 'ops/agent-runtime/ssh_connect_proxy.py', scoped / 'connect_proxy.py')
        (scoped / 'config').write_text(f'Host {host}\n  HostName {host}\n  Port 22\n  User {user}\n  ProxyCommand python3 /opt/data/.ssh/connect_proxy.py %h %p\n  IdentityFile /opt/data/.ssh/id_ed25519\n  IdentitiesOnly yes\n  IdentityAgent none\n  ForwardAgent no\n  StrictHostKeyChecking yes\n  HostKeyAlias {host}\n  UserKnownHostsFile /opt/data/.ssh/known_hosts\n  ConnectTimeout 8\n  ServerAliveInterval 30\n')
        key_added = True
        remote_key(host, (scoped / 'id_ed25519.pub').read_text())
        emit(new_thales_key_added=True, key_comment=COMMENT, no_forwarding=True, scope_verified_readback=True)
        claude = root / 'claude-access.json'
        h.dump(claude, access_only(json.loads((source.parent / '.claude/.credentials.json').read_text())))
        gitcfg = root / 'gitconfig'
        gitcfg.write_text('[safe]\n\tdirectory = ' + str(workspace / 'wizard-os') + '\n[credential "https://github.com"]\n\thelper =\n\thelper = !gh auth git-credential\n')
        plan = h.scan(home, owner_home=home.parent)
        plan.update(move=True, image=image, port=18721, owner_home=str(source.parent), logical_home=str(source),
                    mode='paused', gateway_url='http://edge:8923/wizard/mcp', approved_plugins=['holographic'],
                    supplemental_groups=[workspace.stat().st_gid], declared_tcp=[declaration])
        plan['owner_approvals'] = [{'owner': 'James', 'date': '2026-10-22',
            'item': 'GitHub OAuth hosts.yml', 'scopes': ['gist', 'read:org', 'repo', 'workflow'],
            'rationale': 'Same GitHub authority as the main agent today; day-one GitHub and Thales build access required. Does not touch the Private seal.'},
            {'owner': 'James', 'date': '2026-10-22', 'item': 'declared TCP', 'grant': declaration,
             'rationale': 'Exactly one build host:port, enforced at egress and a fixed host relay; no agent Tailscale socket.'}]
        plan['dependencies'] = [{'kind': 'folder', 'path': str(p), 'proposal': a, 'action': a, 'approved': True}
                                for p, a in [(workspace, 'mount rw'), (context, 'mount ro')]]
        for dest, src, members in [(source.parent / '.ssh', scoped, ['config', 'connect_proxy.py', 'id_ed25519', 'id_ed25519.pub', 'known_hosts']),
                                   (source.parent / '.config/gh/hosts.yml', source.parent / '.config/gh/hosts.yml', None),
                                   (source.parent / '.claude/.credentials.json', claude, None), (source.parent / '.gitconfig', gitcfg, None)]:
            item = {'kind': 'credential', 'path': str(dest), 'credential_source': str(src), 'proposal': 'carry secret', 'action': 'carry secret', 'approved': True}
            if members is not None:
                item['approved_files'] = members
            plan['dependencies'].append(item)
        # No other source auth/env item is approved. GitHub is a separate file grant.
        for item in plan['credentials']:
            if item['path'] == 'auth.json' and item['kind'] == 'auth-provider' and item['item'] == 'credential_pool:anthropic':
                item['approved'] = True
        emit(credential_dispositions=plan['credentials'], gh_file_grant_approved=True,
             gh_file_grant='.config/gh/hosts.yml', owner_approvals=plan['owner_approvals'])
        h.require(plan['summary']['model'] == {'provider': 'anthropic', 'default': 'claude-opus-5-5'}, 'rehearsal_model_mismatch')
        h.approve(plan); h.dump(root / 'plan.json', plan)
        section('3. Restricted apply and sealed uid-10000 home')
        result = h.apply(plan, AGENT, wizard)
        emit(apply=result)
        record_path = wizard / 'agents' / AGENT / 'agent.json'
        record = json.loads(record_path.read_text())
        h.require(record['runtime']['declared_tcp'] == [declaration], 'declared_policy_readback_failed')
        fw_scope = record['runtime']['network']['uplink']
        command(['sudo', '-n', 'sh', str(firewall), 'declared-add', fw_scope, str(declaration['relay_port'])], check=True)
        command(['sudo', '-n', 'sh', str(firewall), 'declared-check', fw_scope, str(declaration['relay_port'])], check=True)
        relay = subprocess.Popen([sys.executable, str(firewall.with_name('declared_egress.py')),
                    '--agent-json', str(record_path), '--alias', host,
                    '--tailscale', get('TAILSCALE'), '--socket', get('TAILSCALE_SOCKET')],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        h.require(bool(select.select([relay.stdout], [], [], 8)[0]), 'declared_relay_start_timeout')
        ready = json.loads(relay.stdout.readline())
        h.require(ready.get('ready') is True and relay.poll() is None, 'declared_relay_start_failed')
        emit(fixed_relay=ready, declared_tcp_readback=record['runtime']['declared_tcp'], tailscale_socket_in_agent=False)
        cid = restricted.rt.container_for('agent-' + AGENT, 'agent')
        inspect = json.loads(command(['docker', 'inspect', cid], check=True, log=False).stdout)[0]
        emit(container_user=inspect['Config']['User'], image=inspect['Config']['Image'], read_only_root=inspect['HostConfig']['ReadonlyRootfs'],
             cap_drop=inspect['HostConfig']['CapDrop'], published_ports=inspect['HostConfig']['PortBindings'],
             mounts=[{'destination': m['Destination'], 'rw': m['RW']} for m in inspect['Mounts']])
        h.require(inspect['Config']['User'] == '10000:10000' and inspect['HostConfig']['ReadonlyRootfs']
                  and 'ALL' in inspect['HostConfig']['CapDrop'] and not inspect['HostConfig'].get('CapAdd')
                  and not inspect['HostConfig']['Privileged'] and not inspect['HostConfig']['PortBindings']
                  and len(inspect['NetworkSettings']['Networks']) == 1
                  and all('docker.sock' not in m['Destination'] and 'tailscale' not in m['Destination'] for m in inspect['Mounts']),
                  'container_seal_failed')
        def probe(args, timeout=40, expected=0):
            result = command(['docker', 'exec', cid, *args], timeout=timeout)
            h.require(result.returncode == expected, 'restricted_probe_exit_mismatch')
            return result
        probe(['id'])
        probe(['python3', '-c', f'import os,json; assert os.getuid()==10000; s=os.stat("/opt/data"); assert s.st_uid==10000 and s.st_mode&511==448; assert os.stat("/opt/data/state.db").st_ino=={inode}; print(json.dumps({{"home_uid":s.st_uid,"home_mode":oct(s.st_mode&511),"state_inode_preserved":True}}))'])
        host_read = command(['ls', str(wizard / 'agents' / AGENT / 'home')])
        h.require(host_read.returncode != 0, 'sealed_home_host_readable')
        probe(['python3', '-c', 'import yaml,json; c=yaml.safe_load(open("/opt/data/config.yaml")); j=json.load(open("/opt/data/cron/jobs.json")); j=j if isinstance(j,list) else j["jobs"]; paused=all(x.get("enabled")==False and x.get("state")=="paused" for x in j); disabled=all(not v.get("enabled") for k,v in c["gateway"]["platforms"].items() if k!="api_server"); assert paused and disabled; print(json.dumps({"cron_paused":paused,"messaging_disabled":disabled,"memory_backend":c.get("memory",{}).get("provider"),"plugins":c["plugins"]["enabled"]}))'])
        section('4. Literal container tool exits and mount boundaries')
        probe(['ssh', '-o', 'BatchMode=yes', host, 'true'])
        probe(['gh', 'auth', 'status'])
        probe(['git', '-C', str(workspace / 'wizard-os'), 'fetch', '--dry-run'])
        probe(['python3', '-c', 'import urllib.request,json; print(json.dumps({h:urllib.request.urlopen("https://"+h+"/",timeout=15).status for h in ["github.com","api.github.com"]}))'])
        negative = '''import socket,json,ipaddress,sys
alias,address,gateway=sys.argv[1:]
other=str(ipaddress.ip_address(address)+1)
checks=[]
for host,port in [(alias,23),(other,22),(address,23),(gateway,22),('host.docker.internal',22)]:
 s=socket.create_connection(('egress',3128),5)
 s.settimeout(5)
 s.sendall(f'CONNECT {host}:{port} HTTP/1.1\\r\\n\\r\\n'.encode())
 reply=s.recv(512); s.close()
 assert reply.startswith(b'HTTP/1.1 403 '), (host,port)
 checks.append({'via':'egress','host':host,'port':port,'refused':True})
for host,port in [(address,22),(other,22),(address,23),(gateway,22)]:
 try: s=socket.create_connection((host,port),2)
 except OSError: checks.append({'via':'direct','host':host,'port':port,'refused':True})
 else: s.close(); raise AssertionError('direct host/tailnet reachable')
print(json.dumps({'negative_tcp_checks':checks}))
'''
        probe(['python3', '-c', negative, host, address, ready['bind']])
        probe(['sh', '-c', 'p="$1/.restricted-import-write-$$"; printf probe > "$p" && rm "$p" && test ! -e "$p"', 'probe', str(workspace)])
        probe(['sh', '-c', 'printf probe > "$1/.restricted-import-write-refused"', 'probe', str(context)], expected=2)
        probe(['sh', '-c', 'test ! -e /var/run/docker.sock && test ! -e /run/docker.sock && test ! -e "$1/.wizard-os/agents/private" && test ! -e /opt/data/.wizard-os/agents/private', 'probe', str(source.parent)])
        section('5. Live Service hidden session then one original-provider model turn')
        model_pass = model_exercise(service, cid, plan['summary']['model'], fact)
        h.require(model_pass, 'restricted_acceptance_remaining_gates')
        emit(restricted_acceptance='PASS')
    finally:
        section('6. Undo, key removal, copy deletion and invariant readbacks')
        cleanup_errors = []
        def clean(name, fn):
            try:
                return fn()
            except BaseException as exc:
                cleanup_errors.append(name)
                emit(cleanup_step=name, error_type=type(exc).__name__)
        if fw_scope:
            clean('firewall-remove', lambda: command(['sudo', '-n', 'sh', str(firewall), 'declared-remove', fw_scope,
                                                      str(declaration['relay_port'])], check=True))
            check = clean('firewall-readback', lambda: command(['sudo', '-n', 'sh', str(firewall), 'declared-check', fw_scope,
                                                               str(declaration['relay_port'])]))
            if check is not None and check.returncode == 0:
                cleanup_errors.append('firewall-rule-remains')
            emit(scoped_firewall_rule_absent=check is not None and check.returncode != 0)
        if relay:
            def stop_relay():
                relay.terminate()
                try:
                    relay.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    relay.kill(); relay.communicate(timeout=10)
                emit(fixed_relay_stopped=relay.poll() is not None)
            clean('relay-stop', stop_relay)
        if journal.exists():
            clean('undo', lambda: emit(undo=h.undo(journal)))
        if key_added:
            clean('key-remove-readback', lambda: remote_key(host))
            emit(thales_key_removed_verified='key-remove-readback' not in cleanup_errors)
        if not (wizard / 'agents' / AGENT).exists():
            clean('copy-delete', lambda: shutil.rmtree(root))
            if journal.parent.exists():
                clean('journal-delete', lambda: shutil.rmtree(journal.parent))
        else:
            cleanup_errors.append('agent-still-present-recovery-preserved')
        after_agents = sorted(a['id'] for a in canary.call(service, '/wizard/v1/agents')['agents'])
        after_hash = h.file_hash(source / 'config.yaml')
        emit(copies_deleted=not root.exists(), agent_directory_absent=not (wizard / 'agents' / AGENT).exists(),
             agent_list_restored=before_agents == after_agents, config_sha256_after=after_hash, config_unchanged=before_hash == after_hash,
             free_bytes_before=before_free, free_bytes_after=shutil.disk_usage(source).free, cleanup_errors=cleanup_errors)
        containers = command(['docker', 'ps', '-a', '--filter', 'label=com.docker.compose.project=agent-' + AGENT, '--format', '{{.Names}}'])
        command(['systemctl', '--user', 'is-active', 'hermes-gateway', 'wizard-mobile'])
        h.require(not cleanup_errors and not containers.stdout.strip() and not root.exists()
                  and before_hash == after_hash and before_agents == after_agents, 'cleanup_invariant_failed')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        emit(rehearsal_error_type=type(exc).__name__)
        if isinstance(exc, h.ImportFailure):
            emit(rehearsal_error_code=str(exc))
        raise SystemExit(1)
