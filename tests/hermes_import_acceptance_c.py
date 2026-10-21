#!/usr/bin/env python3
"""Explicit acceptance C; no live source writes or gateway/service lifecycle calls.

Required env: WIZARD_IMPORT_REHEARSAL_SOURCE, _ROOT, _WIZARD_HOME, _SERVICE,
_IMAGE, _WORKSPACE, _CONTEXT, _BUILD_HOST, _BUILD_ADDRESS, _RELAY_ADDRESS,
_RELAY_PORT, _VPS_ADDRESS. Run only with --confirm-reduced-rehearsal.
Private keys are generated ONLY in the importer's final credential placement.
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
import socketserver
import sqlite3
import stat
import subprocess
import sys
import threading
import time

import hermes_import_rehearsal as rehearsal
import hermes_import_canary as canary
m = rehearsal.m
PREFIX = 'WIZARD_IMPORT_REHEARSAL_'
COMMENT = 'wizard-import-archimedes-rehearsal'


def emit(**value):
    print(json.dumps(value, sort_keys=True), flush=True)


def command(argv, *, input=None, timeout=60):
    result = subprocess.run(argv, input=input, capture_output=True, text=True, timeout=timeout)
    m.require(result.returncode == 0, 'acceptance_command_failed_' + Path(argv[0]).name)
    return result.stdout


# These names are ephemeral local launch/UI state, not portable agent content.
EPHEMERAL = {'webui', 'worktrees', '.curator_backups', 'gateway', 'pairing',
             'pending_messages', 'mcp-tokens', 'sandbox', 'sandboxes', 'staging',
             '.restart_pending.json', '.restart_last_processed.json', 'spawn-ledger.json'}


def portable_inventory(source):
    """All regular non-DB home files except documented cache/log/bin/runtime paths.

    No symlinks are followed and database bytes are never copied as ordinary files.
    The two memory DBs are separately snapshotted through read-only SQLite.
    """
    rows, omitted = [], {}
    for base, dirs, names in os.walk(source, followlinks=False):
        relbase = Path(base).relative_to(source)
        keep = []
        for name in sorted(dirs):
            p = Path(base) / name
            rel = relbase / name
            if p.is_symlink() or m.excluded(str(rel / 'placeholder')) or name in EPHEMERAL or name in {'cache', 'caches', 'logs', 'bin', '.venv', 'venv', '.cache'}:
                omitted[str(rel)] = 'per-machine directory/cache/bin or symlink'
            else:
                keep.append(name)
        dirs[:] = keep
        for name in sorted(names):
            p = Path(base) / name
            rel = relbase / name
            try:
                s = p.lstat()
                if not stat.S_ISREG(s.st_mode) or m.excluded(str(rel)) or name in EPHEMERAL or name.endswith(('.log', '.log.1')) or '_cache' in name or '.cache' in name:
                    omitted[str(rel)] = 'per-machine/cache/log/special file'
                    continue
                # Recognize SQLite regardless of its name, and DB artifacts by suffix.
                if re.search(r'\.(db|sqlite|sqlite3)(?:[.-]|$)', name) or name == ':memory:':
                    omitted[str(rel)] = 'database (separate selected snapshots only)'
                    continue
                with p.open('rb') as f:
                    if f.read(16) == b'SQLite format 3\x00':
                        omitted[str(rel)] = 'database signature'
                        continue
                rows.append((p, rel, s.st_size))
            except FileNotFoundError:
                omitted[str(rel)] = 'transient file disappeared'
    return rows, omitted


def copy_portable(source, home, manifest):
    rows, omitted = portable_inventory(source)
    size = sum(n for _, _, n in rows)
    m.require(size < 40 * 1024**3 and shutil.disk_usage(home).free > size + 8 * 1024**3, 'acceptance_copy_disk_budget')
    emit(copy_inventory_files=len(rows), copy_inventory_bytes=size,
         per_root_bytes={root: sum(n for _, rel, n in rows if rel.parts[0] == root) for root in sorted({r.parts[0] for _, r, _ in rows})})
    # Complete path disposition stays private; evidence records only aggregate counts.
    m.dump(manifest, {'included': [str(rel) for _, rel, _ in rows], 'omitted': omitted})
    for src, rel, _ in rows:
        dest = home / rel
        dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copy2(src, dest)
    emit(non_database_copy_complete=True, copied_files=len(rows), omitted_paths=len(omitted),
         skill_files=sum(str(r).startswith('skills/') for _, r, _ in rows),
         plugin_files=sum(str(r).startswith('plugins/') for _, r, _ in rows))


def without_refresh(value):
    if isinstance(value, dict):
        return {k: without_refresh(v) for k, v in value.items() if 'refresh' not in k.lower()}
    if isinstance(value, list):
        return [without_refresh(v) for v in value]
    return value


class ThalesRelay(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class RelayHandler(socketserver.BaseRequestHandler):
    def handle(self):
        # A fixed-destination TCP relay, never a shell/agent/socket grant. Only this
        # exact container IP can use it; no caller-supplied destination is parsed.
        try:
            addr = json.loads(command(['docker', 'inspect', self.server.container]))[0]['NetworkSettings']['Networks'][self.server.network]['IPAddress']
            if self.client_address[0] != addr:
                return
            p = subprocess.Popen(self.server.argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            try:
                while True:
                    ready, _, _ = select.select([self.request, p.stdout], [], [], 30)
                    if not ready:
                        break
                    if self.request in ready:
                        data = self.request.recv(65536)
                        if not data:
                            break
                        p.stdin.write(data)
                        p.stdin.flush()
                    if p.stdout in ready:
                        data = os.read(p.stdout.fileno(), 65536)
                        if not data:
                            break
                        self.request.sendall(data)
            finally:
                p.terminate()
                p.communicate(timeout=5)
        except (OSError, subprocess.SubprocessError, m.ImportFailure):
            return


def remote_key(host, public=None):
    # Read back exactly the target line after each external mutation. Never emit keys.
    code = '''import sys,pathlib,json,os
p=pathlib.Path.home()/'.ssh/authorized_keys'
lines=p.read_text().splitlines() if p.exists() else []
comment=sys.argv[1]
new=sys.stdin.read().strip()
lines=[x for x in lines if not x.endswith(' '+comment)]
if new: lines.append('no-agent-forwarding,no-port-forwarding,no-X11-forwarding '+new)
p.parent.mkdir(mode=0o700,exist_ok=True)
p.write_text('\\n'.join(lines)+'\\n');p.chmod(0o600)
rows=[x for x in p.read_text().splitlines() if x.endswith(' '+comment)]
assert len(rows)==(1 if new else 0)
if new: assert rows[0]=='no-agent-forwarding,no-port-forwarding,no-X11-forwarding '+new
print(json.dumps({'thales_rehearsal_key_lines':len(rows),'authorized_keys_readback':True}))
'''
    out = command(['ssh', '-o', 'BatchMode=yes', host, 'python3 -c ' + shlex.quote(code) + ' ' + shlex.quote(COMMENT)], input=public or '', timeout=30)
    emit(remote_key=json.loads(out))


def probe(container, argv, *, expect=0):
    result = subprocess.run(['docker', 'exec', container, *argv], capture_output=True, text=True, timeout=70)
    # gh masks its token but do not preserve even the masked token line.
    text = '\n'.join(x for x in (result.stdout + result.stderr).splitlines() if not re.search(r'token\s*:', x, re.I))
    emit(command=shlex.join(argv), exit_code=result.returncode, output=text[:4000])
    m.require(result.returncode == expect if expect is not None else result.returncode != 0, 'probe_exit_mismatch_' + argv[0])
    return result


def model_exercise(service, agent, target, model):
    session = 'wizard_import_c_' + secrets.token_hex(6)
    canary.hidden_session(service, agent, session)
    # A real preexisting fact, not an acceptance fixture. Only its hash enters evidence.
    with sqlite3.connect((target / 'memory_store.db').as_uri() + '?mode=ro', uri=True) as db:
        facts = db.execute('SELECT content FROM facts WHERE content LIKE ? LIMIT 20', ('%Thales%',)).fetchall()
        m.require(bool(facts), 'no_known_thales_fact')
        fact = min((r[0] for r in facts), key=len)
    emit(known_fact_sha256=hashlib.sha256(fact.encode()).hexdigest())
    prompt = ('This is one authorized hidden import acceptance check. Do not load skills or do any other work. '
              'Use your terminal tool to run exactly these two independent read-only checks: '
              'gh auth status ; then ssh -o BatchMode=yes thales echo ok . '
              'Use fact_store action=search to recall an existing fact about Thales. '
              'The fact to find is: ' + fact + '\n'
              'After the tools finish, reply IMPORT_C_OK, give each literal exit code, and state the recalled fact. '
              'Do not print credentials or call any other tool. Do not fabricate results.')
    req = {'session_id': session, 'agent_id': agent, 'input': prompt,
           'model': model['default'], 'provider': model['provider']}
    result = canary.call(service, '/wizard/hermes/v1/runs', 'POST', req, headers={'Idempotency-Key': 'import-' + session})
    run_id = result.get('run_id') or result.get('id') or (result.get('run') or {}).get('id')
    m.require(bool(run_id), 'acceptance_no_run_id')
    emit(run_id=run_id, session=session, requested_model=model)
    end = time.monotonic() + 220
    rows = []
    status = {}
    while time.monotonic() < end:
        msgs = canary.call(service, '/wizard/hermes/api/sessions/' + session + '/messages?agent_id=' + agent)
        rows = msgs.get('data', msgs.get('messages', []))
        status = canary.call(service, '/wizard/hermes/v1/runs/' + str(run_id) + '?agent_id=' + agent)
        if any(r.get('role') == 'assistant' and 'IMPORT_C_OK' in str(r.get('content', '')) for r in rows):
            break
        if status.get('status', (status.get('run') or {}).get('status')) in {'failed', 'cancelled', 'error', 'completed'}:
            break
        time.sleep(2)
    emit(service_message_roles=[r.get('role') for r in rows], service_run_status=status.get('status', (status.get('run') or {}).get('status')),
         service_status_keys=sorted(status))
    # Ground verification in the actual canonical session, not the assistant's claims.
    with sqlite3.connect((target / 'state.db').as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        session_row = dict(db.execute('SELECT * FROM sessions WHERE id=?', (session,)).fetchone())
        messages = [dict(r) for r in db.execute('SELECT * FROM messages WHERE session_id=? ORDER BY id', (session,))]
    actual_model = session_row.get('model')
    provider = session_row.get('provider')
    emit(session_model=actual_model, session_provider=provider,
         session_metadata_columns=[k for k in session_row if 'model' in k or 'provider' in k],
         canonical_message_roles=[r.get('role') for r in messages])
    tool_calls, results = [], []
    for row in messages:
        calls = row.get('tool_calls')
        if calls:
            calls = json.loads(calls) if isinstance(calls, str) else calls
            tool_calls.extend(calls)
        if row.get('role') == 'tool':
            raw = row.get('content') or '{}'
            try:
                payload = json.loads(raw)
            except ValueError:
                payload = {'text': raw}
            results.append((row.get('tool_call_id'), payload))
    emit(tool_call_names=[c.get('function', {}).get('name', c.get('name')) for c in tool_calls],
         tool_result_shapes=[sorted(p) if isinstance(p, dict) else type(p).__name__ for _, p in results])
    terminals, fact_ok = [], False
    for call in tool_calls:
        fn = call.get('function', call)
        name = fn.get('name')
        args = fn.get('arguments') or {}
        args = json.loads(args) if isinstance(args, str) else args
        match = next((p for cid, p in results if cid == call.get('id')), None)
        if name == 'terminal':
            terminals.append({'command': args.get('command'), 'exit_code': match.get('exit_code') if isinstance(match, dict) else None,
                              'ok_output': 'ok' in str(match)})
        if name == 'fact_store' and args.get('action') == 'search':
            fact_ok = fact in json.dumps(match, ensure_ascii=False)
    reply = '\n'.join(str(r.get('content', '')) for r in rows if r.get('role') == 'assistant')
    emit(terminal_tool_results=terminals, fact_store_existing_fact_verified=fact_ok,
         model_reply_marker='IMPORT_C_OK' in reply, model_reply_recalled_fact=fact in reply)
    m.require(actual_model == model['default'], 'session_model_mismatch')
    # Some schema versions expose provider in run metadata instead of the session row.
    if provider is not None:
        m.require(provider == model['provider'], 'session_provider_mismatch')
    m.require('IMPORT_C_OK' in reply and fact in reply and fact_ok, 'acceptance_reply_or_fact_failed')
    m.require(terminals and all(t['exit_code'] == 0 for t in terminals), 'acceptance_terminal_tool_failed')
    m.require(any('gh auth status' in (t['command'] or '') for t in terminals) and any('thales' in (t['command'] or '') for t in terminals), 'acceptance_terminal_commands_missing')
    return session


def main():
    m.require(sys.argv[1:] == ['--confirm-reduced-rehearsal'], 'explicit_confirmation_required')
    get = lambda name: os.environ[PREFIX + name]
    source, root, wizard = (Path(get(k)).absolute() for k in ['SOURCE', 'ROOT', 'WIZARD_HOME'])
    service, image, host = get('SERVICE'), get('IMAGE'), get('BUILD_HOST')
    owner = source.parent
    workspace, context = Path(get('WORKSPACE')), Path(get('CONTEXT'))
    agent, container = 'archimedes-rehearsal', 'agent-archimedes-rehearsal'
    before_hash = m.file_hash(source / 'config.yaml')
    before_free = shutil.disk_usage(source).free
    before_agents = sorted(a['id'] for a in canary.call(service, '/wizard/v1/agents')['agents'])
    m.require(agent not in before_agents and not root.exists(), 'acceptance_preexisting_target')
    root.mkdir(mode=0o700, parents=True)
    home = root / 'source-owner/.hermes'
    home.mkdir(mode=0o700, parents=True)
    relay = None
    key_may_exist = False
    try:
        live = m.scan(source, owner_home=owner)
        emit(live_scan_summary=live['summary'], live_config_sha256=before_hash, free_bytes_before=before_free)
        copy_portable(source, home, root / 'copy-dispositions.json')
        # Complete provider/pool structure is retained, but no test can rotate a live refresh grant.
        m.dump(home / 'auth.json', without_refresh(json.loads((home / 'auth.json').read_text())))
        for name in ['memory_store.db', 'shared-state.db']:
            if (source / name).exists():
                rehearsal.snapshot_small_db(source / name, home / name)
        stats = rehearsal.reduced_db(source / 'state.db', home / 'state.db')
        with contextlib.closing(sqlite3.connect(home / 'state.db')) as db:
            db.execute('UPDATE sessions SET hidden=1')
            db.commit()
        emit(reduced_db=stats, auth_all_provider_structures_preserved=True, refresh_grants_removed_from_test=True)
        plan = m.scan(home, owner_home=home.parent)
        plan.update(move=True, image=image, network='runtipi_tipi_main_network', port=18721,
                    owner_home=str(owner), logical_home=str(source), mode='paused',
                    gateway_url='http://wizard-agent-service:8923/wizard/mcp', approved_plugins=['holographic'])
        # Retain no auto-selected outside authority: two folders and approved credentials only.
        plan['dependencies'] = [{'kind': 'folder', 'path': str(p), 'proposal': action, 'action': action, 'approved': True}
                                for p, action in [(workspace, 'mount rw'), (context, 'mount ro')]]
        scoped = root / 'scoped-ssh'
        scoped.mkdir(mode=0o700)
        relay_addr, relay_port = get('RELAY_ADDRESS'), int(get('RELAY_PORT'))
        ssh_cfg = ('Host thales\n  HostName ' + relay_addr + '\n  Port ' + str(relay_port) + '\n  User ' + get('BUILD_USER') +
                   '\n  IdentityFile ' + str(owner / '.ssh/id_ed25519') + '\n  IdentitiesOnly yes\n  IdentityAgent none\n  ForwardAgent no\n  StrictHostKeyChecking yes\n  HostKeyAlias thales\n  UserKnownHostsFile ' + str(owner / '.ssh/known_hosts') + '\n')
        (scoped / 'config').write_text(ssh_cfg)
        known = command(['ssh-keygen', '-F', get('BUILD_ADDRESS'), '-f', str(owner / '.ssh/known_hosts')])
        line = next(x.split() for x in known.splitlines() if not x.startswith('#') and ' ssh-ed25519 ' in x)
        (scoped / 'known_hosts').write_text('thales ' + ' '.join(line[1:]) + '\n')
        creds = [(owner / '.ssh', scoped), (owner / '.config/gh/hosts.yml', owner / '.config/gh/hosts.yml')]
        # Borrow only the current Anthropic access grant, never the refresh token.
        claude = root / 'claude-access.json'
        m.dump(claude, without_refresh(json.loads((owner / '.claude/.credentials.json').read_text())))
        creds.append((owner / '.claude/.credentials.json', claude))
        gitcfg = root / 'gitconfig'
        gitcfg.write_text('[credential "https://github.com"]\n\thelper = !gh auth git-credential\n')
        creds.append((owner / '.gitconfig', gitcfg))
        for dest, src in creds:
            plan['dependencies'].append({'kind': 'credential', 'path': str(dest), 'credential_source': str(src),
                                         'proposal': 'carry secret', 'action': 'carry secret', 'approved': True})
        model = live['summary']['model']
        m.require(plan['summary']['model'] == model, 'copy_main_model_changed')
        m.approve(plan)
        m.dump(root / 'plan.json', plan)
        # Native userspace Tailscale has no kernel route. Relay just this container's
        # encrypted SSH stream to the one approved host, without exposing its socket.
        relay = ThalesRelay((relay_addr, relay_port), RelayHandler)
        relay.container, relay.network = container, plan['network']
        relay.argv = [str(owner / '.local/bin/tailscale'), '--socket=' + get('TAILSCALE_SOCKET'), 'nc', get('BUILD_ADDRESS'), '22']
        threading.Thread(target=relay.serve_forever, daemon=True).start()

        class Runtime(m.DockerRuntime):
            def start(self):
                nonlocal key_may_exist
                placement = self.directory / 'credentials' / m.digest(str(owner / '.ssh'))
                key = placement / 'id_ed25519'
                command(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', COMMENT, '-f', str(key)])
                m.require(key.stat().st_mode & 0o077 == 0, 'private_key_mode')
                key_may_exist = True
                remote_key(host, (placement / 'id_ed25519.pub').read_text())
                emit(key_generated_only_in_importer_credential_placement=True, host_ssh_config_entries=1,
                     thales_key_restrictions=['no-agent-forwarding', 'no-port-forwarding', 'no-X11-forwarding'])
                super().start()

        result = m.apply(plan, agent, wizard, runtime_factory=Runtime)
        emit(apply=result)
        target = wizard / 'agents' / agent / 'home'
        cfg = m.load_yaml((target / 'config.yaml').read_text())
        m.require(cfg['model'] == model, 'wired_main_model_changed')
        jobs = json.loads((target / 'cron/jobs.json').read_text())
        jobs = jobs if isinstance(jobs, list) else jobs['jobs']
        m.require(all(j.get('enabled') is False and j.get('state') == 'paused' for j in jobs), 'cron_not_paused')
        m.require(all(not v.get('enabled') for k, v in cfg['gateway']['platforms'].items() if k != 'api_server'), 'messaging_enabled')
        inspect = json.loads(command(['docker', 'inspect', container]))[0]
        emit(cron_all_paused=True, messaging_all_disabled=True, image=inspect['Config']['Image'],
             container_user=inspect['Config']['User'], model=cfg['model'],
             mounts=[{'destination': x['Destination'], 'rw': x['RW'], 'type': x['Type']} for x in inspect['Mounts']])
        probe(container, ['id'])
        probe(container, ['ssh', '-o', 'BatchMode=yes', 'thales', 'true'])
        probe(container, ['gh', 'auth', 'status'])
        probe(container, ['git', '-C', str(workspace / 'wizard-os'), 'fetch', '--dry-run'])
        probe(container, ['sh', '-c', 'p="$1/.hermes-import-c-write-$$"; printf probe > "$p" && test "$(cat "$p")" = probe && rm "$p" && test ! -e "$p"', 'probe', str(workspace)])
        probe(container, ['sh', '-c', 'p="$1/.hermes-import-c-refused-$$"; printf probe > "$p"', 'probe', str(context)], expect=None)
        probe(container, ['sh', '-c', 'test ! -e /var/run/docker.sock && test ! -e /run/docker.sock && test ! -e "$HOME/.wizard-os/agents/private"'])
        vps = probe(container, ['ssh', '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=10', '-i', str(owner / '.ssh/id_ed25519'), str(owner.name) + '@' + get('VPS_ADDRESS'), 'true'], expect=255)
        m.require('Permission denied (publickey' in vps.stderr, 'vps_not_proven_auth_refused')
        model_exercise(service, agent, target, model)
        emit(acceptance_C=True)
    finally:
        journal = wizard / 'agents' / agent / 'import-journal.json'
        if journal.exists():
            emit(undo=m.undo(journal))
        if key_may_exist:
            remote_key(host)
        if relay:
            relay.shutdown()
            relay.server_close()
        shutil.rmtree(root)
        after_agents = sorted(a['id'] for a in canary.call(service, '/wizard/v1/agents')['agents'])
        after_hash = m.file_hash(source / 'config.yaml')
        removed = not (wizard / 'agents' / agent).exists()
        absent = not command(['docker', 'ps', '-a', '--filter', 'name=^/' + container + '$', '--format', '{{.Names}}']).strip()
        emit(cleanup_root_absent=not root.exists(), cleanup_agent_directory_absent=removed,
             cleanup_container_absent=absent, agent_list_restored=after_agents == before_agents,
             live_config_sha256=after_hash, live_config_sha256_unchanged=after_hash == before_hash,
             free_bytes_before=before_free, free_bytes_after=shutil.disk_usage(source).free,
             host_services=command(['systemctl', '--user', 'is-active', 'hermes-gateway', 'wizard-mobile']).splitlines())
        m.require(after_hash == before_hash and removed and absent and after_agents == before_agents, 'acceptance_cleanup_failed')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        emit(error=str(exc) if isinstance(exc, m.ImportFailure) else type(exc).__name__)
        sys.exit(1)
