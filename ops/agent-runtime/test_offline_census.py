"""Stopped census: mocked Docker/Runtipi boundary, real disposable SQLite indexes."""
import json
import os
from contextlib import closing
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent_runtime as ar
import offline_index


class OfflineCensusTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.agents = ar.Agents(self.root / 'agents', None)
        self.home = self.agents.home('fixture')
        self.home.mkdir(parents=True)
        with closing(sqlite3.connect(self.home / 'state.db')) as db:
            db.executescript("CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES('private-id'); CREATE TABLE messages(content TEXT); INSERT INTO messages VALUES('must never read');")
        self.agent = {'schema': 1, 'id': 'fixture', 'runtime': {'kind': 'container', 'port': 18642, 'app_id': 'agent-fixture'}}
        self.state = {'Status': 'exited', 'Running': False, 'StartedAt': '2026-01-01T01:00:00Z', 'FinishedAt': '2026-01-01T02:00:00Z'}
        self.restarts, self.container, self.app_status = 0, 'fixture-container', 'stopped'
        self.calls = []
        self.driver = self.make_driver(ar.ComposeDriver)

    def make_driver(self, kind):
        driver = kind.__new__(kind)
        driver.agents = self.agents
        if kind is ar.RuntipiDriver:
            driver.home_mount = 'alongside'
            rt = SimpleNamespace(app=lambda urn: {'app': {'status': self.app_status}},
                                 req=lambda *a, **kw: self.runtipi_stop(),
                                 wait_status=lambda *a, **kw: self.app_status)
            driver.cli = SimpleNamespace(Config=lambda: SimpleNamespace(runtipi=lambda: rt))
        if kind is ar.RestrictedDriver:
            driver._compose = lambda *args, **kw: SimpleNamespace(returncode=0)
        return driver

    def runtipi_stop(self):
        self.container, self.app_status = '', 'stopped'  # actual compose down semantics

    def docker(self, argv, **kwargs):
        self.calls.append(argv)
        if argv[0] == 'ps':
            if 'label=com.docker.compose.service=claude-init' in argv:
                self.assertIn('label=com.docker.compose.project=agent-fixture', argv)
                return SimpleNamespace(stdout='', returncode=0)  # no Claude grant in census fixtures
            self.assertIn('-aq', argv)
            return SimpleNamespace(stdout=self.container, returncode=0)
        if argv[0] == 'run':
            for flag, value in [('--network', 'none'), ('--user', '10000:10000'), ('--cap-drop', 'ALL')]:
                self.assertEqual(argv[argv.index(flag) + 1], value)
            self.assertIn('--read-only', argv)
            self.assertIn(f'type=bind,src={self.home},dst=/opt/data,readonly', argv)
            self.assertLessEqual(kwargs['timeout'], 30)
            # Simulate the uid-10000 subprocess boundary, not a host-readable home.
            # chmod 000 is the unprivileged fixture equivalent of foreign uid/0700.
            mode = self.home.stat().st_mode & 0o777
            os.chmod(self.home, 0o700)
            try:
                value = offline_index.snapshot(self.home, argv[-1] == 'ids')
            finally:
                os.chmod(self.home, mode)
            return SimpleNamespace(stdout=json.dumps(value), returncode=0)
        self.assertEqual(argv[0], 'inspect')
        self.assertNotIn('Config', argv[2])
        self.assertNotIn('Mounts', argv[2])
        return SimpleNamespace(stdout='\n'.join(map(json.dumps, [self.container, self.state, self.restarts])), returncode=0)

    def test_runtipi_stop_down_returns_seal_without_a_surviving_container(self):
        driver = self.make_driver(ar.RuntipiDriver)
        self.app_status = 'running'
        with patch.object(ar, 'docker', self.docker):
            result = ar.lifecycle_action(driver, self.agent, 'stop')
            self.assertTrue(result['ok'])
            self.assertEqual(self.container, '')
            self.assertEqual(result['census']['ids'], ['private-id'])
            self.assertEqual(ar.inspect_runtime(driver, self.agent)[0]['generation'], result['census']['generation'])
        self.assertFalse(any(a[0] == 'inspect' for a in self.calls))
        self.assertNotIn('must never read', json.dumps(result))

    def test_restricted_foreign_0700_home_uses_agent_uid_readonly_sidecar(self):
        driver = self.make_driver(ar.RestrictedDriver)
        self.agent['runtime']['isolation'] = 'restricted'
        os.chmod(self.home, 0)
        try:
            with patch.object(ar, 'docker', self.docker), patch.object(ar, 'index_snapshot', side_effect=AssertionError('no host read')):
                result = ar.lifecycle_action(driver, self.agent, 'stop')
                self.assertEqual(result['census']['ids'], ['private-id'])
                self.assertEqual(result['census']['generation'], ar.inspect_runtime(driver, self.agent)[0]['generation'])
        finally:
            os.chmod(self.home, 0o700)
        self.assertNotIn('must never read', json.dumps(result))

    def test_restricted_stop_keeps_pregrant_seal_bytes_with_or_without_grant(self):
        driver = self.make_driver(ar.RestrictedDriver)
        self.agent['runtime']['isolation'] = 'restricted'
        self.agent.update(privacy='standard', model={'provider': 'anthropic'})
        (self.home.parent / 'agent.json').write_text(json.dumps(self.agent))
        def pregrant_stop(agent):  # d49037d stop boundary, no credential cleanup
            driver._compose(agent, "stop", timeout=300)
            return {'ok': True}
        for granted in (False, True):
            removed = []
            def docker(argv, **kwargs):
                if argv[0] == 'ps' and 'label=com.docker.compose.service=claude-init' in argv:
                    self.assertIn('label=com.docker.compose.project=agent-fixture', argv)
                    return SimpleNamespace(stdout='fixture-seeder' if granted else '')
                if argv[0] == 'rm':
                    self.assertEqual(argv, ['rm', '-f', 'fixture-seeder'])
                    removed.append(argv)
                    return SimpleNamespace(returncode=0)
                return self.docker(argv, **kwargs)
            if granted:
                self.agents.set_secret('fixture', 'claude.token', 'synthetic-not-a-real-token')
            before = self._home_files()
            with self.subTest(granted=granted), patch.object(ar, 'docker', docker):
                with patch.object(driver, 'stop', pregrant_stop):
                    baseline = ar.lifecycle_action(driver, self.agent, 'stop')
                current = ar.lifecycle_action(driver, self.agent, 'stop')
                self.assertEqual(json.dumps(current, sort_keys=True).encode(),
                                 json.dumps(baseline, sort_keys=True).encode())
                self.assertEqual(current['census']['ids'], ['private-id'])
                self.assertEqual(len(removed), int(granted))
            self.assertEqual(self._home_files(), before)

    def test_compose_absent_and_exited_are_both_sealable(self):
        for container in ('', 'fixture-container'):
            self.container = container
            with self.subTest(container=container), patch.object(ar, 'docker', self.docker):
                result = ar.offline_census(self.driver, self.agent)
                self.assertEqual(result['status'], 'stopped')
                self.assertEqual(result['ids'], ['private-id'])
                self.assertEqual(len(result['generation']), 64)

    def test_each_db_bundle_stat_member_changes_generation(self):
        self.container = ''
        with patch.object(ar, 'docker', self.docker):
            previous = ar.inspect_runtime(self.driver, self.agent)[0]['generation']
            for name in offline_index.NAMES:
                path = self.home / name
                if not path.exists():
                    path.touch()
                st = path.stat()
                os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 1000000))
                current = ar.inspect_runtime(self.driver, self.agent)[0]['generation']
                self.assertNotEqual(previous, current, name)
                previous = current
            (self.home / 'state.db-shm').unlink()
            self.assertNotEqual(previous, ar.inspect_runtime(self.driver, self.agent)[0]['generation'])

    def test_external_restart_changes_generation_even_after_stopping_again(self):
        with patch.object(ar, 'docker', self.docker):
            before = ar.inspect_runtime(self.driver, self.agent)[0]
            self.restarts += 1
            after = ar.inspect_runtime(self.driver, self.agent)[0]
            self.assertNotEqual(before['generation'], after['generation'])
            self.state['StartedAt'] = '2026-02-01T01:00:00Z'
            self.assertNotEqual(after['generation'], ar.inspect_runtime(self.driver, self.agent)[0]['generation'])

    def test_runtipi_unknown_starting_running_and_surviving_container_fail_closed(self):
        driver = self.make_driver(ar.RuntipiDriver)
        with patch.object(ar, 'docker', self.docker):
            for status in ('unknown', None, 'starting', 'running', 'stopped'):
                self.app_status = status
                with self.subTest(status=status), self.assertRaises(ar.RuntimeFailure):
                    ar.inspect_runtime(driver, self.agent)

    def test_running_missing_index_and_unknown_container_generation_fail_closed(self):
        with patch.object(ar, 'docker', self.docker):
            self.state['Status'], self.state['Running'] = 'running', True
            with self.assertRaises(ar.RuntimeFailure):
                ar.offline_census(self.driver, self.agent)
            self.state['Status'], self.state['Running'] = 'exited', False
            (self.home / 'state.db').unlink()
            with self.assertRaises(ar.RuntimeFailure):
                ar.offline_census(self.driver, self.agent)
            self.assertFalse((self.home / 'state.db').exists())
            self.state['StartedAt'] = '0001-01-01T00:00:00Z'
            with self.assertRaises(ar.RuntimeFailure):
                ar.inspect_runtime(self.driver, self.agent)

    def test_generation_change_during_offline_read_refuses_seal(self):
        with patch.object(ar, 'inspect_runtime', side_effect=[({'status': 'stopped', 'generation': 'old'}, {}),
                                                            ({'status': 'stopped', 'generation': 'new'}, {})]):
            with self.assertRaises(ar.RuntimeFailure) as error:
                ar.offline_census(self.driver, self.agent)
            self.assertEqual(error.exception.code, 'runtime_generation_changed')

    def test_restricted_sidecar_failure_keeps_stop_success_but_no_seal(self):
        driver = self.make_driver(ar.RestrictedDriver)
        self.agent['runtime']['isolation'] = 'restricted'
        def fail(args, **kw):
            if args[0] == 'run':
                raise ar.RuntimeFailure('docker_failed')
            return self.docker(args, **kw)
        with patch.object(ar, 'docker', fail):
            result = ar.lifecycle_action(driver, self.agent, 'stop')
        self.assertTrue(result['ok'])
        self.assertIsNone(result['census'])
        self.assertEqual(result['census_error'], 'docker_failed')

    def test_restricted_sidecar_timeout_removes_it_and_never_seals(self):
        driver = self.make_driver(ar.RestrictedDriver)
        self.agent['runtime']['isolation'] = 'restricted'
        removed = []
        def fail(args, **kw):
            if args[0] == 'run':
                raise subprocess.TimeoutExpired(args, 30)
            if args[0] == 'rm':
                removed.append(args)
                return SimpleNamespace(returncode=0)
            return self.docker(args, **kw)
        with patch.object(ar, 'docker', fail):
            result = ar.lifecycle_action(driver, self.agent, 'stop')
        self.assertIsNone(result['census'])
        self.assertEqual(result['census_error'], 'offline_census_timeout')
        self.assertEqual(len(removed), 1)

    def test_symlink_probe_never_reports_foreign_ids(self):
        outside = self.root / 'foreign.db'
        with closing(sqlite3.connect(outside)) as db:
            db.executescript("CREATE TABLE sessions(id TEXT); INSERT INTO sessions VALUES('outside-owner-id');")
        (self.home / 'state.db').unlink()
        (self.home / 'state.db').symlink_to(outside)
        with patch.object(ar, 'docker', self.docker), patch.object(offline_index, 'read_ids', wraps=offline_index.read_ids) as reader:
            with self.assertRaises(ar.RuntimeFailure):
                ar.offline_census(self.driver, self.agent)
            reader.assert_not_called()

    def test_fifo_and_symlinked_wal_or_home_are_refused(self):
        for name in ('state.db-wal', 'state.db-shm'):
            path = self.home / name
            path.symlink_to(self.root / 'foreign')
            with self.subTest(name=name), self.assertRaises(ValueError):
                offline_index.snapshot(self.home, True)
            path.unlink()
        (self.home / 'state.db').unlink()
        os.mkfifo(self.home / 'state.db')
        with self.assertRaises(ValueError):
            offline_index.snapshot(self.home, True)
        (self.home / 'state.db').unlink()
        self.home.rmdir()
        self.home.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ar.RuntimeFailure):
            ar.read_index(self.driver, self.agent)

    def test_sqlite_open_itself_refuses_symlink_swapped_after_stat(self):
        original = self.home / 'state.db'
        target = self.home / 'saved.db'
        real_read = offline_index.read_ids
        def swap(path, **kw):
            original.rename(target)
            original.symlink_to(target)
            return real_read(path, **kw)
        with patch.object(offline_index, 'read_ids', swap), self.assertRaises(ValueError):
            offline_index.snapshot(self.home, True)

    def test_stop_response_seals_inside_the_handler_lifecycle_lock(self):
        import threading
        import urllib.request
        from http.server import ThreadingHTTPServer
        driver = self.make_driver(ar.RuntipiDriver)
        (self.home.parent / 'agent.json').write_text(json.dumps(self.agent))
        self.app_status = 'running'
        real_census = ar.offline_census
        def locked_census(chosen, agent):
            self.assertTrue(ar.lifecycle_lock(driver, None, 'fixture').locked())
            self.assertEqual(self.app_status, 'stopped')
            self.assertEqual(self.container, '')
            return real_census(chosen, agent)
        server = ThreadingHTTPServer(('127.0.0.1', 0), ar.make_handler('fixture-token', self.agents, driver))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.object(ar, 'docker', self.docker), patch.object(ar, 'offline_census', locked_census):
                req = urllib.request.Request(f'http://127.0.0.1:{server.server_port}/agents/fixture/stop',
                    data=b'{}', headers={'Authorization': 'Bearer fixture-token', 'Content-Type': 'application/json'})
                with urllib.request.urlopen(req, timeout=5) as response:
                    result = json.load(response)
                self.assertEqual(result['census']['ids'], ['private-id'])
            self.assertFalse(ar.lifecycle_lock(driver, None, 'fixture').locked())
        finally:
            server.shutdown(); thread.join(timeout=5); server.server_close()

    def test_committed_wal_ids_are_read_without_message_queries(self):
        db = sqlite3.connect(self.home / 'state.db')
        self.addCleanup(db.close)
        db.execute('PRAGMA journal_mode=WAL')
        db.execute("INSERT INTO sessions VALUES('wal-id')")
        db.commit()
        # Model a stopped/crashed runtime with committed WAL, no surviving writer.
        bundle = {name: (self.home / name).read_bytes() for name in offline_index.NAMES if (self.home / name).exists()}
        db.close()
        for name, data in bundle.items():
            (self.home / name).write_bytes(data)
        before = offline_index.snapshot(self.home)
        result = offline_index.snapshot(self.home, True)
        self.assertEqual(result['files'], before['files'])
        self.assertEqual(result['ids'], ['private-id', 'wal-id'])
        self.assertNotEqual(result['files']['state.db-wal'], 'absent')
        self.assertNotIn('must never read', json.dumps(result))

    def _home_files(self):
        return {p.name: (p.read_bytes(), p.stat().st_mode) for p in self.home.iterdir()}

    def test_wal_clean_close_is_censused_without_creating_files(self):
        # Hermes keeps state.db in WAL mode; a graceful stop (compose down, SIGTERM) checkpoints
        # and deletes -wal/-shm on the last close, leaving a WAL-header db with no siblings.
        with closing(sqlite3.connect(self.home / 'state.db')) as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute("INSERT INTO sessions VALUES('wal-clean-id')")
            db.commit()
        self.assertEqual(sorted(p.name for p in self.home.iterdir()), ['state.db'])
        self.assertEqual((self.home / 'state.db').read_bytes()[18:20], b'\x02\x02')  # WAL format
        for mode in (0o700, 0o500):
            with self.subTest(home_mode=oct(mode)):
                os.chmod(self.home, mode)
                try:
                    before = self._home_files()
                    result = offline_index.snapshot(self.home, True)
                    self.assertEqual(sorted(result['ids']), ['private-id', 'wal-clean-id'])
                    self.assertEqual(self._home_files(), before)
                    self.assertNotIn('must never read', json.dumps(result))
                finally:
                    os.chmod(self.home, 0o700)

    def test_empty_wal_without_shm_is_immutable_and_frames_without_shm_fail_closed(self):
        with closing(sqlite3.connect(self.home / 'state.db')) as db:
            db.execute('PRAGMA journal_mode=WAL')
        (self.home / 'state.db-wal').write_bytes(b'')
        before = self._home_files()
        self.assertEqual(offline_index.snapshot(self.home, True)['ids'], ['private-id'])
        self.assertEqual(self._home_files(), before)
        (self.home / 'state.db-wal').write_bytes(b'x' * 64)
        with self.assertRaises(ValueError):
            offline_index.snapshot(self.home, True)

    def test_hot_rollback_journal_fails_closed_and_empty_journal_reads(self):
        # Hermes falls back to journal_mode=DELETE on NFS/FUSE/ZFS. A crash mid-commit leaves a hot
        # journal; immutable mode would read the torn db and omit committed ids (review R6-B1).
        journal = self.home / 'state.db-journal'
        journal.write_bytes(b'\xd9\xd5\x05\xf9\x20\xa1\x63\xd7' + b'\x00' * 504)
        before = self._home_files()
        with self.assertRaises(ValueError):
            offline_index.snapshot(self.home, True)
        self.assertEqual(self._home_files(), before)
        journal.write_bytes(b'')
        self.assertEqual(offline_index.snapshot(self.home, True)['ids'], ['private-id'])
        sealed = offline_index.snapshot(self.home)['files']
        journal.unlink()
        self.assertNotEqual(offline_index.snapshot(self.home)['files'], sealed)

    def test_owner_mtime_reset_still_changes_generation(self):
        path = self.home / 'state.db'
        sealed = offline_index.snapshot(self.home)['files']['state.db']
        st = path.stat()
        with closing(sqlite3.connect(path)) as db:
            db.execute("UPDATE sessions SET id='private-id' WHERE id='private-id'")
            db.commit()
        os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns))
        self.assertNotEqual(offline_index.snapshot(self.home)['files']['state.db'], sealed)

    def test_ids_view_cannot_read_messages(self):
        with closing(sqlite3.connect(self.home / 'state.db')) as db:
            db.executescript('DROP TABLE sessions; CREATE VIEW sessions AS SELECT content AS id FROM messages;')
        with self.assertRaises(ValueError):
            offline_index.snapshot(self.home, True)


if __name__ == '__main__':
    unittest.main()
