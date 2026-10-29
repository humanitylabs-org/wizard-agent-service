"""Setup regressions: no daemon, credentials or live agent required."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import private_seal_round11_setup as setup


class SetupTests(unittest.TestCase):
    def test_alias_import_is_unique_and_stable(self):
        self.assertEqual(setup.unique_images(['daemon','edge','edge','stock']), ['daemon','edge','stock'])

    def test_stock_config_mapping_and_mode(self):
        config = setup.stock_config()
        self.assertIsInstance(config['toolsets'], dict)
        self.assertEqual(config['model']['api_mode'], 'chat_completions')
        self.assertEqual(config['fallback_providers'], [])
        self.assertEqual(config['terminal']['cwd'], '/opt/data')

    def test_empty_sessions_are_ready(self):
        self.assertTrue(setup.stock_sessions_ready({'object':'list','data':[]}))

    def test_sessions_reject_unknown_shape(self):
        for value in (None, [], {}, {'object':'list','data':None}):
            with self.assertRaises(RuntimeError):
                setup.stock_sessions_ready(value)

    def test_startup_program_compiles(self):
        compile(setup.STOCK_BOOT, '<synthetic-boot>', 'exec')

    def node_case(self, version='22.21.1', rc=0, digest=None, actual_path=None):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'node'
            path.write_bytes(b'fixture-node')
            expected = digest or hashlib.sha256(path.read_bytes()).hexdigest()
            output = json.dumps({'version':version,'execPath':str(actual_path or path)})
            with patch.object(setup.subprocess, 'run', return_value=SimpleNamespace(returncode=rc,stdout=output)) as run:
                result = setup.node_environment(str(path), expected, {'PATH':'/usr/bin'})
                self.assertEqual(run.call_args.kwargs['env']['PATH'], folder+':/usr/bin')
                return result

    def test_node_pin_and_sqlite_probe(self):
        _, evidence = self.node_case()
        self.assertTrue(evidence['sqlite_builtin'])

    def test_node20_rejected(self):
        with self.assertRaisesRegex(RuntimeError,'below_service_engine'):
            self.node_case(version='20.19.0')

    def test_node_builtin_failure_rejected(self):
        with self.assertRaisesRegex(RuntimeError,'sqlite_unavailable'):
            self.node_case(rc=1)

    def test_node_hash_drift_rejected(self):
        with self.assertRaisesRegex(RuntimeError,'hash_mismatch'):
            self.node_case(digest='0'*64)

    def test_missing_node_rejected(self):
        with self.assertRaisesRegex(RuntimeError,'missing'):
            setup.node_environment('/does-not-exist-round11-node','0'*64,{})


if __name__ == '__main__':
    unittest.main()
