#!/usr/bin/env python3
"""Tiny isolated filesystem checks only. Native lifecycle suite is parent-admitted."""
from contextlib import closing
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid

BASE = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


trim = load('run_trim', BASE / 'scripts/heavy-run-trim.py')
worker = load('trim_worker', BASE / 'scripts/heavy-worker.py')


def job_id():
    return 'heavy_' + uuid.uuid4().hex


class TrimTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='run-trim-unit-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        for ctx in (patch.dict(os.environ, {'WIZARD_HEAVY_ROOT': str(self.base), 'WIZARD_HEAVY_HOST': 'forum'}),
                    patch.object(trim, 'process_busy', return_value=False), patch.object(trim, 'loop_busy', return_value=False),
                    patch.object(trim, 'mountpoints', return_value=[])):
            ctx.start(); self.addCleanup(ctx.stop)
        self.make_run()

    def make_run(self, purpose='ephemeral'):
        self.record = trim.prepare(self.base, purpose)
        self.run_dir = Path(self.record['path']); self.job = job_id()
        self.spec = {'cwd': str(self.run_dir), 'argv': ['/usr/bin/true'], 'timeout_seconds': 20, 'host': 'forum'}
        trim.admit(self.base, self.spec, self.job)
        self.bulk = self.put('build/a.o', b'bulk object')

    def put(self, name, value=b'bulk'):
        path = self.run_dir / name; path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value); return path

    def sweep(self, **kwargs):
        return trim.trim(self.base, self.spec, self.job, **kwargs)

    def activate(self):
        policy = trim.stage_policy(self.base)
        trim.enable_policy(self.base)
        return policy

    def new_auto(self, name='future'):
        self.run_dir = self.base / name; self.run_dir.mkdir()
        self.job = job_id(); self.spec = {**self.spec, 'cwd': str(self.run_dir)}
        self.bulk = self.put('source/main.py', b'copied source')
        return trim.admit(self.base, self.spec, self.job)

    def test_all_requested_bulk_classes_and_evidence_precedence(self):
        bulk = ['source/main.py', 'src/a.rs', 'candidate/a.cpp', 'baseline/a.c', 'checkouts/x/a.sh',
                'source-v2/a', 'candidate-abc/a', 'baseline-42/a', 'node_modules/lib/a.js',
                'other/x/node_modules/lib/a.js', 'tmp/arbitrary', 'build/final.apk', 'cache/item',
                'intermediates/data', 'profiles/chrome/Local State', 'profiles/chrome/Default/Preferences',
                'profiles/chrome/Default/History', 'browser-profile/Local State', 'browser-profile/Default/Cookies',
                'guests/linux/disk.qcow2', 'vms/disk.vmdk', 'disposable-vms/disk.raw', 'vms/disk.img',
                'misc/disposable-linux.img']
        keep = ['source/results/a.bin', 'candidate/evidence/unknown.bin', 'baseline/reports/a.bin',
                'node_modules/pkg/evidence/a.js', 'node_modules/pkg/package.json', 'tmp/a.jsonl',
                'build/image.png', 'source/photo.jpg', 'source/photo.webp', 'source/readme.md',
                'node_modules/license.txt', 'tmp/page.html', 'tmp/results.xml', 'build/receipt.bin',
                'build/submission.bin', 'build/admission.bin', 'build/preflight.bin', 'build/log.bin',
                'build/screenshot.bin', 'source/manifest.bin', 'results/bulk.o', 'evidence/keep.bin',
                'reports/a.bin', 'screenshots/a.bin', 'logs/a.bin', 'receipts/a.bin',
                'unknown/owner-tool', 'unknown/disk.qcow2', 'source.tar', 'runner.py',
                'sourceish/a.py', 'profiles/unknown/arbitrary.bin', 'profile/Default/Cookies',
                'source/AndroidBuilds/app.apk', 'source/android-sdk/platform.bin',
                'source/wizard-local/owner.bin', 'source/.wizard-secure/owner.bin']
        for name in bulk + keep:
            self.put(name, b'{}' if name.endswith(('.json', '.jsonl')) else b'preserved bytes')
        hashes = {p: hashlib.sha256((self.run_dir / p).read_bytes()).hexdigest() for p in keep}
        report = self.sweep()
        self.assertEqual(report['status'], 'trimmed', report)
        self.assertTrue(all(not (self.run_dir / p).exists() for p in bulk), report)
        self.assertFalse(self.bulk.exists())
        self.assertEqual(hashes, {p: hashlib.sha256((self.run_dir / p).read_bytes()).hexdigest() for p in keep})
        self.assertEqual(report['before_logical_bytes'] - report['after_logical_bytes'], report['bytes_unlinked'])
        self.assertEqual(report['bytes_unlinked'], sum(p['bytes'] for p in report['removed']))
        registry = trim.roots(self.base)[1]
        self.assertEqual(json.loads((registry / (self.record['run_id'] + '.' + self.job + '.trim.json')).read_text()), report)
        self.assertTrue((registry / (self.record['run_id'] + '.' + self.job + '.trim-intent.json')).exists())

    def test_default_preparation_is_ephemeral_and_broad_without_slots(self):
        record = trim.prepare(self.base)
        self.assertEqual(record['purpose'], 'ephemeral')
        run = Path(record['path']); (run / 'source').mkdir(); (run / 'source/a.py').write_bytes(b'copied')
        spec = {**self.spec, 'cwd': str(run)}; job = job_id(); trim.admit(self.base, spec, job)
        self.assertEqual(trim.trim(self.base, spec, job)['status'], 'trimmed')
        self.assertFalse((run / 'source/a.py').exists())

    def test_automatic_future_admission_without_spec_changes(self):
        policy = self.activate()
        record = self.new_auto()
        self.assertIsNotNone(record)
        self.assertGreater(record['birthtime_ns'], policy['cutoff_ns'])
        self.assertEqual(record['mode'], 'automatic')
        digest = trim.spec_hash(self.spec)
        self.assertEqual(self.sweep()['status'], 'trimmed')
        self.assertFalse(self.bulk.exists()); self.assertEqual(digest, trim.spec_hash(self.spec))

    def test_old_top_levels_and_baseline_names_recreated_are_never_adopted(self):
        old = self.base / 'old'; old.mkdir()
        self.activate()
        old.rmdir(); old.mkdir()
        self.run_dir = old / 'new-child'; self.run_dir.mkdir(); self.bulk = self.put('source/x.py')
        self.spec['cwd'] = str(self.run_dir)
        self.assertIsNone(trim.admit(self.base, self.spec, job_id()))
        self.assertIsNone(self.sweep()); self.assertTrue(self.bulk.exists())
        self.spec['cwd'] = str(old)
        self.assertIsNone(trim.admit(self.base, self.spec, job_id()))
        self.assertTrue(self.bulk.exists())

    def test_no_activation_unknown_birthtime_and_pre_cutoff_retain(self):
        self.assertIsNone(self.new_auto('disabled')); self.assertTrue(self.bulk.exists())
        self.activate()
        for name, btime in [('unsupported', None), ('equal-cutoff', trim.active_policy(self.base)['cutoff_ns']), ('old-btime', 1)]:
            with self.subTest(name=name), patch.object(trim, 'birthtime_ns', return_value=btime):
                self.assertIsNone(self.new_auto(name)); self.assertIsNone(self.sweep())
                self.assertTrue(self.bulk.exists())

    def test_policy_disabled_until_enabled_immutable_and_release_bound(self):
        trim.stage_policy(self.base)
        self.assertIsNone(self.new_auto('before-enable'))
        trim.enable_policy(self.base)
        with self.assertRaises(FileExistsError):
            trim.stage_policy(self.base)
        with patch.object(trim, 'release_hashes', return_value={}):
            self.assertIsNone(self.new_auto('wrong-release'))
        registry = trim.roots(self.base)[1]
        value = json.loads((registry / 'activation.json').read_text()); value['device'] += 1
        (registry / 'activation.json').write_text(json.dumps(value))
        self.assertIsNone(self.new_auto('changed-policy'))

    def test_canonical_nonlink_same_device_and_reserved_exclusions(self):
        self.activate()
        real = self.base / 'real'; real.mkdir(); (real / 'source').mkdir()
        alias = self.base / 'alias'; alias.symlink_to(real, target_is_directory=True)
        spec = {**self.spec, 'cwd': str(alias)}
        self.assertIsNone(trim.admit(self.base, spec, job_id()))
        self.assertIsNone(trim.admit(self.base, {**spec, 'cwd': str(real)}, job_id(), raw_cwd=str(alias)))
        for name in trim.RESERVED:
            target = self.base / name; target.mkdir(exist_ok=True)
            self.assertIsNone(trim.admit(self.base, {**self.spec, 'cwd': str(target)}, job_id()))
        target = self.base / 'cross-device'; target.mkdir()
        policy = trim.active_policy(self.base)
        with patch.object(trim, 'active_policy', return_value={**policy, 'device': policy['device'] + 1}):
            self.assertIsNone(trim.admit(self.base, {**self.spec, 'cwd': str(target)}, job_id()))

    def test_record_identity_and_birthtime_replacement_retain(self):
        self.activate(); self.record = self.new_auto()
        with patch.object(trim, 'birthtime_ns', return_value=self.record['birthtime_ns'] + 1):
            self.assertIsNone(self.sweep()); self.assertTrue(self.bulk.exists())
        old = self.run_dir.with_name('renamed'); self.run_dir.rename(old); self.run_dir.mkdir()
        with self.assertRaisesRegex(ValueError, 'ownership identity mismatch'):
            self.sweep()
        self.assertTrue((old / 'source/main.py').exists())

    def test_old_unregistered_and_v1_prepared_records_are_frozen(self):
        legacy = self.base / 'legacy'; legacy.mkdir(); (legacy / 'bulk.o').write_bytes(b'old')
        self.assertIsNone(trim.trim(self.base, {**self.spec, 'cwd': str(legacy)}, self.job))
        registry = trim.roots(self.base)[1]
        value = {**self.record, 'version': 1}
        (registry / (self.record['run_id'] + '.json')).write_text(json.dumps(value))
        self.assertIsNone(self.sweep()); self.assertIsNone(trim.run_lease(self.base, self.spec))
        self.assertTrue(self.bulk.exists())

    def test_retain_purposes_markers_and_manifest_flag(self):
        for purpose in ('retained', 'weekly-launch'):
            self.make_run(purpose); self.assertEqual(self.sweep()['status'], 'retained'); self.assertTrue(self.bulk.exists())
        for name, data in [('RETAIN', b''), ('.retain', b''), ('manifest.json', b'{"retain":true}')]:
            self.make_run(); self.put(name, data)
            self.assertEqual(self.sweep()['status'], 'retained'); self.assertTrue(self.bulk.exists())

    def test_weekly_argv_cwd_and_mutable_manifest_cannot_relax_retention(self):
        for token in ('WEEKLY/LAUNCH', 'weekly_launch', 'weekly-launch'):
            record = trim.prepare(self.base); run = Path(record['path'])
            (run / 'build').mkdir(); obj = run / 'build/a'; obj.write_bytes(b'keep')
            spec = {**self.spec, 'cwd': str(run), 'argv': ['/usr/bin/true', token]}; job = job_id()
            trim.admit(self.base, spec, job)
            self.assertEqual(trim.trim(self.base, spec, job)['status'], 'retained'); self.assertTrue(obj.exists())
        self.make_run('weekly-launch')
        (self.run_dir / 'run-manifest.json').write_text('{"purpose":"ephemeral"}')
        self.assertEqual(self.sweep()['status'], 'retained'); self.assertTrue(self.bulk.exists())
        self.activate(); self.record = self.new_auto('weekly-launch-fixture')
        self.assertEqual(self.sweep()['status'], 'retained'); self.assertTrue(self.bulk.exists())

    def test_explicit_paths_local_and_native_log_references_keep_subtrees(self):
        paths = ['build/explicit.bin', 'build/explicit-dir/a', 'source/relative.bin', 'source/absolute.bin',
                 'candidate/linked/a', 'baseline/native/a', 'node_modules/printed.bin']
        for name in paths:
            self.put(name)
        self.put('retain.json', json.dumps({'paths': ['build/explicit.bin', 'build/explicit-dir']}).encode())
        self.put('evidence.json', json.dumps({'r': 'source/relative.bin', 'a': str(self.run_dir / 'source/absolute.bin'),
                                           'directory': 'candidate/linked/'}).encode())
        log = self.base / 'native-job.log'
        log.write_text('published baseline/native/ and node_modules/printed.bin\n')
        self.assertEqual(self.sweep(evidence_paths=(log,))['status'], 'trimmed')
        self.assertTrue(all((self.run_dir / p).exists() for p in paths)); self.assertFalse(self.bulk.exists())

    def test_nonstandard_retained_text_references_and_manifest_flag(self):
        linked = self.put('source/linked.bin')
        self.put('reports/brief.data', b'Published source/linked.bin\n')
        self.assertEqual(self.sweep()['status'], 'trimmed'); self.assertTrue(linked.exists())
        self.make_run(); self.put('manifest.data', b'{"retain":true}')
        self.assertEqual(self.sweep()['status'], 'retained'); self.assertTrue(self.bulk.exists())

    def test_malformed_retention_oversized_or_unreadable_text_fails_closed(self):
        for name, value in [('retain.json', b'{"paths":["../out"]}'), ('source/a.json', b'\xff'),
                            ('manifest.json', b'{"retain":'), ('retain.json', b'{"paths":"wrong"}')]:
            self.make_run(); self.put(name, value)
            self.assertEqual(self.sweep()['status'], 'skipped'); self.assertTrue(self.bulk.exists())
        self.make_run()
        with self.put('source/evidence.txt').open('wb') as stream:
            stream.truncate(8 * 1024 * 1024 + 1)
        self.assertIn('reference scan limit', self.sweep()['reason']); self.assertTrue(self.bulk.exists())

    def test_links_never_followed_and_hardlinks_left_while_other_bulk_deleted(self):
        outside = self.base / 'outside'; outside.mkdir(); sentinel = outside / 'a'; sentinel.write_bytes(b'outside')
        self.put('source/linked-file').unlink(); (self.run_dir / 'source/linked-file').symlink_to(sentinel)
        (self.run_dir / 'source/external-dir').symlink_to(outside, target_is_directory=True)
        os.link(self.bulk, outside / 'hardlinked')
        removable = self.put('tmp/discard')
        self.assertEqual(self.sweep()['status'], 'trimmed')
        self.assertTrue(self.bulk.exists()); self.assertFalse(removable.exists())
        self.assertEqual(sentinel.read_bytes(), b'outside'); self.assertTrue((self.run_dir / 'source/external-dir').is_symlink())

    def test_linked_text_evidence_special_files_and_mounts_block(self):
        outside = self.base / 'outside.txt'; outside.write_text('outside')
        (self.run_dir / 'evidence.txt').symlink_to(outside)
        self.assertEqual(self.sweep()['status'], 'skipped'); self.assertTrue(self.bulk.exists())
        self.make_run(); os.mkfifo(self.run_dir / 'pipe')
        self.assertEqual(self.sweep()['status'], 'skipped'); self.assertTrue(self.bulk.exists())
        for suffix in ('', '/build', '/build/a.o'):
            self.make_run()
            with patch.object(trim, 'mountpoints', return_value=[Path(str(self.run_dir) + suffix)]):
                self.assertEqual(self.sweep()['reason'], 'mounted_tree'); self.assertTrue(self.bulk.exists())

    def test_live_execution_lease_busy_process_and_loop_fail_closed(self):
        lease = trim.run_lease(self.base, self.spec)
        try:
            self.assertEqual(self.sweep()['status'], 'skipped'); self.assertTrue(self.bulk.exists())
        finally:
            os.close(lease)
        for probe, reason in [('process_busy', 'process_busy_or_unknown'), ('loop_busy', 'loop_busy_or_unknown')]:
            self.make_run()
            with patch.object(trim, probe, return_value=True):
                self.assertEqual(self.sweep()['reason'], reason); self.assertTrue(self.bulk.exists())

    def test_second_job_and_cross_lane_share_is_permanently_retained_not_rejected(self):
        trim.admit(self.base, self.spec, self.job)  # exact duplicate idempotent
        other = job_id(); spec = {**self.spec, 'lane': 'light'}
        trim.admit(self.base, spec, other)
        self.assertEqual(self.sweep()['reason'], 'multiple_submissions_permanent_retention')
        self.assertEqual(trim.trim(self.base, spec, other)['reason'], 'multiple_submissions_permanent_retention')
        self.assertTrue(self.bulk.exists())
        another = job_id(); trim.admit(self.base, self.spec, another)
        self.assertEqual(trim.trim(self.base, self.spec, another)['status'], 'retained')

    def test_rpc_queued_cross_lane_admissions_and_unchanged_spec_hash(self):
        spool = self.base / 'spool'; lock = self.base / 'worker.lock'
        with patch.object(worker, 'ensure_dispatchers'), patch.object(worker, 'run_trim_module', return_value=trim):
            first = worker.rpc(spool, lock, {'action': 'submit', 'job_id': self.job, 'spec': self.spec})
            other = job_id(); spec = {**self.spec, 'lane': 'light'}
            second = worker.rpc(spool, lock, {'action': 'submit', 'job_id': other, 'spec': spec})
            self.assertEqual((first['state'], second['state']), ('queued', 'queued'))
            with closing(worker.connect(spool)) as db:
                value = db.execute('SELECT spec FROM jobs WHERE id=?', (self.job,)).fetchone()[0]
                self.assertEqual(hashlib.sha256(value.encode()).hexdigest(), trim.spec_hash(self.spec))
        self.assertEqual(self.sweep()['status'], 'retained'); self.assertTrue(self.bulk.exists())

    def test_exact_native_fixture_bulk_and_evidence_contract(self):
        fixture = load('fixture', BASE / 'scripts/heavy-run-trim-fixture.py')
        seeded = fixture.seed(self.run_dir, bytes_per_file=17)
        log = self.base / 'native.log'; log.write_text('published source/published.bin\n')
        report = self.sweep(evidence_paths=(log,))
        self.assertEqual(report['status'], 'trimmed', report)
        self.assertTrue(all(not (self.run_dir / p).exists() for p in seeded['bulk']))
        self.assertEqual(seeded['retained_sha256'], {
            p: hashlib.sha256((self.run_dir / p).read_bytes()).hexdigest() for p in seeded['retained_sha256']})

    def test_second_canonicalized_alias_and_foreign_cwd_argv_reference_pin_existing_root(self):
        trim.admit(self.base, self.spec, job_id(), raw_cwd=str(self.base / 'alias'))
        self.assertEqual(self.sweep()['reason'], 'multiple_submissions_permanent_retention')
        self.make_run()
        foreign = self.base / 'legacy-cwd'; foreign.mkdir()
        spec = {**self.spec, 'cwd': str(foreign), 'argv': ['/usr/bin/python3', str(self.run_dir / 'source/main.py')]}
        self.assertIsNone(trim.admit(self.base, spec, job_id()))
        self.assertEqual(self.sweep()['reason'], 'multiple_submissions_permanent_retention')
        self.assertTrue(self.bulk.exists())

    def test_document_relative_and_native_cwd_relative_links(self):
        keep = self.put('source/assets/linked.bin')
        self.put('source/README.md', b'[asset](assets/linked.bin)')
        native = self.put('candidate/published/a.bin')
        self.spec['cwd'] = str(self.run_dir / 'candidate')
        # Unit fixture resets only its own synthetic admissions before first use.
        registry = trim.roots(self.base)[1]
        for path in registry.glob(self.record['run_id'] + '*.admission.json'): path.unlink()
        trim.admit(self.base, self.spec, self.job)
        log = self.base / 'native.log'; log.write_text('published/a.bin\n')
        self.assertEqual(self.sweep(evidence_paths=(log,))['status'], 'trimmed')
        self.assertTrue(keep.exists() and native.exists()); self.assertFalse(self.bulk.exists())

    def test_global_registry_lock_serializes_new_admission_against_final_unlink(self):
        entered = threading.Event(); release = threading.Event(); admitted = threading.Event(); errors = []
        def probe(_):
            entered.set(); self.assertTrue(release.wait(3)); return False
        def sweep():
            try: self.sweep()
            except Exception as error: errors.append(error)
        def submit():
            try: trim.admit(self.base, {**self.spec, 'lane': 'light'}, job_id()); admitted.set()
            except Exception as error: errors.append(error)
        with patch.object(trim, 'process_busy', side_effect=probe):
            first = threading.Thread(target=sweep); first.start(); self.assertTrue(entered.wait(3))
            second = threading.Thread(target=submit); second.start()
            self.assertFalse(admitted.wait(0.05))
            release.set(); first.join(3); second.join(3)
        self.assertFalse(first.is_alive() or second.is_alive()); self.assertEqual(errors, [])
        self.assertTrue(admitted.is_set())  # later reuse permitted, prior source may be gone (documented)

    def test_identity_or_symlink_parent_race_never_unlinks_outside(self):
        outside = self.base / 'outside'; outside.mkdir(); sentinel = outside / 'a.o'; sentinel.write_bytes(b'keep')
        expected = self.bulk.stat(); fd = os.open(self.run_dir, os.O_RDONLY | os.O_DIRECTORY)
        try:
            (self.run_dir / 'build').rename(self.run_dir / 'old-build')
            (self.run_dir / 'build').symlink_to(outside, target_is_directory=True)
            with self.assertRaises(OSError): trim.unlink_same(fd, 'build/a.o', expected)
        finally:
            os.close(fd)
        self.assertEqual(sentinel.read_bytes(), b'keep'); self.assertTrue((self.run_dir / 'old-build/a.o').exists())

    def test_intent_fsync_failure_vetoes_unlink_and_no_retry(self):
        original = trim.write_new
        def failing(path, value):
            if str(path).endswith('.trim-intent.json'): raise OSError('intent disk full')
            return original(path, value)
        with patch.object(trim, 'write_new', side_effect=failing):
            self.assertIn('intent disk full', self.sweep()['reason'])
        self.assertTrue(self.bulk.exists())
        with self.assertRaisesRegex(ValueError, 'no retry'): self.sweep()

    def test_partial_unlink_failure_is_reported_and_never_retried(self):
        self.put('tmp/extra'); original = trim.unlink_same; calls = []
        def failing(*args):
            calls.append(args[1])
            if len(calls) > 1: raise OSError('injected failure')
            return original(*args)
        with patch.object(trim, 'unlink_same', side_effect=failing):
            report = self.sweep()
        self.assertEqual(report['status'], 'partial'); self.assertEqual(len(report['removed']), 1)
        with self.assertRaisesRegex(ValueError, 'no retry'): self.sweep()

    def test_cleanup_failure_never_changes_native_success_or_failure_receipts(self):
        for state, code in [('completed', 0), ('failed', 7)]:
            root = self.base / state
            with closing(worker.connect(root)) as db:
                spec = json.dumps(self.spec, sort_keys=True, separators=(',', ':'))
                db.execute('INSERT INTO jobs(id,spec,state,created,updated,execution_result) VALUES(?,?,?,?,?,?)',
                           (self.job, spec, 'running', 1, 1, json.dumps({'state': state, 'code': code, 'reason': ''})))
                row = db.execute('SELECT * FROM jobs WHERE id=?', (self.job,)).fetchone()
                with patch.object(worker, 'run_trim_module', side_effect=OSError('injected trim failure')):
                    worker.finish(db, root, row, state, code)
                saved = worker.public(db.execute('SELECT * FROM jobs WHERE id=?', (self.job,)).fetchone())
                self.assertEqual((saved['state'], saved['receipt']['exit_code'], saved['reason']), (state, code, ''))
                self.assertEqual(saved['receipt']['spec_sha256'], hashlib.sha256(spec.encode()).hexdigest())
                self.assertIn('injected trim failure', (root / (self.job + '.trim-error.log')).read_text())
                self.assertTrue(self.bulk.exists())

    def test_thales_agent_jobs_and_protected_base_excluded(self):
        with patch.dict(os.environ, {'WIZARD_HEAVY_HOST': 'thales'}):
            self.assertIsNone(self.sweep())
            with self.assertRaisesRegex(ValueError, 'Forum Linux only'): trim.prepare(self.base)
        self.assertIsNone(trim.trim(self.base, {**self.spec, 'agent_id': 'other'}, self.job))
        for name in trim.FORBIDDEN:
            base = self.base / name; base.mkdir()
            with self.assertRaisesRegex(ValueError, 'protected tree'): trim.prepare(base)
            self.assertEqual(list(base.iterdir()), [])


