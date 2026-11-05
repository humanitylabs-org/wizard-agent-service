"""Synthetic-only activation-helper regressions; no service or owner-data access."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('activation', Path(__file__).with_name('activate_security.py'))
assert spec is not None and spec.loader is not None
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

LOGGER = b'''    log default {
        format filter {
            wrap json
            fields {
                request>headers>X-Wizard-Owner-Proof delete
                request>headers>x-wizard-owner-proof delete
            }
        }
    }
'''


class ActivationTests(unittest.TestCase):
    def test_exact_block_isolated_from_route(self):
        value = b'{\n' + LOGGER + b' admin off\n}\nimport forbidden-metadata-route\n'
        self.assertEqual(m.block(value), LOGGER)

    def test_single_field_change_refused(self):
        with self.assertRaises(m.r.Gate):
            m.block(b'{\n' + LOGGER.replace(b' delete', b' hash', 1) + b' admin off\n}')

    def test_hide_substitution_only(self):
        original = {'handler': 'file_server', 'hide': ['/synthetic-candidate', '/unrelated'], 'secret': 'unchanged'}
        result = m.normalize_candidate_hide(original, Path('/synthetic-candidate'))
        self.assertEqual(result['hide'], sorted([str(m.r.GATEWAY), '/unrelated']))
        self.assertEqual(original['hide'], ['/synthetic-candidate', '/unrelated'])
        self.assertEqual(result['secret'], 'unchanged')

    def test_no_hide_entry_cannot_be_silently_normalized(self):
        with self.assertRaises(m.r.Gate):
            m.normalize_candidate_hide({'handler': 'file_server', 'hide': ['/unrelated']}, Path('/synthetic-candidate'))

    def test_ambiguous_hide_refused(self):
        with self.assertRaises(m.r.Gate):
            m.normalize_candidate_hide({'handler': 'file_server', 'hide': ['/synthetic-candidate', str(m.r.GATEWAY)]}, Path('/synthetic-candidate'))

    def test_atomic_no_temp_leaks_and_mode_preserved(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as tmp:
            p = Path(tmp) / 'config'
            m.atomic(p, b'before', 0o600)
            m.atomic(p, b'after', 0o640)
            self.assertEqual(p.read_bytes(), b'after')
            self.assertEqual(p.stat().st_mode & 0o777, 0o640)
            self.assertEqual([x.name for x in Path(tmp).iterdir()], ['config'])

    def test_import_closure_detects_new_glob_sibling(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as tmp:
            root = Path(tmp)
            p = root / 'Caddyfile'
            p.write_text('import ' + str(root / '*.inc') + '\nimport named_snippet\n')
            (root / 'a.inc').write_text('respond ok')
            with patch.object(m.r, 'GATEWAY', p):
                before = m.closure()
                (root / 'b.inc').write_text('respond new')
                after = m.closure()
            self.assertNotEqual(before, after)
            self.assertEqual(len(after['files']), 3)


if __name__ == '__main__':
    unittest.main()
