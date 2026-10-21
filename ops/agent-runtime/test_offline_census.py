"""Offline sealed census: fixtures only, no Docker daemon or real agent homes."""
import json
from contextlib import closing
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent_runtime as ar


class OfflineCensusTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        with closing(sqlite3.connect(self.home / "state.db")) as db:
            db.executescript("CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES('private-id'); CREATE TABLE messages(content TEXT); INSERT INTO messages VALUES('must never read');")
        self.agent = {"id": "fixture", "runtime": {"app_id": "agent-fixture"}}
        self.state = {"Status": "exited", "Running": False, "StartedAt": "2026-01-01T01:00:00Z", "FinishedAt": "2026-01-01T02:00:00Z"}
        self.restarts = 0
        self.calls = []

    def docker(self, argv, **kwargs):
        self.calls.append(argv)
        if argv[0] == 'ps':
            self.assertIn('-aq', argv)
            return SimpleNamespace(stdout='fixture-container\n')
        self.assertEqual(argv[0], 'inspect')
        self.assertNotIn('Config', argv[2])
        return SimpleNamespace(stdout='\n'.join(map(json.dumps, ['fixture-container', self.state, self.restarts,
            [{"Source": str(self.home), "Destination": "/opt/data"}]])))

    def test_all_existing_adapters_can_seal_their_stopped_mounted_index(self):
        for driver_type in (ar.ComposeDriver, ar.RuntipiDriver, ar.RestrictedDriver):
            with self.subTest(driver=driver_type.__name__), patch.object(ar, 'docker', self.docker):
                driver = driver_type.__new__(driver_type)
                result = ar.offline_census(driver, self.agent)
                self.assertEqual(result['ids'], ['private-id'])
                self.assertEqual(result['status'], 'stopped')
                self.assertEqual(len(result['generation']), 64)
                self.assertNotIn('must never read', json.dumps(result))
        self.assertTrue(all(c[0] in {'ps', 'inspect'} for c in self.calls))

    def test_external_restart_changes_generation_even_after_stopping_again(self):
        with patch.object(ar, 'docker', self.docker):
            driver = ar.ComposeDriver.__new__(ar.ComposeDriver)
            before, _ = ar.inspect_runtime(driver, self.agent)
            self.restarts += 1
            after, _ = ar.inspect_runtime(driver, self.agent)
            self.assertNotEqual(before['generation'], after['generation'])
            self.state['StartedAt'] = '2026-02-01T01:00:00Z'
            latest, _ = ar.inspect_runtime(driver, self.agent)
            self.assertNotEqual(after['generation'], latest['generation'])

    def test_running_missing_index_and_unknown_generation_provide_no_negative_evidence(self):
        driver = ar.ComposeDriver.__new__(ar.ComposeDriver)
        with patch.object(ar, 'docker', self.docker):
            self.state['Status'], self.state['Running'] = 'running', True
            with self.assertRaises(ar.RuntimeFailure):
                ar.offline_census(driver, self.agent)
            self.state['Status'], self.state['Running'] = 'exited', False
            (self.home / 'state.db').unlink()
            with self.assertRaises(ar.RuntimeFailure):
                ar.offline_census(driver, self.agent)
            self.assertFalse((self.home / 'state.db').exists())
            self.state['StartedAt'] = '0001-01-01T00:00:00Z'
            with self.assertRaises(ar.RuntimeFailure):
                ar.inspect_runtime(driver, self.agent)

    def test_generation_change_during_offline_read_refuses_seal(self):
        driver = ar.ComposeDriver.__new__(ar.ComposeDriver)
        with patch.object(ar, 'inspect_runtime', side_effect=[({'status': 'stopped', 'generation': 'old'}, {'Source': str(self.home)}),
                                                            ({'status': 'stopped', 'generation': 'new'}, {})]):
            with self.assertRaises(ar.RuntimeFailure) as error:
                ar.offline_census(driver, self.agent)
            self.assertEqual(error.exception.code, 'runtime_generation_changed')


if __name__ == '__main__':
    unittest.main()
