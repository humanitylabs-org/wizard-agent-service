#!/usr/bin/env python3
"""Explicit real Docker + live-Service canary. Never run by npm test.

Set WIZARD_IMPORT_CANARY_ROOT, WIZARD_IMPORT_CANARY_AUTH_HOME and
WIZARD_IMPORT_CANARY_SERVICE, then run with --confirm-live-canary.
All sessions are CREATE -> PATCH hidden -> GET verified before input.
Only access tokens are copied, never refresh grants. All output is allowlisted.
"""
import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SPEC = importlib.util.spec_from_file_location('hermes_import', Path(__file__).parents[1] / 'ops/agent-runtime/hermes_import.py')
assert SPEC and SPEC.loader
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
PREPARING_ROOT = None


def call(origin, path, method='GET', body=None, *, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(origin + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json', **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as exc:
        # Never print arbitrary service/provider responses.
        raise m.ImportFailure('canary_http_' + str(exc.code) + '_' + method + '_' + path.split('?')[0]) from None


def copy_access_only(source, target):
    auth = json.loads((Path(source) / 'auth.json').read_text())
    candidates = auth.get('credential_pool', {}).get('openai-codex', [])
    current = auth.get('providers', {}).get('openai-codex', {}).get('tokens', {})
    tokens = [x.get('access_token') for x in candidates] + [current.get('access_token')]
    for token in tokens:
        if not token or token.count('.') != 2:
            continue
        try:
            payload = token.split('.')[1]
            claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
            if float(claims.get('exp', 0)) < time.time() + 1800:
                continue
        except (ValueError, TypeError):
            continue
        # Structurally stock auth, with no refresh credential anywhere in the copy.
        account_id = claims.get('https://api.openai.com/auth', {}).get('chatgpt_account_id') or current.get('account_id')
        result = {'version': auth.get('version', 1), 'active_provider': 'openai-codex',
                  'providers': {'openai-codex': {'auth_mode': 'oauth', 'tokens': {'access_token': token, 'account_id': account_id}}},
                  'credential_pool': {'openai-codex': [{'id': 'import-canary-access-only', 'label': 'canary',
                     'auth_type': 'oauth', 'priority': 0, 'source': 'device_code', 'access_token': token,
                     'account_id': account_id, 'base_url': 'https://chatgpt.com/backend-api/codex'}]}}
        m.dump(Path(target) / 'auth.json', result)
        return
    raise m.ImportFailure('no_unexpired_access_token_without_refresh')


def fixture(root, auth_home):
    home = root / 'fresh-owner/.hermes'
    home.mkdir(parents=True, mode=0o700)
    cfg = {'model': {'provider': 'openai-codex', 'default': 'codex-auto-review'}, 'memory': {'provider': 'builtin'},
           'agent': {'max_turns': 4}, 'gateway': {'multiplex_profiles': False}, 'plugins': {}}
    (home / 'config.yaml').write_text(json.dumps(cfg))
    (home / 'SOUL.md').write_text('You are Import Canary. For an importer health check, answer IMPORT_OK. Do not call tools unless asked.')
    (home / 'memories').mkdir()
    (home / 'memories/MEMORY.md').write_text('A portable memory: importer-canary-memory.')
    (home / 'skills/canary').mkdir(parents=True)
    (home / 'skills/canary/SKILL.md').write_text('---\nname: canary\ndescription: Import portability probe.\n---\nReply IMPORT_OK when asked to prove identity.')
    (home / 'cron').mkdir()
    m.dump(home / 'cron/jobs.json', {'jobs': [{'id': 'must-not-run', 'name': 'Canary must remain paused', 'enabled': True,
                        'state': 'scheduled', 'schedule': {'kind': 'interval', 'seconds': 1}, 'prompt': 'DO NOT RUN'}]})
    copy_access_only(auth_home, home)
    return home


def hidden_session(service, agent, session):
    suffix = '?agent_id=' + urllib.parse.quote(agent)
    path = '/wizard/hermes/api/sessions/' + urllib.parse.quote(session)
    call(service, '/wizard/hermes/api/sessions' + suffix, 'POST', {'id': session, 'title': 'Importer hidden canary', 'hidden': True, 'agent_id': agent})
    call(service, path + suffix, 'PATCH', {'hidden': True})
    value = call(service, path + suffix)
    m.require(value.get('session', {}).get('hidden') is True, 'canary_not_hidden_fail_closed')
    print(json.dumps({'session': session, 'agent': agent, 'hidden_readback': True}))
    return path + suffix


def exercise(service, agent, home, *, history_id=None, tools=False, model='codex-auto-review', provider='openai-codex'):
    agents = call(service, '/wizard/v1/agents')['agents']
    record = next((a for a in agents if a['id'] == agent), None)
    m.require(record is not None and record['status'] == 'running', 'canary_agent_not_running_in_service')
    print(json.dumps({'agent_discovered': agent, 'status': record['status']}))
    if history_id:
        path = '/wizard/hermes/api/sessions/' + history_id + '/messages?agent_id=' + agent
        history = call(service, path)
        values = history.get('data', history.get('messages', []))
        m.require(bool(values), 'canary_import_history_empty')
        print(json.dumps({'imported_history_visible_through_service': True, 'message_count': len(values)}))
    session = 'wizard_import_' + secrets.token_hex(5)
    hidden_session(service, agent, session)
    if tools:
        build_host = os.environ['WIZARD_IMPORT_BUILD_HOST']
        m.require(__import__('re').fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@:-]*', build_host), 'build_host_invalid')
        prompt = f'Use terminal to run: git --version; gh --version; ssh -o BatchMode=yes -o ConnectTimeout=10 {build_host} true. Report each exit code, then IMPORT_OK.'
    else:
        prompt = 'Reply with exactly IMPORT_OK. Do not call any tools.'
    req = {'session_id': session, 'agent_id': agent, 'input': prompt, 'model': model, 'provider': provider}
    result = call(service, '/wizard/hermes/v1/runs', 'POST', req, headers={'Idempotency-Key': 'import-' + session})
    print(json.dumps({'run_admission_keys': sorted(result)}))
    run_id = result.get('run_id') or result.get('id') or (result.get('run') or {}).get('id')
    m.require(bool(run_id), 'canary_no_run_id')
    end = time.monotonic() + 90
    while time.monotonic() < end:
        time.sleep(2)
        msgs = call(service, '/wizard/hermes/api/sessions/' + session + '/messages?agent_id=' + agent)
        rows = msgs.get('data', msgs.get('messages', []))
        if any(r.get('role') == 'assistant' and 'IMPORT_OK' in str(r.get('content', '')) for r in rows):
            print(json.dumps({'message_through_existing_service': True, 'run_id': run_id, 'reply_marker_verified': True}))
            return session
        state = call(service, '/wizard/hermes/v1/runs/' + str(run_id) + '?agent_id=' + agent)
        if state.get('status') in {'failed', 'cancelled', 'error'}:
            break
    status = call(service, '/wizard/hermes/v1/runs/' + str(run_id) + '?agent_id=' + agent)
    print(json.dumps({'run_status': status.get('status') or status.get('run', {}).get('status'), 'run_error_keys': sorted((status.get('error') or {}).keys()) if isinstance(status.get('error'), dict) else type(status.get('error')).__name__}))
    # Logs can contain source-home data. Emit fixed diagnostic markers only,
    # never provider text or traceback/error lines, even on an auth failure.
    import subprocess
    log_result = subprocess.run(['docker', 'logs', 'agent-' + agent], capture_output=True, text=True)
    logs = (log_result.stdout + log_result.stderr).lower()
    print(json.dumps({'log_markers': [v for v in ['unauthorized', 'not authenticated', 'missing', 'refresh', '401', '403', '404', 'model', 'credential', 'error', 'traceback'] if v in logs]}))
    raise m.ImportFailure('canary_reply_timeout')


def main():
    global PREPARING_ROOT
    parser = argparse.ArgumentParser()
    parser.add_argument('--confirm-live-canary', action='store_true', required=True)
    args = parser.parse_args()
    root = Path(os.environ['WIZARD_IMPORT_CANARY_ROOT']).absolute()
    service = os.environ['WIZARD_IMPORT_CANARY_SERVICE']
    auth_home = Path(os.environ['WIZARD_IMPORT_CANARY_AUTH_HOME'])
    wizard = Path(os.environ['WIZARD_IMPORT_CANARY_WIZARD_HOME'])
    m.require(not root.exists(), 'canary_root_exists')
    root.mkdir(parents=True, mode=0o700)
    PREPARING_ROOT = root
    before = sorted(a['id'] for a in call(service, '/wizard/v1/agents')['agents'])
    home = fixture(root, auth_home)
    archive = root / 'stock-backup.zip'
    # Public stock Hermes CLI, not our exporter, creates the package.
    code = ('import os,pathlib,runpy,sys; os.chdir("/opt/hermes"); '
            'from hermes_state import SessionDB; db=SessionDB(pathlib.Path("/source-owner/.hermes/state.db")); '
            'db.create_session("import-history",source="import-canary"); '
            'db.set_session_hidden("import-history",True); '
            'assert db.get_session("import-history")["hidden"]; '
            'db.append_message("import-history","user","Portable archive history"); db.close(); '
            'sys.argv=["hermes","--ignore-rules","backup","--output","/output/stock-backup.zip"]; '
            'runpy.run_module("hermes_cli.main",run_name="__main__")')
    m.run(['docker', 'run', '--rm', '--network', 'none', '--user', f'{os.getuid()}:{os.getgid()}',
           '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,mode=1777',
           '-e', 'HOME=/source-owner', '-e', 'HERMES_HOME=/source-owner/.hermes', '-e', 'PYTHONDONTWRITEBYTECODE=1',
           '--mount', f'type=bind,src={home.parent},dst=/source-owner', '--mount', f'type=bind,src={root},dst=/output',
           '--entrypoint', '/opt/hermes/.venv/bin/python', m.IMAGE, '-c', code])
    m.require(archive.exists(), 'stock_backup_missing')
    print(json.dumps({'stock_backup_bytes': archive.stat().st_size, 'stock_archive_entries': len(m.archive_entries(archive))}))
    p = m.scan(archive, owner_home=home.parent)
    p.update(network='runtipi_tipi_main_network', gateway_url='http://wizard-agent-service:8923/wizard/mcp', port=18720)
    m.approve(p)
    agent = 'import-fresh-canary'
    result = None
    PREPARING_ROOT = None  # From here, the journalled finally block owns cleanup.
    try:
        result = m.apply(p, agent, wizard)
        print(json.dumps({'apply': result}))
        target = wizard / 'agents' / agent / 'home'
        for rel in ['SOUL.md', 'memories/MEMORY.md', 'skills/canary/SKILL.md']:
            m.require((target / rel).read_bytes() == (home / rel).read_bytes(), 'portable_state_changed_' + rel)
        print(json.dumps({'identity_memory_skill_bytes_preserved': True}))
        exercise(service, agent, target, history_id='import-history')
    finally:
        journal = wizard / 'agents' / agent / 'import-journal.json'
        if journal.exists():
            removed = m.undo(journal)
            print(json.dumps({'undo': removed}))
        try:
            after = sorted(a['id'] for a in call(service, '/wizard/v1/agents')['agents'])
            print(json.dumps({'agent_list_restored': after == before}))
            m.require(after == before, 'canary_orphan_agent')
        finally:
            shutil.rmtree(root)
            print(json.dumps({'canary_data_deleted': not root.exists()}))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        if PREPARING_ROOT is not None:
            shutil.rmtree(PREPARING_ROOT)
        print(json.dumps({'error': str(e) if isinstance(e, m.ImportFailure) else type(e).__name__,
                          'cause_type': type(getattr(e, 'reason', None)).__name__}), file=sys.stderr)
        sys.exit(1)
