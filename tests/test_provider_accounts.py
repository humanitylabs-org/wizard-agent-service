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

    def test_legacy_labels_never_merge_unproven_accounts(self):
        rows = [row('a', 'r1', 'CODEX'), row('b', 'r2', 'CODEX-2'), row('c', 'r3', 'CODEX-3')]
        out = m.provider_accounts('chatgpt', lambda _: rows, self.fetch)
        self.assertEqual(out['accountCount'], 3)
        self.assertEqual(out['management']['contract'], 'wizard.account-management/1')
        for item in rows: item['access_token'] = 'unproven'
        self.assertEqual(m.provider_accounts('chatgpt', lambda _: rows, self.fetch)['accountCount'], 3)

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

    def test_exact_email_hash_without_the_email(self):
        import hashlib
        out = m.provider_accounts('chatgpt', lambda _: [row(), row('b', 'r2')], self.fetch)
        want = hashlib.sha256(b'private@example.com').hexdigest()[:16]
        self.assertEqual([a['emailHash'] for a in out['accounts']], [want, want])
        self.assertNotIn('private@example.com', json.dumps(out))
        plain = row(label='Work'); plain['access_token'] = 'opaque'
        self.assertNotIn('emailHash', m.provider_accounts('claude', lambda _: [plain], self.fetch)['accounts'][0])

    def test_email_like_label_is_never_hashed_as_the_account(self):
        # A label is owner-typed text, not proof of the account: an opaque token labelled with someone's
        # address must not get that address's hash (the app would merge two unrelated accounts).
        labelled = row(label='other@example.com'); labelled['access_token'] = 'opaque'
        account = m.provider_accounts('claude', lambda _: [labelled], self.fetch)['accounts'][0]
        self.assertNotIn('emailHash', account)
        self.assertNotIn('other@example.com', json.dumps(account))

    def test_long_anthropic_profile_email_is_hashed_whole(self):
        import hashlib
        long_email = ('a' * 60) + '@' + ('d' * 100) + '.example'
        original = m._anthropic_get
        m._anthropic_get = lambda path, token: {'account': {'email': long_email}} if path == 'profile' else {}
        try:
            plan, usage, email = m._anthropic_quota('opaque')
            self.assertEqual(email, long_email)
            claude = row(label='Work'); claude['access_token'] = 'opaque-long'
            account = m.provider_accounts('claude', lambda _: [claude], self.fetch)['accounts'][0]
        finally:
            m._anthropic_get = original
        self.assertEqual(account['emailHash'], hashlib.sha256(long_email.encode()).hexdigest()[:16])

    def test_labels_mask_email_and_credential_like_values(self):
        out = m.provider_accounts('chatgpt', lambda _: [row(label='private@example.com')], self.fetch)
        self.assertEqual(out['accounts'][0]['name'], 'p***@e***')
        out = m.provider_accounts('chatgpt', lambda _: [row(label='sk-secret')], self.fetch)
        self.assertEqual(out['accounts'][0]['name'], 'ChatGPT subscription')

if __name__ == '__main__':
    unittest.main()
