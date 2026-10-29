#!/usr/bin/env python3
"""Generic scan preserves synthetic source files/inodes; no Docker or owner data."""
from contextlib import closing
import hashlib
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops/agent-runtime'))
import hermes_import as h


class ScanPreservationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.owner = Path(self.tmp.name) / 'owner'
        self.home = self.owner / '.hermes'
        self.home.mkdir(parents=True)
        (self.home / 'config.yaml').write_text('model: {provider: synthetic, default: synthetic}\n')
        self.db = self.home / 'state.db'

    def snapshot(self, root=None):
        root = root or self.home
        return {str(p.relative_to(root)): {'inode': p.stat().st_ino,
                'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
                for p in root.rglob('*') if p.is_file()}

    def create(self, journal='WAL'):
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute('PRAGMA journal_mode=' + journal).fetchone()[0], journal.lower())
            db.executescript('CREATE TABLE sessions(id TEXT); INSERT INTO sessions VALUES ("base");')
            db.commit()
        self.assertFalse(Path(str(self.db) + '-wal').exists())
        self.assertFalse(Path(str(self.db) + '-shm').exists())

    def scan_preserved(self, source=None):
        before = self.snapshot(self.owner)
        plan = h.scan(source or self.home, owner_home=self.owner)
        # Check exact regular-file membership, content AND inodes before checking
        # the estimate. The old head fails here by creating WAL/SHM sidecars.
        self.assertEqual(before, self.snapshot(self.owner), 'scan changed source files/inodes')
        return plan

    def assert_unknown(self, plan):
        self.assertIn(plan['summary']['sessions'], (None, 'unavailable'))
        self.assertNotIsInstance(plan['summary']['sessions'], int)

    def test_closed_wal_scan_preserves_files_and_inodes(self):
        self.create()
        self.assertEqual(self.db.read_bytes()[18:20], b'\x02\x02')
        self.assert_unknown(self.scan_preserved())

    def test_nonempty_active_wal_is_unknown_not_main_db_count(self):
        self.create()
        with closing(sqlite3.connect(self.db)) as writer:
            writer.execute('PRAGMA wal_autocheckpoint=0')
            writer.execute('INSERT INTO sessions VALUES ("committed-in-wal")')
            writer.commit()
            self.assertGreater(Path(str(self.db) + '-wal').stat().st_size, 32)
            self.assertEqual(writer.execute('SELECT count(*) FROM sessions').fetchone()[0], 2)
            # Scan must not use immutable=1 to ignore this committed WAL, nor
            # report a confident count from a source whose writer is still live.
            self.assert_unknown(self.scan_preserved())

    def test_rollback_home_without_quiescence_is_unknown(self):
        self.create('DELETE')
        with patch.object(h.sqlite3, 'connect', side_effect=AssertionError('scan must not open source SQLite')):
            self.assert_unknown(self.scan_preserved())

    def test_missing_database_is_unknown_without_creation(self):
        self.assert_unknown(self.scan_preserved())
        self.assertFalse(self.db.exists())

    def test_corrupt_database_is_unknown_without_sidecars(self):
        self.db.write_bytes(b'not a SQLite database')
        self.assert_unknown(self.scan_preserved())

    def test_archive_keeps_unknown_count_and_exact_source(self):
        self.create()
        archive = self.owner / 'synthetic.zip'
        with zipfile.ZipFile(archive, 'w') as out:
            for p in self.home.iterdir():
                out.write(p, p.name)
        self.assert_unknown(self.scan_preserved(archive))


if __name__ == '__main__':
    unittest.main()
