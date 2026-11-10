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
        m._IDENTITIES.clear()
        m._SEEN.clear()
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

    def test_priority_order_marks_the_sign_in_hermes_tries_first(self):
        rows = [row('a', 'r1', 'Work'), row('b', 'r2', 'Home')]
        rows[0]['priority'], rows[1]['priority'] = 1, 0
        out = m.provider_accounts('chatgpt', lambda _: rows, self.fetch)
        self.assertEqual([(a['priority'], a['preferred']) for a in out['accounts']], [(1, False), (0, True)])
        self.assertEqual([c['priority'] for a in out['accounts'] for c in a['credentials']], [1, 0])
        self.assertTrue(all(a['actions']['prefer'] for a in out['accounts']))
        self.assertEqual(out['management']['order'], 'priority')
        for item in rows: item.pop('priority')
        out = m.provider_accounts('chatgpt', lambda _: rows, self.fetch)
        self.assertEqual([a['preferred'] for a in out['accounts']], [False, False])
        seeded = dict(row('c', 'r9', 'claude_code'), source='claude_code')
        mixed = m.provider_accounts('claude', lambda _: [row('a', 'r1', 'Work'), seeded], self.fetch)
        self.assertEqual([a['actions']['prefer'] for a in mixed['accounts']], [True, False])
        alone = m.provider_accounts('claude', lambda _: [seeded], self.fetch)
        self.assertTrue(alone['accounts'][0]['actions']['prefer'])
        claude = m.provider_accounts('claude', lambda _: [], self.fetch)
        self.assertIn('different Claude account', claude['management']['message'])

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

    def test_claude_cooldown_projection_is_fresh_complete_and_secret_free(self):
        import time
        rows = [row(id='oscar'), row(id='claude_code')]
        for r in rows:
            r['source'] = 'claude_code' if r['id'] == 'claude_code' else 'manual:hermes_pkce'
            r['model_cooldowns'] = {'claude-opus-5-5': time.time() + 3600}
        first = m.claude_model_cooldowns(read=lambda _: rows)
        evidence = first
        self.assertEqual(evidence['contract'], 'wizard.model-cooldowns/1')
        self.assertEqual(len(evidence['grants']), 2)
        self.assertEqual(len({r['id'] for r in evidence['grants']}), 2)
        self.assertNotIn('SECRET', json.dumps(evidence))
        self.assertNotIn('access_token', json.dumps(evidence))
        rows[1]['model_cooldowns'].clear()  # Hermes auth reset, not stale cached usage.
        second = m.claude_model_cooldowns(read=lambda _: rows)
        self.assertEqual(second['grants'][1]['models'], {})
        rows.append(row(id='third'))
        self.assertEqual(len(m.claude_model_cooldowns(read=lambda _: rows)['grants']), 3)
        rows[-1]['auth_type'] = 'api_key'  # Unknown alternate grant: no authoritative projection.
        self.assertIsNone(m.claude_model_cooldowns(read=lambda _: rows))

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

    def claude_rows(self, profiles):
        """Fake the Claude profile/usage endpoints per opaque token; returns the list of profile calls."""
        calls = []
        original = m._anthropic_get
        def fake(path, token):
            if path == 'profile':
                calls.append(token)
                if profiles.get(token) is None:
                    raise OSError('401')
                return profiles[token]
            return {'five_hour': {'utilization': 10, 'resets_at': None}}
        m._anthropic_get = fake
        self.addCleanup(setattr, m, '_anthropic_get', original)
        return calls

    @staticmethod
    def claude(id, token, source='manual:hermes_pkce', priority=None):
        r = {'id': id, 'label': 'Claude', 'auth_type': 'oauth', 'source': source, 'access_token': token}
        if priority is not None:
            r['priority'] = priority
        return r

    def test_claude_duplicate_sign_in_is_one_row_with_a_removable_grant(self):
        # Owner report (issue 434): signing in to an already-added Claude account again showed it twice.
        import hashlib
        acct = {'account': {'uuid': 'acc-11111111', 'email': 'other@example.com'},
                'organization': {'uuid': 'org-22222222', 'organization_type': 'claude_max'}}
        code = {'account': {'uuid': 'acc-33333333', 'email': 'me@example.com'},
                'organization': {'uuid': 'org-44444444'}}
        calls = self.claude_rows({'tok-old': acct, 'tok-new': acct, 'tok-code': code})
        rows = [self.claude('9f3a1c', 'tok-code', source='claude_code', priority=2),
                self.claude('a1b2c3', 'tok-old', priority=0), self.claude('d4e5f6', 'tok-new', priority=1)]
        before = m.provider_accounts('claude', lambda _: rows[:2], self.fetch)['accounts']
        m._CACHE.clear()
        out = m.provider_accounts('claude', lambda _: rows, self.fetch)
        self.assertEqual(out['accountCount'], 2)
        mirror, added = out['accounts']
        self.assertEqual(mirror['mirror'], 'claude-code')
        self.assertEqual(mirror['credentialCount'], 1)
        self.assertEqual(added['credentialCount'], 2)
        # Newest sign-in first: Use first targets the grant that still renews; each one can be removed.
        self.assertEqual([c['id'] for c in added['credentials']], ['d4e5f6', 'a1b2c3'])
        self.assertTrue(all(c['managed'] for c in added['credentials']))
        self.assertTrue(added['actions']['remove'])
        self.assertEqual(added['priority'], 0)
        # The row keeps the ID it had before the duplicate arrived.
        self.assertEqual(added['id'], before[1]['id'])
        self.assertEqual(added['id'], hashlib.sha256(b'anthropic:a1b2c3').hexdigest()[:24])
        self.assertEqual(added['emailHash'], hashlib.sha256(b'other@example.com').hexdigest()[:16])
        self.assertEqual(added['plan'], 'Max')
        # One profile lookup per token and listing serves both identity and usage labels.
        self.assertEqual(sorted(calls), ['tok-code', 'tok-code', 'tok-new', 'tok-old', 'tok-old'])
        text = json.dumps(out)
        for secret in ('acc-1111', 'org-2222', 'other@example.com', 'tok-'):
            self.assertNotIn(secret, text)
        # After the owner removes the duplicate, the same row remains with one grant.
        m._CACHE.clear()
        after = m.provider_accounts('claude', lambda _: rows[:2], self.fetch)['accounts']
        self.assertEqual([a['id'] for a in after], [a['id'] for a in before])
        self.assertEqual(after[1]['credentialCount'], 1)

    def test_claude_same_email_in_another_organization_stays_separate(self):
        email = {'uuid': 'acc-11111111', 'email': 'other@example.com'}
        self.claude_rows({'tok-a': {'account': email, 'organization': {'uuid': 'org-aaaaaaaa'}},
                          'tok-b': {'account': email, 'organization': {'uuid': 'org-bbbbbbbb'}},
                          'tok-c': {'account': {'email': 'other@example.com'}, 'organization': {}}})
        rows = [self.claude('a1', 'tok-a'), self.claude('b2', 'tok-b'), self.claude('c3', 'tok-c')]
        out = m.provider_accounts('claude', lambda _: rows, self.fetch)
        self.assertEqual(out['accountCount'], 3)
        self.assertEqual([a['credentialCount'] for a in out['accounts']], [1, 1, 1])

    def test_claude_mirror_of_the_same_account_keeps_its_own_row(self):
        acct = {'account': {'uuid': 'acc-11111111'}, 'organization': {'uuid': 'org-22222222'}}
        self.claude_rows({'tok-code': acct, 'tok-added': acct})
        rows = [self.claude('m1', 'tok-code', source='claude_code'), self.claude('a1', 'tok-added')]
        out = m.provider_accounts('claude', lambda _: rows, self.fetch)
        self.assertEqual(out['accountCount'], 2)
        self.assertEqual([a.get('mirror') for a in out['accounts']], ['claude-code', None])

    def test_claude_grant_whose_profile_is_unreadable_keeps_its_known_account(self):
        acct = {'account': {'uuid': 'acc-11111111'}, 'organization': {'uuid': 'org-22222222'}}
        profiles = {'tok-old': acct, 'tok-new': acct}
        self.claude_rows(profiles)
        rows = [self.claude('a1', 'tok-old'), self.claude('b2', 'tok-new')]
        self.assertEqual(m.provider_accounts('claude', lambda _: rows, self.fetch)['accountCount'], 1)
        m._CACHE.clear()
        profiles['tok-old'] = None   # e.g. the older grant's token stopped working
        self.assertEqual(m.provider_accounts('claude', lambda _: rows, self.fetch)['accountCount'], 1)
        # A grant never seen with a readable profile is not guessed into any account.
        rows.append(self.claude('c3', 'tok-unknown'))
        self.assertEqual(m.provider_accounts('claude', lambda _: rows, self.fetch)['accountCount'], 2)

    def test_claude_folded_row_survives_use_first_reordering_the_pool(self):
        acct = {'account': {'uuid': 'acc-11111111'}, 'organization': {'uuid': 'org-22222222'}}
        self.claude_rows({'tok-old': acct, 'tok-new': acct})
        old, new = self.claude('a1b2c3', 'tok-old', priority=0), self.claude('d4e5f6', 'tok-new', priority=1)
        first = m.provider_accounts('claude', lambda _: [old, new], self.fetch)['accounts'][0]
        # Use first on the newer sign-in: stock `hermes auth priority` moves it to the front of the pool.
        new['priority'], old['priority'] = 0, 1
        m._CACHE.clear()
        moved = m.provider_accounts('claude', lambda _: [new, old], self.fetch)['accounts'][0]
        self.assertEqual(moved['id'], first['id'])
        self.assertEqual([c['id'] for c in moved['credentials']], ['d4e5f6', 'a1b2c3'])
        self.assertTrue(moved['preferred'])
        # A newer sign-in that stopped working never speaks for the row while an older one still works.
        new['last_status'] = 'invalid'
        m._CACHE.clear()
        broken = m.provider_accounts('claude', lambda _: [new, old], self.fetch)['accounts'][0]
        self.assertEqual([c['id'] for c in broken['credentials']], ['a1b2c3', 'd4e5f6'])
        self.assertEqual(broken['status'], 'ready')

# CI's quality job runs this file; the renewal/status regressions live next door, so run them here too.
_STATUS = importlib.util.spec_from_file_location('provider_account_status_tests', Path(__file__).with_name('test_provider_account_status.py'))
_status = importlib.util.module_from_spec(_STATUS)
_STATUS.loader.exec_module(_status)
StatusTests = _status.StatusTests

if __name__ == '__main__':
    unittest.main()
