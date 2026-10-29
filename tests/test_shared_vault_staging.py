"""Fast staging contracts: no Docker/browser/provider, disposable state only."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1] / 'qa/shared-vault-platform'
sys.path.insert(0, str(HERE))
from staging_support import bounded_output, capture_failure, sanitize, validate_socket_paths, LOG_LIMIT
spec = importlib.util.spec_from_file_location('staging_runner', HERE/'run.py')
assert spec is not None and spec.loader is not None
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class StagingSupportTests(unittest.TestCase):
    def test_old_output_fails_before_any_build_or_resource(self):
        sha = 'd4316a0b7228f31f0dbe55449bd4f569470f4724'
        root = Path('/srv/work/shared-vault-platform')/sha/'receipts'
        self.assertEqual(len(str(root/'agents/agent-a/gateway/gateway.sock').encode()), 117)
        with patch.object(sys, 'argv', ['run.py', '--forum-staging', '--source-sha', sha,
              '--vault-source', '/srv/work/fixture/vault', '--vault-sha', 'e'*40, '--output', str(root)]), \
              patch.object(runner.os, 'geteuid', return_value=1000), \
              patch.object(runner, 'SOURCE', Path('/srv/work/svfixture/service')), \
              patch.object(runner.Path, 'exists', return_value=False), \
              patch.object(runner, 'run') as command, patch.object(runner.Path, 'mkdir') as mkdir:
            with self.assertRaisesRegex(ValueError, 'staging_socket_path_too_long'):
                runner.main()
            command.assert_not_called(); mkdir.assert_not_called()

    def test_short_output_covers_service_edge_and_runtime_sockets(self):
        paths = validate_socket_paths(Path('/srv/work/sv-0123456789ab'))
        self.assertEqual(len(paths), 7)
        self.assertTrue(all(len(str(p).encode()) <= 103 for p in paths))
        # Validate bytes, not characters.
        with self.assertRaisesRegex(ValueError, 'staging_socket_path_too_long'):
            validate_socket_paths(Path('/srv/work') / ('é' * 40))

    def test_container_exit_is_immediate_even_if_a_stale_socket_exists(self):
        def dead(): raise RuntimeError('Service process exited')
        with patch.object(runner.time, 'sleep') as sleep:
            with self.assertRaisesRegex(RuntimeError, 'Service process exited'):
                runner.wait(lambda: True, 'sockets', watch=dead)
            sleep.assert_not_called()

    def test_failure_snapshot_is_private_bounded_and_redacted(self):
        secret = 'generated-proof-value-that-must-not-escape'
        project_id = 'abcdef012345'
        calls = []
        def output(argv):
            calls.append(argv)
            if argv[1] == 'ps': return project_id + '\n'
            if argv[1] == 'inspect': return '{"Running":false,"ExitCode":1}\n'
            return 'x' * 20000 + '\nagent_socket_path_too_long\n' + secret + '\nSYNTHETIC_SHARED_PASSWORD_DO_NOT_RETURN_98\nBearer hidden-value\npartial-pem-line-material\n'
        with tempfile.TemporaryDirectory(prefix='sv-') as tmp, patch('staging_support.bounded_output', side_effect=output):
            private = Path(tmp)/'service-private'; private.mkdir()
            (private/'key.pem').write_text('-----BEGIN PRIVATE KEY-----\npartial-pem-line-material\n-----END PRIVATE KEY-----\n')
            path = capture_failure(Path(tmp), ['svstage-test-service'], ['svstage-test-agent-a'], secrets=[secret], error=RuntimeError('startup ' + secret))
            raw = path.read_text(); report = json.loads(raw)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual([c['target'] for c in report['containers']], ['svstage-test-service', project_id])
            self.assertIn('agent_socket_path_too_long', raw)
            for value in [secret, 'SYNTHETIC_SHARED_PASSWORD_DO_NOT_RETURN_98', 'hidden-value', 'partial-pem-line-material']:
                self.assertNotIn(value, raw)
            self.assertTrue(all(len(c['logs']) <= LOG_LIMIT for c in report['containers']))
            self.assertTrue(all('rm' not in c for c in calls))
            self.assertTrue(all('{{json .Config}}' not in c for c in calls))

    def test_real_bounded_reader_handles_stderr_timeout_and_oversized_lines(self):
        self.assertIn('stderr-marker', bounded_output([sys.executable, '-c', "import sys; print('stderr-marker', file=sys.stderr)"]))
        large = bounded_output([sys.executable, '-c', "print('sensitive-fragment'*10000)"])
        self.assertEqual(large, '\n[diagnostic output capped]\n')
        stopped = bounded_output([sys.executable, '-c', 'import time; time.sleep(10)'], timeout=.1)
        self.assertIn('capped', stopped)

    def test_private_key_even_with_incomplete_footer_is_removed(self):
        for value in ['-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----',
                      '-----BEGIN RSA PRIVATE KEY-----\nprivate-material']:
            self.assertNotIn('private-material', sanitize(value))

    def test_command_errors_and_timeouts_keep_sanitized_stderr_not_secret_argv(self):
        secret = 'generated-command-authority'
        with patch.object(runner, 'COMMAND_SECRETS', [secret]), patch.object(runner, 'COMMAND_FAILURES', []):
            with self.assertRaisesRegex(RuntimeError, 'worker command failed'):
                runner.run([sys.executable, '-c', "import sys; print(sys.argv[1], file=sys.stderr); sys.exit(3)", secret])
            self.assertNotIn(secret, json.dumps(runner.COMMAND_FAILURES))
            self.assertIn('[REDACTED]', runner.COMMAND_FAILURES[-1]['stderr'])
            with self.assertRaisesRegex(RuntimeError, 'worker command timed out') as caught:
                runner.run([sys.executable, '-c', 'import time; time.sleep(10)', secret], timeout=.1)
            self.assertNotIn(secret, str(caught.exception))


if __name__ == '__main__': unittest.main()
