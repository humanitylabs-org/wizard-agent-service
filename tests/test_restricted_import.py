#!/usr/bin/env python3
"""Restricted admission regression tests; no live registry, Docker or credentials."""
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops/agent-runtime'))
import hermes_import as h
import restricted_import as r


class RestrictedImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.owner = self.tmp / 'owner'
        self.home = self.owner / '.hermes'
        self.home.mkdir(parents=True, mode=0o700)
        (self.home / 'config.yaml').write_text('model:\n  provider: anthropic\n  default: claude-opus-5-5\nmemory:\n  backend: native\n')
        (self.home / 'SOUL.md').write_text('original')
        with sqlite3.connect(self.home / 'state.db') as db:
            db.executescript('create table sessions(id text); create table messages(id integer);')
        db.close()
        self.root = self.tmp / 'wizard'
        self.plan = h.scan(self.home, owner_home=self.owner)
        self.plan.update(move=True, gateway_url='http://edge:8923/wizard/mcp', image='fixture:restricted')
        h.approve(self.plan)
        def fake_docker(args, **kw):
            if args[0] == 'run' and '/target/.import-transfer/home' in args[-1]:
                mount = next(a for a in args if a.startswith('type=bind,src='))
                base = Path(mount.split('src=', 1)[1].split(',dst=')[0])
                (base / '.import-transfer/home').rename(base / 'home')
            return type('Result', (), {'stdout': '', 'returncode': 0})()
        self.mocks = [patch.object(r.rt, 'docker', side_effect=fake_docker), patch.object(r, 'reown'), patch.object(r, 'helper'),
                      patch.object(r.rt.RestrictedDriver, 'start', return_value={'ok': True}),
                      patch.object(h.DockerRuntime, 'healthy')]
        for p in self.mocks:
            p.start()
    def tearDown(self):
        for p in reversed(self.mocks):
            p.stop()
        shutil.rmtree(self.tmp)
    def test_registry_authority_allocates_pair_and_moves_inode(self):
        inode = (self.home / 'state.db').stat().st_ino
        result = h.apply(self.plan, 'restricted-fixture', self.root)
        folder = self.root / 'agents/restricted-fixture'
        record = json.loads((folder / 'agent.json').read_text())
        self.assertEqual(record['runtime']['isolation'], 'restricted')
        self.assertEqual(record['runtime']['network'], {'uplink': '10.250.0.16/28', 'sandbox': '10.251.0.16/28'})
        self.assertNotIn('admission', record['runtime'])
        self.assertEqual((folder / 'home/state.db').stat().st_ino, inode)
        self.assertFalse(result['journal'].startswith(str(folder)))
        h.undo(result['journal'])
        self.assertEqual((self.home / 'state.db').stat().st_ino, inode)
        self.assertFalse(folder.exists())
    def test_outer_crash_steps_restore_exact_source(self):
        before = {str(p.relative_to(self.home)): p.read_bytes() for p in self.home.rglob('*') if p.is_file()}
        inode = (self.home / 'state.db').stat().st_ino
        steps = ['intent', 'reserved', 'staged', 'prepared', 'sealed', 'transfer-staged', 'transfer-moved', 'placed', 'admitted', 'running']
        for step in steps:
            with self.subTest(step=step):
                with patch.dict(os.environ, {'WIZARD_IMPORT_CRASH_AFTER': step}), self.assertRaises(SystemExit):
                    h.apply(self.plan, 'restricted-fixture', self.root)
                h.undo(self.root / 'imports/restricted-fixture/journal.json')
                after = {str(p.relative_to(self.home)): p.read_bytes() for p in self.home.rglob('*') if p.is_file()}
                self.assertEqual(before, after)
                self.assertEqual((self.home / 'state.db').stat().st_ino, inode)
                self.assertFalse((self.root / 'agents/restricted-fixture').exists())
                shutil.rmtree(self.root / 'imports/restricted-fixture')
    def test_reservation_start_is_denied_before_any_docker(self):
        agent = {'id': 'fixture', 'runtime': {'admission': 'importing'}, 'model': {}}
        with self.assertRaisesRegex(r.rt.RuntimeFailure, 'agent_import_in_progress'):
            r.rt.RestrictedDriver(r.rt.Agents(self.root / 'agents', None), r.rt.RESTRICTED_DIR, 'fixture', 8929)._prepare(agent)
        r.rt.docker.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
