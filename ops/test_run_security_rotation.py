"""Detached wrapper pre-mutation refusals; synthetic temporary artifacts only."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('wrapper', Path(__file__).with_name('run_security_rotation.py'))
assert spec is not None and spec.loader is not None
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class WrapperTests(unittest.TestCase):
    def test_no_loaded_filter_never_applies(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as tmp:
            root = Path(tmp)
            (root / 'filter-activation.json').write_text(json.dumps({'filter_loaded': False}))
            with patch.object(m.subprocess, 'run') as run, patch.object(m.r, 'protect'), redirect_stdout(io.StringIO()):
                self.assertEqual(m.run(root, root / 'plan.json', root / 'controller.py'), 1)
                run.assert_not_called()
            result = json.loads((root / 'result.json').read_text())
            self.assertEqual(result['failure'], 'filter_not_loaded')
            self.assertFalse(result['old_proof_revoked'] if 'old_proof_revoked' in result else False)

    def test_config_drift_never_applies(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as tmp:
            root = Path(tmp)
            (root / 'filter-activation.json').write_text(json.dumps({'filter_loaded': True, 'config_sha256': 'expected'}))
            with patch.object(m.subprocess, 'run') as run, patch.object(m.r, 'protect'), \
                    patch.object(m.r, 'runtime_filter', return_value={'loaded': True}), \
                    patch.object(m.r, 'hashfile', return_value='changed'), redirect_stdout(io.StringIO()):
                self.assertEqual(m.run(root, root / 'plan.json', root / 'controller.py'), 1)
                run.assert_not_called()
            result = json.loads((root / 'result.json').read_text())
            self.assertEqual(result['failure'], 'gateway_config_drift')


if __name__ == '__main__':
    unittest.main()
