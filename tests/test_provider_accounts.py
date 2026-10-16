"""Synthetic-only account tests; no writes or logins against the owner's pool."""
import base64
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from datetime import datetime, timezone
import unittest

SPEC = importlib.util.spec_from_file_location('accounts', Path(__file__).parents[1] / 'hermes-plugin/wizard-os/dashboard/provider_accounts.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


def row(identity='a', id='r1', label='Work'):
    claims = {'sub': identity, 'email': 'private@example.com', 'https://api.openai.com/auth': {'chatgpt_account_id': identity, 'chatgpt_plan_type': 'pro'}}
    token = 'eyJ.' + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=') + '.SECRET'
    return {'id': id, 'label': label, 'auth_type': 'oauth', 'source': 'manual:device_code', 'access_token': token, 'refresh_token': 'SECRET_REFRESH'}


class AccountsTest(unittest.TestCase):
    def setUp(self):
        m._CACHE.clear()
        self.calls = []

    def fetch(self, provider, **kwargs):
        self.calls.append((provider, kwargs))
        return SimpleNamespace(plan='Pro', windows=[SimpleNamespace(label='Weekly', used_percent=20, reset_at=None)], fetched_at=datetime.now(timezone.utc), unavailable_reason=None)

    def test_duplicate_grants_are_one_subscription(self):
        rows = [row(), row(id='mirror'), row('b', 'r3')]
        out = m.provider_accounts('chatgpt', lambda _: rows, self.fetch)
        self.assertEqual(out['accountCount'], 2)
        self.assertEqual([a['credentialCount'] for a in out['accounts']], [2, 1])
        self.assertEqual(len(self.calls), 2)
        self.assertTrue(all(kw['read_only'] for _, kw in self.calls))
        self.assertTrue(all(kw['base_url'] == 'https://chatgpt.com/backend-api/codex' for _, kw in self.calls))
        text = json.dumps(out)
        for secret in ('SECRET', 'private@example.com', 'access_token', 'refresh_token'):
            self.assertNotIn(secret, text)

    def test_dynamic_add_remove_and_empty_no_fallback(self):
        rows = [row()]
        read = lambda _: rows
        first = m.provider_accounts('chatgpt', read, self.fetch)
        rows.append(row('b', 'r2'))
        self.assertEqual(m.provider_accounts('chatgpt', read, self.fetch)['accountCount'], 2)
        rows.pop(0)
        second = m.provider_accounts('chatgpt', read, self.fetch)
        self.assertEqual(second['accountCount'], 1)
        self.assertNotEqual(second['accounts'][0]['id'], first['accounts'][0]['id'])
        rows.clear()
        self.assertEqual(m.provider_accounts('chatgpt', read, self.fetch)['accounts'], [])

    def test_error_and_missing_token_do_not_reveal_or_use_singleton(self):
        def fail(*args, **kwargs):
            raise RuntimeError('SECRET_IN_EXCEPTION')
        out = m.provider_accounts('chatgpt', lambda _: [row()], fail)
        self.assertEqual(out['accounts'][0]['usageStatus'], 'unavailable')
        self.assertNotIn('SECRET', json.dumps(out))
        empty = row(); empty['access_token'] = ''
        self.assertEqual(m.provider_accounts('chatgpt', lambda _: [empty], self.fetch)['accounts'][0]['usageStatus'], 'unavailable')
        self.assertEqual(self.calls, [])

    def test_claude_is_not_invented_from_another_volume(self):
        out = m.provider_accounts('claude', lambda _: [], self.fetch)
        self.assertEqual(out['accountCount'], 0)
        self.assertTrue(out['actions']['add'])

    def test_labels_mask_email_and_credential_like_values(self):
        out = m.provider_accounts('chatgpt', lambda _: [row(label='private@example.com')], self.fetch)
        self.assertEqual(out['accounts'][0]['name'], 'p***@e***')
        out = m.provider_accounts('chatgpt', lambda _: [row(label='sk-secret')], self.fetch)
        self.assertEqual(out['accounts'][0]['name'], 'ChatGPT subscription')

if __name__ == '__main__':
    unittest.main()
