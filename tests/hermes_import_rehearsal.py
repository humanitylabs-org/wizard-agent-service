#!/usr/bin/env python3
"""Reduced LIVE-home rehearsal. Copies only the explicit portable allowlist.

The full home cannot be copied on a small control-plane disk. This tool documents
that acceptance exception, snapshots SQLite read-only, never hardlinks live data,
and deletes its reduced copy after apply/undo. No cutover call exists here.
"""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import time

SPEC = importlib.util.spec_from_file_location('hermes_import', Path(__file__).parents[1] / 'ops/agent-runtime/hermes_import.py')
assert SPEC and SPEC.loader
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)

import hermes_import_canary as canary

SOURCE_ITEMS = ['config.yaml', '.env', 'auth.json', 'SOUL.md', 'AGENTS.md', 'memories', 'skills', 'plugins', 'scripts', 'hooks', 'cron', 'bin', 'gateway.json']


def reduced_db(source, dest, days=7):
    """Materialize the last week + parent lineage, never source backup/VACUUM."""
    start = time.monotonic()
    with contextlib.closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=5)) as src, contextlib.closing(sqlite3.connect(dest)) as out:
        out.execute('PRAGMA journal_mode=DELETE')
        names = {x[0] for x in src.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        cap = int(os.environ.get('WIZARD_IMPORT_REHEARSAL_MAX_SESSIONS', '0'))
        m.require(0 <= cap <= 200, 'rehearsal_cap_invalid')
        query = 'SELECT id FROM sessions WHERE started_at >= ? ORDER BY started_at DESC' + (' LIMIT ?' if cap else '')
        args = (time.time() - days * 86400, cap) if cap else (time.time() - days * 86400,)
        ids = {r[0] for r in src.execute(query, args)}
        m.require(bool(ids) and len(ids) <= 20000, 'rehearsal_recent_session_budget')
        current = set(ids)
        while current:
            marks = ','.join('?' * len(current))
            parents = {r[0] for r in src.execute(f'SELECT parent_session_id FROM sessions WHERE id IN ({marks})', list(current)) if r[0]}
            current = parents - ids
            ids.update(current)
        for name in ['sessions', 'messages']:
            sql = src.execute('SELECT sql FROM sqlite_master WHERE type=\'table\' AND name=?', (name,)).fetchone()[0]
            out.execute(sql)
            field = 'id' if name == 'sessions' else 'session_id'
            marks = ','.join('?' * len(ids))
            cursor = src.execute(f'SELECT * FROM {name} WHERE {field} IN ({marks})', list(ids))
            insert = f'INSERT INTO {name} VALUES ({",".join("?" * len(cursor.description))})'
            while batch := cursor.fetchmany(100):
                out.executemany(insert, batch)
                m.require(dest.stat().st_size < 1500 * 1024**2, 'rehearsal_state_limit')
            out.commit()
        # Native runtime will rebuild its own FTS; preserve only compatibility metadata.
        if 'schema_version' in names:
            sql = src.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='schema_version'").fetchone()[0]
            out.execute(sql)
            rows = src.execute('SELECT * FROM schema_version').fetchall()
            if rows:
                out.executemany('INSERT INTO schema_version VALUES (' + ','.join('?' * len(rows[0])) + ')', rows)
        out.commit()
        count = out.execute('SELECT count(*) FROM sessions').fetchone()[0]
        messages = out.execute('SELECT count(*) FROM messages').fetchone()[0]
        integrity = out.execute('PRAGMA integrity_check').fetchone()[0]
    m.require(integrity == 'ok' and dest.stat().st_size < 2 * 1024**3, 'rehearsal_state_invalid')
    return {'sessions': count, 'messages': messages, 'bytes': dest.stat().st_size, 'integrity': integrity, 'seconds': round(time.monotonic() - start, 3), 'lookback_days': days, 'session_cap_exception': cap or None}


def snapshot_small_db(source, dest):
    m.require(source.stat().st_size < 256 * 1024**2, 'fact_store_too_large_for_control_plane')
    with contextlib.closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=5)) as src, contextlib.closing(sqlite3.connect(dest)) as out:
        src.backup(out, pages=256, sleep=0.01)
        m.require(out.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'fact_snapshot_integrity')


