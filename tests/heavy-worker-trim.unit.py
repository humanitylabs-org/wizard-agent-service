#!/usr/bin/env python3
"""Tiny source-only safety fixtures; no RPC, dispatcher loops, builds or sudo.

Run full remote regression/lifecycle via heavy-run-trim-canary.py in native light
queue. These fixtures use only new temporary roots and synthetic process probes.
"""
from contextlib import closing
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid

BASE = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


trim = load('run_trim', BASE / 'scripts/heavy-run-trim.py')
worker = load('trim_worker', BASE / 'scripts/heavy-worker.py')


class TrimTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='run-trim-unit-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        env = patch.dict(os.environ, {'WIZARD_HEAVY_ROOT': str(self.base), 'WIZARD_HEAVY_HOST': 'forum'})
        env.start(); self.addCleanup(env.stop)
        busy = patch.object(trim, 'process_busy', return_value=False)
        busy.start(); self.addCleanup(busy.stop)
        mounts = patch.object(trim, 'mountpoints', return_value=[])
        mounts.start(); self.addCleanup(mounts.stop)
        self.job = 'heavy_' + uuid.uuid4().hex
        self.make_run()

    def make_run(self, purpose='ephemeral', slots=('build', 'cache', 'tmp')):
        self.record = trim.prepare(self.base, purpose, slots)
        self.run_dir = Path(self.record['path'])
        self.spec = {'cwd': str(self.run_dir), 'argv': ['/usr/bin/true'], 'timeout_seconds': 20, 'host': 'forum'}
        trim.admit(self.base, self.spec, self.job)
        self.bulk = self.run_dir / 'build/a.o'
        self.bulk.parent.mkdir(exist_ok=True)
        self.bulk.write_bytes(b'bulk object')

    def sweep(self, **kwargs):
        return trim.trim(self.base, self.spec, self.job, **kwargs)

    def test_only_explicit_compiled_bulk_removed_unknown_and_all_evidence_retained(self):
        names = ['results/out.o', 'build/evidence.o', 'build/receipt.o', 'build/submission.json',
                 'build/admission.json', 'build/preflight.json', 'build/log.o', 'build/screenshot.png',
                 'build/manifest.o', 'build/output.o', 'build/unknown.bin', 'build/source.py',
                 'build/final.apk', 'build/disk.qcow2', 'build/image.iso', 'build/readme.txt', 'unknown.o']
        snapshots = {}
        for name in names:
            target = self.run_dir / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('preserve byte exact')
            snapshots[name] = hashlib.sha256(target.read_bytes()).hexdigest()
        result = self.sweep()
        self.assertEqual(result['status'], 'trimmed')
        self.assertEqual(result['bytes_unlinked'], 11)
        self.assertEqual([p['path'] for p in result['removed']], ['build/a.o'])
        self.assertFalse(self.bulk.exists())
        self.assertEqual(snapshots, {p: hashlib.sha256((self.run_dir / p).read_bytes()).hexdigest() for p in names})
        report = self.base / 'heavy/run-ownership-v1' / (self.record['run_id'] + '.' + self.job + '.trim.json')
        self.assertEqual(json.loads(report.read_text()), result)

    def test_legacy_completed_and_preexisting_unregistered_directories_not_adopted(self):
        legacy = self.base / 'legacy-completed'; legacy.mkdir()
        obj = legacy / 'bulk.o'; obj.write_text('old')
        self.assertIsNone(trim.trim(self.base, {**self.spec, 'cwd': str(legacy)}, self.job))
        fake = self.base / 'heavy/managed-runs-v1' / ('1' * 32); fake.mkdir()
        (fake / 'build').mkdir(); (fake / 'build/b.o').write_text('old too')
        with self.assertRaises(FileNotFoundError):
            trim.trim(self.base, {**self.spec, 'cwd': str(fake)}, self.job)
        self.assertEqual(obj.read_text(), 'old')
        self.assertEqual((fake / 'build/b.o').read_text(), 'old too')

    def test_default_retained_and_weekly_launch_are_never_trimmed(self):
        for purpose in ('retained', 'weekly-launch'):
            with self.subTest(purpose=purpose):
                self.make_run(purpose)
                self.assertEqual(self.sweep()['reason'], 'retained_purpose_or_weekly_launch')
                self.assertTrue(self.bulk.exists())

    def test_weekly_argv_tripwire_and_retain_marker(self):
        self.spec['argv'] = ['/usr/bin/true', 'weekly-launch']
        # Bind a fresh run: changing an already admitted spec must be refused.
        self.job = 'heavy_' + uuid.uuid4().hex
        self.make_run()
        self.spec['argv'] = ['/usr/bin/true', 'weekly_launch']
        # Registry binding deliberately exact; a changed spec cannot trim at all.
        with self.assertRaisesRegex(ValueError, 'admission mismatch'):
            self.sweep()
        self.spec['argv'] = ['/usr/bin/true']
        (self.run_dir / 'RETAIN').touch()
        self.assertEqual(self.sweep()['reason'], 'retain_marker')
        self.assertTrue(self.bulk.exists())

    def test_weekly_argv_even_if_ephemeral_is_retained(self):
        self.spec['argv'] = ['/usr/bin/true', 'WEEKLY/LAUNCH']
        self.job = 'heavy_' + uuid.uuid4().hex
        # Use another new run and bind this exact command.
        self.record = trim.prepare(self.base, 'ephemeral', ('build',))
        self.run_dir = Path(self.record['path']); self.spec['cwd'] = str(self.run_dir)
        self.bulk = self.run_dir / 'build/a.o'; self.bulk.write_text('bulk')
        trim.admit(self.base, self.spec, self.job)
        self.assertEqual(self.sweep()['reason'], 'retained_purpose_or_weekly_launch')
        self.assertTrue(self.bulk.exists())

    def test_retain_paths_and_relative_absolute_and_log_linked_outputs(self):
        names = ('explicit.o', 'relative.o', 'absolute.o', 'printed.o')
        for name in names:
            (self.run_dir / 'build' / name).write_text('preserve')
        (self.run_dir / 'retain.json').write_text(json.dumps({'paths': ['build/explicit.o']}))
        (self.run_dir / 'evidence.json').write_text(json.dumps({'a': 'build/relative.o', 'b': str(self.run_dir / 'build/absolute.o')}))
        log = self.base / 'native-job.log'; log.write_text('output at build/printed.o\n')
        result = self.sweep(evidence_paths=(log,))
        self.assertEqual(result['status'], 'trimmed')
        self.assertTrue(all((self.run_dir / 'build' / p).exists() for p in names))
        self.assertFalse(self.bulk.exists())

    def test_symlinks_anywhere_block_whole_pass_without_following(self):
        outside = self.base / 'outside'; outside.mkdir()
        sentinel = outside / 'keep.o'; sentinel.write_text('outside')
        (self.run_dir / 'shortcut').symlink_to(outside, target_is_directory=True)
        result = self.sweep()
        self.assertEqual(result['status'], 'skipped')
        self.assertTrue(self.bulk.exists()); self.assertEqual(sentinel.read_text(), 'outside')

    def test_hardlinks_block_whole_pass(self):
        os.link(self.bulk, self.base / 'external-linked-output.o')
        self.assertEqual(self.sweep()['status'], 'skipped')
        self.assertTrue(self.bulk.exists())

    def test_special_files_block_whole_pass(self):
        os.mkfifo(self.run_dir / 'pipe')
        self.assertEqual(self.sweep()['status'], 'skipped')
        self.assertTrue(self.bulk.exists())

    def test_mount_including_bind_file_blocks_pass(self):
        for path in (self.run_dir, self.run_dir / 'build', self.bulk):
            with self.subTest(path=path), patch.object(trim, 'mountpoints', return_value=[path]):
                self.job = 'heavy_' + uuid.uuid4().hex
                # unique report for each simulated pass, exact admission updated only in fixture
                registry = self.base / 'heavy/run-ownership-v1'
                (registry / (self.record['run_id'] + '.admission.json')).unlink()
                trim.admit(self.base, self.spec, self.job)
                self.assertEqual(self.sweep()['reason'], 'mounted_tree')
                self.assertTrue(self.bulk.exists())

    def test_process_busy_or_unknown_blocks_pass(self):
        with patch.object(trim, 'process_busy', return_value=True):
            self.assertEqual(self.sweep()['reason'], 'process_busy_or_unknown')
        self.assertTrue(self.bulk.exists())

    def test_execution_and_concurrent_trim_leases_block_pass(self):
        lease = trim.run_lease(self.base, self.spec)
        try:
            self.assertEqual(self.sweep()['status'], 'skipped')
            self.assertTrue(self.bulk.exists())
        finally:
            os.close(lease)

    def test_replaced_run_or_lease_rejected(self):
        (self.run_dir / '.run.lock').rename(self.run_dir / 'old-lock')
        (self.run_dir / '.run.lock').touch()
        with self.assertRaisesRegex(ValueError, 'unsafe run lease'):
            trim.run_lease(self.base, self.spec)
        self.assertEqual(self.sweep()['status'], 'skipped')
        self.assertTrue(self.bulk.exists())
        old = self.run_dir.with_name(self.run_dir.name + '-old'); self.run_dir.rename(old); self.run_dir.mkdir()
        with self.assertRaisesRegex(ValueError, 'ownership identity mismatch'):
            self.sweep()
        self.assertTrue((old / 'build/a.o').exists())

    def test_one_run_cannot_be_reused_or_move_lanes_or_change_command(self):
        trim.admit(self.base, self.spec, self.job)  # exact duplicate is idempotent
        for job, spec in ((self.job, {**self.spec, 'lane': 'light'}),
                          ('heavy_' + uuid.uuid4().hex, self.spec),
                          (self.job, {**self.spec, 'argv': ['/usr/bin/false']})):
            with self.assertRaisesRegex(ValueError, 'single-submission'):
                trim.admit(self.base, spec, job)

    def test_malformed_retain_and_oversized_reference_evidence_fail_closed(self):
        (self.run_dir / 'retain.json').write_text('{"paths":["../outside"]}')
        self.assertEqual(self.sweep()['status'], 'skipped')
        self.assertTrue(self.bulk.exists())
        self.make_run()
        with (self.run_dir / 'evidence.json').open('wb') as stream:
            stream.truncate(8 * 1024 * 1024 + 1)
        self.assertIn('reference scan limit', self.sweep()['reason'])
        self.assertTrue(self.bulk.exists())

    def test_rename_or_symlink_race_cannot_unlink_outside(self):
        outside = self.base / 'outside'; outside.mkdir()
        sentinel = outside / 'a.o'; sentinel.write_text('safe')
        expected = self.bulk.stat()
        fd = os.open(self.run_dir, os.O_DIRECTORY | os.O_RDONLY)
        try:
            (self.run_dir / 'build').rename(self.run_dir / 'old-build')
            (self.run_dir / 'build').symlink_to(outside, target_is_directory=True)
            with self.assertRaises(OSError):
                trim.unlink_same(fd, 'build/a.o', expected)
        finally:
            os.close(fd)
        self.assertEqual(sentinel.read_text(), 'safe')
        self.assertTrue((self.run_dir / 'old-build/a.o').exists())

    def test_cleanup_exception_cannot_change_native_terminal_receipt(self):
        root = self.base / 'spool'
        with closing(worker.connect(root)) as db:
            spec = json.dumps(self.spec, sort_keys=True, separators=(',', ':'))
            db.execute('INSERT INTO jobs(id,spec,state,created,updated,execution_result) VALUES(?,?,?,?,?,?)',
                       (self.job, spec, 'running', 1, 1, json.dumps({'state': 'completed', 'code': 0, 'reason': ''})))
            row = db.execute('SELECT * FROM jobs WHERE id=?', (self.job,)).fetchone()
            with patch.object(worker, 'run_trim_module', side_effect=OSError('injected cleanup failure')):
                worker.finish(db, root, row, 'completed', 0)
            saved = worker.public(db.execute('SELECT * FROM jobs WHERE id=?', (self.job,)).fetchone())
            self.assertEqual((saved['state'], saved['receipt']['exit_code'], saved['reason']), ('completed', 0, ''))
            self.assertEqual(saved['receipt']['spec_sha256'], hashlib.sha256(spec.encode()).hexdigest())
            self.assertEqual(saved['receipt']['log_sha256'], hashlib.sha256(b'').hexdigest())
            self.assertIn('injected cleanup failure', (root / (self.job + '.trim-error.log')).read_text())
            self.assertTrue(self.bulk.exists())

    def test_thales_and_agent_jobs_are_excluded(self):
        with patch.dict(os.environ, {'WIZARD_HEAVY_HOST': 'thales'}):
            self.assertIsNone(self.sweep())
            with self.assertRaisesRegex(ValueError, 'Forum Linux only'):
                trim.prepare(self.base)
        self.assertIsNone(trim.trim(self.base, {**self.spec, 'agent_id': 'other'}, self.job))
        self.assertTrue(self.bulk.exists())

    def test_each_allowlisted_suffix_and_unselected_slots(self):
        self.make_run(slots=('cache',))
        for suffix in trim.SUFFIXES:
            (self.run_dir / 'cache' / ('discard' + suffix)).write_bytes(b'compiled')
        result = self.sweep()
        self.assertEqual({Path(p['path']).suffix for p in result['removed']}, trim.SUFFIXES)
        self.assertTrue(self.bulk.exists())  # unselected build slot

    def test_mutable_manifest_cannot_expand_authority_or_change_weekly_retention(self):
        self.make_run('weekly-launch')
        value = {**self.record, 'purpose': 'ephemeral', 'disposable': ['build', 'results']}
        (self.run_dir / 'run-manifest.json').write_text(json.dumps(value))
        self.assertEqual(self.sweep()['reason'], 'retained_purpose_or_weekly_launch')
        self.assertTrue(self.bulk.exists())

    def test_predelete_intent_is_required_and_failed_audit_retains_bulk(self):
        original = trim.write_new
        def audit(path, value):
            if str(path).endswith('.trim-intent.json'):
                raise OSError('intent disk full')
            return original(path, value)
        with patch.object(trim, 'write_new', side_effect=audit):
            self.assertIn('intent disk full', self.sweep()['reason'])
        self.assertTrue(self.bulk.exists())
        with self.assertRaisesRegex(ValueError, 'no retry'):
            self.sweep()

    def test_all_protected_roots_refused(self):
        for name in trim.FORBIDDEN:
            base = self.base / name; base.mkdir()
            with self.assertRaisesRegex(ValueError, 'protected tree'):
                trim.prepare(base, 'ephemeral', ('build',))
            self.assertEqual(list(base.iterdir()), [])


class ProbeTests(unittest.TestCase):
    def test_privileged_probe_unknowns_and_other_pid_retain(self):
        for code, stdout, stderr, expected in (
                (0, f'p{os.getpid()}\n', '', False), (1, '', '', False),
                (0, 'p1\n', '', True), (0, '', '', True),
                (0, 'garbage', '', True), (1, 'p1\n', '', True),
                (0, f'p{os.getpid()}\n', 'warning', True), (2, '', '', True)):
            with self.subTest(code=code, stdout=stdout, stderr=stderr), patch.object(
                    trim.subprocess, 'run', return_value=subprocess.CompletedProcess([], code, stdout, stderr)) as probe:
                self.assertEqual(trim.process_busy(Path('/nonexistent-fixture')), expected)
                self.assertEqual(probe.call_args.args[0][:5], ['/usr/bin/sudo', '-n', '--', '/usr/bin/lsof', '-nP'])
        for error in (FileNotFoundError('sudo'), subprocess.TimeoutExpired('lsof', 30)):
            with patch.object(trim.subprocess, 'run', side_effect=error):
                self.assertTrue(trim.process_busy(Path('/nonexistent-fixture')))


if __name__ == '__main__':
    unittest.main(verbosity=2)
