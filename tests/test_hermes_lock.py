"""Stock Hermes defaults resolve through the shared lock, without Docker writes."""
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'ops/agent-runtime'))
import agent_runtime as runtime
import hermes_import


class SharedLockTests(unittest.TestCase):
    def test_normal_and_imported_defaults_are_exact_locked_image(self):
        lock = json.loads((ROOT / 'ops/agent-runtime/hermes-lock.json').read_text())
        self.assertEqual(runtime.DEFAULT_IMAGE, lock['runtime_image'])
        self.assertEqual(hermes_import.IMAGE, lock['runtime_image'])
        self.assertRegex(runtime.DEFAULT_IMAGE, r'@sha256:[0-9a-f]{64}$')

    def test_restricted_runtime_never_inherits_ambient_floating_image(self):
        agents = SimpleNamespace(root=Path('/fixture'), secret=lambda *_: 'fixture-key', home=lambda _: Path('/fixture/home'))
        driver = runtime.RestrictedDriver(agents, runtime.RESTRICTED_DIR, '')
        agent = {'id': 'fixture', 'runtime': {'network': {'uplink': '10.250.0.16/28', 'sandbox': '10.251.0.16/28'}}}
        with patch.dict('os.environ', {'AGENT_IMAGE': 'nousresearch/hermes-agent:latest'}):
            env = driver.env(agent)
        self.assertEqual(env['AGENT_IMAGE'], runtime.DEFAULT_IMAGE)
        self.assertIn('@sha256:', env['AGENT_IMAGE'])

    def test_existing_agent_is_never_silently_upgraded_or_downgraded(self):
        driver = runtime.ComposeDriver(SimpleNamespace(root=Path('/nonexistent-fixture'), providers=SimpleNamespace(is_private=lambda _agent: False)), runtime.DEFAULT_IMAGE, 'proxy')
        agent = {'id': 'fixture', 'runtime': {'app_id': 'agent-fixture'}}
        image = 'sha256:' + 'a' * 64
        def result(value):
            return SimpleNamespace(stdout=value, returncode=0)
        with patch.object(runtime, 'docker', side_effect=[result('container'), result(image), result('sha256:' + 'b' * 64)]), patch.object(driver, 'apply') as apply:
            with self.assertRaises(runtime.RuntimeFailure) as exc:
                runtime.lifecycle_action(driver, agent, 'apply')
        self.assertEqual(exc.exception.code, 'hermes_updates_paused')
        apply.assert_not_called()
        with patch.object(runtime, 'docker', side_effect=[result('container'), result(image), result(image)]), patch.object(driver, 'apply', return_value={'ok': True}) as apply:
            self.assertEqual(runtime.lifecycle_action(driver, agent, 'apply'), {'ok': True})
        apply.assert_called_once()
        with patch.object(runtime, 'docker', return_value=result('')), patch.object(driver, 'apply', return_value={'ok': True}) as apply:
            runtime.lifecycle_action(driver, agent, 'apply')
        apply.assert_called_once()

    def test_cli_refuses_unreviewed_image_before_opening_credentials(self):
        import contextlib
        import io
        output = io.StringIO()
        with contextlib.redirect_stderr(output), self.assertRaises(SystemExit) as exc:
            runtime.main(['--agents-dir', '/fixture', '--image', 'nousresearch/hermes-agent:latest'])
        self.assertEqual(exc.exception.code, 2)
        self.assertIn('shared exact lock', output.getvalue())


if __name__ == '__main__':
    unittest.main()
