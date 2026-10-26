"""Synthetic large-tree importer regressions; no real homes or Docker."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops/agent-runtime'))
import hermes_import as h


class ImportTreeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        self.addCleanup(self.tmp.cleanup)
        self.owner = Path(self.tmp.name) / 'owner'
        self.home = self.owner / '.hermes'
        self.home.mkdir(parents=True)
        (self.home / 'config.yaml').write_text('model: {provider: fixture, default: fixture-model}\n')

    def test_nested_and_profile_inline_credentials_are_names_only(self):
        for rel in ['config.yaml', 'state/old/config.yaml', 'profiles/old/config.yaml',
                    'profiles-retired/old/config.yaml', 'settings/config.yml.bak']:
            p = self.home / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('model:\n  api_key: synthetic-inline-value\nmcp_servers:\n  sample:\n    env:\n      EXAMPLE_API_KEY: synthetic-nested-value\n')
        plan = h.scan(self.home, owner_home=self.owner)
        configs = {c['path'] for c in plan['credentials'] if c['kind'] == 'config-field'}
        self.assertEqual(len(configs), 5)
        text = json.dumps(plan)
        self.assertNotIn('synthetic-inline-value', text)
        self.assertNotIn('synthetic-nested-value', text)
        self.assertEqual(plan['profiles_policy'], 'archive')
        self.assertEqual(plan['summary']['profiles_archived'], ['profiles', 'profiles-retired'])
        plan.update(move=True, gateway_url='http://edge:8923/wizard/mcp')
        h.approve(plan)
        with self.assertRaisesRegex(h.ImportFailure, 'inline_credentials_require_secret_store') as caught:
            h.validate_plan(plan, self.owner / 'wizard')
        self.assertIn('model/api_key', str(caught.exception))
        self.assertNotIn('synthetic-inline-value', str(caught.exception))
        self.assertTrue((self.home / 'config.yaml').exists())

    def test_cli_refusal_is_names_only_and_source_is_untouched(self):
        p = self.home / 'state/old/config.yaml'
        p.parent.mkdir(parents=True)
        p.write_text('model: {api_key: synthetic-do-not-print}\n')
        plan = h.scan(self.home, owner_home=self.owner)
        plan.update(move=True, gateway_url='http://edge:8923/wizard/mcp')
        h.approve(plan)
        plan_path = Path(self.tmp.name) / 'plan.json'
        h.dump(plan_path, plan)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(h.main(['apply', str(plan_path), '--id', 'fixture', '--wizard-home', str(self.owner / 'wizard')]), 1)
        self.assertIn('model/api_key', err.getvalue())
        self.assertNotIn('synthetic-do-not-print', err.getvalue())
        self.assertFalse((self.owner / 'wizard/agents').exists())

    def test_config_reference_is_not_an_inline_credential(self):
        (self.home / 'config.yaml').write_text('model: {api_key: "${EXAMPLE_API_KEY}"}\n')
        plan = h.scan(self.home, owner_home=self.owner)
        self.assertEqual(plan['credentials'], [])

    def test_ownership_count_detach_and_resume(self):
        import import_tree as tree
        folder = self.home / 'many'
        folder.mkdir()
        for i in range(1000):
            (folder / str(i)).write_text('synthetic')
        outside = self.owner / 'outside'
        outside.write_text('outside-unchanged')
        os.link(outside, folder / 'external-alias')
        os.link(folder / '0', folder / 'internal-alias')
        (self.home / 'outside-link').symlink_to(outside)
        (self.home / 'outside-dir').symlink_to(self.owner, target_is_directory=True)
        before = outside.stat()
        count = tree.ownership(self.home, os.getuid(), os.getgid(), dry_run=True)
        self.assertEqual(count['entries'], 1007)
        self.assertEqual(count['hardlinked_files'], 3)
        self.assertEqual(tree.detach_hardlinks(self.home), 2)
        self.assertEqual((folder / 'external-alias').stat().st_nlink, 1)
        self.assertNotEqual((folder / 'external-alias').stat().st_ino, outside.stat().st_ino)
        # Matching entries need no chown at all (including after a restart).
        with patch.object(tree.os, 'chown', side_effect=AssertionError('unnecessary chown')):
            result = tree.ownership(self.home, os.getuid(), os.getgid())
        self.assertEqual(result['changed'], 0)
        self.assertEqual(result['entries'], count['entries'])
        self.assertEqual(outside.read_text(), 'outside-unchanged')
        self.assertEqual((outside.stat().st_uid, outside.stat().st_gid, outside.stat().st_ino),
                         (before.st_uid, before.st_gid, before.st_ino))

    def test_ownership_fails_closed_on_shared_inode(self):
        import import_tree as tree
        outside = self.owner / 'outside'
        outside.write_text('synthetic')
        os.link(outside, self.home / 'shared')
        with self.assertRaisesRegex(ValueError, 'ownership_shared_inode'):
            tree.ownership(self.home, os.getuid(), os.getgid())

    def test_old_config_formats_and_parse_errors_do_not_leak_values(self):
        cases = {
            'config.json.old': '{"model": {"apiKey": "synthetic-json-value"}}',
            'config.toml': '[model]\nclient_secret="synthetic-toml-value"\n',
            'config.yml': 'headers: {Authorization: synthetic-header-value}\n',
        }
        for name, text in cases.items():
            with self.subTest(name=name):
                p = self.home / 'old' / name
                p.parent.mkdir(exist_ok=True)
                p.write_text(text)
                plan = h.scan(self.home, owner_home=self.owner)
                self.assertIn('old/' + name, {c['path'] for c in plan['credentials']})
                self.assertNotIn('synthetic-json-value', json.dumps(plan))
                self.assertNotIn('synthetic-toml-value', json.dumps(plan))
                self.assertNotIn('synthetic-header-value', json.dumps(plan))
        (self.home / 'config.yaml').write_text('model: {api_key: synthetic-bad-value\n')
        out = io.StringIO()
        with contextlib.redirect_stderr(out):
            self.assertEqual(h.main(['scan', str(self.home), '--owner-home', str(self.owner), '--out', str(Path(self.tmp.name) / 'plan.json')]), 1)
        self.assertIn('import_io_or_format_error', out.getvalue())
        self.assertNotIn('synthetic-bad-value', out.getvalue())

    def test_reown_dispatches_same_tree_code_to_one_constrained_helper(self):
        import import_tree as tree
        import restricted_import as restricted
        def fake_helper(home, code, **kwargs):
            self.assertEqual(home, self.home)
            self.assertEqual(kwargs, {'uid': 0, 'privileged': True,
                'data': {'uid': os.getuid(), 'dry_run': True}, 'timeout': 1800})
            # This process stands in only for the mount namespace, not walker
            # logic: execute the exact helper script against a synthetic root.
            result = subprocess.run([sys.executable, '-c', code.replace("'/opt/data'", repr(str(home)))],
                input=json.dumps(kwargs['data']), text=True, capture_output=True, check=True)
            return result
        with patch.object(restricted, 'helper', side_effect=fake_helper) as helper:
            result = restricted.reown(self.home, os.getuid(), dry_run=True)
        helper.assert_called_once()
        self.assertEqual(result, tree.ownership(self.home, os.getuid(), dry_run=True))

    def test_detach_failure_keeps_original_and_cleans_temporary_file(self):
        import import_tree as tree
        outside = self.owner / 'outside'
        outside.write_text('synthetic')
        linked = self.home / 'linked'
        os.link(outside, linked)
        with patch.object(tree.shutil, 'copyfileobj', side_effect=OSError('fixture disk full')):
            with self.assertRaisesRegex(OSError, 'fixture disk full'):
                tree.detach_hardlinks(self.home)
        self.assertEqual(linked.stat().st_ino, outside.stat().st_ino)
        self.assertEqual(linked.read_text(), 'synthetic')
        self.assertEqual(list(self.home.glob('.wizard-import-copy-*')), [])
        tree.detach_hardlinks(self.home)
        self.assertNotEqual(linked.stat().st_ino, outside.stat().st_ino)

    def test_ownership_root_symlink_refused(self):
        import import_tree as tree
        alias = self.owner / 'alias'
        alias.symlink_to(self.home, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'ownership_root_symlink'):
            tree.ownership(alias, os.getuid(), dry_run=True)

    def test_ownership_restart_skips_completed_entries(self):
        import import_tree as tree
        for i in range(50):
            (self.home / f'file-{i}').write_text('synthetic')
        # Emulate differing ownership without root privileges, including an
        # interrupted pass. The real walker/chown arguments remain exercised.
        original_stat = os.stat
        completed = set()
        changed = []
        def fake_stat(path, *args, **kwargs):
            result = original_stat(path, *args, **kwargs)
            if result.st_ino in completed:
                return result
            fields = list(result)
            fields[4:6] = [-1, -1]
            return os.stat_result(fields)
        def fake_chown(path, uid, gid, **kwargs):
            s = original_stat(path, dir_fd=kwargs.get('dir_fd'), follow_symlinks=False)
            if len(changed) == 17:
                raise OSError('interrupted fixture')
            completed.add(s.st_ino)
            changed.append(s.st_ino)
        with patch.object(tree.os, 'stat', side_effect=fake_stat), patch.object(tree.os, 'chown', side_effect=fake_chown):
            with self.assertRaisesRegex(OSError, 'interrupted fixture'):
                tree.ownership(self.home, os.getuid(), os.getgid())
        def finish(path, uid, gid, **kwargs):
            s = original_stat(path, dir_fd=kwargs.get('dir_fd'), follow_symlinks=False)
            self.assertNotIn(s.st_ino, completed)
            completed.add(s.st_ino)
        with patch.object(tree.os, 'stat', side_effect=fake_stat), patch.object(tree.os, 'chown', side_effect=finish):
            result = tree.ownership(self.home, os.getuid(), os.getgid())
        self.assertEqual(result['changed'], 35)
        self.assertEqual(result['entries'], 52)


if __name__ == '__main__':
    unittest.main(verbosity=2)
