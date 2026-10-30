"""Synthetic-only account tests; no writes or logins against the owner's pool."""
import base64
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from datetime import datetime, timezone
import time
import unittest

SPEC = importlib.util.spec_from_file_location('accounts', Path(__file__).parents[1] / 'hermes-plugin/wizard-os/dashboard/provider_accounts.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


def row(identity='a', id='r1', label='Work', exp=None):
    claims = {'sub': identity, 'email': 'private@example.com', 'https://api.openai.com/auth': {'chatgpt_account_id': identity, 'chatgpt_plan_type': 'pro'}}
    if exp is not None:
        claims['exp'] = exp
    token = 'eyJ.' + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=') + '.SECRET'
    return {'id': id, 'label': label, 'auth_type': 'oauth', 'source': 'manual:device_code', 'access_token': token, 'refresh_token': 'SECRET_REFRESH'}


class AccountsTest(unittest.TestCase):
    def setUp(self):
        m._CACHE.clear()
        m._REFRESHED.clear()
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

    def test_listing_declares_it_reports_email_hashes(self):
        # Connection apps fall back to comparing masked emails only for plugins that predate emailHash; this marker
        # tells them a row without a hash is not the same account, even when the masks match.
        out = m.provider_accounts('claude', lambda _: [], self.fetch)
        self.assertEqual(out['identity'], {'emailHash': 'sha256-16'})

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


class StatusContractTest(unittest.TestCase):
    """Row states the connection apps understand, and usage that survives an idle (expired) access token."""

    def setUp(self):
        m._CACHE.clear()
        m._REFRESHED.clear()
        self.calls = []
        self.refreshes = []

    def fetch(self, provider, **kwargs):
        self.calls.append(kwargs.get('api_key'))
        return SimpleNamespace(plan='Pro', windows=[SimpleNamespace(label='Weekly', used_percent=20, reset_at=None)],
                               fetched_at=datetime.now(timezone.utc), unavailable_reason=None)

    def no_refresh(self, slug, credential_id):
        self.refreshes.append((slug, credential_id))
        raise AssertionError('a live token must not be renewed')

    def test_hermes_ok_is_reported_ready(self):
        live = row(); live['last_status'] = 'ok'
        account = m.provider_accounts('chatgpt', lambda _: [live], self.fetch, self.no_refresh)['accounts'][0]
        self.assertEqual(account['status'], 'ready')
        self.assertIsNone(account['error'])
        self.assertEqual(account['usageStatus'], 'ok')

    def test_dead_grant_is_reported_expired_for_reconnect(self):
        dead = row(); dead['last_status'] = 'dead'
        account = m.provider_accounts('chatgpt', lambda _: [dead], self.fetch, self.no_refresh)['accounts'][0]
        self.assertEqual(account['status'], 'expired')
        self.assertEqual(account['error']['code'], 'expired')

    def test_expired_token_is_renewed_by_stock_hermes_before_reading_usage(self):
        stale = row(exp=time.time() - 3600); stale['last_status'] = 'ok'
        renewed = row(exp=time.time() + 86400); renewed['last_status'] = 'ok'
        store = [stale]

        def refresh(slug, credential_id):
            self.refreshes.append((slug, credential_id))
            store[0] = renewed  # Hermes persists the new token in the pool store.
            return True
        out = m.provider_accounts('chatgpt', lambda _: list(store), self.fetch, refresh)
        account = out['accounts'][0]
        self.assertEqual(self.refreshes, [('openai-codex', 'r1')])
        self.assertEqual(self.calls, [renewed['access_token']])  # never the stale token
        self.assertEqual((account['status'], account['usageStatus']), ('ready', 'ok'))
        m.provider_accounts('chatgpt', lambda _: list(store), self.fetch, refresh)
        self.assertEqual(len(self.refreshes), 1)  # the renewed token needs no second renewal
        self.assertNotIn('SECRET', json.dumps(out))

    def test_refused_renewal_reports_expired_and_is_not_retried_every_read(self):
        stale = row(exp=time.time() - 3600); stale['last_status'] = 'ok'

        def refuse(slug, credential_id):
            self.refreshes.append(credential_id)
            return False
        for _ in range(3):
            account = m.provider_accounts('chatgpt', lambda _: [stale], self.fetch, refuse)['accounts'][0]
            self.assertEqual(account['status'], 'expired')
            self.assertEqual(account['error'], {'code': 'expired', 'message': 'This sign-in expired and could not be renewed. Reconnect it.'})
            self.assertEqual(account['usageStatus'], 'unavailable')
        self.assertEqual(self.refreshes, ['r1'])  # one attempt per interval
        self.assertEqual(self.calls, [])  # no usage call with a dead token
        m._REFRESHED[('openai-codex', 'r1')] = (time.monotonic() - m._REFRESH_INTERVAL - 1, 'refused')
        m.provider_accounts('chatgpt', lambda _: [stale], self.fetch, refuse)
        self.assertEqual(self.refreshes, ['r1', 'r1'])  # retried once the interval has passed

    def test_inconclusive_renewal_does_not_claim_expired(self):
        stale = row(exp=time.time() - 3600); stale['last_status'] = 'ok'
        account = m.provider_accounts('chatgpt', lambda _: [stale], self.fetch, lambda *a: None)['accounts'][0]
        self.assertEqual((account['status'], account['usageStatus']), ('ready', 'unavailable'))
        self.assertIsNone(account['error'])

    def test_live_alias_is_read_instead_of_renewing_a_stale_one(self):
        stale = row(id='old', exp=time.time() - 3600)
        live = row(id='new', exp=time.time() + 86400)
        out = m.provider_accounts('chatgpt', lambda _: [live, stale], self.fetch, self.no_refresh)
        self.assertEqual(out['accountCount'], 1)
        self.assertEqual(self.calls, [live['access_token']])
        self.assertEqual(self.refreshes, [])

    def test_claude_rows_renew_by_expiry_stamp_but_never_the_claude_code_mirror(self):
        pool = row(id='p1'); pool['access_token'] = 'old-claude'; pool['expires_at_ms'] = int((time.time() - 60) * 1000)
        mirror = row(id='cc'); mirror.update(access_token='mirror-claude', source='claude_code', refresh_token='',
                                             expires_at_ms=int((time.time() - 60) * 1000))
        store = {'p1': pool}
        tokens = []

        def refresh(slug, credential_id):
            self.refreshes.append((slug, credential_id))
            store['p1'] = {**pool, 'access_token': 'new-claude', 'expires_at_ms': int((time.time() + 28800) * 1000)}
            return True
        original = m._anthropic_get
        m._anthropic_get = lambda path, token: tokens.append(token) or (
            {'five_hour': {'utilization': 12, 'resets_at': None}} if path == 'usage' else {})
        try:
            out = m.provider_accounts('claude', lambda _: [store['p1'], mirror], self.fetch, refresh)
        finally:
            m._anthropic_get = original
        self.assertEqual(self.refreshes, [('anthropic', 'p1')])
        self.assertNotIn('old-claude', tokens)
        self.assertNotIn('mirror-claude', tokens)
        by_id = {a['credentials'][0]['id']: a for a in out['accounts']}
        self.assertEqual(by_id['p1']['usageStatus'], 'ok')
        self.assertEqual(by_id['cc']['mirror'], 'claude-code')

    def test_management_message_names_the_provider(self):
        chatgpt = m.provider_accounts('chatgpt', lambda _: [], self.fetch)['management']['message']
        claude = m.provider_accounts('claude', lambda _: [], self.fetch)['management']['message']
        self.assertIn('OpenAI', chatgpt)
        self.assertEqual(claude, 'Add signs in to a separate Claude subscription in the Hermes Anthropic pool. '
                                 'The existing Claude Code login is unchanged.')
        self.assertNotIn('OpenAI', claude)


if __name__ == '__main__':
    unittest.main()
