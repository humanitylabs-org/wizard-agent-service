#!/usr/bin/env python3
"""Tiny synthetic rollout adapter tests; NEVER invoke SSH/systemctl/admission."""
from contextlib import closing
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
loader = importlib.util.spec_from_file_location('rollout', ROOT / 'ops/rollout-heavy-run-trim.py')
assert loader is not None and loader.loader is not None
rollout = importlib.util.module_from_spec(loader); loader.loader.exec_module(rollout)


class RolloutTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix='rollout-unit-'); self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name).resolve(); (self.base / 'heavy/production/spool').mkdir(parents=True)
        self.old = self.base / 'old-existing'; self.old.mkdir()
        self.sentinel = self.old / 'owner.bin'; self.sentinel.write_bytes(b'existing bytes unchanged')
        self.paused = False; self.pointers = {'rpc': '/old/worker.py', 'supervisor': '/old/worker.py'}
        self.events = []; self.failure = None
        adapters = {key: ['/adapter', key] for key in ('pause', 'resume', 'gate_read')}
        adapters.update({key: {action: ['/adapter', key, action] for action in ('read', 'set', 'reload', 'attest')}
                         for key in ('rpc', 'supervisor')})
        self.plan = {'base': str(self.base), 'spool': str(self.base / 'heavy/production/spool'),
                     'lock': str(self.base / 'heavy/production/worker.lock'), 'source_scripts': str(ROOT / 'scripts'),
                     'release_dir': str(self.base / 'heavy/releases/new-sealed'), 'audit_dir': str(self.base / 'heavy/audit/new'),
                     'release_hashes': {n: hashlib.sha256((ROOT / 'scripts' / n).read_bytes()).hexdigest()
                                        for n in ('heavy-worker.py', 'heavy-run-trim.py')}, 'adapters': adapters}
        ctx = patch.dict(os.environ, {'WIZARD_HEAVY_HOST': 'forum', 'WIZARD_HEAVY_ROOT': str(self.base)})
        ctx.start(); self.addCleanup(ctx.stop)
        mock = patch.object(rollout, 'command', side_effect=self.adapter); mock.start(); self.addCleanup(mock.stop)

    def adapter(self, argv, payload=None):
        key = argv[1]; action = argv[2] if len(argv) > 2 else None
        self.events.append((key, action, payload))
        if key == 'pause': self.paused = True; return {'paused': True}
        if key == 'resume': self.paused = False; return {'paused': False}
        if key == 'gate_read': return {'paused': self.paused}
        if action == 'read': return {'target': self.pointers[key]}
        if action == 'set':
            self.assertEqual(self.pointers[key], payload['expected'])
            self.pointers[key] = payload['target']
            if self.failure == key + '-set': self.failure = None; raise RuntimeError('ambiguous update failure')
            return {'set': True}
        if action == 'reload': return {'reloaded': True}
        if action == 'attest':
            if self.failure == key + '-attest': return {'target': '/wrong/worker.py', 'release_hashes': {}}
            trim = rollout.load_trim(ROOT / 'scripts')
            self.assertIsNone(trim.active_policy(self.base), 'no activation before both attestations')
            self.assertTrue(self.paused)
            return {'target': self.pointers[key], 'release_hashes': self.plan['release_hashes']}
        raise AssertionError(argv)

    def busy_db(self, spool):
        spool.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(spool / 'jobs.sqlite3')
        db.execute('CREATE TABLE jobs(id TEXT,state TEXT)'); db.execute("INSERT INTO jobs VALUES('active','running')")
        db.commit(); db.close()

    def test_check_is_read_only_and_no_adapters_with_side_effects(self):
        result = rollout.rollout(self.plan)
        self.assertFalse(result['applied']); self.assertFalse((self.base / 'heavy/run-ownership-v1').exists())
        self.assertFalse(Path(self.plan['release_dir']).exists())
        self.assertEqual([(e[0], e[1]) for e in self.events], [('rpc', 'read'), ('supervisor', 'read')])

    def test_idle_rollout_orders_epoch_both_exact_pointers_attestation_then_enable(self):
        result = rollout.rollout(self.plan, apply=True)
        self.assertTrue(result['applied']); self.assertFalse(self.paused)
        target = str(Path(self.plan['release_dir']) / 'heavy-worker.py')
        self.assertEqual(set(self.pointers.values()), {target})
        trim = rollout.load_trim(ROOT / 'scripts'); policy = trim.active_policy(self.base)
        self.assertIsNotNone(policy); self.assertIn('old-existing', policy['baseline_names'])
        self.assertEqual(self.sentinel.read_bytes(), b'existing bytes unchanged')
        self.assertEqual(json.loads((Path(self.plan['audit_dir']) / 'before.json').read_text()),
                         {'rpc': {'target': '/old/worker.py'}, 'supervisor': {'target': '/old/worker.py'}})
        self.assertEqual([e[0] for e in self.events if e[1] == 'attest'], ['rpc', 'supervisor'])
        with self.assertRaisesRegex(ValueError, 'NEW'): rollout.rollout(self.plan, apply=True)

    def test_all_old_spools_busy_fail_before_pause_or_baseline(self):
        for name in ('', 'light', 'agent-sandbox-v1', 'agent-sandbox-v1/light'):
            with self.subTest(name=name):
                root = Path(self.plan['spool']); db = root / name / 'jobs.sqlite3'
                self.busy_db(root / name)
                with self.assertRaisesRegex(RuntimeError, 'not idle'): rollout.rollout(self.plan, apply=True)
                self.assertEqual(self.events, []); self.assertFalse(self.paused)
                self.assertFalse((self.base / 'heavy/run-ownership-v1').exists()); db.unlink()

    def test_ambiguous_pointer_failure_restores_only_our_exact_settings_and_leaves_paused(self):
        self.failure = 'supervisor-set'
        with self.assertRaisesRegex(RuntimeError, 'ambiguous'): rollout.rollout(self.plan, apply=True)
        self.assertEqual(set(self.pointers.values()), {'/old/worker.py'}); self.assertTrue(self.paused)
        trim = rollout.load_trim(ROOT / 'scripts'); self.assertIsNone(trim.active_policy(self.base))
        self.assertTrue((trim.roots(self.base)[1] / 'activation.json').exists())
        self.assertTrue((Path(self.plan['audit_dir']) / 'failed.json').exists())
        self.assertEqual(self.sentinel.read_bytes(), b'existing bytes unchanged')

    def test_wrong_effective_release_rolls_back_both_and_never_enables(self):
        self.failure = 'supervisor-attest'
        with self.assertRaisesRegex(RuntimeError, 'effective running release mismatch'): rollout.rollout(self.plan, apply=True)
        self.assertEqual(set(self.pointers.values()), {'/old/worker.py'}); self.assertTrue(self.paused)
        trim = rollout.load_trim(ROOT / 'scripts'); self.assertIsNone(trim.active_policy(self.base))
        self.assertFalse((trim.roots(self.base)[1] / 'enabled.json').exists())

    def test_ambiguous_enable_failure_removes_only_its_marker_and_restores_pointers(self):
        trim = rollout.load_trim(ROOT / 'scripts'); original = trim.enable_policy
        def failing(base):
            original(base)
            raise OSError('enable publication acknowledgment failed')
        with patch.object(rollout, 'load_trim', return_value=trim), patch.object(trim, 'enable_policy', side_effect=failing):
            with self.assertRaisesRegex(OSError, 'acknowledgment'):
                rollout.rollout(self.plan, apply=True)
        self.assertIsNone(trim.active_policy(self.base)); self.assertTrue(self.paused)
        self.assertEqual(set(self.pointers.values()), {'/old/worker.py'})
        self.assertFalse((trim.roots(self.base)[1] / 'enabled.json').exists())
        self.assertTrue((trim.roots(self.base)[1] / 'activation.json').exists())

    def test_source_seal_and_out_of_scope_destinations_refused(self):
        self.plan['release_hashes']['heavy-worker.py'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'source seal'): rollout.rollout(self.plan, apply=True)
        self.assertEqual(self.events, [])
        self.plan['release_dir'] = str(self.old)
        with self.assertRaisesRegex(ValueError, 'under heavy'): rollout.rollout(self.plan, apply=True)
        self.assertEqual(self.sentinel.read_bytes(), b'existing bytes unchanged')


if __name__ == '__main__': unittest.main(verbosity=2)
