import tempfile
import unittest
from pathlib import Path
from live_sources import discover, launcher_source, runtime_source, FILES

class SourceTests(unittest.TestCase):
    def test_three_independent_selections_and_readonly_hashes(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            roots = {name: home / name for name in ('cli', 'api', 'runtime')}
            for name, root in roots.items():
                for file in FILES:
                    target = root / file
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(name + file)
            launcher = home / '.local/bin/wam'
            launcher.parent.mkdir(parents=True)
            launcher.write_text(f'#!/bin/sh\ncd "{roots["cli"]}" && exec /usr/bin/python3 -m wam "$@"\n')
            def show(unit, field):
                return str(roots['api']) if field == 'WorkingDirectory' else f'{{ argv[]=python3 agent_runtime.py --wam {roots["runtime"]} --port 7794 ; }}'
            before = {p: p.read_bytes() for p in home.rglob('*') if p.is_file()}
            result = discover(home, show)
            self.assertEqual({x: y['resolved'] for x, y in result['selected'].items()}, {x: str(y) for x, y in roots.items()})
            self.assertNotEqual(result['selected']['api']['sha256'], result['selected']['cli']['sha256'])
            self.assertEqual(before, {p: p.read_bytes() for p in home.rglob('*') if p.is_file()})

    def test_unknown_launchers_fail_closed(self):
        for value in ('exec python3 -m wam', 'cd relative && exec python3 -m wam', 'cd /one && exec python3 -m wam\ncd /two && exec python3 -m wam'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                launcher_source(value)

    def test_runtime_missing_or_duplicate_wam_fails_closed(self):
        for value in ('python3 runtime.py', 'python3 runtime.py --wam relative', 'python3 runtime.py --wam /one --wam /two'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                runtime_source(value)

if __name__ == '__main__':
    unittest.main()
