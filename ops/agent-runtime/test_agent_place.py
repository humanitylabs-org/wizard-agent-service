"""Bounded in-container file placement. Run: python3 -m unittest discover -s ops/agent-runtime -p 'test_agent*.py'."""
import base64
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent_runtime as ar


class PlaceTest(unittest.TestCase):
    def setUp(self):
        self.data = b'synthetic attachment bytes'
        self.payload = {'filename': '../../unsafe note.txt', 'data_base64': base64.b64encode(self.data).decode(), 'sha256': hashlib.sha256(self.data).hexdigest()}
        self.agent = {'id': 'fixture', 'runtime': {'isolation': 'restricted'}, 'permissions': {'files': 'own'}}
        self.driver = mock.Mock()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.calls = []

    def tearDown(self):
        self.tmp.cleanup()

    def docker(self, argv, **kw):
        self.calls.append(argv)
        script = argv[-1].replace('"/opt/data"', repr(str(self.root)))
        return subprocess.run([sys.executable, '-c', script], input=kw['input_text'], text=True, capture_output=True)

    def place(self):
        with mock.patch.object(ar, 'container_for', return_value='fixture-container'), mock.patch.object(ar, 'docker', side_effect=self.docker):
            return ar.place(self.driver, self.agent, self.payload)

    def test_writes_as_container_user_sanitizes_and_reads_back(self):
        result = self.place()
        self.assertTrue(result['verified'])
        self.assertRegex(result['path'], r'^/opt/data/inbox/\d{4}-\d{2}-\d{2}/[0-9a-f]{16}-unsafe_note.txt$')
        path = self.root / result['path'].removeprefix('/opt/data/')
        self.assertEqual(path.read_bytes(), self.data)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.calls[0][:5], ['exec', '-i', '-u', f'{ar.AGENT_UID}:{ar.AGENT_UID}', 'fixture-container'])
        self.assertEqual(self.place(), result)

    def test_rejects_bad_hash_base64_empty_and_oversize(self):
        for changes in ({'sha256': '0' * 64}, {'data_base64': '!!!'}, {'data_base64': ''}, {'data_base64': 'a' * (4 * ((ar.PLACE_LIMIT + 2) // 3) + 1)}):
            with self.subTest(changes=list(changes)):
                with mock.patch.object(ar, 'docker') as docker:
                    with self.assertRaises(ar.RuntimeFailure):
                        ar.place(self.driver, self.agent, {**self.payload, **changes})
                    docker.assert_not_called()

    def test_files_none_fails_closed(self):
        self.agent['permissions']['files'] = 'none'
        with self.assertRaises(ar.RuntimeFailure) as cm:
            self.place()
        self.assertEqual(cm.exception.status, 409)
        self.assertEqual(self.calls, [])

    def test_inbox_symlink_cannot_escape(self):
        with tempfile.TemporaryDirectory() as other:
            (self.root / 'inbox').symlink_to(other)
            with self.assertRaises(ar.RuntimeFailure):
                self.place()
            self.assertEqual(list(Path(other).iterdir()), [])

    def test_existing_file_symlink_is_not_followed_or_overwritten(self):
        result = self.place()
        path = self.root / result['path'].removeprefix('/opt/data/')
        path.unlink()
        target = self.root / 'do-not-change'
        target.write_text('safe')
        path.symlink_to(target)
        with self.assertRaises(ar.RuntimeFailure):
            self.place()
        self.assertEqual(target.read_text(), 'safe')

    def test_existing_conflicting_file_is_not_overwritten(self):
        result = self.place()
        path = self.root / result['path'].removeprefix('/opt/data/')
        path.write_text('keep agent data')
        with self.assertRaises(ar.RuntimeFailure):
            self.place()
        self.assertEqual(path.read_text(), 'keep agent data')


if __name__ == '__main__':
    unittest.main()


class FetchTest(unittest.TestCase):
    def setUp(self):
        self.agent = {'id': 'fixture', 'runtime': {'isolation': 'restricted'}, 'permissions': {'files': 'own'}}
        self.driver = mock.Mock()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'data'
        (self.root / 'cache' / 'documents').mkdir(parents=True)
        (self.root / 'cache' / 'documents' / 'notes.md').write_bytes(b'# fetched\n')
        (Path(self.tmp.name) / 'outside.md').write_bytes(b'outside')
        (self.root / 'cache' / 'documents' / 'link.md').symlink_to(Path(self.tmp.name) / 'outside.md')
        (self.root / 'linkdir').symlink_to(Path(self.tmp.name))
        self.calls = []

    def tearDown(self):
        self.tmp.cleanup()

    def docker(self, argv, **kw):
        self.calls.append(argv)
        script = argv[-1].replace('"/opt/data"', repr(str(self.root)))
        return subprocess.run([sys.executable, '-c', script], input=kw['input_text'], text=True, capture_output=True)

    def fetch(self, path):
        with mock.patch.object(ar, 'container_for', return_value='fixture-container'), mock.patch.object(ar, 'docker', side_effect=self.docker):
            return ar.fetch(self.driver, self.agent, {'path': path})

    def test_reads_regular_file_as_agent_uid(self):
        result = self.fetch('/opt/data/cache/documents/notes.md')
        self.assertTrue(result['verified'])
        self.assertEqual(base64.b64decode(result['data_base64']), b'# fetched\n')
        self.assertEqual(result['sha256'], hashlib.sha256(b'# fetched\n').hexdigest())
        self.assertEqual(self.calls[0][:5], ['exec', '-i', '-u', f'{ar.AGENT_UID}:{ar.AGENT_UID}', 'fixture-container'])

    def test_refuses_symlinks_traversal_missing_and_outside_paths(self):
        for path in ('/opt/data/cache/documents/link.md', '/opt/data/linkdir/outside.md', '/opt/data/cache/documents/gone.md', '/opt/data/cache'):
            with self.subTest(path=path), self.assertRaises(ar.RuntimeFailure):
                self.fetch(path)
        for path in ('/opt/data/../etc/passwd', '/etc/passwd', '/opt/data', '/opt/data/a/./b', 'relative'):
            with self.subTest(path=path), mock.patch.object(ar, 'docker') as docker:
                with self.assertRaises(ar.RuntimeFailure):
                    ar.fetch(self.driver, self.agent, {'path': path})
                docker.assert_not_called()

    def test_files_none_fails_closed(self):
        self.agent['permissions']['files'] = 'none'
        with self.assertRaises(ar.RuntimeFailure) as cm:
            self.fetch('/opt/data/cache/documents/notes.md')
        self.assertEqual(cm.exception.status, 409)
