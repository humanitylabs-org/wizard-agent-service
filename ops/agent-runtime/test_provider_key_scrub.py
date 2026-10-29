"""Synthetic-only credential retirement and interrupted migration coverage."""
import json
from pathlib import Path
import os
import io
from email.message import Message
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
import agent_runtime as ar
import provider_key_scrub as scrubber


class ScrubTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home = self.root / 'home'; self.home.mkdir()
        self.receipt = self.root / 'runtime/key-scrub.json'
        self.key = 'fixture-current-only-123456789'
        self.old = 'fixture-old-only-abcdefghijk'
        (self.home / '.env').write_text('OTHER=retained\nTINFOIL_API_KEY='+self.key+'\n')
        (self.home / 'backups/config').mkdir(parents=True)
        (self.home / 'backups/config/.env.pre-docker').write_text(' export TINFOIL_API_KEY="'+self.old+'"\n')
        (self.home / 'a-byte-copy').write_bytes(b'\x00'+self.old.encode()+b'\x00'+self.key.encode())
        (self.home / 'history.db').write_bytes(b'synthetic-history-no-credentials')

    def run_scrub(self):
        return scrubber.scrub(self.home, self.receipt, self.key)

    def assert_clean(self):
        for p in self.home.rglob('*'):
            if p.is_file():
                data = p.read_bytes()
                self.assertNotIn(self.key.encode(), data)
                self.assertNotIn(self.old.encode(), data)
                self.assertNotIn(b'TINFOIL_API_KEY', data)
        self.assertEqual((self.home / 'history.db').read_bytes(), b'synthetic-history-no-credentials')

    def test_scrubs_env_backup_binary_copies_preserves_home_inode_and_mode(self):
        inode = self.home.stat().st_ino
        (self.home / 'a-byte-copy').chmod(0o640)
        receipt = self.run_scrub()
        self.assert_clean()
        self.assertEqual(self.home.stat().st_ino, inode)
        self.assertEqual((self.home / 'a-byte-copy').stat().st_mode & 0o777, 0o640)
        self.assertEqual(receipt['count'], 3)
        self.assertEqual(receipt['status'], 'completed')
        self.assertEqual(set(receipt), {'schema', 'status', 'count', 'paths'})
        self.assertEqual(self.run_scrub(), receipt)
        self.assertNotIn(self.key, self.receipt.read_text())
        self.assertNotIn(self.old, self.receipt.read_text())

    def test_every_interrupted_write_is_restart_safe_without_plaintext_undo(self):
        original = scrubber.atomic
        # Recreate a fixture for each interruption point, including after the
        # final credential assignment has been retired.
        for stop_after in range(1, 15):
            with self.subTest(stop_after=stop_after):
                self.tearDown_fixture()
                self.setUp()
                calls = 0
                def killed(*args, **kwargs):
                    nonlocal calls
                    original(*args, **kwargs); calls += 1
                    if calls == stop_after:
                        raise InterruptedError('simulated process loss')
                with patch.object(scrubber, 'atomic', side_effect=killed):
                    try: self.run_scrub()
                    except InterruptedError: pass
                self.run_scrub(); self.assert_clean()

    def test_runtime_rpc_stops_under_lock_fences_restart_and_rolls_back_from_host(self):
        d = self.root / 'agents/probe'; d.mkdir(parents=True)
        self.home.rename(d / 'home'); self.home = d / 'home'
        source = self.root / 'host.env'; source.write_text('TINFOIL_API_KEY='+self.key+'\n')
        agents = ar.Agents(self.root / 'agents', tinfoil_key_file=source)
        agent = {'schema':1,'id':'probe','runtime':{'kind':'container','port':18650},'model':{'provider':'tinfoil'}}
        (d / 'agent.json').write_text(json.dumps(agent))
        stopped = []
        def stop(_):
            self.assertTrue(ar.LOCK.locked()); stopped.append(True)
        driver = SimpleNamespace(agents=agents, stop=stop)
        handler = object.__new__(ar.make_handler('synthetic-auth', agents, driver))
        handler.headers = Message(); handler.headers['Authorization']='Bearer synthetic-auth'
        handler.rfile = io.BytesIO()
        replies = []; handler._json = lambda code, obj: replies.append((code, obj))
        handler.path = '/agents/probe/scrub-private-migration'
        with patch.object(ar, 'docker', return_value=SimpleNamespace(stdout='')):
            handler.do_POST()
        self.assertEqual(replies[-1][0], 200)
        self.assertEqual(stopped, [True]); self.assert_clean()
        with self.assertRaisesRegex(ar.RuntimeFailure, 'private_migration_pending'):
            ar.lifecycle_action(driver, agent, 'start')
        handler.path = '/agents/probe/rollback-private-migration'; handler.do_POST()
        self.assertEqual(replies[-1], (200, {'ok':True}))
        self.assertIn(self.key, (self.home / '.env').read_text())
        self.assertNotIn(self.old, (self.home / 'backups/config/.env.pre-docker').read_text())
        self.assertFalse((d / 'runtime/key-scrub.json').exists())

    def tearDown_fixture(self):
        self.tmp.cleanup()

    def test_external_file_alias_is_unlinked_not_rewritten(self):
        source = self.root / 'host-source'; source.write_text(self.key)
        (self.home / 'alias').symlink_to(source)
        self.run_scrub()
        self.assertFalse((self.home / 'alias').exists())
        self.assertEqual(source.read_text(), self.key)

    def test_unreadable_file_fails_before_complete_receipt(self):
        original = Path.read_bytes
        def denied(p):
            if p.name == 'a-byte-copy': raise PermissionError('synthetic unreadable')
            return original(p)
        with patch.object(Path, 'read_bytes', denied):
            with self.assertRaises(PermissionError): self.run_scrub()
        self.assertEqual(json.loads(self.receipt.read_text())['status'], 'pending')
        self.run_scrub(); self.assert_clean()


if __name__ == '__main__':
    unittest.main(verbosity=2)
