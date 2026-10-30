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
        projection._RENEWED['g3'] = projection.time.monotonic()
        row = {'id': 'g3', 'access_token': 'stale', 'expires_at_ms': 1}
        self.assertEqual(projection._renew('anthropic', row, lambda _: []), (None, None))

    def test_management_message_names_the_provider(self):
        out = projection.provider_accounts('claude', read=lambda _: [], fetch=lambda *a, **k: None)
        self.assertIn('Claude', out['management']['message'])
        self.assertNotIn('OpenAI', out['management']['message'])


if __name__ == '__main__':
    unittest.main()
