#!/usr/bin/env python3
"""Restricted admission regression tests; no live registry, Docker or credentials."""
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops/agent-runtime'))
import hermes_import as h
import restricted_import as r


class RestrictedImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.owner = self.tmp / 'owner'
        self.home = self.owner / '.hermes'
        self.home.mkdir(parents=True, mode=0o700)
        (self.home / 'config.yaml').write_text('model:\n  provider: anthropic\n  default: claude-opus-5-5\nmemory:\n  backend: native\n')
        (self.home / 'SOUL.md').write_text('original')
        with sqlite3.connect(self.home / 'state.db') as db:
            db.executescript('create table sessions(id text); create table messages(id integer);')
        db.close()
        self.root = self.tmp / 'wizard'
        self.plan = h.scan(self.home, owner_home=self.owner)
        self.plan.update(move=True, gateway_url='http://edge:8923/wizard/mcp', image='fixture:restricted')
        h.approve(self.plan)
        def fake_docker(args, **kw):
            if args[0] == 'run' and '/target/.import-transfer/home' in args[-1]:
                mount = next(a for a in args if a.startswith('type=bind,src='))
                base = Path(mount.split('src=', 1)[1].split(',dst=')[0])
                (base / '.import-transfer/home').rename(base / 'home')
            return type('Result', (), {'stdout': '', 'returncode': 0})()
        self.mocks = [patch.object(r.rt, 'docker', side_effect=fake_docker), patch.object(r, 'reown'), patch.object(r, 'helper'),
                      patch.object(r.rt.RestrictedDriver, 'start', return_value={'ok': True}),
                      patch.object(r, 'health'), patch.object(r, 'prepare_socket')]
        for p in self.mocks:
            p.start()
    def tearDown(self):
        for p in reversed(self.mocks):
            p.stop()
        shutil.rmtree(self.tmp)
    def test_archive_helper_uses_uid_10000_and_private_transport(self):
        directory = self.tmp / 'staging-only'
        directory.mkdir()
        (directory / 'home').mkdir()
        archive = directory / 'transport.zip'
        archive.write_bytes(b'fixture')
        archive.chmod(0o600)
        with patch.object(h.DockerRuntime, 'import_archive') as native:
            r.StagingRuntime(self.plan, directory, 'fixture').import_archive(archive)
        native.assert_called_once_with(archive, uid=10000)
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
        r.helper.assert_called_once()
        self.assertEqual(r.reown.call_args_list[-2].args[1], 10000)
        self.assertEqual(r.reown.call_args_list[-1].args[1], os.getuid())

    def test_registry_authority_allocates_pair_and_moves_inode(self):
        for rel in ['data/apps/host/file', 'hermes-agent/venv/bin/python', 'state/host/file']:
            p = self.home / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('host fixture')
        self.plan['host_shared_paths'] = ['state/host']
        h.approve(self.plan)
        host_inode = (self.home / 'data/apps/host/file').stat().st_ino
        inode = (self.home / 'state.db').stat().st_ino
        result = h.apply(self.plan, 'restricted-fixture', self.root)
        folder = self.root / 'agents/restricted-fixture'
        record = json.loads((folder / 'agent.json').read_text())
        self.assertEqual(record['runtime']['isolation'], 'restricted')
        self.assertEqual(record['runtime']['network'], {'uplink': '10.250.0.16/28', 'sandbox': '10.251.0.16/28'})
        self.assertNotIn('admission', record['runtime'])
        self.assertEqual((folder / 'home/state.db').stat().st_ino, inode)
        self.assertFalse(result['journal'].startswith(str(folder)))
        outer = json.loads(Path(result['journal']).read_text())
        for rel in ['data/apps', 'hermes-agent', 'state/host']:
            self.assertTrue((self.home / rel).exists())
            self.assertFalse((folder / 'home' / rel).exists())
            self.assertFalse(any(p == rel or p.startswith(rel + '/') for p in outer['metadata']))
        self.assertEqual((self.home / 'data/apps/host/file').stat().st_ino, host_inode)
        h.undo(result['journal'])
        self.assertEqual((self.home / 'data/apps/host/file').stat().st_ino, host_inode)
        self.assertEqual((self.home / 'state.db').stat().st_ino, inode)
        self.assertFalse(folder.exists())
    def test_outer_crash_steps_restore_exact_source(self):
        before = {str(p.relative_to(self.home)): p.read_bytes() for p in self.home.rglob('*') if p.is_file()}
        inode = (self.home / 'state.db').stat().st_ino
        steps = ['intent', 'reserved', 'staged', 'prepared', 'sealed', 'transfer-staged', 'transfer-moved', 'placed', 'admitted', 'running']
        for step in steps:
            with self.subTest(step=step):
                with patch.dict(os.environ, {'WIZARD_IMPORT_CRASH_AFTER': step}), self.assertRaises(SystemExit):
                    h.apply(self.plan, 'restricted-fixture', self.root)
                h.undo(self.root / 'imports/restricted-fixture/journal.json')
                after = {str(p.relative_to(self.home)): p.read_bytes() for p in self.home.rglob('*') if p.is_file()}
                self.assertEqual(before, after)
                self.assertEqual((self.home / 'state.db').stat().st_ino, inode)
                self.assertFalse((self.root / 'agents/restricted-fixture').exists())
                shutil.rmtree(self.root / 'imports/restricted-fixture')
    def test_undo_crash_during_both_sealed_transfer_windows(self):
        before = {str(p.relative_to(self.home)): p.read_bytes() for p in self.home.rglob('*') if p.is_file()}
        inode = (self.home / 'state.db').stat().st_ino
        for step in ['transfer-staged', 'transfer-moved']:
            with self.subTest(step=step):
                result = h.apply(self.plan, 'restricted-fixture', self.root)
                with patch.dict(os.environ, {'WIZARD_IMPORT_CRASH_AFTER': step}), self.assertRaises(SystemExit):
                    h.undo(result['journal'])
                h.undo(result['journal'])
                after = {str(p.relative_to(self.home)): p.read_bytes() for p in self.home.rglob('*') if p.is_file()}
                self.assertEqual(before, after)
                self.assertEqual((self.home / 'state.db').stat().st_ino, inode)
                shutil.rmtree(self.root / 'imports/restricted-fixture')

    def test_rw_mount_groups_explicit_and_never_root(self):
        workspace = self.owner / 'workspace'
        workspace.mkdir(mode=0o775)
        workspace.chmod(0o775)
        self.plan['dependencies'] = [{'kind': 'folder', 'path': str(workspace), 'proposal': 'mount rw', 'action': 'mount rw', 'approved': True}]
        self.plan['supplemental_groups'] = [workspace.stat().st_gid]
        h.approve(self.plan)
        result = h.apply(self.plan, 'restricted-fixture', self.root)
        override = json.loads((self.root / 'agents/restricted-fixture/import-runtime.json').read_text())
        self.assertEqual(override['services']['agent']['group_add'], [str(workspace.stat().st_gid)])
        h.undo(result['journal'])
        shutil.rmtree(self.root / 'imports/restricted-fixture')
        self.plan['supplemental_groups'] = [0]
        h.approve(self.plan)
        with self.assertRaisesRegex(h.ImportFailure, 'import_mount_group_not_granted'):
            h.apply(self.plan, 'restricted-fixture', self.root)
        h.undo(self.root / 'imports/restricted-fixture/journal.json')

    def test_explicit_gh_file_only_and_heavy_grant_survive_admission(self):
        gh = self.owner / '.config/gh'
        gh.mkdir(parents=True)
        hosts = gh / 'hosts.yml'
        hosts.write_text('github.com:\n  oauth_token: synthetic-fixture-not-a-real-token\n')
        (gh / 'unapproved').write_text('not granted')
        self.plan['dependencies'] = [{'kind': 'credential', 'path': str(hosts), 'credential_source': str(hosts),
                                      'proposal': 'carry secret', 'action': 'carry secret', 'approved': True}]
        self.plan['grants'] = {'heavy': True}
        self.plan['grant_items'] = [{'item': 'grants.heavy', 'approved': True}]
        h.approve(self.plan)
        result = h.apply(self.plan, 'restricted-fixture', self.root)
        folder = self.root / 'agents/restricted-fixture'
        self.assertEqual((folder / 'home/native-home/.config/gh/hosts.yml').read_text(), hosts.read_text())
        self.assertFalse((folder / 'home/native-home/.config/gh/unapproved').exists())
        self.assertTrue(json.loads((folder / 'agent.json').read_text())['grants']['heavy'])
        self.assertTrue((folder / 'home/plugins/wizard-agent-heavy/__init__.py').is_file())
        self.assertFalse((folder / 'home/native-home/.ssh').exists())
        h.undo(result['journal'])
        self.assertTrue(hosts.is_file())

    def test_heavy_grant_requires_explicit_item_and_approval_hash(self):
        self.plan['grants']['heavy'] = True
        with self.assertRaisesRegex(h.ImportFailure, 'plan_not_approved'):
            h.validate_plan(self.plan, self.root)
        h.approve(self.plan)
        with self.assertRaisesRegex(h.ImportFailure, 'heavy_grant_not_approved'):
            h.validate_plan(self.plan, self.root)
        self.plan['grant_items'][0]['approved'] = True
        h.approve(self.plan)
        h.validate_plan(self.plan, self.root)
        self.plan['grants']['heavy'] = 'true'
        h.approve(self.plan)
        with self.assertRaisesRegex(h.ImportFailure, 'grants_invalid'):
            h.validate_plan(self.plan, self.root)

    def test_scan_long_noncredential_script_line_is_linear(self):
        import time
        script = self.home / 'scripts/long.sh'
        script.parent.mkdir(parents=True)
        script.write_text('a' * 100000 + ': harmless ' + '/work/folder ' * 10000 + '\nssh ' + 'thales uname -a\n')
        start = time.monotonic()
        plan = h.scan(self.home, owner_home=self.owner)
        self.assertLess(time.monotonic() - start, 5)
        self.assertEqual(plan['warnings'], [{'reference': 'scripts/long.sh:2', 'warning': 'needs Machines/heavy job'}])

    def test_scan_reports_thales_usages_without_command_bytes(self):
        for rel, text in [('skills/build/SKILL.md', 'ssh ' + 'thales uname -a'),
                          ('scripts/fetch.sh', 'scp thales:/work/artifact ./out'),
                          ('cron/check.py', 'rsync -a thales:/work/logs ./logs')]:
            dest = self.home / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(text)
        output = self.home / 'cron/output/past.md'
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text('ssh ' + 'thales historical-output-only')
        plan = h.scan(self.home, owner_home=self.owner)
        self.assertFalse(plan['grants']['heavy'])
        self.assertFalse(plan['grant_items'][0]['approved'])
        self.assertEqual(len(plan['warnings']), 3)
        self.assertTrue(all(x['warning'] == 'needs Machines/heavy job' for x in plan['warnings']))
        self.assertNotIn('uname -a', json.dumps(plan))

    def test_reservation_start_is_denied_before_any_docker(self):
        agent = {'id': 'fixture', 'runtime': {'admission': 'importing'}, 'model': {}}
        with self.assertRaisesRegex(r.rt.RuntimeFailure, 'agent_import_in_progress'):
            r.rt.RestrictedDriver(r.rt.Agents(self.root / 'agents', None), r.rt.RESTRICTED_DIR, 'fixture')._prepare(agent)
        r.rt.docker.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
