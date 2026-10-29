"""wizard-os plugin media.py: every MEDIA: file an agent sends lands where Wizard can show it."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('wizard_os_media', ROOT / 'hermes-plugin/wizard-os/media.py')
media = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = media
spec.loader.exec_module(media)

PNG = b'\x89PNG\r\n\x1a\n' + b'\x00' * 64


class MediaPluginTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.home = base / 'hermes'
        self.files = base / 'media'
        for d in ('cache/images', 'cache/screenshots', 'cache/scratch/run'):
            (self.home / d).mkdir(parents=True)
        self.files.mkdir()
        self.env = {k: os.environ.get(k) for k in ('HERMES_HOME', 'WIZARD_FILES_ROOT')}
        os.environ['HERMES_HOME'] = str(self.home)
        os.environ['WIZARD_FILES_ROOT'] = str(self.files)
        self.base = base

    def tearDown(self):
        for k, v in self.env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def write(self, rel, data=PNG):
        path = self.base / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def sent(self, text):
        out = media.transform_llm_output(response_text=text, platform='api_server')
        return out

    def test_scratch_screenshot_is_copied_into_a_shown_folder(self):
        src = self.write('hermes/cache/scratch/run/shot.png')
        out = self.sent(f'Here it is:\n\nMEDIA:{src}\n\nDone.')
        line = [l for l in out.splitlines() if l.startswith('MEDIA:')][0]
        copy = Path(line[6:])
        self.assertEqual(copy.parent, self.home / 'cache/images/wizard-sent')
        self.assertEqual(copy.read_bytes(), PNG)
        self.assertTrue(out.startswith('Here it is:\n\nMEDIA:') and out.endswith('\n\nDone.'))

    def test_already_shown_paths_are_left_alone(self):
        shot = self.write('hermes/cache/screenshots/a.png')
        doc = self.write('media/Inbox/a.pdf', b'%PDF-1.4')
        text = f'MEDIA:{shot}\nMEDIA:{doc}'
        self.assertIsNone(self.sent(text))

    def test_sloppy_forms_become_one_canonical_line(self):
        src = self.write('tmp/out dir/shot one.png')
        out = self.sent(f'See MEDIA: `{src}` for the result.')
        lines = out.splitlines()
        self.assertEqual(lines[0], 'See')
        self.assertTrue(lines[1].startswith('MEDIA:' + str(self.home / 'cache/images/wizard-sent')))
        self.assertEqual(lines[2], 'for the result.')
        # Space after the colon, whole-line path with spaces
        out = self.sent(f'MEDIA: {src}')
        self.assertTrue(out.startswith('MEDIA:/') and out.count('\n') == 0)

    def test_tilde_and_trailing_punctuation(self):
        fake_home = self.base / 'user'
        src = self.write('user/Desktop/pic.png')
        old = os.environ.get('HOME')
        os.environ['HOME'] = str(fake_home)
        try:
            out = self.sent('Saved it (MEDIA:~/Desktop/pic.png).')
        finally:
            os.environ['HOME'] = old
        self.assertIn('\nMEDIA:' + str(self.home / 'cache/images/wizard-sent'), out)
        self.assertTrue(src.exists())

    def test_refused_and_missing_files_stay_as_written(self):
        secret = self.write('other/.hermes/profiles/bob/cache/images/x.png')
        key = self.write('tmp/.ssh/id.png')
        notes = self.write('tmp/notes.py', b'print(1)')
        for path in (secret, key, notes, self.base / 'missing.png'):
            self.assertIsNone(self.sent(f'MEDIA:{path}'), path)
        self.assertFalse((self.home / 'cache/images/wizard-sent').exists())

    def test_fake_image_and_oversize_image_refused(self):
        fake = self.write('tmp/fake.png', b'not an image')
        self.assertIsNone(self.sent(f'MEDIA:{fake}'))

    def test_code_fences_inline_code_and_other_platforms_untouched(self):
        src = self.write('tmp/x.png')
        self.assertIsNone(self.sent(f'```\nMEDIA:{src}\n```'))
        self.assertIsNone(self.sent(f'Write `MEDIA:{src}` like this.'))
        self.assertIsNone(media.transform_llm_output(response_text=f'MEDIA:{src}', platform='telegram'))

    def test_pdf_outside_roots_is_sent(self):
        src = self.write('tmp/report.pdf', b'%PDF-1.4 hello')
        out = self.sent(f'MEDIA:{src}')
        self.assertTrue(Path(out[6:]).read_bytes().startswith(b'%PDF'))

    def test_same_file_twice_reuses_one_copy(self):
        src = self.write('tmp/x.png')
        a = self.sent(f'MEDIA:{src}')
        b = self.sent(f'MEDIA:{src}')
        self.assertEqual(a, b)
        self.assertEqual(len(list((self.home / 'cache/images/wizard-sent').iterdir())), 1)

    def test_sent_copy_is_a_snapshot_not_a_link(self):
        src = self.write('hermes/cache/scratch/run/screenshot.png')
        out = self.sent(f'MEDIA:{src}')
        copy = Path(out[6:])
        self.assertNotEqual(copy.stat().st_ino, src.stat().st_ino)
        with open(src, 'r+b') as f:  # the agent rewrites the same path in place
            f.write(b'\x89PNG\r\n\x1a\nNEWER')
        self.assertEqual(copy.read_bytes(), PNG)

    def test_routed_agent_home_under_profiles_still_works(self):
        os.environ['HERMES_HOME'] = str(self.base / 'h/profiles/alice')
        (self.base / 'h/profiles/alice/cache/images').mkdir(parents=True)
        src = self.write('h/profiles/alice/cache/scratch/s.png')
        out = self.sent(f'MEDIA:{src}')
        self.assertTrue(out.startswith('MEDIA:' + str(self.base / 'h/profiles/alice/cache/images/wizard-sent')))


if __name__ == '__main__':
    unittest.main()
