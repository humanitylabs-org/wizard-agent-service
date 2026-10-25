import tempfile
import unittest
from pathlib import Path
from release_transaction import Transaction, Drift, identity

class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.current = self.home / '.local/share/wizard-mobile-server/current'
        self.old = self.current.parent / 'releases/old'
        self.new = self.current.parent / 'releases/new'
        for path in (self.old, self.new): path.mkdir(parents=True)
        self.current.symlink_to(self.old)
        self.cli = self.home / '.local/bin/wam'
        self.cli.parent.mkdir(parents=True)
        self.cli.write_bytes(b'#!/bin/sh\nexec python3 -m wam "$@"\n')
        self.cli.chmod(0o755)
        self.dropin = self.home / '.config/systemd/user/wizard-agent-runtime.service.d/99-pp-launch-wam.conf'
        self.dropin.parent.mkdir(parents=True)
        self.root = self.home / 'receipts'
        self.tx = Transaction(self.home, self.root, 'a' * 32)

    def test_promote_and_exact_rollback_real_filesystem(self):
        before = {p: identity(p) for p in (self.current, self.cli, self.dropin)}
        self.assertTrue(self.tx.snapshot(before)['readback'])
        self.tx.install(self.current, link=self.new)
        self.tx.install(self.cli, text=b'#!/bin/sh\nexec python3 -m wam --candidate\n', mode=0o755)
        self.tx.install(self.dropin, text=b'[Service]\nEnvironment=PYTHONDONTWRITEBYTECODE=1\n')
        result = Transaction(self.home, self.root, 'a' * 32).rollback()
        self.assertEqual(result['targets_restored'], 3)
        self.assertEqual(before, {p: identity(p) for p in before})

    def test_candidate_pointer_cannot_escape_its_release_store(self):
        self.tx.snapshot([self.current])
        with self.assertRaises(ValueError): self.tx.install(self.current, link=self.home)
        self.assertEqual(self.current.resolve(), self.old)
        self.assertIsNone(self.tx.data['targets'][str(self.current)]['pending'])

    def test_prewrite_drift_blocks(self):
        self.tx.snapshot([self.cli])
        self.cli.write_text('foreign')
        with self.assertRaises(Drift): self.tx.install(self.cli, text=b'candidate')
        self.assertEqual(self.cli.read_text(), 'foreign')

    def test_foreign_drift_prevents_any_partial_rollback(self):
        self.tx.snapshot([self.current, self.cli])
        self.tx.install(self.current, link=self.new)
        self.tx.install(self.cli, text=b'candidate')
        self.cli.write_text('other owner update')
        with self.assertRaises(Drift): self.tx.rollback()
        self.assertEqual(self.current.resolve(), self.new)

    def test_pending_write_crash_is_restorable(self):
        self.tx.snapshot([self.current])
        row = self.tx.data['targets'][str(self.current)]
        row['pending'] = {'kind': 'link', 'target': str(self.new)}
        self.tx.save()
        self.current.unlink(); self.current.symlink_to(self.new)
        self.assertEqual(Transaction(self.home, self.root, 'a' * 32).rollback()['status'], 'passed')
        self.assertEqual(self.current.resolve(), self.old)

    def test_private_home_never_opened_or_accepted(self):
        private = self.home / '.wizard-os/agents/private/home/state.db'
        with self.assertRaises(ValueError): self.tx.snapshot([private])
        self.assertFalse(private.exists())

    def test_no_plaintext_credentials_in_snapshot(self):
        self.cli.write_text('export TINFOIL_API_KEY=synthetic-do-not-retain\n')
        with self.assertRaises(ValueError): self.tx.snapshot([self.cli])
        self.assertFalse(self.tx.path.exists())

    def test_snapshot_cannot_be_reused_or_crossed(self):
        self.tx.snapshot([self.current])
        with self.assertRaises(ValueError): self.tx.snapshot([self.current])
        alien = Transaction(self.home, self.root, 'b' * 32)
        self.assertEqual(alien.rollback()['targets_restored'], 0)
        self.assertEqual(self.current.resolve(), self.old)

if __name__ == '__main__': unittest.main()
