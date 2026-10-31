#!/usr/bin/env python3
"""Synthetic unit contracts. Real image execution is a separate Forum acceptance."""
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops/agent-runtime'))
import history_schema as s
import hermes_import as h
import restricted_import as r


class Schema30Runtime(h.DockerRuntime):
    def history_schema_version(self):
        return 30
    def preflight(self):
        pass
    def stop(self):
        pass
    def remove(self):
        pass
    def start(self):
        raise AssertionError('must refuse before startup')
    def import_archive(self, archive):
        raise AssertionError('must refuse before native import')


class HistorySchemaTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='schema-unit-')
        self.root = Path(self.tmp.name)
        self.home = self.root / 'owner' / '.hermes'
        self.home.mkdir(parents=True)
        (self.home / 'config.yaml').write_text('model:\n  provider: synthetic\n  default: synthetic\n')
    def tearDown(self):
        self.tmp.cleanup()
    def make_db(self, version=31):
        with closing(sqlite3.connect(self.home / 'state.db')) as db:
            db.executescript('CREATE TABLE schema_version(version INTEGER); CREATE TABLE sessions(id TEXT); CREATE TABLE messages(id INTEGER);')
            db.execute('INSERT INTO schema_version VALUES (?)', (version,))
            db.commit()
    def snapshot(self):
        return {p.name: (p.stat().st_ino, p.read_bytes()) for p in self.home.iterdir() if p.is_file()}
    def test_newer_refused_without_bytes_or_inode_changes(self):
        self.make_db()
        before = self.snapshot()
        with self.assertRaisesRegex(s.HistorySchemaFailure, '^history_schema_newer_than_runtime$'):
            s.require_supported(self.home, 30)
        self.assertEqual(before, self.snapshot())
    def test_equal_and_older_pass_without_rewriting(self):
        for target in (31, 32):
            if not (self.home / 'state.db').exists():
                self.make_db()
            before = self.snapshot()
            self.assertEqual(s.require_supported(self.home, target), 31)
            self.assertEqual(before, self.snapshot())
    def test_missing_store_is_fresh(self):
        self.assertIsNone(s.require_supported(self.home, 30))
        self.assertFalse((self.home / 'state.db').exists())
    def test_existing_store_without_version_fails_closed(self):
        with closing(sqlite3.connect(self.home / 'state.db')) as db:
            db.execute('CREATE TABLE sessions(id TEXT)')
            db.commit()
        with self.assertRaisesRegex(s.HistorySchemaFailure, '^history_schema_unknown$'):
            s.require_supported(self.home, 30)
    def test_unknown_target_fails_closed(self):
        for version in (None, True, 0, '31'):
            with self.subTest(version=version), self.assertRaisesRegex(s.HistorySchemaFailure, '^runtime_history_schema_unknown$'):
                s.require_supported(self.home, version)
    def test_nonempty_recovery_sidecars_refused(self):
        self.make_db()
        for suffix in ('-wal', '-journal'):
            sidecar = self.home / ('state.db' + suffix)
            sidecar.write_bytes(b'not-safe-to-ignore')
            before = self.snapshot()
            with self.assertRaisesRegex(s.HistorySchemaFailure, '^history_schema_checkpoint_required$'):
                s.require_supported(self.home, 31)
            self.assertEqual(before, self.snapshot())
            sidecar.unlink()
    def test_symlink_and_invalid_db_refused(self):
        path = self.home / 'state.db'
        path.symlink_to('config.yaml')
        with self.assertRaisesRegex(s.HistorySchemaFailure, '^history_schema_not_regular$'):
            s.schema_version(self.home)
        path.unlink()
        path.write_bytes(b'not sqlite')
        with self.assertRaisesRegex(s.HistorySchemaFailure, '^history_schema_invalid$'):
            s.schema_version(self.home)
    def test_multiple_version_rows_refused(self):
        self.make_db()
        with closing(sqlite3.connect(self.home / 'state.db')) as db:
            db.execute('INSERT INTO schema_version VALUES (30)')
            db.commit()
        with self.assertRaisesRegex(s.HistorySchemaFailure, '^history_schema_invalid$'):
            s.schema_version(self.home)
    def test_target_probe_no_source_mounts_and_cleanup_on_timeout(self):
        calls = []
        def command(argv, **kw):
            calls.append(argv)
            if argv[1] == 'run':
                raise h.ImportFailure('command_unavailable_or_timeout')
            if argv[1] == 'ps':
                return 'fixture' if not any(c[1] == 'rm' for c in calls) else ''
            return ''
        runtime = h.DockerRuntime({'image': 'synthetic:unit'}, self.root, 'fixture')
        with patch.object(h, 'run', side_effect=command), self.assertRaisesRegex(h.ImportFailure, 'command_unavailable_or_timeout'):
            runtime.history_schema_version()
        argv = calls[0]
        self.assertNotIn('--mount', argv)
        self.assertEqual(argv[argv.index('--network') + 1], 'none')
        self.assertIn('--read-only', argv)
        self.assertTrue(any(c[1] == 'rm' for c in calls))
    def test_target_probe_rejects_malformed_output(self):
        runtime = h.DockerRuntime({'image': 'synthetic:unit'}, self.root, 'fixture')
        for output in ('[]', '[[true]]', '[[0]]', '[[30],[31]]'):
            with patch.object(h, 'run', side_effect=lambda argv, **kw: output if argv[1] == 'run' else ''), self.assertRaises(h.ImportFailure):
                runtime.history_schema_version()
    @unittest.skipUnless(sys.platform.startswith('linux'), 'requires stopped-writer census')
    def test_move_refused_before_rename_or_wiring(self):
        self.make_db()
        plan = h.scan(self.home, owner_home=self.home.parent)
        plan.update(move=True, gateway_url='http://edge:8923/wizard/mcp')
        h.approve(plan)
        before = self.snapshot()
        with self.assertRaisesRegex(h.ImportFailure, '^history_schema_newer_than_runtime$'):
            h.apply(plan, 'schema-fixture', self.root / 'wizard', runtime_factory=Schema30Runtime)
        self.assertEqual(before, self.snapshot())
        journal = json.loads((self.root / 'wizard/agents/schema-fixture/import-journal.json').read_text())
        self.assertFalse(journal['moved'])
        self.assertFalse((self.home / 'WIZARD-IMPORTED.json').exists())
    def test_archive_refused_before_native_cli(self):
        self.make_db()
        archive = self.root / 'fixture.zip'
        with zipfile.ZipFile(archive, 'w') as z:
            for p in self.home.iterdir():
                z.write(p, p.name)
        plan = h.scan(archive, owner_home=self.home.parent)
        plan.update(move=False, gateway_url='http://edge:8923/wizard/mcp')
        h.approve(plan)
        before = archive.read_bytes()
        with self.assertRaisesRegex(h.ImportFailure, '^history_schema_newer_than_runtime$'):
            h.apply(plan, 'schema-fixture', self.root / 'wizard', runtime_factory=Schema30Runtime)
        self.assertEqual(before, archive.read_bytes())
    def test_archive_sidecar_is_not_silently_filtered(self):
        self.make_db(30)
        archive = self.root / 'fixture.zip'
        with zipfile.ZipFile(archive, 'w') as z:
            z.write(self.home / 'config.yaml', 'config.yaml')
            z.write(self.home / 'state.db', 'state.db')
            z.writestr('state.db-wal', b'pending')
        runtime = Schema30Runtime({}, self.root, 'fixture')
        with self.assertRaisesRegex(h.ImportFailure, '^history_schema_checkpoint_required$'):
            runtime.check_archive_history(archive)
    def test_restricted_runtime_delegates_both_checks(self):
        runtime = r.StagingRuntime({}, self.root, 'fixture')
        for method, value in [('check_history', self.home), ('check_archive_history', self.root / 'fixture.zip')]:
            with patch.object(h.DockerRuntime, method, return_value=31) as checked:
                self.assertEqual(getattr(runtime, method)(value), 31)
                checked.assert_called_once_with(value)


if __name__ == '__main__':
    unittest.main()