def main():
    m.require(sys.argv[1:] == ['--confirm-reduced-rehearsal'], 'explicit_rehearsal_confirmation_required')
    source = Path(os.environ['WIZARD_IMPORT_REHEARSAL_SOURCE']).absolute()
    root = Path(os.environ['WIZARD_IMPORT_REHEARSAL_ROOT']).absolute()
    wizard = Path(os.environ['WIZARD_IMPORT_REHEARSAL_WIZARD_HOME']).absolute()
    image = os.environ.get('WIZARD_IMPORT_REHEARSAL_IMAGE', m.IMAGE)
    m.require(not root.exists(), 'rehearsal_root_exists')
    root.mkdir(parents=True, mode=0o700)
    home = root / 'source-owner/.hermes'
    home.mkdir(parents=True, mode=0o700)
    before_free = shutil.disk_usage(root).free
    source_config_hash = m.file_hash(source / 'config.yaml')
    copied, omitted = [], []
    result = None
    agent = 'archimedes-rehearsal'
    service = os.environ.get('WIZARD_IMPORT_REHEARSAL_SERVICE')
    before_agents = sorted(a['id'] for a in canary.call(service, '/wizard/v1/agents')['agents']) if service else None
    probe_dir = None
    try:
        for name in SOURCE_ITEMS:
            src = source / name
            if not src.exists():
                continue
            if src.is_dir():
                shutil.copytree(src, home / name, symlinks=True, ignore=shutil.ignore_patterns('__pycache__', '.git', 'node_modules', '.venv', '*.lock', '*.pid', 'output', 'logs'))
            elif src.is_file() and not src.is_symlink():
                shutil.copy2(src, home / name)
            copied.append(name)
        for name in ['memory_store.db', 'shared-state.db']:
            src = source / name
            if src.exists():
                snapshot_small_db(src, home / name)
                copied.append(name + ' (read-only SQLite snapshot)')
        # Rehearsal must keep the live main provider and every provider/pool structure.
        # The fresh Codex canary's copy_access_only() intentionally rewrites auth;
        # using it here dropped Anthropic credentials and selected the wrong route.
        def access_only(value):
            if isinstance(value, dict):
                return {k: access_only(v) for k, v in value.items() if 'refresh' not in k.lower()}
            if isinstance(value, list):
                return [access_only(v) for v in value]
            return value
        m.dump(home / 'auth.json', access_only(json.loads((source / 'auth.json').read_text())))
        print(json.dumps({'rehearsal_auth_all_provider_structures_no_refresh_grants': True}))
        omitted = sorted(p.name for p in source.iterdir() if p.name not in SOURCE_ITEMS and p.name not in {'state.db', 'memory_store.db', 'shared-state.db'})
        stats = reduced_db(source / 'state.db', home / 'state.db')
        # Every copied session is hidden BEFORE its runtime can start. No test input
        # is sent here; the separate live canary enforces HTTP create/patch/get.
        with contextlib.closing(sqlite3.connect(home / 'state.db')) as db:
            columns = {r[1] for r in db.execute('PRAGMA table_info(sessions)')}
            if 'hidden' in columns:
                db.execute('UPDATE sessions SET hidden=1')
                db.commit()
                m.require(db.execute('SELECT count(*) FROM sessions WHERE hidden != 1').fetchone()[0] == 0, 'rehearsal_history_not_hidden')
        print(json.dumps({'reduced_state': stats, 'copied_roots': copied, 'omitted_roots': omitted,
                          'full_copy_acceptance_exception': True, 'reason': 'portable allowlist only; full roots require separately approved remote-sized rehearsal storage'}, sort_keys=True))
        # Record passive-state identity before wiring; do not log any memory/history content.
        identities = {rel: m.file_hash(home / rel) for rel in ['SOUL.md', 'memories/MEMORY.md', 'memories/USER.md', 'memory_store.db'] if (home / rel).exists()}
        inode = home.stat().st_ino
        plan = m.scan(home, owner_home=home.parent)
        plan.update(move=True, image=image, network='runtipi_tipi_main_network', port=18721,
                    owner_home=str(source.parent), logical_home=str(source),
                    gateway_url='http://wizard-agent-service:8923/wizard/mcp')
        if template := os.environ.get('WIZARD_IMPORT_REHEARSAL_SELECTIONS'):
            selected = json.loads(Path(template).read_text())
            for key in ['dependencies', 'approved_env_names', 'approved_plugins', 'approved_mcp', 'wizard_assets', 'outside_tools']:
                if key in selected:
                    plan[key] = selected[key]
        if workspace := os.environ.get('WIZARD_IMPORT_REHEARSAL_WORKSPACE'):
            import secrets
            probe_dir = Path(workspace) / ('.hermes-import-rehearsal-' + secrets.token_hex(4))
            probe_dir.mkdir(mode=0o700)
            (probe_dir / 'probe.txt').write_text('host\n')
            plan['dependencies'].append({'kind': 'folder', 'path': str(probe_dir), 'proposal': 'mount rw', 'action': 'mount rw', 'approved': True, 'references': ['rehearsal fixture']})
        m.approve(plan)
        m.dump(root / 'rehearsal-plan.json', plan)
        result = m.apply(plan, agent, wizard)
        print(json.dumps({'rehearsal_apply': result, 'source_pointer_is_directory_not_symlink': home.is_dir() and not home.is_symlink()}))
        target = wizard / 'agents' / agent / 'home'
        m.require(target.stat().st_ino == inode, 'rehearsal_not_atomic_move')
        unchanged = all(m.file_hash(target / rel) == h for rel, h in identities.items())
        with contextlib.closing(sqlite3.connect(target / 'state.db')) as db:
            counts = [db.execute('SELECT count(*) FROM ' + table).fetchone()[0] for table in ['sessions', 'messages']]
        jobs = json.loads((target / 'cron/jobs.json').read_text())
        paused = all(not j.get('enabled', True) and j.get('state') == 'paused' for j in jobs.get('jobs', []) if isinstance(jobs, dict))
        inspect = json.loads(m.run(['docker', 'inspect', 'agent-' + agent]))[0]
        mounts = [{'destination': x['Destination'], 'type': x['Type'], 'source_is_own_home': x.get('Source') == str(target)} for x in inspect['Mounts']]
        allowed = {str(target)} | {str(Path(d['path']).resolve()) for d in plan['dependencies'] if d.get('approved') and d.get('action', d['proposal']) in {'mount ro', 'mount rw'}}
        m.require(all(x.get('Source') in allowed or x['Type'] == 'tmpfs' or Path(x.get('Source', '/')).is_relative_to(target.parent / 'credentials') for x in inspect['Mounts']), 'unexpected_rehearsal_mount')
        m.require(unchanged and counts == [stats['sessions'], stats['messages']] and paused, 'rehearsal_state_drift')
        print(json.dumps({'identity_memory_hashes_unchanged_before_any_message': unchanged,
                          'history_counts_preserved': counts == [stats['sessions'], stats['messages']],
                          'all_cron_paused': paused, 'only_own_home_mounted': mounts,
                          'container_no_host_pid_namespace': inspect['HostConfig']['PidMode'] != 'host',
                          'container_cap_drop_all': inspect['HostConfig']['CapDrop'] == ['ALL']}))
        # Probe tools directly; do not invent gh/SSH success from a model reply.
        import subprocess
        probes = {}
        commands = [['git', '--version'], ['gh', '--version']]
        if build_host := os.environ.get('WIZARD_IMPORT_BUILD_HOST'):
            m.require(__import__('re').fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@:-]*', build_host), 'build_host_invalid')
            commands.append(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', build_host, 'true'])
        else:
            probes['ssh_build_host_not_configured'] = {'exit_code': None, 'available': False}
        for command in commands:
            r = subprocess.run(['docker', 'exec', 'agent-' + agent, *command], capture_output=True, text=True, timeout=20)
            probes[' '.join(command)] = {'exit_code': r.returncode, 'available': r.returncode == 0}
        print(json.dumps({'real_container_tool_probes': probes, 'check_C_not_passed_without_derived_image_and_scoped_credentials': True}))
        seal = subprocess.run(['docker', 'exec', 'agent-' + agent, 'sh', '-c', 'test ! -e /var/run/docker.sock && test ! -e /run/docker.sock && test ! -e "$HOME/.wizard-os/agents/private"'], capture_output=True, timeout=10)
        m.require(seal.returncode == 0 and inspect['HostConfig']['NetworkMode'] != 'host', 'rehearsal_seal_failed')
        print(json.dumps({'private_agent_unreachable': True, 'docker_socket_absent': True, 'no_host_network_namespace': True, 'logical_home': m.logical_home(plan)}))
        if probe_dir:
            probe = probe_dir / 'probe.txt'
            write = subprocess.run(['docker', 'exec', 'agent-' + agent, 'sh', '-c', 'test "$(cat "$1")" = host && printf "container\\n" >> "$1"', 'probe', str(probe)], capture_output=True, timeout=10)
            m.require(write.returncode == 0 and probe.read_text() == 'host\ncontainer\n', 'workspace_read_write_failed')
            print(json.dumps({'approved_workspace_file_read_write': True}))
        recall_code = '''import json,os,pathlib
from plugins.memory.holographic import HolographicMemoryProvider
from tools.skills_tool import skills_list,skill_view
p=HolographicMemoryProvider({'db_path':os.environ['HERMES_HOME']+'/memory_store.db','auto_extract':'false'})
try:
 p.initialize('import-recall')
 count=p._store._conn.execute('SELECT count(*) FROM facts').fetchone()[0]
 row=p._store._conn.execute('SELECT content FROM facts ORDER BY rowid LIMIT 1').fetchone()
 assert row and row[0]
 result=p.handle_tool_call('fact_store',{'action':'search','query':row[0],'limit':5})
 assert row[0] in result
 listing=json.loads(skills_list()); entries=listing['skills']; assert entries
 loaded=skill_view(entries[0]['name'],preprocess=False); assert loaded and 'error' not in json.loads(loaded)
 print(json.dumps({'fact_count':count,'actual_fact_recalled_without_content_logging':True,'skills_loaded':True,'holographic_plugin_loaded':True}))
finally:
 p.shutdown()
'''
        recalled = subprocess.run(['docker', 'exec', 'agent-' + agent, '/opt/hermes/.venv/bin/python', '-c', recall_code], capture_output=True, text=True, timeout=30)
        print(json.dumps({'memory_skill_plugin_probe_exit_code': recalled.returncode}))
        if recalled.returncode == 0:
            value = json.loads(recalled.stdout.strip().splitlines()[-1])
            m.require(type(value.get('fact_count')) is int, 'recall_probe_schema')
            print(json.dumps({'fact_count': value['fact_count'], **{k: value.get(k) is True for k in ['actual_fact_recalled_without_content_logging', 'skills_loaded', 'holographic_plugin_loaded']}}))
        if service:
            model = plan['summary']['model']
            canary.exercise(service, agent, target, model=model['default'], provider=model['provider'])
    finally:
        journal = wizard / 'agents' / agent / 'import-journal.json'
        if journal.exists():
            undone = m.undo(journal)
            print(json.dumps({'rehearsal_undo': undone}))
            m.require(home.exists(), 'rehearsal_source_not_restored')
        m.require(m.file_hash(source / 'config.yaml') == source_config_hash, 'LIVE_CONFIG_CHANGED')
        shutil.rmtree(root)
        if probe_dir:
            shutil.rmtree(probe_dir)
        if service:
            after = sorted(a['id'] for a in canary.call(service, '/wizard/v1/agents')['agents'])
            m.require(after == before_agents, 'rehearsal_orphan_agent')
            print(json.dumps({'rehearsal_agent_list_restored': True}))
        print(json.dumps({'rehearsal_data_deleted': not root.exists(), 'live_config_sha256_unchanged': source_config_hash,
                          'free_bytes_before_copy': before_free, 'free_bytes_after_cleanup': shutil.disk_usage(root.parent).free}))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(json.dumps({'error': str(e) if isinstance(e, m.ImportFailure) else type(e).__name__}), file=sys.stderr)
        sys.exit(1)
