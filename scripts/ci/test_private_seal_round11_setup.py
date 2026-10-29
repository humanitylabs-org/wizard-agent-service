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

    def test_round11b_exact_socket_path_refused(self):
        with self.assertRaisesRegex(RuntimeError, 'path_too_long:107'):
            setup.socket_temp_contract('/srv/work/incog-seal-r11b-b11a7f0/work-tmp-round11b')

    def test_short_socket_path_budget(self):
        result = setup.socket_temp_contract('/srv/work/r11c-0123456789ab')
        self.assertLessEqual(result['socket_path_bytes'], 103)

    def test_manager_documented_mounts_and_parent(self):
        state = Path('/synthetic/manager')
        directories, mounts, app_parent = setup.manager_layout(state)
        self.assertIn('cache', directories)
        self.assertIn('media', directories)
        self.assertEqual(app_parent, str(state))
        self.assertFalse(app_parent.endswith('/app-data'))
        mounted = dict((target, source) for source, target in mounts)
        self.assertEqual(mounted['/cache'], state / 'cache')
        self.assertEqual(mounted['/app-data'], Path(app_parent) / 'app-data')
        self.assertEqual(mounted['/data/state'], state / 'state')
        self.assertEqual(mounted['/data/.env'], state / '.env')
        self.assertEqual(mounted['/data/docker-compose.yml'], state / 'docker-compose.yml')
        self.assertNotIn('/data', mounted)
        self.assertEqual(len(mounted), len(mounts))

    def test_stock_official_entrypoint_and_uid_remap(self):
        args, flags = setup.stock_launch('/synthetic/home', '/opt/hermes/.venv/bin/python', 'fixture-net', 'synthetic-key', 1000, 1000)
        self.assertEqual(args[:2], ['/opt/hermes/.venv/bin/python', '-c'])
        self.assertEqual(args[2], setup.STOCK_BOOT)
        for forbidden in ('--entrypoint', '--user', '--read-only', '--init'):
            self.assertNotIn(forbidden, flags)
        self.assertIn('HERMES_UID=1000', flags)
        self.assertIn('HERMES_GID=1000', flags)
        self.assertNotIn('HERMES_ALLOW_ROOT_GATEWAY', '\n'.join(flags))
        self.assertIn('synthetic_stock_gateway_must_not_be_root', setup.STOCK_BOOT)
        self.assertIn('synthetic_stock_home_owner_mismatch', setup.STOCK_BOOT)
        self.assertIn('synthetic_stock_missing_init', setup.STOCK_BOOT)

    def test_root_stock_owner_refused(self):
        with self.assertRaisesRegex(RuntimeError, 'nonroot_owner'):
            setup.stock_launch('/synthetic/home', 'python', 'fixture', 'synthetic', 0, 0)

    def preflight_receipt(self):
        return {'preflight_only':True, 'synthetic_only':True, 'live_touched':False,
                'admission':{'required_unmet':[]}, 'checks':{k:True for k in
                ('stock_setup_ready', 'manager_setup_ready', 'owned_resources_cleaned', 'synthetic_secret_work_removed')}}

    def test_startup_preflight_requires_every_setup_and_cleanup_gate(self):
        self.assertTrue(setup.assert_startup_preflight(0, self.preflight_receipt()))
        for missing in self.preflight_receipt()['checks']:
            value = self.preflight_receipt(); del value['checks'][missing]
            with self.assertRaisesRegex(RuntimeError, 'startup_preflight_failed'):
                setup.assert_startup_preflight(0, value)

    def test_startup_preflight_refuses_failed_exit_or_receipt(self):
        cases = [(2, self.preflight_receipt()), (0, {})]
        for key, new in [('preflight_only',False), ('synthetic_only',False), ('live_touched',True),
                         ('errors',{'stock':{'reason':'root_gateway_refused'}}), ('admission',{'required_unmet':['manager_setup_ready']})]:
            value = self.preflight_receipt(); value[key] = new; cases.append((0, value))
        for rc, value in cases:
            with self.assertRaisesRegex(RuntimeError, 'startup_preflight_failed'):
                setup.assert_startup_preflight(rc, value)

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
