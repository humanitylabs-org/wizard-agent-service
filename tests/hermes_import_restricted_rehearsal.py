#!/usr/bin/env python3
"""Explicit owner-run restricted rehearsal; no production cutover or service restart.

WIZARD_IMPORT_REHEARSAL_{SOURCE,ROOT,WIZARD_HOME,SERVICE,IMAGE,WORKSPACE,CONTEXT}
plus WIZARD_IMPORT_RESTRICTED_EVIDENCE are required. No host gh token is copied:
this host's broad OAuth grant is not a scoped imported-agent grant.
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
import hermes_import_acceptance_c as previous

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


def model_exercise(service, cid, model, fact):
    session = 'wizard_import_restricted_' + secrets.token_hex(6)
    # This helper does POST, PATCH hidden, GET and asserts true before returning.
    canary.hidden_session(service, AGENT, session)
    readback = canary.call(service, '/wizard/hermes/api/sessions/' + session + '?agent_id=' + AGENT)
    hidden = (readback.get('session') or readback).get('hidden')
    h.require(hidden is True or hidden == 1, 'session_not_hidden_fail_closed')
    emit(session=session, hidden_readback=hidden, before_message=True,
         fact_sha256=hashlib.sha256(fact.encode()).hexdigest())
    prompt = ('This is a single authorized hidden restricted-agent import rehearsal. Do not load skills. '
              'Run these as separate terminal calls, exactly: gh auth status ; ssh -o BatchMode=yes thales echo ok . '
              'Do not join commands or add echo/pipe. The sandbox currently blocks tailnet SSH and no broad host gh '
              'credential is granted: report failures honestly; never bypass the proxy/firewall or edit configuration. '
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
    code = '''import sqlite3,json
with sqlite3.connect('file:/opt/data/state.db?mode=ro',uri=True) as db:
 db.row_factory=sqlite3.Row
 row=db.execute('select * from sessions where id=?',(__import__('sys').argv[1],)).fetchone()
 session=dict(row) if row else {}
 messages=[dict(r) for r in db.execute('select * from messages where session_id=? order by id',(__import__('sys').argv[1],))]
print(json.dumps({'session':session,'messages':messages}))
'''
    emit(service_run_terminal_status=status.get('status', (status.get('run') or {}).get('status')), status_keys=sorted(status))
    raw = command(['docker', 'exec', cid, 'python3', '-c', code, session], log=False)
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
    emit(service_run_status=status.get('status', (status.get('run') or {}).get('status')),
         canonical_model=row.get('model'), canonical_provider=row.get('billing_provider') or row.get('provider') or model_config.get('provider'),
         canonical_tool_results=terminals, fact_store_existing_fact_verified=fact_ok,
         reply_marker='IMPORT_RESTRICTED_CHECK' in reply, reply_fact_verified=fact in reply,
         model_gate_pass=bool(terminals) and all(t['exit_code'] == 0 for t in terminals) and fact_ok)
    return bool(terminals) and all(t['exit_code'] == 0 for t in terminals) and fact_ok


def main():
    global LOG
    h.require(sys.argv[1:] == ['--confirm-reduced-restricted-rehearsal'], 'explicit_confirmation_required')
    get = lambda key: os.environ[PREFIX + key]
    source, root, wizard = [Path(get(k)).absolute() for k in ['SOURCE', 'ROOT', 'WIZARD_HOME']]
    service, image = get('SERVICE'), get('IMAGE')
    workspace, context = Path(get('WORKSPACE')), Path(get('CONTEXT'))
    LOG = Path(os.environ['WIZARD_IMPORT_RESTRICTED_EVIDENCE'])
    previous.emit = emit
    h.require(not root.exists() and not (wizard / 'agents' / AGENT).exists(), 'rehearsal_target_exists')
    before_hash = h.file_hash(source / 'config.yaml')
    before_free = shutil.disk_usage(source).free
    before_agents = sorted(a['id'] for a in canary.call(service, '/wizard/v1/agents')['agents'])
    root.mkdir(mode=0o700, parents=True)
    home = root / 'source-owner/.hermes'
    home.mkdir(mode=0o700, parents=True)
    journal = wizard / 'imports' / AGENT / 'journal.json'
    key_added = False
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
        emit(reduced_db=stats, copied_roots=names + ['cron/jobs.json', 'memory_store.db', 'shared-state.db'],
             small_copy_bytes=sum(p.stat().st_size for p in home.rglob('*') if p.is_file() and not p.is_symlink()),
             full_home_acceptance=False, refresh_grants_removed=True)
        section('2. Per-item grants, fresh build-host key, no broad gh authority')
        scoped = root / 'scoped-ssh'; scoped.mkdir(mode=0o700)
        command(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', COMMENT, '-f', str(scoped / 'id_ed25519')], check=True)
        cfg = command(['ssh', '-G', 'thales'], check=True, log=False)
        fields = dict(x.split(' ', 1) for x in cfg.stdout.splitlines() if ' ' in x)
        address, user = fields['hostname'], fields['user']
        known = command(['ssh-keygen', '-F', address, '-f', str(source.parent / '.ssh/known_hosts')], check=True, log=False)
        line = next(x.split() for x in known.stdout.splitlines() if not x.startswith('#') and ' ssh-ed25519 ' in x)
        (scoped / 'known_hosts').write_text('thales ' + ' '.join(line[1:]) + '\n')
        (scoped / 'config').write_text(f'Host thales\n  HostName {address}\n  User {user}\n  IdentityFile /opt/data/.ssh/id_ed25519\n  IdentitiesOnly yes\n  IdentityAgent none\n  ForwardAgent no\n  StrictHostKeyChecking yes\n  HostKeyAlias thales\n  UserKnownHostsFile /opt/data/.ssh/known_hosts\n  ConnectTimeout 8\n')
        key_added = True
        previous.remote_key('thales', (scoped / 'id_ed25519.pub').read_text())
        emit(new_thales_key_added=True, key_comment=COMMENT, no_forwarding=True, scope_verified_readback=True)
        claude = root / 'claude-access.json'
        h.dump(claude, access_only(json.loads((source.parent / '.claude/.credentials.json').read_text())))
        gitcfg = root / 'gitconfig'
        gitcfg.write_text('[safe]\n\tdirectory = ' + str(workspace / 'wizard-os') + '\n[credential "https://github.com"]\n\thelper = !gh auth git-credential\n')
        plan = h.scan(home, owner_home=home.parent)
        plan.update(move=True, image=image, port=18721, owner_home=str(source.parent), logical_home=str(source),
                    mode='paused', gateway_url='http://edge:8923/wizard/mcp', approved_plugins=['holographic'],
                    supplemental_groups=[workspace.stat().st_gid])
        plan['dependencies'] = [{'kind': 'folder', 'path': str(p), 'proposal': a, 'action': a, 'approved': True}
                                for p, a in [(workspace, 'mount rw'), (context, 'mount ro')]]
        for dest, src, members in [(source.parent / '.ssh', scoped, ['config', 'id_ed25519', 'id_ed25519.pub', 'known_hosts']),
                                   (source.parent / '.claude/.credentials.json', claude, None), (source.parent / '.gitconfig', gitcfg, None)]:
            item = {'kind': 'credential', 'path': str(dest), 'credential_source': str(src), 'proposal': 'carry secret', 'action': 'carry secret', 'approved': True}
            if members is not None:
                item['approved_files'] = members
            plan['dependencies'].append(item)
        # Individually reviewed Anthropic provider-pool access grant only. Every
        # other source auth/env item remains false, including broad GitHub OAuth.
        for item in plan['credentials']:
            if item['path'] == 'auth.json' and item['kind'] == 'auth-provider' and item['item'] == 'credential_pool:anthropic':
                item['approved'] = True
        emit(credential_dispositions=plan['credentials'], gh_credential_imported=False,
             gh_blocker='available host OAuth scopes are gist, read:org, repo, workflow; no scoped grant supplied')
        h.approve(plan); h.dump(root / 'plan.json', plan)
        section('3. Restricted apply and sealed uid-10000 home')
        result = h.apply(plan, AGENT, wizard)
        emit(apply=result)
        cid = restricted.rt.container_for('agent-' + AGENT, 'agent')
        inspect = json.loads(command(['docker', 'inspect', cid], check=True, log=False).stdout)[0]
        emit(container_user=inspect['Config']['User'], image=inspect['Config']['Image'], read_only_root=inspect['HostConfig']['ReadonlyRootfs'],
             cap_drop=inspect['HostConfig']['CapDrop'], published_ports=inspect['HostConfig']['PortBindings'],
             mounts=[{'destination': m['Destination'], 'rw': m['RW']} for m in inspect['Mounts']])
        def probe(args, timeout=40):
            return command(['docker', 'exec', cid, *args], timeout=timeout)
        probe(['id'])
        probe(['python3', '-c', f'import os,json; assert os.getuid()==10000; s=os.stat("/opt/data"); print(json.dumps({{"home_uid":s.st_uid,"home_mode":oct(s.st_mode&511),"state_inode_preserved":os.stat("/opt/data/state.db").st_ino=={inode}}}))'])
        command(['ls', str(wizard / 'agents' / AGENT / 'home')])
        probe(['python3', '-c', 'import yaml,json; c=yaml.safe_load(open("/opt/data/config.yaml")); j=json.load(open("/opt/data/cron/jobs.json")); j=j if isinstance(j,list) else j["jobs"]; print(json.dumps({"cron_paused":all(x.get("enabled")==False and x.get("state")=="paused" for x in j),"messaging_disabled":all(not v.get("enabled") for k,v in c["gateway"]["platforms"].items() if k!="api_server"),"memory_backend":c.get("memory",{}).get("provider"),"plugins":c["plugins"]["enabled"]}))'])
        section('4. Literal container tool exits and mount boundaries')
        probe(['ssh', '-o', 'BatchMode=yes', 'thales', 'true'])
        probe(['gh', 'auth', 'status'])
        probe(['git', '-C', str(workspace / 'wizard-os'), 'fetch', '--dry-run'])
        probe(['sh', '-c', 'p="$1/.restricted-import-write-$$"; printf probe > "$p" && rm "$p" && test ! -e "$p"', 'probe', str(workspace)])
        probe(['sh', '-c', 'printf probe > "$1/.restricted-import-write-refused"', 'probe', str(context)])
        probe(['sh', '-c', 'test ! -e /var/run/docker.sock && test ! -e /run/docker.sock && test ! -e /home/telos/.wizard-os/agents/private && test ! -e /opt/data/.wizard-os/agents/private'])
        section('5. Live Service hidden session then one original-provider model turn')
        model_pass = model_exercise(service, cid, plan['summary']['model'], fact)
        h.require(model_pass, 'restricted_acceptance_remaining_gates')
    finally:
        section('6. Undo, key removal, copy deletion and invariant readbacks')
        if journal.exists():
            emit(undo=h.undo(journal))
        if key_added:
            previous.remote_key('thales')
            emit(thales_key_removed_verified=True)
        shutil.rmtree(root)
        if journal.parent.exists():
            shutil.rmtree(journal.parent)
        after_agents = sorted(a['id'] for a in canary.call(service, '/wizard/v1/agents')['agents'])
        after_hash = h.file_hash(source / 'config.yaml')
        emit(copies_deleted=not root.exists(), agent_directory_absent=not (wizard / 'agents' / AGENT).exists(),
             agent_list_restored=before_agents == after_agents, config_sha256_after=after_hash, config_unchanged=before_hash == after_hash,
             free_bytes_before=before_free, free_bytes_after=shutil.disk_usage(source).free)
        command(['docker', 'ps', '-a', '--filter', 'label=com.docker.compose.project=agent-' + AGENT, '--format', '{{.Names}}'])
        command(['systemctl', '--user', 'is-active', 'hermes-gateway', 'wizard-mobile'])
        h.require(before_hash == after_hash and before_agents == after_agents, 'cleanup_invariant_failed')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        emit(rehearsal_error_type=type(exc).__name__)
        if isinstance(exc, h.ImportFailure):
            emit(rehearsal_error_code=str(exc))
        raise SystemExit(1)
