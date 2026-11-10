"""Offline regression for Hermes 'ok' vs connection-app 'ready' status."""
import importlib.util
import sys
import types
import unittest
from unittest import mock
from pathlib import Path

PATH = Path(__file__).parents[1] / 'hermes-plugin/wizard-os/dashboard/provider_accounts.py'
spec = importlib.util.spec_from_file_location('account_projection_under_test', PATH)
projection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(projection)


class StatusTests(unittest.TestCase):
    def test_healthy_hermes_grant_is_ready_for_connection_app(self):
        entry = {'id': 'synthetic', 'label': 'Synthetic', 'auth_type': 'oauth',
                 'last_status': 'ok', 'access_token': 't1'}
        window = types.SimpleNamespace(used_percent=10, label='Weekly', reset_at=None)
        snapshot = types.SimpleNamespace(windows=[window], plan='Pro', fetched_at=None,
                                         unavailable_reason=None)
        output = projection.provider_accounts('chatgpt', read=lambda _: [entry],
                                               fetch=lambda *args, **kwargs: snapshot)
        self.assertEqual(output['accountCount'], 1)
        self.assertEqual(output['accounts'][0]['status'], 'ready')
        self.assertEqual(output['accounts'][0]['usageStatus'], 'ok')
        self.assertEqual(output['accounts'][0]['plan'], 'Pro')


    def _snapshot(self):
        window = types.SimpleNamespace(used_percent=10, label='Weekly', reset_at=None)
        return types.SimpleNamespace(windows=[window], plan='Pro', fetched_at=None, unavailable_reason=None)

    def setUp(self):
        projection._CACHE.clear()
        projection._RENEWED.clear()
        offline = mock.patch.object(projection, '_anthropic_quota', return_value=(None, None, None))
        offline.start()
        self.addCleanup(offline.stop)

    def test_expired_grant_is_renewed_before_reading_usage(self):
        old = {'id': 'g1', 'label': 'A', 'auth_type': 'oauth', 'last_status': 'ok',
               'access_token': 'stale', 'expires_at_ms': 1}
        new = dict(old, access_token='fresh', expires_at_ms=9e15)
        seen = []
        def fetch(provider, api_key, **kwargs):
            seen.append(api_key)
            return self._snapshot()
        out = projection.provider_accounts('chatgpt', read=lambda _: [old], fetch=fetch,
                                           renew=lambda slug, row, read: (new, False))
        self.assertEqual(seen, ['fresh'])
        self.assertEqual(out['accounts'][0]['status'], 'ready')
        self.assertEqual(out['accounts'][0]['usageStatus'], 'ok')

    def test_grant_that_cannot_be_renewed_reads_expired(self):
        old = {'id': 'g2', 'label': 'B', 'auth_type': 'oauth', 'last_status': 'ok',
               'access_token': 'stale', 'expires_at_ms': 1}
        out = projection.provider_accounts('chatgpt', read=lambda _: [old], fetch=lambda *a, **k: None,
                                           renew=lambda slug, row, read: (None, True))
        row = out['accounts'][0]
        self.assertEqual(row['status'], 'expired')
        self.assertEqual(row['error']['code'], 'expired')
        self.assertTrue(row['actions']['reconnect'])

    def test_claude_code_mirror_is_never_renewed_here(self):
        mirror = {'id': 'm', 'label': 'claude_code', 'source': 'claude_code', 'auth_type': 'oauth',
                  'access_token': 'stale', 'expires_at_ms': 1}
        def renew(*args):
            raise AssertionError('mirror renewed')
        out = projection.provider_accounts('claude', read=lambda _: [mirror], fetch=lambda *a, **k: None, renew=renew)
        self.assertEqual(out['accounts'][0]['mirror'], 'claude-code')

    def test_renewal_is_attempted_at_most_once_per_interval(self):
        projection._RENEWED['g3'] = (projection.time.monotonic(), None)
        row = {'id': 'g3', 'access_token': 'stale', 'expires_at_ms': 1}
        self.assertEqual(projection._renew('anthropic', row, lambda _: []), (None, None))

    def _stock_pool(self, refresh):
        """Stand-in for stock Hermes' `agent.credential_pool.load_pool` (synthetic, offline)."""
        calls = []
        pool = types.SimpleNamespace(try_refresh_matching=lambda credential_id: calls.append(credential_id) or refresh())
        module = types.ModuleType('agent.credential_pool')
        module.load_pool = lambda slug: pool
        patch = mock.patch.dict(sys.modules, {'agent': types.ModuleType('agent'), 'agent.credential_pool': module})
        patch.start()
        self.addCleanup(patch.stop)
        return calls

    def test_dead_grant_without_expiry_reads_expired(self):
        # Hermes marks a terminally refused grant `dead`; with no stored expiry it was shown as needs_attention.
        dead = {'id': 'g4', 'label': 'D', 'auth_type': 'oauth', 'last_status': 'dead', 'access_token': 'stale'}
        def renew(*args):
            raise AssertionError('a dead grant is not renewed')
        out = projection.provider_accounts('chatgpt', read=lambda _: [dead], fetch=lambda *a, **k: None, renew=renew)
        row = out['accounts'][0]
        self.assertEqual(row['status'], 'expired')
        self.assertEqual(row['error']['code'], 'expired')

    def test_no_usage_call_with_a_token_that_failed_to_renew(self):
        old = {'id': 'g5', 'label': 'E', 'auth_type': 'oauth', 'last_status': 'ok',
               'access_token': 'stale', 'expires_at_ms': 1}
        seen = []
        def fetch(provider, api_key, **kwargs):
            seen.append(api_key)
            return self._snapshot()
        for result in ((None, True), (None, None)):
            out = projection.provider_accounts('chatgpt', read=lambda _: [old], fetch=fetch,
                                               renew=lambda slug, row, read: result)
            self.assertEqual(out['accounts'][0]['usageStatus'], 'unavailable')
        self.assertEqual(seen, [])

    def test_refused_renewal_is_remembered_until_the_next_attempt(self):
        calls = self._stock_pool(lambda: None)
        row = {'id': 'g6', 'auth_type': 'oauth', 'last_status': 'ok', 'access_token': 'stale', 'expires_at_ms': 1}
        self.assertEqual(projection._renew('openai-codex', row, lambda _: [row]), (None, True))
        # Within the interval the row keeps reading expired, without a second attempt.
        self.assertEqual(projection._renew('openai-codex', row, lambda _: [row]), (None, True))
        self.assertEqual(calls, ['g6'])
        projection._RENEWED['g6'] = (projection._RENEWED['g6'][0] - projection._RENEW_EVERY - 1, True)
        projection._renew('openai-codex', row, lambda _: [row])
        self.assertEqual(calls, ['g6', 'g6'])

    def test_inconclusive_renewal_never_claims_expired(self):
        def boom():
            raise TimeoutError('refresh lock busy')
        self._stock_pool(boom)
        row = {'id': 'g7', 'label': 'F', 'auth_type': 'oauth', 'last_status': 'ok',
               'access_token': 'stale', 'expires_at_ms': 1}
        self.assertEqual(projection._renew('openai-codex', row, lambda _: [row]), (None, None))
        out = projection.provider_accounts('chatgpt', read=lambda _: [row], fetch=lambda *a, **k: None)
        self.assertEqual(out['accounts'][0]['status'], 'ready')
        self.assertIsNone(out['accounts'][0].get('error'))

    def test_live_grant_speaks_for_the_account_over_a_dead_or_expired_one(self):
        import base64, json
        def token(exp):
            claims = {'sub': 'u1', 'exp': exp, 'https://api.openai.com/auth': {'chatgpt_account_id': 'acct'}}
            return 'eyJ.' + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=') + '.sig'
        stale = {'id': 'old', 'label': 'Old', 'auth_type': 'oauth', 'source': 'manual:device_code',
                 'last_status': 'ok', 'access_token': token(1)}
        dead = dict(stale, id='dead', label='Dead', last_status='dead')
        live = {'id': 'live', 'label': 'Live', 'auth_type': 'oauth', 'source': 'device_code',
                'last_status': 'ok', 'access_token': token(9e9)}
        def renew(*args):
            raise AssertionError('a stale duplicate is renewed while a working grant exists')
        out = projection.provider_accounts('chatgpt', read=lambda _: [dead, stale, live],
                                           fetch=lambda *a, **k: self._snapshot(), renew=renew)
        row = out['accounts'][0]
        self.assertEqual(out['accountCount'], 1)
        self.assertEqual(row['name'], 'Live')
        self.assertEqual(row['status'], 'ready')
        self.assertEqual(row['usageStatus'], 'ok')

    def test_claude_dead_newest_grant_never_speaks_for_the_account(self):
        acct = {'account': {'uuid': 'acc-11111111'}, 'organization': {'uuid': 'org-22222222'}}
        tokens = {'tok-old': acct, 'tok-new': acct}
        projection._IDENTITIES.clear()
        projection._SEEN.clear()
        def profile(token):
            return tokens.get(token)
        patch = mock.patch.object(projection, '_claude_profile', side_effect=profile)
        patch.start()
        self.addCleanup(patch.stop)
        old = {'id': 'a1', 'label': 'Old', 'auth_type': 'oauth', 'source': 'manual:hermes_pkce', 'access_token': 'tok-old'}
        new = dict(old, id='b2', label='New', access_token='tok-new', last_status='dead')
        out = projection.provider_accounts('claude', read=lambda _: [old, new], fetch=lambda *a, **k: None)
        row = out['accounts'][0]
        self.assertEqual([c['id'] for c in row['credentials']], ['a1', 'b2'])
        self.assertEqual(row['status'], 'ready')

    def test_management_message_names_the_provider(self):
        out = projection.provider_accounts('claude', read=lambda _: [], fetch=lambda *a, **k: None)
        self.assertIn('Claude', out['management']['message'])
        self.assertNotIn('OpenAI', out['management']['message'])


if __name__ == '__main__':
    unittest.main()