class ProbeTests(unittest.TestCase):
    def test_real_linux_statx_birthtime_has_no_timestamp_substitute(self):
        with tempfile.TemporaryDirectory() as directory:
            before = time.time_ns(); path = Path(directory) / 'new'; path.mkdir()
            birth = trim.birthtime_ns(path)
            self.assertIsNotNone(birth, 'fixture filesystem must support statx btime')
            self.assertGreaterEqual(birth, before - 1_000_000_000)
            self.assertLessEqual(birth, time.time_ns())
        self.assertIsNone(trim.birthtime_ns('/not/a/real/directory'))

    def test_privileged_process_probe_diagnostics_are_fail_closed(self):
        for code, out, err, expected in [(0, f'p{os.getpid()}\n', '', False), (1, '', '', False),
                (0, 'p1\n', '', True), (0, '', '', True), (0, 'garbage', '', True),
                (1, 'p1\n', '', True), (0, f'p{os.getpid()}\n', 'warning', True), (2, '', '', True)]:
            with self.subTest(out=out, err=err), patch.object(trim.subprocess, 'run', return_value=subprocess.CompletedProcess([], code, out, err)):
                self.assertEqual(trim.process_busy(Path('/fixture')), expected)
        with patch.object(trim.subprocess, 'run', side_effect=FileNotFoundError()):
            self.assertTrue(trim.process_busy(Path('/fixture')))

    def test_loop_backing_probe_inside_outside_unknown_and_errors(self):
        for output, error, expected in [('{"loopdevices":[]}', '', False),
                ('{"loopdevices":[{"back-file":"/outside/disk.img"}]}', '', False),
                ('{"loopdevices":[{"back-file":"/fixture/vms/disk.img"}]}', '', True),
                ('{"loopdevices":[{"back-file":"/fixture/vms/disk.img (deleted)"}]}', '', True),
                ('{"loopdevices":[{}]}', '', True), ('bad json', '', True), ('{"loopdevices":[]}', 'warning', True)]:
            with self.subTest(output=output), patch.object(trim.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, output, error)):
                self.assertEqual(trim.loop_busy(Path('/fixture')), expected)
        with patch.object(trim.subprocess, 'run', side_effect=subprocess.TimeoutExpired('losetup', 15)):
            self.assertTrue(trim.loop_busy(Path('/fixture')))


if __name__ == '__main__':
    unittest.main(verbosity=2)
