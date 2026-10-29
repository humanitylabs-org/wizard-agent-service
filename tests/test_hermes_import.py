"""Bring your Hermes contract tests: no network, native home or host services."""
import contextlib
import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
import zipfile
import yaml
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('hermes_import', Path(__file__).parents[1] / 'ops/agent-runtime/hermes_import.py')
assert SPEC and SPEC.loader
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class FakeRuntime:
    live = set()
    fail = False
    def __init__(self, plan, directory, agent_id):
        self.plan, self.directory, self.id = plan, Path(directory), agent_id
    def import_archive(self, archive):
        with zipfile.ZipFile(archive) as z:
            z.extractall(self.directory / 'home')  # Library validated/sanitized the envelope first.
    def start(self):
        self.live.add(self.id)
    def healthy(self, key):
        if self.fail:
            raise m.ImportFailure('fixture_health_failure')
    def remove(self):
        self.live.discard(self.id)


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'])
        self.root = Path(self.tmp.name)
        self.owner = self.root / 'owner'
        self.home = self.owner / '.hermes'
        self.wizard = self.owner / '.wizard-os'
        self.home.mkdir(parents=True)
        self.wizard.mkdir()
        self.env = patch.dict(os.environ, {'HOME': str(self.owner), 'HERMES_HOME': str(self.home),
                                          'WIZARD_OS_HOME': str(self.wizard), 'TMPDIR': str(self.root)})
        self.env.start()
        self.census_real = m.assert_no_writers
        self.census = patch.object(m, 'assert_no_writers')
        self.census.start()
        (self.home / 'config.yaml').write_text('model:\n  provider: openai-codex\n  default: fixture-model\nterminal:\n  backend: ssh\ngateway:\n  platforms:\n    telegram:\n      enabled: true\nmemory:\n  provider: holographic\nmcp_servers:\n  old:\n    command: /host/special\n')
        (self.home / '.env').write_text('TELEGRAM_BOT_TOKEN=fixture-secret\nOPENAI_API_KEY=fixture-provider\nWIZARD_ADMIN_KEY=fixture-host-power\n')
        (self.home / 'cron').mkdir()
        m.dump(self.home / 'cron/jobs.json', {'jobs': [{'id': 'one', 'enabled': True, 'state': 'scheduled'}]})
        (self.home / 'skills/sample').mkdir(parents=True)
        (self.home / 'skills/sample/SKILL.md').write_text('Use /work/project with /usr/bin/gh and ~/.ssh/config')
        (self.home / 'SOUL.md').write_text('Identity stays intact')
        FakeRuntime.live.clear()
        FakeRuntime.fail = False
    def tearDown(self):
        self.census.stop()
        self.env.stop()
        self.tmp.cleanup()
    def plan(self):
        p = m.scan(self.home, owner_home=self.owner)
        p.update(move=True, gateway_url='http://service:8923/wizard/mcp', network='fixture')
        for grant in p['credentials']:
            if grant['item'] in {'OPENAI_API_KEY', 'TELEGRAM_BOT_TOKEN'}:
                grant['approved'] = True
        return m.approve(p)
    def apply(self, p=None):
        return m.apply(p or self.plan(), 'fixture-agent', self.wizard, runtime_factory=FakeRuntime)
    def undo(self, result):
        return m.undo(result['journal'], runtime_factory=FakeRuntime)
    def host_fixture(self):
        for rel in ['data/apps/inbox/data', 'hermes-agent/venv/bin/python', 'scripts/host.sh', 'state/host/data']:
            p = self.home / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('host fixture: ' + rel)
        return m.approve(dict(self.plan(), host_shared_paths=['scripts', 'state/host']))

    def tree_identity(self):
        return {'.': (self.home.stat().st_ino, None), **{
            p.relative_to(self.home).as_posix(): (p.lstat().st_ino, p.read_bytes() if p.is_file() else None)
            for p in self.home.rglob('*')}}

    def test_host_shared_move_keeps_host_inodes_and_bytes(self):
        plan = self.host_fixture()
        before = self.tree_identity()
        result = self.apply(plan)
        for rel in ['data/apps', 'data/apps/inbox/data', 'hermes-agent', 'hermes-agent/venv/bin/python', 'scripts', 'state/host/data']:
            p = self.home / rel
            self.assertTrue(p.exists(), rel)
            self.assertEqual((p.stat().st_ino, p.read_bytes() if p.is_file() else None), before[rel])
        self.assertEqual((self.home / 'data').stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.home / 'state').stat().st_mode & 0o777, 0o700)
        self.undo(result)
        self.assertEqual(self.tree_identity(), before)

    def test_host_shared_absent_from_sealed_home_and_mounts(self):
        plan = self.host_fixture()
        for rel in ['data/apps', 'hermes-agent', 'scripts', 'state/host']:
            mounted = m.approve(dict(plan, dependencies=[{'kind': 'folder', 'path': str(self.home / rel),
                'proposal': 'mount ro', 'action': 'mount ro', 'approved': True}]))
            with self.assertRaisesRegex(m.ImportFailure, 'home_mount_override|mount_sealed'):
                m.validate_plan(mounted, self.wizard)
        result = self.apply(plan)
        directory = self.wizard / 'agents/fixture-agent'
        for rel in ['data/apps', 'hermes-agent', 'scripts', 'state/host']:
            self.assertFalse((directory / 'home' / rel).exists(), rel)
            self.assertFalse((directory / 'quarantine' / rel).exists(), rel)
        with patch.object(m, 'run', return_value='') as called:
            m.DockerRuntime(plan, directory, 'fixture-agent').start()
        args = called.call_args.args[0]
        mounts = [args[i + 1] for i, a in enumerate(args[:-1]) if a == '--mount']
        self.assertFalse(any('src=' + str(self.home) in x for x in mounts))
        self.undo(result)

    def test_host_shared_writer_allowed_but_state_db_writer_refused(self):
        import subprocess
        plan = self.host_fixture()
        for rel in ['data/apps-other/file', 'cron/writer', 'sessions/writer', 'memories/writer', 'skills/writer']:
            p = self.home / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('agent fixture')
        for rel, blocked in [('data/apps/inbox/data', False), ('scripts/host.sh', False), ('state/host/data', False),
                             ('state.db', True), ('data/apps-other/file', True), ('cron/writer', True),
                             ('sessions/writer', True), ('memories/writer', True), ('skills/writer', True)]:
            with self.subTest(rel=rel):
                child = subprocess.Popen([sys.executable, '-c',
                    'import sys,time; f=open(sys.argv[1],"a"); print("ready",flush=True); time.sleep(30)',
                    str(self.home / rel)], stdout=subprocess.PIPE, text=True)
                try:
                    assert child.stdout is not None
                    self.assertEqual(child.stdout.readline().strip(), 'ready')
                    # Exercise both /proc fd names and the fail-closed lease
                    # fallback used for non-dumpable systemd service processes.
                    selected = m.host_shared_paths(plan)
                    real_iterdir = Path.iterdir
                    def denied(path):
                        if path == Path('/proc') / str(child.pid) / 'fd':
                            raise PermissionError('fixture denied')
                        return real_iterdir(path)
                    with patch.object(Path, 'iterdir', denied):
                        if blocked:
                            with self.assertRaisesRegex(m.ImportFailure, 'source_has_writers'):
                                self.census_real(self.home, host_shared=selected, _pids=[child.pid])
                        else:
                            self.census_real(self.home, host_shared=selected, _pids=[child.pid])
                    with patch.object(m, 'assert_no_writers', lambda source, **kw: self.census_real(source, _pids=[child.pid], **kw)):
                        if blocked:
                            with self.assertRaisesRegex(m.ImportFailure, 'source_has_writers'):
                                self.apply(plan)
                        else:
                            result = self.apply(plan)
                finally:
                    child.terminate(); child.wait()
                    if child.stdout is not None:
                        child.stdout.close()
                    journal = self.wizard / 'agents/fixture-agent/import-journal.json'
                    if journal.exists():
                        self.undo({'journal': str(journal)})
                plan = m.approve(dict(self.plan(), host_shared_paths=['scripts', 'state/host']))

    def test_host_shared_undo_crash_between_renames_exact_tree(self):
        plan = self.host_fixture()
        before = self.tree_identity()
        real_rename = Path.rename
        count = [0]
        def crash(src, dst):
            value = real_rename(src, dst)
            if Path(dst) == self.home / 'data/apps':
                count[0] += 1
                raise SystemExit('host-shared-rename-crash')
            return value
        with patch.object(Path, 'rename', crash):
            with self.assertRaisesRegex(SystemExit, 'host-shared-rename-crash'):
                self.apply(plan)
        self.assertEqual(count[0], 1)
        self.undo({'journal': str(self.wizard / 'agents/fixture-agent/import-journal.json')})
        self.assertEqual(self.tree_identity(), before)
        # All shared intent/completion writes, plus undo death after the actual
        # reverse rename (before completion is durable), must reconcile too.
        original_dump = m.dump
        writes = []
        def count_writes(path, value):
            original_dump(path, value)
            if Path(path).name == 'import-journal.json':
                writes.append(1)
        with patch.object(m, 'dump', count_writes):
            result = self.apply(plan)
        self.undo(result)
        for boundary in range(1, len(writes) + 1):
            with self.subTest(boundary=boundary):
                seen = [0]
                def crash_write(path, value):
                    original_dump(path, value)
                    if Path(path).name == 'import-journal.json':
                        seen[0] += 1
                        if seen[0] == boundary:
                            raise SystemExit('journal-crash')
                with patch.object(m, 'dump', crash_write), self.assertRaises(SystemExit):
                    self.apply(plan)
                self.undo({'journal': str(self.wizard / 'agents/fixture-agent/import-journal.json')})
                self.assertEqual(self.tree_identity(), before)
        for rel in ['data/apps', 'hermes-agent', 'scripts', 'state/host']:
            with self.subTest(undo_crash=rel):
                result = self.apply(plan)
                def crash_undo(src, dst):
                    value = real_rename(src, dst)
                    if src == self.home / rel:
                        raise SystemExit('undo-rename-crash')
                    return value
                with patch.object(Path, 'rename', crash_undo), self.assertRaises(SystemExit):
                    self.undo(result)
                self.undo(result)
                self.assertEqual(self.tree_identity(), before)

    def test_host_shared_invalid_paths_rejected(self):
        self.host_fixture()
        for rel in ['state.db', 'memories', 'skills', 'sessions', 'cron', 'config.yaml', '.env',
                    '.', '..', '../outside', '/absolute', 'state/../skills', 'missing', 'data/../../outside', 'scripts//host.sh']:
            with self.subTest(rel=rel):
                p = m.approve(dict(self.plan(), host_shared_paths=[rel]))
                with self.assertRaisesRegex(m.ImportFailure, 'host_shared'):
                    m.validate_plan(p, self.wizard)
        for value in ['scripts', [1], None]:
            with self.subTest(value=value), self.assertRaisesRegex(m.ImportFailure, 'host_shared'):
                m.validate_plan(m.approve(dict(self.plan(), host_shared_paths=value)), self.wizard)
        alias = self.home / 'alias'
        alias.symlink_to(self.home / 'skills', target_is_directory=True)
        with self.assertRaisesRegex(m.ImportFailure, 'host_shared'):
            m.validate_plan(m.approve(dict(self.plan(), host_shared_paths=['alias'])), self.wizard)

        p = self.host_fixture()
        p['host_shared_paths'].append('data')
        with self.assertRaisesRegex(m.ImportFailure, 'plan_not_approved'):
            m.validate_plan(p, self.wizard)

    def test_credential_named_documentation_is_not_a_secret_file(self):
        d = self.home / 'skills/agent-credential-provisioning'
        d.mkdir(parents=True)
        (d / 'SKILL.md').write_text('Useful public procedures, no credentials.')
        (self.home / 'scripts').mkdir()
        (self.home / 'scripts/auth_watchdog.py').write_text('# Procedure, not a credential\n')
        plan = self.plan()
        self.assertFalse(any(c['path'].startswith(('skills/', 'scripts/')) for c in plan['credentials']))
        result = self.apply(plan)
        target = self.wizard / 'agents/fixture-agent/home'
        self.assertTrue((target / 'skills/agent-credential-provisioning/SKILL.md').exists())
        self.assertTrue((target / 'scripts/auth_watchdog.py').exists())
        self.undo(result)

    def test_credentials_deny_by_default_and_multiline_no_tail(self):
        (self.home / 'credentials').mkdir()
        (self.home / 'credentials/host-authority.json').write_text('{"token":"fake-host"}')
        (self.home / '.anthropic_oauth.json').write_text('{"access_token":"fake-oauth"}')
        (self.home / 'auth.json').write_text(json.dumps({'version': 1, 'providers': {'anthropic': {'token': 'fake-a'}, 'openai-codex': {'token': 'fake-b'}}, 'credentials': {'anthropic': [{'token': 'fake-pool'}]}}))
        (self.home / '.env').write_text('ODD_NAME="first\nsecret-tail"\nOPENAI_API_KEY=fake-c\n')
        p = m.scan(self.home, owner_home=self.owner)
        p.update(move=True, gateway_url='http://service:8923/wizard/mcp', network='fixture')
        self.assertTrue(all(c['approved'] is False for c in p['credentials']))
        self.assertNotIn('secret-tail', json.dumps(p))
        for c in p['credentials']:
            if c['kind'] == 'auth-provider' and c['item'] == 'providers:anthropic':
                c['approved'] = True
        m.approve(p)
        before = {str(x.relative_to(self.home)): x.read_bytes() for x in self.home.rglob('*') if x.is_file()}
        result = self.apply(p)
        target = self.wizard / 'agents/fixture-agent/home'
        self.assertFalse((target / '.anthropic_oauth.json').exists())
        self.assertFalse((target / 'credentials/host-authority.json').exists())
        self.assertNotIn('secret-tail', (target / '.env').read_text())
        auth = json.loads((target / 'auth.json').read_text())
        self.assertEqual(set(auth['providers']), {'anthropic'})
        self.assertEqual(auth['credentials'], {})
        self.undo(result)
        for rel, data in before.items():
            self.assertEqual((self.home / rel).read_bytes(), data)

    def test_forbidden_nested_config_authority_cannot_be_approved(self):
        config = m.load_yaml((self.home / 'config.yaml').read_text())
        config['env'] = {'WIZARD_HEAVY_TOKEN': 'fixture-not-a-real-authority'}
        (self.home / 'config.yaml').write_text(m.yaml.safe_dump(config))
        plan = self.plan()
        for entry in plan['credentials']:
            if entry['kind'] == 'config-field': entry['approved'] = True
        with self.assertRaisesRegex(m.ImportFailure, 'inline_credentials_require_secret_store'):
            self.apply(m.approve(plan))
        self.assertFalse((self.wizard / 'agents').exists())
        self.assertEqual(m.load_yaml((self.home / 'config.yaml').read_text()), config)

    def test_corrupt_backup_fails_before_any_rollback_mutation(self):
        result = self.apply()
        directory = self.wizard / 'agents/fixture-agent'
        (directory / 'originals/config.yaml').write_text('corrupt')
        current = (directory / 'home/config.yaml').read_bytes()
        with self.assertRaisesRegex(m.ImportFailure, 'backup_corrupt'):
            self.undo(result)
        self.assertTrue((directory / 'agent.json').exists())
        self.assertEqual((directory / 'home/config.yaml').read_bytes(), current)

    def test_crash_during_backup_never_publishes_partial(self):
        before = (self.home / 'config.yaml').read_bytes()
        real_copy = m.shutil.copy2
        def broken(src, dst, *args, **kwargs):
            if '.partial-' in str(dst):
                Path(dst).write_bytes(b'bad')
                raise SystemExit('simulated-crash')
            return real_copy(src, dst, *args, **kwargs)
        with patch.object(m.shutil, 'copy2', side_effect=broken):
            with self.assertRaises(SystemExit):
                self.apply()
        self.undo({'journal': str(self.wizard / 'agents/fixture-agent/import-journal.json')})
        self.assertEqual((self.home / 'config.yaml').read_bytes(), before)

    def test_crash_at_each_apply_journal_write_restores_exact_files(self):
        # Repeat a fresh fixture at every durable intent/completion boundary.
        original_dump = m.dump
        writes = []
        def count(path, value):
            original_dump(path, value)
            if Path(path).name == 'import-journal.json':
                writes.append(1)
        with patch.object(m, 'dump', side_effect=count):
            result = self.apply()
        self.undo(result)
        for step in range(1, len(writes) + 1):
            with self.subTest(step=step):
                before = {str(x.relative_to(self.home)): x.read_bytes() for x in self.home.rglob('*') if x.is_file()}
                counter = [0]
                def crash(path, value):
                    original_dump(path, value)
                    if Path(path).name == 'import-journal.json':
                        counter[0] += 1
                        if counter[0] == step:
                            raise SystemExit('crash')
                with patch.object(m, 'dump', side_effect=crash), self.assertRaises(SystemExit):
                    self.apply()
                self.undo({'journal': str(self.wizard / 'agents/fixture-agent/import-journal.json')})
                after = {str(x.relative_to(self.home)): x.read_bytes() for x in self.home.rglob('*') if x.is_file()}
                self.assertEqual(after, before)

    def test_scan_names_only_classifies_references(self):
        p = self.plan()
        self.assertNotIn('fixture-secret', json.dumps(p))
        self.assertNotIn('fixture-provider', json.dumps(p))
        self.assertEqual(p['summary']['cron_enabled'], 1)
        self.assertEqual(p['summary']['skills'], 1)
        self.assertEqual(p['summary']['memory_provider'], 'holographic')
        self.assertIn('TELEGRAM_BOT_TOKEN', p['summary']['credential_names'])
        self.assertTrue(any(i['path'] == '/work/project' and i['references'] == ['skills/sample/SKILL.md:1'] for i in p['dependencies']))
        self.assertTrue(any(i['kind'] == 'host-service' for i in p['dependencies']))
    def test_runtime_mounts_synthetic_identity_and_undo_removes_it(self):
        p = self.plan()
        result = self.apply(p)
        directory = self.wizard / 'agents/fixture-agent'
        runtime = m.DockerRuntime(p, directory, 'fixture-agent')
        with patch.object(m, 'run', return_value='') as called:
            runtime.start()
        argv = called.call_args.args[0]
        mounts = [argv[i + 1] for i, arg in enumerate(argv[:-1]) if arg == '--mount']
        self.assertTrue(any('dst=/etc/passwd,readonly' in x for x in mounts))
        self.assertTrue(any('dst=/etc/group,readonly' in x for x in mounts))
        rows = (directory / 'runtime-identity/passwd').read_text().splitlines()
        self.assertTrue(any(row.split(':')[2] == str(os.getuid()) and row.split(':')[5] == str(self.owner) for row in rows))
        self.assertTrue(all(row.split(':')[1] == 'x' for row in rows))
        self.undo(result)
        self.assertFalse(directory.exists())

    def test_scan_closes_sqlite_reader_before_writer_census(self):
        import sqlite3
        with contextlib.closing(sqlite3.connect(self.home / 'state.db')) as db:
            db.execute('CREATE TABLE sessions (id TEXT)')
            db.commit()
        connections = []
        real_connect = m.sqlite3.connect
        def tracked(*args, **kwargs):
            connection = real_connect(*args, **kwargs)
            connections.append(connection)
            return connection
        with patch.object(m.sqlite3, 'connect', side_effect=tracked):
            self.plan()
        self.assertTrue(connections)
        for connection in connections:
            with self.assertRaises(sqlite3.ProgrammingError):
                connection.execute('SELECT 1')

    def test_scoped_credential_source_preserves_logical_destination(self):
        ssh = self.owner / '.ssh'
        ssh.mkdir()
        (ssh / 'owner-key').write_text('must never be carried')
        scoped = self.owner / 'scoped-ssh'
        scoped.mkdir()
        (scoped / 'config').write_text('Host build-only\n')
        p = self.plan()
        p['dependencies'] = [{'kind': 'credential', 'path': str(ssh), 'credential_source': str(scoped),
                              'proposal': 'carry secret', 'action': 'carry secret', 'approved': True, 'approved_files': ['config']}]
        m.approve(p)
        result = self.apply(p)
        carried = self.wizard / 'agents/fixture-agent/credentials' / m.digest(str(ssh))
        self.assertEqual(sorted(x.name for x in carried.iterdir()), ['config'])
        self.undo(result)
        self.assertTrue((ssh / 'owner-key').exists())
        self.assertTrue(scoped.exists())

    def test_scoped_credential_source_is_approval_bound_and_sealed(self):
        ssh = self.owner / '.ssh'
        ssh.mkdir()
        scoped = self.owner / 'scoped-ssh'
        scoped.mkdir()
        p = self.plan()
        item = {'kind': 'credential', 'path': str(ssh), 'credential_source': str(scoped),
                'proposal': 'carry secret', 'approved': True}
        p['dependencies'] = [item]
        m.approve(p)
        item['credential_source'] = str(self.wizard)
        with self.assertRaisesRegex(m.ImportFailure, 'plan_not_approved'):
            m.validate_plan(p, self.wizard)
        m.approve(p)
        with self.assertRaisesRegex(m.ImportFailure, 'mount_sealed'):
            m.validate_plan(p, self.wizard)
        item['credential_source'] = str(scoped)
        item['kind'] = 'folder'
        m.approve(p)
        with self.assertRaisesRegex(m.ImportFailure, 'credential_source_action'):
            m.validate_plan(p, self.wizard)

    def test_approval_bound_to_every_selection(self):
        p = self.plan()
        p['port'] += 1
        with self.assertRaisesRegex(m.ImportFailure, 'plan_not_approved'):
            self.apply(p)
    def test_source_change_fails_before_side_effect(self):
        p = self.plan()
        (self.home / 'config.yaml').write_text('{}')
        with self.assertRaisesRegex(m.ImportFailure, 'source_changed'):
            self.apply(p)
        self.assertFalse((self.wizard / 'agents').exists())
    def test_refuses_sealed_parent_and_alias_mounts(self):
        private = self.wizard / 'agents/private/home'
        private.mkdir(parents=True)
        alias = self.root / 'alias'
        alias.symlink_to(self.wizard, target_is_directory=True)
        for path in [self.wizard, private, self.owner, self.root, alias, Path('/var/run')]:
            with self.subTest(path=path), self.assertRaises(m.ImportFailure):
                m.safe_mount(path, owner_home=self.owner, wizard_home=self.wizard, source=self.home)
    def test_refuses_nested_wizard_or_private_symlink(self):
        workspace = self.owner / 'workspace'
        workspace.mkdir()
        (workspace / '.wizard-os').mkdir()
        with self.assertRaisesRegex(m.ImportFailure, 'mount_contains_wizard'):
            m.safe_mount(workspace, owner_home=self.owner, wizard_home=self.wizard, source=self.home)
        (workspace / '.wizard-os').rmdir()
        (workspace / 'leak').symlink_to(self.wizard)
        with self.assertRaisesRegex(m.ImportFailure, 'mount_sealed_symlink'):
            m.safe_mount(workspace, owner_home=self.owner, wizard_home=self.wizard, source=self.home)
    def test_move_wiring_pauses_and_undo_exact_bytes_inode(self):
        originals = {str(p.relative_to(self.home)): p.read_bytes() for p in self.home.rglob('*') if p.is_file()}
        inode = self.home.stat().st_ino
        (self.home / 'bin').mkdir()
        (self.home / 'bin/mac').write_text('not portable')
        result = self.apply()
        target = self.wizard / 'agents/fixture-agent/home'
        self.assertEqual(target.stat().st_ino, inode)
        self.assertFalse(self.home.is_symlink())
        self.assertTrue((self.home / 'WIZARD-IMPORTED.json').exists())
        cfg = m.load_yaml((target / 'config.yaml').read_text())
        self.assertEqual(cfg['terminal']['backend'], 'local')
        self.assertIn('wizard', cfg['mcp_servers'])
        self.assertNotIn('old', cfg['mcp_servers'])
        self.assertFalse(cfg['gateway']['platforms']['telegram']['enabled'])
        self.assertTrue(cfg['gateway']['platforms']['api_server']['enabled'])
        env = (target / '.env').read_text()
        self.assertNotIn('TELEGRAM_BOT_TOKEN', env)
        self.assertNotIn('WIZARD_ADMIN_KEY', env)
        self.assertIn('OPENAI_API_KEY="fixture-provider"', env)
        job = json.loads((target / 'cron/jobs.json').read_text())['jobs'][0]
        self.assertEqual(job['state'], 'paused')
        self.assertFalse(job['enabled'])
        self.assertFalse((target / 'bin').exists())
        result = self.undo(result)
        self.assertEqual(self.home.stat().st_ino, inode)
        self.assertFalse((self.wizard / 'agents/fixture-agent').exists())
        self.assertEqual((self.home / 'bin/mac').read_text(), 'not portable')
        for rel, data in originals.items():
            self.assertEqual((self.home / rel).read_bytes(), data)
        self.assertEqual(result['state'], 'undone')
    def test_takeover_requires_explicit_stop_authority(self):
        p = self.plan()
        p.update(mode='take-over', source_units=['hermes-gateway.service'])
        m.approve(p)
        with self.assertRaisesRegex(m.ImportFailure, 'source_stop_requires'):
            self.apply(p)
        self.assertTrue(self.home.exists())
        self.undo({'journal': str(self.wizard / 'agents/fixture-agent/import-journal.json')})
    def test_takeover_without_writers_units_rejected(self):
        p = self.plan()
        p['mode'] = 'take-over'
        m.approve(p)
        with self.assertRaisesRegex(m.ImportFailure, 'writer_units'):
            self.apply(p)
    def test_approved_heavy_grant_exposes_plugin_in_explicit_api_toolsets_only(self):
        cfg = m.load_yaml((self.home / 'config.yaml').read_text())
        cfg['platform_toolsets'] = {'api_server': ['terminal', 'memory'], 'telegram': ['memory']}
        original = m.yaml.safe_dump(cfg)
        (self.home / 'config.yaml').write_text(original)
        p = self.plan()
        m.wire(self.home, p, 'api-fixture', 'gateway-fixture')
        unchanged = m.load_yaml((self.home / 'config.yaml').read_text())
        self.assertEqual(unchanged['platform_toolsets']['api_server'], ['terminal', 'memory'])
        (self.home / 'config.yaml').write_text(original)
        p['grants'] = {'heavy': True}
        m.wire(self.home, p, 'api-fixture', 'gateway-fixture')
        granted = m.load_yaml((self.home / 'config.yaml').read_text())
        self.assertIn('wizard-agent-heavy', granted['plugins']['enabled'])
        self.assertEqual(granted['platform_toolsets']['api_server'], ['terminal', 'memory', 'wizard-agent-heavy'])
        self.assertEqual(granted['platform_toolsets']['telegram'], ['memory'])
        m.wire(self.home, p, 'api-fixture', 'gateway-fixture')
        twice = m.load_yaml((self.home / 'config.yaml').read_text())
        self.assertEqual(twice['platform_toolsets']['api_server'].count('wizard-agent-heavy'), 1)
        p['grants'] = {'heavy': False}
        m.wire(self.home, p, 'api-fixture', 'gateway-fixture')
        revoked = m.load_yaml((self.home / 'config.yaml').read_text())
        self.assertNotIn('wizard-agent-heavy', revoked['platform_toolsets']['api_server'])
        self.assertNotIn('wizard-agent-heavy', revoked['plugins']['enabled'])

    def test_heavy_api_allowlist_shapes_fail_closed_or_preserve_defaults(self):
        original = m.load_yaml((self.home / 'config.yaml').read_text())
        for value in [None, [], ['terminal'], 'terminal']:
            cfg = {**original, 'platform_toolsets': {'api_server': value, 'telegram': ['memory']}}
            (self.home / 'config.yaml').write_text(m.yaml.safe_dump(cfg))
            p = self.plan(); p['grants'] = {'heavy': True}
            if isinstance(value, str):
                with self.assertRaisesRegex(m.ImportFailure, 'api_toolsets_invalid'):
                    m.wire(self.home, p, 'api-fixture', 'gateway-fixture')
                continue
            m.wire(self.home, p, 'api-fixture', 'gateway-fixture')
            actual = m.load_yaml((self.home / 'config.yaml').read_text())
            expected = None if value is None else [*value, 'wizard-agent-heavy']
            self.assertEqual(actual['platform_toolsets']['api_server'], expected)
            self.assertEqual(actual['platform_toolsets']['telegram'], ['memory'])

    def test_takeover_wiring_keeps_own_cron_messaging(self):
        p = self.plan()
        p['mode'] = 'take-over'
        m.wire(self.home, p, 'api-fixture', 'gateway-fixture')
        self.assertIn('TELEGRAM_BOT_TOKEN="fixture-secret"', (self.home / '.env').read_text())
        self.assertTrue(json.loads((self.home / 'cron/jobs.json').read_text())['jobs'][0]['enabled'])
        self.assertTrue(m.load_yaml((self.home / 'config.yaml').read_text())['gateway']['platforms']['telegram']['enabled'])
    @unittest.skipUnless(sys.platform.startswith('linux'), 'the writer census reads /proc/<pid>/fd and F_SETLEASE: Linux only')
    def test_live_writable_fd_refuses_move(self):
        # A different process, same owner, holding a writable FD blocks rename even for rehearsal.
        import subprocess, sys
        child = subprocess.Popen([sys.executable, '-c', 'import sys,time; f=open(sys.argv[1],"a"); print("ready",flush=True); time.sleep(30)', str(self.home / '.env')], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'ready')
            with patch.object(m, 'assert_no_writers', lambda source, **kw: self.census_real(source, _pids=[child.pid], **kw)):
                with self.assertRaisesRegex(m.ImportFailure, 'source_has_writers'):
                    self.apply()
        finally:
            child.terminate()
            child.wait()
            child.stdout.close()
        self.undo({'journal': str(self.wizard / 'agents/fixture-agent/import-journal.json')})
    def test_failed_health_undo_is_recoverable(self):
        FakeRuntime.fail = True
        with self.assertRaisesRegex(m.ImportFailure, 'fixture_health_failure'):
            self.apply()
        self.assertFalse(FakeRuntime.live)
        self.undo({'journal': str(self.wizard / 'agents/fixture-agent/import-journal.json')})
        self.assertTrue((self.home / 'SOUL.md').exists())
    def test_existing_agent_not_overwritten(self):
        self.apply()
        # Second apply cannot reach any external side effect.
        with self.assertRaises(m.ImportFailure):
            self.apply(self.plan())
    def test_undo_pointer_conflict_fails_closed(self):
        result = self.apply()
        (self.home / 'new-owner-data').write_text('must not delete')
        with self.assertRaisesRegex(m.ImportFailure, 'source_pointer_changed'):
            self.undo(result)
        self.assertEqual((self.home / 'new-owner-data').read_text(), 'must not delete')
    def test_archive_rejects_all_bad_members_before_import(self):
        for name in ['/absolute', '../parent', 'prefix/../../parent', 'C:/bad', 'prefix\\bad', './alias']:
            path = self.root / 'bad.zip'
            with zipfile.ZipFile(path, 'w') as z:
                z.writestr('config.yaml', '{}')
                z.writestr(name, 'unsafe')
            with self.subTest(name=name), self.assertRaisesRegex(m.ImportFailure, 'archive_path'):
                m.archive_entries(path)
    def test_archive_rejects_symlink_and_external_state(self):
        path = self.root / 'bad.zip'
        link = zipfile.ZipInfo('link')
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('config.yaml', '{}')
            z.writestr(link, '/outside')
        with self.assertRaisesRegex(m.ImportFailure, 'archive_special_file'):
            m.archive_entries(path)
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('config.yaml', '{}')
            z.writestr('_external/.ssh/id', 'unsafe')
        with self.assertRaisesRegex(m.ImportFailure, 'external_archive'):
            m.archive_entries(path)
    def test_archive_member_and_size_limits(self):
        path = self.root / 'limit.zip'
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('config.yaml', '{}')
        with self.assertRaisesRegex(m.ImportFailure, 'archive_size_limit'):
            m.archive_entries(path, max_bytes=1)
        with self.assertRaisesRegex(m.ImportFailure, 'archive_member_limit'):
            m.archive_entries(path, max_members=0)
    def test_archive_cross_host_sanitized_and_clean_undo(self):
        path = self.root / 'safe.zip'
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('config.yaml', (self.home / 'config.yaml').read_text())
            z.writestr('SOUL.md', 'portable')
            z.writestr('bin/mac', 'not portable')
            z.writestr('plugins/wizard-old/entry.py', 'not trusted')
        p = m.scan(path, owner_home=self.owner)
        p.update(network='fixture', gateway_url='http://service:8923/wizard/mcp')
        m.approve(p)
        result = self.apply(p)
        target = self.wizard / 'agents/fixture-agent/home'
        self.assertEqual((target / 'SOUL.md').read_text(), 'portable')
        self.assertFalse((target / 'bin').exists())
        self.assertFalse((target / 'plugins/wizard-old').exists())
        self.undo(result)
        self.assertFalse((self.wizard / 'agents/fixture-agent').exists())
        self.assertTrue(path.exists())  # Caller retains ownership of the original archive.
    def test_paused_plugins_and_profiles_not_activated(self):
        for rel in ['plugins/unsafe/__init__.py', 'profiles/other/config.yaml', 'hooks/run.sh']:
            p = self.home / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('must not boot')
        result = self.apply()
        home = self.wizard / 'agents/fixture-agent/home'
        self.assertFalse((home / 'profiles').exists())
        self.assertFalse((home / 'plugins/unsafe').exists())
        self.assertFalse((home / 'hooks').exists())
        self.undo(result)
        self.assertTrue((self.home / 'plugins/unsafe/__init__.py').exists())
    def test_route_default_and_undo_restore_previous_default_and_recovery(self):
        previous = {'agents': {'default_agent_id': 'philosopher'}, 'appearance': {'skin': 'old'}}
        previous_main = {'role': 'standard', 'label': 'Original host agent'}
        m.dump(self.wizard / 'settings.json', previous)
        m.dump(self.wizard / 'agents/.main-agent.json', previous_main)
        p = self.plan()
        p.update(mode='take-over', source_units=['hermes-fixture.service'])
        m.approve(p)
        from types import SimpleNamespace
        with patch.object(m.subprocess, 'run', return_value=SimpleNamespace(returncode=3)):
            result = m.apply(p, 'fixture-agent', self.wizard, runtime_factory=FakeRuntime, allow_source_stop=True)
        with self.assertRaisesRegex(m.ImportFailure, 'acknowledgement'):
            m.route_default(result['journal'])
        m.route_default(result['journal'], acknowledge_cutover=True)
        self.assertEqual(json.loads((self.wizard / 'settings.json').read_text())['agents']['default_agent_id'], 'fixture-agent')
        self.assertEqual(json.loads((self.wizard / 'agents/.main-agent.json').read_text())['role'], 'recovery')
        self.undo(result)
        self.assertEqual(json.loads((self.wizard / 'settings.json').read_text()), previous)
        self.assertEqual(json.loads((self.wizard / 'agents/.main-agent.json').read_text()), previous_main)
    def test_undo_is_idempotent_at_archived_receipt(self):
        result = self.undo(self.apply())
        again = self.undo(result)
        self.assertEqual(again['state'], 'undone')
    def test_unapproved_unknown_and_host_service_have_no_mount(self):
        p = self.plan()
        for dep in p['dependencies']:
            self.assertFalse(dep['approved'])
        dep = next(d for d in p['dependencies'] if d['kind'] == 'host-service')
        dep.update(approved=True, action='mount rw')
        m.approve(p)
        with self.assertRaises(m.ImportFailure):
            self.apply(p)
    def test_lifecycle_preserves_memory_and_rejects_symlink_deputy(self):
        result = self.apply()
        home = self.wizard / 'agents/fixture-agent/home'
        m.imported_lifecycle(result['journal'], 'stop', runtime_factory=FakeRuntime)
        m.imported_lifecycle(result['journal'], 'start', runtime_factory=FakeRuntime)
        self.assertEqual(m.load_yaml((home / 'config.yaml').read_text())['memory']['provider'], 'holographic')
        outside = self.owner / 'private-config'
        outside.write_text('DO NOT TOUCH')
        cfg = (home / 'config.yaml').read_text()
        (home / 'config.yaml').unlink()
        (home / 'config.yaml').symlink_to(outside)
        with self.assertRaisesRegex(m.ImportFailure, 'symlink'):
            m.imported_lifecycle(result['journal'], 'start', runtime_factory=FakeRuntime)
        self.assertEqual(outside.read_text(), 'DO NOT TOUCH')
        (home / 'config.yaml').unlink()
        (home / 'config.yaml').write_text(cfg)
        self.undo(result)
    def test_asset_replace_and_undo_no_new_plugin_left(self):
        old = self.home / 'plugins/wizard-old/plugin.py'
        old.parent.mkdir(parents=True)
        old.write_text('old wiring')
        archive = self.root / 'asset.zip'
        with zipfile.ZipFile(archive, 'w') as z:
            z.writestr('config.yaml', '{}')
            z.writestr('plugin.py', 'new reviewed wiring')
        p = self.plan()
        p['wizard_assets'] = [{'kind': 'plugins', 'name': 'wizard-new', 'archive': str(archive), 'sha256': m.file_hash(archive)}]
        m.approve(p)
        result = self.apply(p)
        target = self.wizard / 'agents/fixture-agent/home'
        self.assertFalse((target / 'plugins/wizard-old').exists())
        self.assertEqual((target / 'plugins/wizard-new/plugin.py').read_text(), 'new reviewed wiring')
        self.assertIn('wizard-new', m.load_yaml((target / 'config.yaml').read_text())['plugins']['enabled'])
        self.undo(result)
        self.assertEqual(old.read_text(), 'old wiring')
        self.assertFalse((self.home / 'plugins/wizard-new').exists())
    def test_absent_dotenv_still_absent_after_undo(self):
        (self.home / '.env').unlink()
        result = self.apply()
        self.undo(result)
        self.assertFalse((self.home / '.env').exists())
    def test_nested_managed_symlink_and_hardlink_refused(self):
        outside = self.owner / 'outside'
        outside.mkdir()
        (outside / 'jobs.json').write_text('{"jobs":[]}')
        shutil = __import__('shutil')
        shutil.rmtree(self.home / 'cron')
        (self.home / 'cron').symlink_to(outside)
        with self.assertRaisesRegex(m.ImportFailure, 'managed_parent_symlink'):
            m.wire(self.home, self.plan(), 'fake-api', 'fake-gateway')
        self.assertEqual((outside / 'jobs.json').read_text(), '{"jobs":[]}')
        (self.home / 'cron').unlink()
        (self.home / 'cron').mkdir()
        os.link(self.home / 'config.yaml', outside / 'linked-config')
        with self.assertRaisesRegex(m.ImportFailure, 'shared'):
            m.wire(self.home, self.plan(), 'fake-api', 'fake-gateway')
    def test_structured_secret_values_never_become_dependency_paths(self):
        cfg = m.load_yaml((self.home / 'config.yaml').read_text())
        cfg['api_key'] = '/DO_NOT_LOG_THIS_FAKE_VALUE'
        cfg['some'] = {'token': '/ALSO_NOT_LOGGABLE'}
        (self.home / 'config.yaml').write_text(yaml.safe_dump(cfg))
        p = m.scan(self.home, owner_home=self.owner)
        output = json.dumps(p)
        self.assertNotIn('DO_NOT_LOG_THIS_FAKE_VALUE', output)
        self.assertNotIn('ALSO_NOT_LOGGABLE', output)
        plugin = self.home / 'plugins/secret-config/config.json'
        plugin.parent.mkdir(parents=True)
        plugin.write_text('{"api_key":"/QUOTED_SECRET_NOT_A_PATH"}')
        self.assertNotIn('QUOTED_SECRET_NOT_A_PATH', json.dumps(m.scan(self.home, owner_home=self.owner)))
    def test_logical_home_preserves_absolute_paths_and_blocks_override(self):
        p = self.plan()
        p['logical_home'] = str(self.owner / '.hermes-logical')
        m.approve(p)
        result = self.apply(p)
        cfg = m.load_yaml((self.wizard / 'agents/fixture-agent/home/config.yaml').read_text())
        self.assertEqual(cfg['terminal']['cwd'], str(self.owner / '.hermes-logical'))
        self.undo(result)
        p = self.plan()
        p['dependencies'].append({'kind': 'folder', 'path': str(self.home), 'proposal': 'mount ro', 'approved': True})
        m.approve(p)
        with self.assertRaisesRegex(m.ImportFailure, 'home_mount_override|mount_sealed'):
            m.validate_plan(p, self.wizard)
    def test_native_memory_plugin_settings_survive_wiring(self):
        cfg = m.load_yaml((self.home / 'config.yaml').read_text())
        settings = {'db_path': '$HERMES_HOME/memory_store.db', 'hrr_dim': 2048, 'min_trust_threshold': 0.4}
        cfg.setdefault('plugins', {})['hermes-memory-store'] = settings
        (self.home / 'config.yaml').write_text(yaml.safe_dump(cfg))
        result = self.apply()
        wired = m.load_yaml((self.wizard / 'agents/fixture-agent/home/config.yaml').read_text())
        self.assertEqual(wired['plugins']['hermes-memory-store'], settings)
        self.undo(result)
    def test_import_driver_does_not_claim_compose_stopped_seal(self):
        runtime_dir = Path(__file__).parents[1] / 'ops/agent-runtime'
        sys.path.insert(0, str(runtime_dir))
        spec = importlib.util.spec_from_file_location('runtime', runtime_dir / 'agent_runtime.py')
        assert spec and spec.loader
        rt = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = rt
        spec.loader.exec_module(rt)
        from types import SimpleNamespace
        driver = rt.ImportDriver(SimpleNamespace(root=self.wizard / 'agents'))
        with self.assertRaisesRegex(rt.RuntimeFailure, 'import_offline_census_unavailable'):
            rt.lifecycle_action(driver, {'id': 'fixture-agent'}, 'inspect')


if __name__ == '__main__':
    unittest.main(verbosity=2)
