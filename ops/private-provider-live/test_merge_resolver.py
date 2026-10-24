import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from merge_resolver import resolve

PIN = 'a' * 40
BLOCK = '<<<<<<< HEAD\nlive\n=======\nprovider\n>>>>>>> ' + PIN + '\n'

class MergeResolverTests(unittest.TestCase):
    def fixture(self, root):
        manifest = root / 'resolutions.json'
        manifest.write_text(json.dumps({'provider_sha': PIN, 'resolutions': [{'path': 'a.mjs', 'sha256': hashlib.sha256(BLOCK.encode()).hexdigest(), 'replacement': 'live\nprovider\n'}]}))
        (root / 'a.mjs').write_text('before\n' + BLOCK + 'after\n')
        return manifest

    def test_exact_reviewed_block_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); manifest = self.fixture(root)
            used = resolve(root, ['a.mjs'], manifest)
            self.assertEqual((root / 'a.mjs').read_text(), 'before\nlive\nprovider\nafter\n')
            self.assertEqual(len(used), 1)

    def test_unknown_hunk_blocks_without_partial_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); manifest = self.fixture(root)
            (root / 'b.mjs').write_text(BLOCK)
            original = (root / 'a.mjs').read_text()
            with self.assertRaisesRegex(ValueError, 'unreviewed'):
                resolve(root, ['a.mjs', 'b.mjs'], manifest)
            self.assertEqual((root / 'a.mjs').read_text(), original)

    def test_changed_base_is_not_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); manifest = self.fixture(root)
            (root / 'a.mjs').write_text(BLOCK.replace('live', 'different live'))
            with self.assertRaisesRegex(ValueError, 'unreviewed'):
                resolve(root, ['a.mjs'], manifest)

    def test_symlink_is_not_followed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); manifest = self.fixture(root)
            (root / 'b.mjs').symlink_to(root / 'a.mjs')
            with self.assertRaisesRegex(ValueError, 'unsafe'):
                resolve(root, ['b.mjs'], manifest)

if __name__ == '__main__':
    unittest.main()
