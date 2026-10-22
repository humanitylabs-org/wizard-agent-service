#!/usr/bin/env python3
"""Explicit owner-run restricted rehearsal; no production cutover or service restart.

WIZARD_IMPORT_REHEARSAL_{SOURCE,ROOT,WIZARD_HOME,SERVICE,IMAGE,WORKSPACE,CONTEXT}
plus WIZARD_IMPORT_RESTRICTED_EVIDENCE are required. The existing GitHub OAuth file
is an explicit owner-approved per-file grant (2026-10-22), not a Private-seal grant.
No host TCP listener, SSH key, root command or firewall operation is permitted.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
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


def model_exercise(service, cid, model, fact):
    session = 'wizard_import_restricted_' + secrets.token_hex(6)
    # This helper does POST, PATCH hidden, GET and asserts true before returning.
    canary.hidden_session(service, AGENT, session)
    readback = canary.call(service, '/wizard/hermes/api/sessions/' + session + '?agent_id=' + AGENT)
    hidden = (readback.get('session') or readback).get('hidden')
    h.require(hidden is True or hidden == 1, 'session_not_hidden_fail_closed')
    emit(session=session, hidden_readback=hidden, before_message=True,
         fact_sha256=hashlib.sha256(fact.encode()).hexdigest())
    required_commands = ['gh auth status']
    heavy_cwd = os.environ[PREFIX + 'HEAVY_ROOT'].rstrip('/') + '/agents/' + AGENT
    prompt = ('This is a single authorized hidden restricted-agent import rehearsal. Do not load skills. '
              'First run exactly gh auth status as one terminal call. '
              'Then use fact_store action=search to recall this existing Thales fact: ' + fact + '\n'
              'Finally call wizard_heavy_submit exactly once with key=hermes-import-rehearsal-heavy-probe, '
              'cwd=' + heavy_cwd + ', argv=["/usr/bin/uname","-a"], lane=light, timeout_seconds=60. '
              'This agent-bound job grant is approved by James 2026-10-22. No SSH, host token, configuration changes, '
              'credential printing or other work. Report admission failure honestly; never use the host relay as fallback. '
              'After the receipt end this turn without polling. Reply IMPORT_RESTRICTED_CHECK with the gh exit code, '
              'recalled fact and job receipt. The Service handles continuation.')
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
    terminals, fact_ok, submissions = [], False, []
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
        if fn.get('name') == 'wizard_heavy_submit':
            submissions.append({'arguments': args, 'receipt': result})
        if fn.get('name') == 'fact_store' and args.get('action') == 'search':
            fact_ok = fact in json.dumps(result, ensure_ascii=False)
    reply = '\n'.join(str(x.get('content', '')) for x in messages if x['role'] == 'assistant')
    model_config = row.get('model_config') or {}
    if isinstance(model_config, str):
        model_config = json.loads(model_config)
    observed_provider = row.get('billing_provider') or row.get('provider') or model_config.get('provider')
    heavy_pass = verify_heavy(service, submissions, heavy_cwd)
    passed = (status.get('status', (status.get('run') or {}).get('status')) == 'completed'
              and row.get('model') == model['default'] and observed_provider == model['provider']
              and sorted(t['command'] for t in terminals) == sorted(required_commands)
              and all(t['exit_code'] == 0 for t in terminals) and fact_ok and heavy_pass
              and 'IMPORT_RESTRICTED_CHECK' in reply and fact in reply)
    emit(service_run_status=status.get('status', (status.get('run') or {}).get('status')),
         canonical_model=row.get('model'), canonical_provider=observed_provider,
         canonical_tool_results=terminals, fact_store_existing_fact_verified=fact_ok,
         reply_marker='IMPORT_RESTRICTED_CHECK' in reply, reply_fact_verified=fact in reply,
         model_gate_pass=passed, heavy_job_gate_pass=heavy_pass)
    return passed


def verify_heavy(service, submissions, cwd):
    if len(submissions) != 1:
        emit(heavy_submit_count=len(submissions), heavy_job_gate_pass=False)
        return False
    item = submissions[0]
    args = item['arguments']
    expected = {'key': 'hermes-import-rehearsal-heavy-probe', 'cwd': cwd,
                'argv': ['/usr/bin/uname', '-a'], 'lane': 'light', 'timeout_seconds': 60}
    receipt = item['receipt']
    # Tool content can be either a direct JSON object or MCP content blocks.
    if isinstance(receipt, dict) and 'content' in receipt:
        try:
            receipt = json.loads(''.join(x.get('text', '') for x in receipt['content']))
        except (ValueError, TypeError):
            pass
    job_id = receipt.get('job_id') if isinstance(receipt, dict) else None
    emit(heavy_submit_arguments_match=args == expected, heavy_submit_receipt=receipt)
    if args != expected or not job_id:
        return False
    end = time.monotonic() + 1800
    status = receipt
    while time.monotonic() < end:
        status = canary.call(service, '/wizard/v1/agent-heavy/status', 'POST', {'job_id': job_id})
        if status.get('state') in {'completed', 'failed', 'cancelled', 'interrupted'}:
            break
        time.sleep(15)  # bounded owner observation, never agent polling or resubmission
    result = status.get('receipt') or {}
    passed = status.get('agent_id') == AGENT and status.get('state') == 'completed' and result.get('exit_code') == 0
    emit(heavy_job_terminal_readback=status, heavy_job_gate_pass=passed)
    return passed


def config_baseline(source):
    # Each authorized run supplies its own start-of-run pin; never an old live pin.
    expected = os.environ.get(PREFIX + 'CONFIG_SHA256', '')
    h.require(re.fullmatch(r'[0-9a-f]{64}', expected) is not None, 'config_baseline_required')
    observed = h.file_hash(source / 'config.yaml')
    h.require(observed == expected, 'live_config_hash_mismatch')
    return observed


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
    before_hash = config_baseline(source)
    emit(config_sha256_before=before_hash, free_bytes_before=shutil.disk_usage(source).free,
         baseline_agents=sorted(a['id'] for a in canary.call(service, '/wizard/v1/agents')['agents']))
    # Refuse an old image before any source copy or registry change.
    expected_egress = h.file_hash(restricted.rt.RESTRICTED_DIR / 'sidecars/egress.py')
    image_probe = command(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                           '--user', '65534:65534', '--security-opt', 'no-new-privileges:true',
                           '--entrypoint', 'python3', restricted.rt.SIDECAR_IMAGE, '-c',
                           'import hashlib; print(hashlib.sha256(open("/srv/egress.py","rb").read()).hexdigest())'], check=True)
    h.require(image_probe.stdout.strip() == expected_egress, 'main_sidecar_image_mismatch')
    capabilities = canary.call(service, '/wizard/v1/agent-options').get('import_capabilities', {})
    emit(live_service_import_capabilities=capabilities)
    h.require(capabilities.get('socket_prepare') is True, 'live_service_socket_prepare_unavailable')
    h.require(capabilities.get('heavy_enabled') is True and capabilities.get('heavy_sandbox') is True,
              'live_service_agent_heavy_unavailable')
    before_free = shutil.disk_usage(source).free
    before_agents = sorted(a['id'] for a in canary.call(service, '/wizard/v1/agents')['agents'])
    root.mkdir(mode=0o700, parents=True)
    home = root / 'source-owner/.hermes'
    home.mkdir(mode=0o700, parents=True)
    journal = wizard / 'imports' / AGENT / 'journal.json'
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
        section('2. Per-item owner-approved GitHub and heavy grants; no SSH key')
        claude = root / 'claude-access.json'
        h.dump(claude, access_only(json.loads((source.parent / '.claude/.credentials.json').read_text())))
        gitcfg = root / 'gitconfig'
        gitcfg.write_text('[safe]\n\tdirectory = ' + str(workspace / 'wizard-os') + '\n[credential "https://github.com"]\n\thelper =\n\thelper = !gh auth git-credential\n')
        plan = h.scan(home, owner_home=home.parent)
        plan.update(move=True, image=image, port=18721, owner_home=str(source.parent), logical_home=str(source),
                    mode='paused', gateway_url='http://edge:8923/wizard/mcp', approved_plugins=['holographic'],
                    supplemental_groups=[workspace.stat().st_gid], service_url=service, grants={'heavy': True})
        plan['grant_items'] = [{'item': 'grants.heavy', 'approved': True, 'owner': 'James', 'date': '2026-10-22'}]
        plan['owner_approvals'] = [{'owner': 'James', 'date': '2026-10-22',
            'item': 'GitHub OAuth hosts.yml', 'scopes': ['gist', 'read:org', 'repo', 'workflow'],
            'rationale': 'Same GitHub authority as the main agent today; no Private seal change.'},
            {'owner': 'James', 'date': '2026-10-22', 'item': 'grants.heavy',
             'rationale': 'Existing agent-bound heavy relay only; Machines/SSH deferred.'}]
        plan['dependencies'] = [{'kind': 'folder', 'path': str(p), 'proposal': a, 'action': a, 'approved': True}
                                for p, a in [(workspace, 'mount rw'), (context, 'mount ro')]]
        for dest, src, members in [(source.parent / '.config/gh/hosts.yml', source.parent / '.config/gh/hosts.yml', None),
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
        started = time.monotonic()
        result = h.apply(plan, AGENT, wizard)
        emit(apply=result, apply_seconds=round(time.monotonic() - started, 3))
        record = json.loads((wizard / 'agents' / AGENT / 'agent.json').read_text())
        h.require(record.get('grants', {}).get('heavy') is True, 'heavy_grant_readback_failed')
        emit(agent_bound_heavy_grant_readback=True, ssh_key_carried=False, host_tcp_listener=False)
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
        probe(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, 'true'], expected=255)
        probe(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', get('VPS_ADDRESS'), 'true'], expected=255)
        probe(['gh', 'auth', 'status'])
        probe(['git', '-C', str(workspace / 'wizard-os'), 'fetch', '--dry-run'])
        probe(['python3', '-c', 'import urllib.request,json; print(json.dumps({h:urllib.request.urlopen("https://"+h+"/",timeout=15).status for h in ["github.com","api.github.com"]}))'])
        probe(['sh', '-c', 'p="$1/.restricted-import-write-$$"; printf probe > "$p" && rm "$p" && test ! -e "$p"', 'probe', str(workspace)])
        probe(['sh', '-c', 'printf probe > "$1/.restricted-import-write-refused"', 'probe', str(context)], expected=2)
        probe(['sh', '-c', 'test ! -e /var/run/docker.sock && test ! -e /run/docker.sock && test ! -e "$1/.wizard-os/agents/private" && test ! -e /opt/data/.wizard-os/agents/private', 'probe', str(source.parent)])
        section('5. Live Service hidden session then one original-provider model turn')
        model_pass = model_exercise(service, cid, plan['summary']['model'], fact)
        h.require(model_pass, 'restricted_acceptance_remaining_gates')
        emit(restricted_acceptance='PASS')
    finally:
        section('6. Undo, copy deletion and invariant readbacks')
        cleanup_errors = []
        def clean(name, fn):
            try:
                return fn()
            except BaseException as exc:
                cleanup_errors.append(name)
                emit(cleanup_step=name, error_type=type(exc).__name__)
        if journal.exists():
            started = time.monotonic()
            clean('undo', lambda: emit(undo=h.undo(journal), undo_seconds=round(time.monotonic() - started, 3)))
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
