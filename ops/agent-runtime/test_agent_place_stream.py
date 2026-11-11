"""Streamed placement of large owner attachments (issue 464). Loaded by test_agent_runtime.py so CI runs it."""
import hashlib
import http.client
import io
import json
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent_runtime as ar  # noqa: E402


class PlaceStreamTest(unittest.TestCase):
    def setUp(self):
        self.data = b'synthetic long recording ' * 50_000   # ~1.2 MB: several 1 MB blocks
        self.sha = hashlib.sha256(self.data).hexdigest()
        self.agent = {'id': 'fixture', 'runtime': {'isolation': 'restricted'}, 'permissions': {'files': 'own'}}
        self.driver = mock.Mock()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.calls = []
        self.patches = [mock.patch.object(ar, 'container_for', return_value='fixture-container'),
                        mock.patch.object(ar, 'docker_cmd', side_effect=self.cmd)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def cmd(self, argv):
        self.calls.append(argv)
        script = argv[-1].replace('"/opt/data"', repr(str(self.root)))
        return [sys.executable, '-c', script]

    def place(self, data=None, sha=None, name='Day 2 retreat.mp3', length=None):
        data = self.data if data is None else data
        return ar.place_stream(self.driver, self.agent, {'filename': name, 'sha256': sha or self.sha},
                               ar.BoundedReader(io.BytesIO(data), len(data) if length is None else length),
                               len(data) if length is None else length)

    def test_streams_exact_bytes_as_agent_uid_and_is_idempotent(self):
        result = self.place()
        self.assertTrue(result['verified'])
        self.assertRegex(result['path'], r'^/opt/data/inbox/\d{4}-\d{2}-\d{2}/[0-9a-f]{16}-Day_2_retreat.mp3$')
        path = self.root / result['path'].removeprefix('/opt/data/')
        self.assertEqual(path.read_bytes(), self.data)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.calls[0][:5], ['exec', '-i', '-u', f'{ar.AGENT_UID}:{ar.AGENT_UID}', 'fixture-container'])
        self.assertEqual(self.place(), result)
        self.assertEqual([p.name for p in path.parent.iterdir()], [path.name], 'no partial files left behind')

    def test_percent_encoded_unicode_name_is_sanitized(self):
        result = self.place(name='..%2F..%2Fretr%C3%A9at%20one.mp3')
        self.assertRegex(result['path'], r'/[0-9a-f]{16}-retr_at_one.mp3$')

    def test_hash_mismatch_and_short_body_leave_nothing(self):
        with self.assertRaises(ar.RuntimeFailure) as cm:
            self.place(sha='0' * 64)
        self.assertEqual(cm.exception.code, 'file_hash_mismatch')
        with self.assertRaises(ar.RuntimeFailure) as cm:
            self.place(data=self.data[:1000], length=len(self.data))
        self.assertEqual(cm.exception.code, 'invalid_file')
        day = next((self.root / 'inbox').iterdir())
        self.assertEqual(list(day.iterdir()), [])

    def test_not_enough_disk_space_is_named(self):
        script = ar.PLACE_STREAM_SCRIPT.replace('room = os.statvfs(fd)', 'room = type("R", (), {"f_bavail": 10, "f_frsize": 4096})')
        with mock.patch.object(ar, 'PLACE_STREAM_SCRIPT', script):
            with self.assertRaises(ar.RuntimeFailure) as cm:
                self.place()
        self.assertEqual((cm.exception.code, cm.exception.status), ('insufficient_space', 507))

    def test_oversize_files_none_and_bad_hash_fail_before_docker(self):
        cases = [({}, ar.PLACE_STREAM_LIMIT + 1, 'file_too_large'), ({}, 0, 'file_too_large'),
                 ({'sha256': 'nothex'}, 10, 'file_hash_mismatch')]
        for meta, length, code in cases:
            with self.subTest(code=code, length=length), self.assertRaises(ar.RuntimeFailure) as cm:
                ar.place_stream(self.driver, self.agent, {'filename': 'a.mp3', 'sha256': self.sha, **meta}, io.BytesIO(b''), length)
            self.assertEqual(cm.exception.code, code)
        self.agent['permissions']['files'] = 'none'
        with self.assertRaises(ar.RuntimeFailure) as cm:
            self.place()
        self.assertEqual(cm.exception.status, 409)
        self.assertEqual(self.calls, [])

    def test_existing_conflicting_file_is_not_overwritten(self):
        result = self.place()
        path = self.root / result['path'].removeprefix('/opt/data/')
        path.write_text('keep agent data')
        with self.assertRaises(ar.RuntimeFailure) as cm:
            self.place()
        self.assertEqual(cm.exception.code, 'file_conflict')
        self.assertEqual(path.read_text(), 'keep agent data')

    def test_http_route_streams_and_answers_refusals_with_the_reason(self):
        agents = mock.Mock()
        agents.read.return_value = self.agent
        server = ThreadingHTTPServer(('127.0.0.1', 0), ar.make_handler('tok', agents, self.driver, restricted_driver=self.driver))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            def post(body, sha):
                conn = http.client.HTTPConnection('127.0.0.1', server.server_address[1], timeout=30)
                conn.request('POST', '/agents/fixture/place-stream', body=body, headers={
                    'Authorization': 'Bearer tok', 'Content-Type': 'application/octet-stream',
                    'X-Wizard-Filename': 'talk%20one.mp3', 'X-Wizard-Sha256': sha})
                r = conn.getresponse()
                return r.status, json.loads(r.read())
            status, reply = post(self.data, self.sha)
            self.assertEqual(status, 200, reply)
            self.assertTrue(reply['path'].endswith('-talk_one.mp3'))
            self.agent['permissions']['files'] = 'none'
            self.assertEqual(post(self.data, self.sha), (409, {'error': 'agent_files_disabled'}))
        finally:
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    unittest.main()
