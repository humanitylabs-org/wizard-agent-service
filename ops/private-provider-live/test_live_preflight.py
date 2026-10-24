import importlib.util
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('preflight', Path(__file__).with_name('live-preflight.py'))
assert SPEC and SPEC.loader
PREFLIGHT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREFLIGHT)

class UiFingerprintTests(unittest.TestCase):
    def test_absent_ui(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(PREFLIGHT.ui_fingerprint(Path(directory)), {'present': False})

    def test_tracks_static_content_and_symlink_destination_without_reading_target(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory); root = home / 'apps/wizard-mobile/.ui-live'; root.mkdir(parents=True)
            (root / 'index.html').write_text('before')
            (root / 'external.js').symlink_to('/nonexistent/do-not-read')
            before = PREFLIGHT.ui_fingerprint(home)
            self.assertEqual(before, PREFLIGHT.ui_fingerprint(home))
            self.assertEqual(before['files'], 1)
            (root / 'index.html').write_text('after')
            self.assertNotEqual(before['sha256'], PREFLIGHT.ui_fingerprint(home)['sha256'])
            (root / 'external.js').unlink(); (root / 'external.js').symlink_to('/nonexistent/other-target')
            self.assertNotEqual(before['sha256'], PREFLIGHT.ui_fingerprint(home)['sha256'])

if __name__ == '__main__':
    unittest.main()
