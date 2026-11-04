#!/usr/bin/env python3
"""Focused Path API regression; never executes Docker or opens a database."""
import ast
from contextlib import redirect_stdout
import io
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops/agent-runtime'))
import hermes_import as h


class ProbePathTests(unittest.TestCase):
    def test_product_probe_passes_path_to_sessiondb(self):
        seen = []
        database = Mock()
        connection = Mock()
        connection.execute.return_value.fetchall.return_value = [(30,)]
        def session_db(path):
            self.assertIsInstance(path, Path, 'SessionDB requires pathlib.Path')
            self.assertEqual(path, Path('/opt/data/state.db'))
            seen.append(path)
            return database
        def command(argv, **kwargs):
            if argv[:2] != ['docker', 'run']:
                return ''
            self.assertEqual(kwargs['timeout'], 120)
            self.assertNotIn('--mount', argv)
            output = io.StringIO()
            with patch.dict(sys.modules, {'hermes_state': SimpleNamespace(SessionDB=session_db)}), \
                    patch('sqlite3.connect', return_value=connection), redirect_stdout(output):
                exec(compile(argv[-1], '<actual-product-probe>', 'exec'), {})
            return output.getvalue()
        runtime = h.DockerRuntime({'image': 'synthetic:unit'}, '.', 'fixture')
        with patch.object(h, 'run', side_effect=command):
            self.assertEqual(runtime.history_schema_version(), 30)
        self.assertEqual(seen, [Path('/opt/data/state.db')])
        database.close.assert_called_once_with()
        connection.close.assert_called_once_with()

    def test_acceptance_sessiondb_fixture_paths(self):
        source = Path(__file__).with_name('history_schema_acceptance.py')
        tree = ast.parse(source.read_text())
        payloads = {n.targets[0].id: n.value.value for n in ast.walk(tree)
                    if isinstance(n, ast.Assign) and len(n.targets) == 1
                    and isinstance(n.targets[0], ast.Name)
                    and n.targets[0].id in {'create', 'reopen', 'unsafe'}
                    and isinstance(n.value, ast.Constant)}
        self.assertEqual(set(payloads), {'create', 'reopen', 'unsafe'})
        class ReachedSessionDB(Exception):
            pass
        def session_db(path):
            self.assertIsInstance(path, Path, 'SessionDB requires pathlib.Path')
            self.assertEqual(path, Path('/opt/data/state.db'))
            raise ReachedSessionDB()
        connection = Mock()
        connection.execute.return_value = [('synthetic-uid-1',), ('synthetic-uid-2',)]
        for name, code in payloads.items():
            with self.subTest(payload=name), \
                    patch.dict(sys.modules, {'hermes_state': SimpleNamespace(SessionDB=session_db)}), \
                    patch('sqlite3.connect', return_value=connection), self.assertRaises(ReachedSessionDB):
                exec(compile(code, '<actual-fixture-' + name + '>', 'exec'), {})


if __name__ == '__main__':
    unittest.main()
