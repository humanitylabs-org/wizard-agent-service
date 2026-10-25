"""No-VM regressions for sealed-service reset and scoped retirement proof."""
import ast
from pathlib import Path
import unittest

R = Path(__file__).parent


def reset_selector():
    tree = ast.parse((R / 'rig-reset-3.py').read_text())
    embedded = next(n.value for n in ast.walk(tree) if isinstance(n, ast.Constant)
                    and isinstance(n.value, str) and 'def synthetic(doc):' in n.value)
    function = next(n for n in ast.walk(ast.parse(embedded)) if isinstance(n, ast.FunctionDef) and n.name == 'synthetic')
    scope = {}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[])), 'reset-selector', 'exec'), scope)
    return scope['synthetic']


class ResetScopeTests(unittest.TestCase):
    def test_generic_sealed_service_is_removed_by_exact_project(self):
        select = reset_selector()
        self.assertTrue(select({'Config':{'Labels':{'com.docker.compose.service':'agent','com.docker.compose.project':'agent-pp-test-legacy'}}}))
        self.assertTrue(select({'Config':{'Labels':{'com.docker.compose.service':'edge','com.docker.compose.project':'agent-pp-test-probe'}}}))
        self.assertFalse(select({'Config':{'Labels':{'com.docker.compose.service':'agent','com.docker.compose.project':'agent-owner'}}}))

    def test_exact_synthetic_home_mount_is_covered(self):
        select = reset_selector()
        self.assertTrue(select({'Config':{},'Mounts':[{'Source':'/home/rig/.wizard-os/agents/pp-test-legacy/home'}]}))
        self.assertFalse(select({'Config':{},'Mounts':[{'Source':'/home/rig/.wizard-os/agents/owner/home'}]}))

    def test_final_runner_does_not_nest_shared_lock_or_reuse_attempt(self):
        source = (R / 'run-key-scrub-final.py').read_text()
        self.assertNotIn('run-locked.py', source)
        self.assertIn("'14'", source)
        self.assertIn('p.unlink()', source)


if __name__ == '__main__':
    unittest.main(verbosity=2)
