#!/usr/bin/env python3
"""Issue 532: a deploy refreshes the host Hermes' plain copies of the Service's own plugins, never an owner's."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sync = load('hermes_plugin_sync', ROOT / 'ops/sync-hermes-plugins.py')
deploy = load('service_deploy_sync', ROOT / 'ops/wizard-agent-service-deploy.py')

OLD = "SCHEMA = {'properties': {'when': {}}}\n"
NEW = "SCHEMA = {'properties': {'when': {}, 'thread': {'enum': ['daily']}}}\n"


def git(cwd, *args):
    env = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@x', 'GIT_COMMITTER_NAME': 't',
           'GIT_COMMITTER_EMAIL': 't@x'}
    subprocess.run(['git', *args], cwd=cwd, env=env, check=True, capture_output=True)


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='plugin-sync-')
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        # A source checkout whose history has an old and a new wizard-schedule; the release is the new one.
        self.src = base / 'src'
        plugin = self.src / 'hermes-plugin/wizard-schedule'
        plugin.mkdir(parents=True)
        (plugin / 'plugin.yaml').write_text('name: wizard-schedule\n')
        (plugin / '__init__.py').write_text(OLD)
        for other in ('wizard-agents', 'wizard-linked', 'wizard-hermes'):
            (self.src / 'hermes-plugin' / other).mkdir()
            (self.src / 'hermes-plugin' / other / 'plugin.yaml').write_text(f'name: {other}\n')
        git(self.src, 'init', '-q')
        git(self.src, 'add', '.')
        git(self.src, 'commit', '-qm', 'old')
        (plugin / '__init__.py').write_text(NEW)
        git(self.src, 'commit', '-qam', 'new')
        self.release = self.src
        self.home = base / 'hermes'
        self.plugins = self.home / 'plugins'
        self.plugins.mkdir(parents=True)

    def install(self, name='wizard-schedule', text=OLD):
        target = self.plugins / name
        target.mkdir()
        (target / 'plugin.yaml').write_text(f'name: {name}\n')
        (target / '__init__.py').write_text(text)
        (target / '__pycache__').mkdir()
        (target / '__pycache__/x.pyc').write_bytes(b'cache')
        return target

    def test_old_shipped_copy_is_refreshed_to_the_release(self):
        target = self.install()
        result = sync.sync(self.release, self.home, self.src)
        self.assertEqual(result['plugins']['wizard-schedule'], 'refreshed')
        self.assertEqual(result['changed'], ['wizard-schedule'])
        self.assertEqual((target / '__init__.py').read_text(), NEW)
        self.assertFalse((target / '__pycache__').exists())
        # A second run changes nothing.
        again = sync.sync(self.release, self.home, self.src)
        self.assertEqual(again['plugins']['wizard-schedule'], 'current')
        self.assertEqual(again['changed'], [])

    def test_owner_edit_is_never_overwritten(self):
        target = self.install(text=OLD + '# my own tweak\n')
        result = sync.sync(self.release, self.home, self.src)
        self.assertEqual(result['plugins']['wizard-schedule'], 'owner-modified')
        self.assertIn('my own tweak', (target / '__init__.py').read_text())
        extra = self.plugins / 'wizard-schedule/notes.txt'
        (target / '__init__.py').write_text(OLD)
        extra.write_text('mine')
        self.assertEqual(sync.sync(self.release, self.home, self.src)['plugins']['wizard-schedule'], 'owner-modified')
        self.assertTrue(extra.exists())

    def test_without_history_only_an_identical_copy_counts_as_known(self):
        target = self.install()
        result = sync.sync(self.release, self.home, None)
        self.assertEqual(result['plugins']['wizard-schedule'], 'owner-modified')
        self.assertEqual((target / '__init__.py').read_text(), OLD)

    def test_missing_linked_and_hermes_installed_plugins_are_left_alone(self):
        self.install()
        (self.plugins / 'wizard-linked').symlink_to(self.src / 'hermes-plugin/wizard-linked')
        hermes = self.install('wizard-hermes', text='anything')
        (self.plugins / '.install-metadata.json').write_text(json.dumps({'wizard-hermes': {'source': 'x'}}))
        result = sync.sync(self.release, self.home, self.src)
        self.assertEqual(result['plugins'], {'wizard-agents': 'not-installed', 'wizard-hermes': 'hermes-managed',
                                             'wizard-linked': 'linked', 'wizard-schedule': 'refreshed'})
        self.assertFalse((self.plugins / 'wizard-agents').exists())
        self.assertEqual((hermes / '__init__.py').read_text(), 'anything')

    def test_unreadable_hermes_metadata_touches_nothing(self):
        target = self.install()
        (self.plugins / '.install-metadata.json').write_text('{not json')
        result = sync.sync(self.release, self.home, self.src)
        self.assertEqual(result['changed'], [])
        self.assertIn('unreadable', result['skipped'])
        self.assertEqual((target / '__init__.py').read_text(), OLD)

    def test_code_from_a_branch_that_never_shipped_is_not_trusted(self):
        git(self.src, 'switch', '-qc', 'side')
        (self.src / 'hermes-plugin/wizard-schedule/__init__.py').write_text(OLD + '# unshipped\n')
        git(self.src, 'commit', '-qam', 'side')
        git(self.src, 'switch', '-q', '-')
        target = self.install(text=OLD + '# unshipped\n')
        result = sync.sync(self.release, self.home, self.src)
        self.assertEqual(result['plugins']['wizard-schedule'], 'owner-modified')
        self.assertIn('# unshipped', (target / '__init__.py').read_text())
        # A release pinned to its own commit trusts only that commit's ancestry.
        (self.src / 'RELEASE_SHA').write_text(subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=self.src, text=True,
                                                             capture_output=True).stdout)
        self.assertEqual(sync.release_ref(self.src), (self.src / 'RELEASE_SHA').read_text().strip())

    def fake_hermes(self, answer):
        script = Path(self.temp.name) / 'fake-python'
        script.write_text('#!/bin/sh\necho \'%s\'\n' % json.dumps(answer))
        script.chmod(0o755)
        return str(script)

    def test_cli_reloads_the_gateway_only_when_something_changed(self):
        self.install()
        python = self.fake_hermes({'verb': True, 'answer': {'reloaded': True}})
        env = {**os.environ, 'WIZARD_HERMES_PYTHON': python}
        cmd = [sys.executable, str(ROOT / 'ops/sync-hermes-plugins.py'), str(self.release),
               '--hermes-home', str(self.home), '--source-git', str(self.src)]
        first = json.loads(subprocess.run(cmd, env=env, text=True, capture_output=True, check=True).stdout)
        self.assertEqual(first['reload'], 'reloaded')
        second = json.loads(subprocess.run(cmd, env=env, text=True, capture_output=True, check=True).stdout)
        self.assertNotIn('reload', second)

    def test_reload_falls_back_to_a_restart_hint(self):
        with patch.dict(os.environ, {'WIZARD_HERMES_PYTHON': self.fake_hermes({'verb': True, 'answer': None})}):
            self.assertEqual(sync.reload_gateway(self.home), 'no-gateway')
        with patch.dict(os.environ, {'WIZARD_HERMES_PYTHON': self.fake_hermes({'verb': False})}):
            self.assertIn('hermes gateway restart', sync.reload_gateway(self.home))

    def test_the_real_release_refreshes_an_old_wizard_schedule_copy(self):
        # The plugin as installed on boxes before issue 532 had no `thread` parameter.
        target = self.install(text=(ROOT / 'hermes-plugin/wizard-schedule/__init__.py').read_text()
                              .replace("'thread'", "'no_thread'"))
        (target / 'plugin.yaml').write_text((ROOT / 'hermes-plugin/wizard-schedule/plugin.yaml').read_text())
        with patch.object(sync, 'shipped_blobs', return_value={(p, s) for p, s in sync.plugin_files(target).items()}):
            result = sync.sync(ROOT, self.home, None)
        self.assertEqual(result['plugins']['wizard-schedule'], 'refreshed')
        self.assertIn("'thread'", (target / '__init__.py').read_text())

    def test_the_box_hand_copy_from_before_the_repo_is_refreshed_without_history(self):
        # The exact 22 Oct bytes on the filer's box (blob f964565): ee86ac2's file with the older one-line
        # loopback check. No source checkout: the release's own seeds list is what makes it known.
        seed = (ROOT / 'tests/fixtures/hermes-plugin-seeds/wizard-schedule-__init__.py.txt').read_bytes()
        self.assertEqual(sync.blob_sha(seed), 'f96456523ec4b74af8e225a9d785ea55e4bcf89a')
        target = self.install()
        (target / '__init__.py').write_bytes(seed)
        (target / 'plugin.yaml').write_bytes((ROOT / 'hermes-plugin/wizard-schedule/plugin.yaml').read_bytes())
        result = sync.sync(ROOT, self.home, None)
        self.assertEqual(result['plugins']['wizard-schedule'], 'refreshed')
        self.assertIn("'thread'", (target / '__init__.py').read_text())
        # The same bytes with one more owner line are still an owner's edit, and the receipt names the file.
        (target / '__init__.py').write_bytes(seed + b'# mine\n')
        again = sync.sync(ROOT, self.home, None)
        self.assertEqual(again['plugins']['wizard-schedule'], 'owner-modified')
        self.assertEqual(again['unknown'], {'wizard-schedule': ['__init__.py']})

    def test_overlapping_runs_take_turns(self):
        # The deploy helper and the Service's startup run can overlap; they share the staging dir.
        import fcntl
        import threading
        self.install()
        done = []
        with open(self.home / sync.LOCK, 'a') as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            worker = threading.Thread(target=lambda: done.append(sync.sync(self.release, self.home, self.src)))
            worker.start()
            worker.join(0.5)
            self.assertEqual(done, [])
        worker.join(10)
        self.assertEqual(done[0]['plugins']['wizard-schedule'], 'refreshed')

    def test_no_plugins_folder_writes_nothing(self):
        self.plugins.rmdir()
        result = sync.sync(self.release, self.home, self.src)
        self.assertEqual(result['changed'], [])
        self.assertFalse((self.home / sync.LOCK).exists())

    def test_a_broken_seeds_list_trusts_no_seed(self):
        (self.release / 'ops').mkdir()
        (self.release / 'ops/hermes-plugin-seeds.json').write_text('{"plugins": [')
        self.assertEqual(sync.seed_blobs(self.release, 'wizard-schedule'), set())
        (self.release / 'ops/hermes-plugin-seeds.json').write_text(json.dumps(
            {'plugins': {'wizard-schedule': {'__init__.py': {sync.blob_sha(b'seed'): 'note'}}}}))
        self.assertEqual(sync.seed_blobs(self.release, 'wizard-schedule'), {('__init__.py', sync.blob_sha(b'seed'))})
        target = self.install(text='seed')
        self.assertEqual(sync.sync(self.release, self.home, None)['plugins']['wizard-schedule'], 'refreshed')
        self.assertEqual((target / '__init__.py').read_text(), NEW)

    def test_a_git_checkout_is_left_to_its_owner(self):
        target = self.install()
        (target / '.git').mkdir()
        (target / '.git/HEAD').write_text('ref: refs/heads/main\n')
        result = sync.sync(self.release, self.home, self.src)
        self.assertEqual(result['plugins']['wizard-schedule'], 'git-checkout')
        self.assertEqual(result['changed'], [])
        self.assertEqual((target / '__init__.py').read_text(), OLD)

    def test_a_hand_run_finds_the_deploy_source_checkout(self):
        with patch.dict(os.environ, {'WAS_SOURCE': str(self.src)}):
            self.assertEqual(sync.default_source(), self.src)
        with patch.dict(os.environ, {'WAS_SOURCE': str(self.home)}):
            self.assertIsNone(sync.default_source())


class DeployWiringTests(unittest.TestCase):
    def test_deploy_runs_the_release_sync_step_and_never_fails_on_it(self):
        with patch.object(deploy, 'run', return_value='noise\n{"changed": ["wizard-schedule"]}') as run:
            self.assertEqual(deploy.sync_hermes_plugins(ROOT), {'changed': ['wizard-schedule']})
        args = run.call_args.args
        self.assertEqual(args[1:3], (str(ROOT / 'ops/sync-hermes-plugins.py'), str(ROOT)))
        self.assertIn('--source-git', args)
        with patch.object(deploy, 'run', side_effect=RuntimeError('boom')):
            self.assertIn('boom', deploy.sync_hermes_plugins(ROOT)['error'])
        with tempfile.TemporaryDirectory() as old_release:
            self.assertIn('skipped', deploy.sync_hermes_plugins(Path(old_release)))


if __name__ == '__main__':
    unittest.main()
