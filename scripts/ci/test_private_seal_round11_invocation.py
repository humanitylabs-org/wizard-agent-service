"""Tiny subprocess invocation smoke; no product tests, Docker or private state."""
import ast
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'scripts'))
spec = importlib.util.spec_from_file_location('round11_runner', ROOT/'scripts/run-private-seal-round11e.py')
assert spec is not None and spec.loader is not None
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class InvocationTests(unittest.TestCase):
    def test_original_six_modules_and_case_definitions_are_retained(self):
        expected = (
            ('protocol', 'scripts/ci', 'test_private_seal_round11_protocol.py'),
            ('followup', 'scripts/ci', 'test_private_seal_round11_followup.py'),
            ('seal', 'ops/agent-runtime', 'test_private_seal.py'),
            ('key', 'ops/agent-runtime', 'test_provider_key_seal.py'),
            ('legacy-search', 'ops/agent-runtime', 'test_private_search.py'),
            ('edge', 'ops/agent-runtime', 'test_private_seal_edge.py'),
        )
        self.assertEqual(runner.FOCUSED_SUITES, expected + (
            ('invocation', 'scripts/ci', Path(__file__).name),))
        for _, folder, filename in runner.FOCUSED_SUITES:
            argv, cwd = runner.suite_invocation(ROOT, folder, filename)
            self.assertEqual(cwd, ROOT/folder)
            self.assertEqual(argv, ['python3', '-m', 'unittest', Path(filename).stem, '-v'])
            tree = ast.parse((cwd/filename).read_text())
            self.assertTrue(any(isinstance(n, ast.FunctionDef) and n.name.startswith('test_')
                                for n in ast.walk(tree)))

    def fixture_run(self, *, fail):
        with tempfile.TemporaryDirectory(prefix='r11-invocation-') as temp:
            root = Path(temp)
            folder = root/'intended'; folder.mkdir()
            qa = root/'logs'; qa.mkdir()
            marker = folder/'unrelated-imported'
            package = folder/'agent-heavy-plugin'; package.mkdir()
            (package/'__init__.py').write_text(
                "from pathlib import Path\nPath('unrelated-imported').touch()\n"
                "raise ModuleNotFoundError('synthetic unrelated agent.secret_scope refusal')\n")
            (folder/'test_intended.py').write_text(
                'import unittest\nclass Intended(unittest.TestCase):\n'
                '    def test_first(self): self.assertTrue(True)\n'
                '    def test_second(self): self.assertTrue(' + str(not fail) + ')\n')
            # Prove this fixture reproduces the old exact-pattern defect.
            old = subprocess.run(['python3', '-m', 'unittest', 'discover', '-s', '.',
                                  '-p', 'test_intended.py', '-v'], cwd=folder,
                                 text=True, capture_output=True, timeout=10)
            self.assertNotEqual(old.returncode, 0)
            self.assertTrue(marker.exists())
            self.assertIn('synthetic unrelated agent.secret_scope refusal', old.stderr)
            marker.unlink()
            records = {}

            def command(argv, *, cwd, log, timeout, check):
                self.assertFalse(check)
                with (qa/log).open('w') as stream:
                    return subprocess.run(argv, cwd=cwd, stdout=stream,
                                          stderr=subprocess.STDOUT, timeout=min(timeout, 10))

            def execute():
                runner.focused_regressions(command, records, qa, root=root,
                    suites=(('fixture', 'intended', 'test_intended.py'),))

            if fail:
                with self.assertRaisesRegex(AssertionError, '^focused_regressions_failed$'):
                    execute()
            else:
                execute()
            output = (qa/'fixture-regressions.log').read_text()
            self.assertIn('Ran 2 tests', output)
            self.assertIn('test_first (test_intended.Intended.test_first) ... ok', output)
            self.assertIn('test_second (test_intended.Intended.test_second) ... ' +
                          ('FAIL' if fail else 'ok'), output)
            self.assertFalse(marker.exists(), 'explicit module execution imported unrelated package')
            self.assertNotIn('synthetic unrelated', output)
            self.assertEqual(records['fixture']['exit_code'], 1 if fail else 0)
            self.assertEqual(records['fixture']['log_sha256'], runner.digest(qa/'fixture-regressions.log'))

    def test_unrelated_package_is_not_imported_and_exact_cases_execute(self):
        self.fixture_run(fail=False)

    def test_intentional_suite_failure_propagates_and_is_recorded(self):
        self.fixture_run(fail=True)


if __name__ == '__main__':
    unittest.main()
