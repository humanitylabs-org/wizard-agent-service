#!/usr/bin/env python3
"""Forum-only synthetic real-Docker schema compatibility proof, no inference.
Run only from a parent-admitted, source-pinned heavy worker stage.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import uuid
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops/agent-runtime'))
import hermes_import as h


def cmd(argv, timeout=180):
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--upstream-contract', type=Path, required=True)
    args = parser.parse_args()
    assert os.environ.get('WIZARD_WORKER_LANE') == 'heavy', 'parent-admitted Forum heavy execution required'
    assert Path.cwd().is_relative_to('/srv/work'), 'Forum stage required'
    evidence = args.evidence
    evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    image = h.IMAGE
    token = uuid.uuid4().hex[:12]
    names = []
    report = {'status': 'failed', 'image': image, 'synthetic_only': True, 'inference': False,
              'phases': [], 'cleanup_errors': [], 'owner_history_read': False,
              'schema_floor_31_satisfied': False, 'runtime_adoption_ready': False}
    scratch = Path(tempfile.mkdtemp(prefix='schema-docker-'))
    before_probes = set(h.run(['docker', 'ps', '-aq', '--filter', 'name=^/wizard-import-schema-']).splitlines())
    before_volumes = set(h.run(['docker', 'volume', 'ls', '-q']).splitlines())

    def run_image(phase, home, code, expected_exit=0):
        name = 'wizard-schema-proof-' + token + '-' + phase
        names.append(name)
        argv = ['docker', 'create', '--name', name, '--network', 'none', '--read-only',
                '--user', f'{os.getuid()}:{os.getgid()}', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges:true', '--pids-limit', '128', '--memory', '1g',
                '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m,mode=1777',
                '--mount', f'type=bind,src={home},dst=/opt/data',
                '-e', 'HOME=/opt/data', '-e', 'HERMES_HOME=/opt/data', '-e', 'PYTHONDONTWRITEBYTECODE=1',
                '--entrypoint', '/opt/hermes/.venv/bin/python', image, '-c', code]
        created = cmd(argv)
        assert created.returncode == 0, created.stderr
        inspected = json.loads(h.run(['docker', 'inspect', name]))[0]
        assert inspected['HostConfig']['NetworkMode'] == 'none'
        assert inspected['HostConfig']['ReadonlyRootfs']
        assert all(m['Type'] == 'bind' and m['Source'] == str(home) for m in inspected['Mounts']), 'unexpected mount/anonymous volume'
        (evidence / (phase + '.inspect.json')).write_text(json.dumps(inspected, indent=2) + '\n')
        p = cmd(['docker', 'start', '-a', name])
        (evidence / (phase + '.stdout')).write_text(p.stdout)
        (evidence / (phase + '.stderr')).write_text(p.stderr)
        state = json.loads(h.run(['docker', 'inspect', name]))[0]['State']
        (evidence / (phase + '.state.json')).write_text(json.dumps(state, indent=2) + '\n')
        assert not state['Running'] and state['ExitCode'] == expected_exit, (phase, state, p.stderr)
        value = json.loads(p.stdout.strip().splitlines()[-1])
        report['phases'].append({'name': phase, 'container_exit': state['ExitCode'], 'observation': value})
        return value

    create = '''import json,sqlite3
from hermes_state import SessionDB
p='/opt/data/state.db'
db=SessionDB(p)
db.create_session('schema-proof','cli')
db.append_message('schema-proof','user','synthetic prompt')
db.append_message('schema-proof','assistant','synthetic answer')
assert [m['content'] for m in db.get_messages('schema-proof')]==['synthetic prompt','synthetic answer']
db.close()
c=sqlite3.connect(p)
v=c.execute('SELECT version FROM schema_version').fetchall()
assert v==[(30,)], v
assert c.execute('PRAGMA integrity_check').fetchall()==[('ok',)]
c.close()
print(json.dumps({'schema':30,'content_roundtrip':True,'integrity':'ok'}))
'''
    upgrade = '''import json,sqlite3
c=sqlite3.connect('/opt/data/state.db')
assert c.execute('SELECT version FROM schema_version').fetchall()==[(30,)]
assert 'message_uid' not in [r[1] for r in c.execute('PRAGMA table_info(messages)')]
# Exact v31 column/backfill delta, synthetic only. No upstream code is patched.
c.execute('ALTER TABLE messages ADD COLUMN message_uid TEXT')
c.execute('UPDATE messages SET message_uid = lower(hex(randomblob(16))) WHERE message_uid IS NULL')
c.execute('UPDATE schema_version SET version=31')
c.commit()
uids=[r[0] for r in c.execute('SELECT message_uid FROM messages ORDER BY id')]
assert len(uids)==2 and len(set(uids))==2 and all(uids)
c.close()
print(json.dumps({'synthetic_schema':31,'exact_v31_column_and_backfill':True,'message_uids':uids}))
'''
    reopen = '''import json,sqlite3
from hermes_state import SessionDB
p='/opt/data/state.db'
db=SessionDB(p)
rows=db.get_messages('schema-proof')
assert [m['content'] for m in rows]==['synthetic prompt','synthetic answer']
db.append_message('schema-proof','user','synthetic append')
rows=db.get_messages('schema-proof')
assert rows[-1]['content']=='synthetic append'
db.replace_messages('schema-proof', rows)
db.close()
db=SessionDB(p)
assert len(db.get_messages('schema-proof'))==3
db.close()
c=sqlite3.connect(p)
version=c.execute('SELECT version FROM schema_version').fetchall()
assert version==[(30,)]
assert c.execute('PRAGMA integrity_check').fetchall()==[('ok',)]
c.close()
print(json.dumps({'schema':30,'read_append_replace_restart':True,'integrity':'ok'}))
'''
    unsafe = '''import json,sqlite3
from hermes_state import SessionDB
p='/opt/data/state.db'
c=sqlite3.connect(p)
before=[r[0] for r in c.execute('SELECT message_uid FROM messages ORDER BY id')]
c.close()
assert len(before)==2 and all(before)
db=SessionDB(p)
rows=db.get_messages('schema-proof')
assert [m['content'] for m in rows]==['synthetic prompt','synthetic answer']
db.append_message('schema-proof','user','synthetic append')
db.replace_messages('schema-proof',db.get_messages('schema-proof'))
db.close()
c=sqlite3.connect(p)
after=[r[0] for r in c.execute('SELECT message_uid FROM messages ORDER BY id')]
version=c.execute('SELECT version FROM schema_version').fetchall()
integrity=c.execute('PRAGMA integrity_check').fetchall()
c.close()
print(json.dumps({'schema_marker':version,'before_message_uids':before,'after_message_uids':after,'integrity':integrity,'expected_negative':'durable_identity_not_preserved'}),flush=True)
# Exact consequential negative: ordinary old-runtime writes lose the v31 identities
# while the higher marker remains. Do not call this physical SQLite corruption.
assert version==[(31,)] and integrity==[('ok',)] and len(after)==3 and all(v is None for v in after)
raise SystemExit(17)
'''
    def snapshot(home):
        return {p.name: {'inode': p.stat().st_ino, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
                for p in home.iterdir() if p.is_file()}
    try:
        report['image_inspect'] = json.loads(h.run(['docker', 'image', 'inspect', image]))[0]
        digest = image.split('@', 1)[1]
        assert any(x.endswith('@' + digest) for x in report['image_inspect']['RepoDigests'])
        target = h.DockerRuntime({'image': image}, scratch, 'fixture').history_schema_version()
        assert target == 30
        report['fresh_target_schema'] = target
        equal = scratch / 'equal'
        equal.mkdir()
        contract = json.loads(args.upstream_contract.read_text())
        source_check = ('import hashlib,json; from pathlib import Path; expected=' + repr(contract['source_sha256']) + '; '
                        'observed={name:hashlib.sha256((Path("/opt/hermes")/name).read_bytes()).hexdigest() for name in expected}; '
                        'print(json.dumps({"source_sha256":observed}),flush=True); assert observed==expected')
        run_image('image-source', equal, source_check)
        run_image('equal-create', equal, create)
        h.DockerRuntime({'image': image}, scratch, 'fixture').check_history(equal)
        run_image('equal-roundtrip', equal, reopen)
        owner = scratch / 'owner'
        newer = owner / '.hermes'
        newer.mkdir(parents=True)
        (newer / 'config.yaml').write_text('model:\n  provider: synthetic\n  default: synthetic\n')
        run_image('newer-create', newer, create)
        run_image('newer-synthetic31', newer, upgrade)
        # Keep the negative on a separate synthetic copy; never mutate the refused source.
        negative = scratch / 'unguarded'
        shutil.copytree(newer, negative)
        run_image('unguarded-write-negative', negative, unsafe, 17)
        before = snapshot(newer)
        factory = lambda *a: h.DockerRuntime(*a)  # real adapter; no fake Docker transport or runtime
        refused = []
        for kind in ('move', 'archive'):
            source = newer
            archive_before = None
            if kind == 'archive':
                source = owner / 'synthetic.zip'
                with zipfile.ZipFile(source, 'w') as z:
                    for p in newer.iterdir():
                        if p.is_file():
                            z.write(p, p.name)
                archive_before = hashlib.sha256(source.read_bytes()).hexdigest()
            plan = h.scan(source, owner_home=owner)
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                port = listener.getsockname()[1]
            plan.update(move=kind == 'move', gateway_url='http://edge:8923/wizard/mcp', network='bridge', port=port)
            h.approve(plan)
            agent_id = 'schema-' + token + '-' + kind
            wizard = scratch / ('wizard-' + kind)
            try:
                h.apply(plan, agent_id, wizard, runtime_factory=factory)
            except h.ImportFailure as exc:
                assert str(exc) == 'history_schema_newer_than_runtime', str(exc)
            else:
                raise AssertionError('newer history was not refused')
            assert snapshot(newer) == before
            if kind == 'archive':
                assert hashlib.sha256(source.read_bytes()).hexdigest() == archive_before
            journal = wizard / 'agents' / agent_id / 'import-journal.json'
            value = json.loads(journal.read_text())
            assert value['moved'] is False and not value['quarantined'] and not value['backups']
            assert not (newer / 'WIZARD-IMPORTED.json').exists()
            assert not h.run(['docker', 'ps', '-aq', '--filter', 'name=^/agent-' + agent_id + '$'])
            (evidence / (kind + '.journal.json')).write_text(json.dumps(value, indent=2) + '\n')
            h.undo(journal, runtime_factory=factory)
            assert snapshot(newer) == before
            refused.append(kind)
        report['refusal_paths'] = refused
        report['source_snapshot_before_after'] = before
        report['status'] = 'passed'
    finally:
        for name in names:
            try:
                remaining = h.run(['docker', 'ps', '-aq', '--filter', 'name=^/' + name + '$'])
                if remaining:
                    h.run(['docker', 'rm', '-f', '-v', name])
                assert not h.run(['docker', 'ps', '-aq', '--filter', 'name=^/' + name + '$'])
            except Exception as error:
                report['cleanup_errors'].append(str(error))
        # A failed product probe may leave a named helper. Scope removal to new IDs only.
        try:
            remaining = set(h.run(['docker', 'ps', '-aq', '--filter', 'name=^/wizard-import-schema-']).splitlines())
            for cid in remaining - before_probes:
                h.run(['docker', 'rm', '-f', '-v', cid])
            assert set(h.run(['docker', 'ps', '-aq', '--filter', 'name=^/wizard-import-schema-']).splitlines()) == before_probes
        except Exception as error:
            report['cleanup_errors'].append(str(error))
        try:
            assert set(h.run(['docker', 'volume', 'ls', '-q']).splitlines()) == before_volumes, 'Docker volume census changed'
            report['docker_volume_census_unchanged'] = True
        except Exception as error:
            report['cleanup_errors'].append(str(error))
        shutil.rmtree(scratch)
        report['scratch_removed'] = not scratch.exists()
        report['all_test_containers_removed'] = not report['cleanup_errors']
        if report['cleanup_errors']:
            report['status'] = 'failed'
        report['artifact_sha256'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in evidence.iterdir() if p.is_file()}
        (evidence / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
    assert report['status'] == 'passed'


if __name__ == '__main__':
    main()
