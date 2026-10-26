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


# A full import runs the source writer census (hermes_import.assert_no_writers): /proc/<pid>/fd and F_SETLEASE, Linux
# only, like the boxes the importer runs on. Elsewhere (macOS) it refuses with FileNotFoundError('/proc') instead.
LINUX_ONLY = unittest.skipUnless(sys.platform.startswith('linux'), 'full import needs the Linux /proc writer census')


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
        self.mocks = [patch.object(r.rt, 'docker', side_effect=fake_docker), patch.object(r, 'reown', return_value={'entries': 1, 'changed': 1}), patch.object(r, 'helper'),
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

    @LINUX_ONLY
    def test_registry_authority_allocates_pair_and_moves_inode(self):
        inode = (self.home / 'state.db').stat().st_ino
        result = h.apply(self.plan, 'restricted-fixture', self.root)
        folder = self.root / 'agents/restricted-fixture'
        record = json.loads((folder / 'agent.json').read_text())
        self.assertEqual(record['runtime']['isolation'], 'restricted')
        self.assertEqual(record['runtime']['network'], {'uplink': '10.250.0.16/28', 'sandbox': '10.251.0.16/28'})
        self.assertNotIn('admission', record['runtime'])
        self.assertEqual((folder / 'home/state.db').stat().st_ino, inode)
        self.assertFalse(result['journal'].startswith(str(folder)))
        h.undo(result['journal'])
        self.assertEqual((self.home / 'state.db').stat().st_ino, inode)
        self.assertFalse(folder.exists())
    @LINUX_ONLY
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
    @LINUX_ONLY
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

    @LINUX_ONLY
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

    @LINUX_ONLY
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

    @LINUX_ONLY
    def test_many_file_home_archives_profiles_detaches_links_and_resumes_seal(self):
        folder = self.home / 'many'
        folder.mkdir()
        for i in range(1000):
            (folder / str(i)).write_text('synthetic')
        external = self.owner / 'external'
        external.write_text('unchanged')
        os.link(external, self.home / 'external-alias')
        os.link(self.home / 'config.yaml', self.home / 'config-alias')
        for bundle in ['profiles', 'profiles-retired']:
            profile = self.home / bundle / 'old'
            profile.mkdir(parents=True)
            (profile / 'config.yaml').write_text('model: {api_key: synthetic-profile-secret}\n')
            (profile / 'SOUL.md').write_text('archived identity')
        self.plan = h.scan(self.home, owner_home=self.owner)
        self.plan.update(move=True, gateway_url='http://edge:8923/wizard/mcp', image='fixture:restricted')
        h.approve(self.plan)
        self.assertGreater(self.plan['summary']['ownership_source_dry_run']['entries'], 1000)
        inode = (self.home / 'state.db').stat().st_ino
        journal = self.root / 'imports/restricted-fixture/journal.json'
        with patch.dict(os.environ, {'WIZARD_IMPORT_CRASH_AFTER': 'prepared'}), self.assertRaises(SystemExit):
            h.apply(self.plan, 'restricted-fixture', self.root)
        stage = journal.parent / 'stage/agents/restricted-fixture'
        for bundle in ['profiles', 'profiles-retired']:
            self.assertFalse((stage / 'home' / bundle).exists())
            self.assertEqual((stage / 'quarantine' / bundle / 'old/config.yaml').read_text(), 'model: {api_key: synthetic-profile-secret}\n')
        self.assertEqual((stage / 'home/external-alias').stat().st_nlink, 1)
        self.assertEqual((stage / 'home/config.yaml').stat().st_nlink, 1)
        self.assertEqual(external.read_text(), 'unchanged')
        r.rt.RestrictedDriver.start.assert_not_called()
        before = journal.read_bytes()
        h.resume(journal, dry_run=True)
        r.reown.assert_called_with(stage / 'home', 10000, dry_run=True)
        self.assertEqual(before, journal.read_bytes())
        r.rt.RestrictedDriver.start.assert_not_called()
        result = h.resume(journal)
        folder = self.root / 'agents/restricted-fixture'
        self.assertEqual((folder / 'home/state.db').stat().st_ino, inode)
        self.assertEqual(json.loads(journal.read_text())['state'], 'applied')
        self.assertFalse((folder / 'home/profiles').exists())
        self.assertFalse((folder / 'home/profiles-retired').exists())
        with self.assertRaisesRegex(h.ImportFailure, 'ownership_resume_requires_prepared'):
            h.resume(journal)
        h.undo(result['journal'])
        self.assertEqual((self.home / 'profiles/old/SOUL.md').read_text(), 'archived identity')
        self.assertEqual((self.home / 'state.db').stat().st_ino, inode)
        self.assertEqual(external.read_text(), 'unchanged')

    @LINUX_ONLY
    def test_ownership_failure_retains_prepared_reservation_for_resume(self):
        with patch.object(r, 'reown', side_effect=RuntimeError('interrupted helper')):
            with self.assertRaisesRegex(RuntimeError, 'interrupted helper'):
                h.apply(self.plan, 'restricted-fixture', self.root)
        journal = self.root / 'imports/restricted-fixture/journal.json'
        self.assertEqual(json.loads(journal.read_text())['step'], 'prepared')
        record = json.loads((self.root / 'agents/restricted-fixture/agent.json').read_text())
        self.assertEqual(record['runtime']['admission'], 'importing')
        r.rt.RestrictedDriver.start.assert_not_called()
        result = h.resume(journal)
        h.undo(result['journal'])
        self.assertTrue((self.home / 'state.db').exists())

    @LINUX_ONLY
    def test_sealed_resume_recreates_socket_preparation_after_restart(self):
        with patch.dict(os.environ, {'WIZARD_IMPORT_CRASH_AFTER': 'sealed'}), self.assertRaises(SystemExit):
            h.apply(self.plan, 'restricted-fixture', self.root)
        journal = self.root / 'imports/restricted-fixture/journal.json'
        r.prepare_socket.reset_mock()
        result = h.resume(journal)
        r.prepare_socket.assert_called_once()
        self.assertEqual(r.prepare_socket.call_args.args[1:], (self.plan, 'restricted-fixture'))
        h.undo(result['journal'])

    def test_profiles_refuse_option_is_approval_bound(self):
        (self.home / 'profiles/old').mkdir(parents=True)
        plan = h.scan(self.home, owner_home=self.owner, profiles_policy='refuse')
        plan.update(move=True, gateway_url='http://edge:8923/wizard/mcp')
        h.approve(plan)
        with self.assertRaisesRegex(h.ImportFailure, 'profiles_require_archive'):
            h.validate_plan(plan, self.root)
        plan['profiles_policy'] = 'archive'
        with self.assertRaisesRegex(h.ImportFailure, 'plan_not_approved'):
            h.validate_plan(plan, self.root)
        with self.assertRaisesRegex(h.ImportFailure, 'profiles_policy_invalid'):
            h.scan(self.home, owner_home=self.owner, profiles_policy='activate')

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
