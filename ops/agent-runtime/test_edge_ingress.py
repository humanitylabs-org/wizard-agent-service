#!/usr/bin/env python3
"""Bind-time permissions and restart recovery for the inbound relay (no Docker required)."""
import importlib.util
import os
from pathlib import Path
import socket
import stat
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('edge', Path(__file__).parent / 'restricted-agent/sidecars/edge.py')
assert spec is not None and spec.loader is not None
edge = importlib.util.module_from_spec(spec)
with patch.dict(os.environ, {'EDGE_TOKEN_SHA256': '0' * 64}):
    spec.loader.exec_module(edge)


class IngressBindTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='ing-')
        self.path = Path(self.tmp.name) / 'ingress.sock'
        self.patch = patch.object(edge, 'INGRESS_SOCKET', str(self.path))
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def test_private_owned_socket_from_bind_and_umask_restored(self):
        mask = os.umask(0o022)
        try:
            with edge.bind_ingress():
                st = self.path.lstat()
                self.assertTrue(stat.S_ISSOCK(st.st_mode))
                self.assertEqual(stat.S_IMODE(st.st_mode), 0o600)
                self.assertEqual(st.st_uid, os.getuid())
                self.assertEqual(os.umask(0o022), 0o022)
        finally:
            os.umask(mask)

    def test_stale_socket_recovered(self):
        edge.bind_ingress().close()
        with edge.bind_ingress():
            self.assertTrue(stat.S_ISSOCK(self.path.lstat().st_mode))

    def test_live_listener_never_unlinked(self):
        with edge.bind_ingress():
            inode = self.path.stat().st_ino
            with self.assertRaisesRegex(RuntimeError, 'already listening'):
                edge.bind_ingress()
            self.assertEqual(self.path.stat().st_ino, inode)

    def test_symlink_refused_without_changing_target(self):
        target = Path(self.tmp.name) / 'file'
        target.write_text('synthetic')
        target.chmod(0o644)
        self.path.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, 'unsafe ingress socket'):
            edge.bind_ingress()
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o644)

    def test_non_socket_refused(self):
        self.path.write_text('synthetic')
        with self.assertRaisesRegex(RuntimeError, 'unsafe ingress socket'):
            edge.bind_ingress()

    def test_nonprivate_directory_refused(self):
        Path(self.tmp.name).chmod(0o755)
        with self.assertRaisesRegex(RuntimeError, 'unsafe ingress directory'):
            edge.bind_ingress()


if __name__ == '__main__':
    unittest.main()
