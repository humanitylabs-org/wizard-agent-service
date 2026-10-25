import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).parent

class CurrentIntegrationReviewTests(unittest.TestCase):
    def setUp(self):
        self.data = json.loads((ROOT / 'merge-resolutions.json').read_text())

    def replacements(self, name):
        return '\n'.join(row['replacement'] for row in self.data['resolutions'] if row['path'] == name)

    def test_staging_and_review_use_same_current_feature_pin(self):
        spec = importlib.util.spec_from_file_location('stage', ROOT / 'stage-candidate.py')
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        self.assertEqual(self.data['provider_sha'], '5e445fca7c87da825e8d669fbf35e3e6eeeb5acb')
        self.assertEqual(module.SERVICE, '5f590792828fd455bd5b4f5b71c155d30e7573ca')
        source=(ROOT/'stage-candidate.py').read_text()
        self.assertIn("'git','apply','--3way'",source)
        self.assertNotIn("'merge','--no-ff'",source)
        self.assertIn("integrated='8aa4372ff0c64ae2e053032da789395d03c70540'",source)

    def test_current_sharing_and_migration_security_both_retained(self):
        text = self.replacements('server/agents.mjs')
        for required in ('shared_with_agents === true', 'Model choices are validated',
                         'const harnessChanged = migrated ||', 'harnessPermissions',
                         'await runtime.scrubPrivateMigration(id)', 'stateHome:',
                         'assertProviderAvailable', 'setRunning, remove,'):
            self.assertIn(required, text)

    def test_current_bounded_search_and_archive_limit_not_replaced_by_stale_feature(self):
        text = self.replacements('server/agents-http.mjs')
        self.assertIn('searchHermesSessionTextAsync', text)
        self.assertIn("searchParams.get('mode')==='body'", text)
        self.assertNotIn('privateChatMatches(', text)
        self.assertIn('LIMIT ?', self.replacements('server/archived-sessions.mjs'))

    def test_spaces_and_provider_parity_rows_are_both_retained(self):
        text = self.replacements('qa/agent-parity/features.json')
        self.assertIn('"id": "private-provider-admission"', text)
        self.assertIn('"id": "chats-spaces"', text)
        self.assertIn('server/spaces-tools.mjs', text)
        self.assertEqual(text.count('"id": "chats-spaces"'), 1)
        self.assertIn('realDate(s.createdAt)', self.replacements('server/ui-preferences.mjs'))
        self.assertIn('2026-02-31', self.replacements('tests/ui-preferences.test.ts'))

if __name__ == '__main__': unittest.main()
