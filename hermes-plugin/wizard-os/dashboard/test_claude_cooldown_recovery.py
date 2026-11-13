"""Issue 505: a stale Claude model cooldown is released only for capped + extra usage enabled and funded.

Synthetic only: the pool, the provider usage reads and the reset are fakes. The last test runs the real stock
Hermes pool (temp HERMES_HOME) when Hermes is importable, and skips otherwise (CI has no Hermes).
"""
import json
import os
import tempfile
import time
import unittest
from datetime import datetime, timezone
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

_spec = spec_from_file_location('claude_cooldown_recovery_test', Path(__file__).with_name('claude_cooldown_recovery.py'))
r = module_from_spec(_spec)
_spec.loader.exec_module(r)

NOW = 1_800_000_000.0
WEEK_RESET = NOW + 3 * 86400
TOKEN = 'sk-ant-oat01-' + 'x' * 20
MODEL = 'claude-sonnet-5-5'
ORG = '12345678-1234-1234-1234-123456789abc'


def iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat().replace('+00:00', 'Z')


def grant(id='g1', until=WEEK_RESET + 5, token=TOKEN, **extra):
    return {'id': id, 'auth_type': 'oauth', 'access_token': token, 'source': 'manual:hermes_pkce',
            'expires_at_ms': (NOW + 3600) * 1000, 'model_cooldowns': {MODEL: until}, **extra}


def usage(weekly=100, enabled=True, used=500, limit=5000):
    return {'five_hour': {'utilization': 12, 'resets_at': iso(NOW + 3600)},
            'seven_day': {'utilization': weekly, 'resets_at': iso(WEEK_RESET)},
            'extra_usage': {'is_enabled': enabled, 'monthly_limit': limit, 'used_credits': used, 'utilization': 10}}


class Provider:
    def __init__(self, payload, balance=2500):
        self.payload, self.balance, self.calls = payload, balance, []

    def __call__(self, path, token):
        self.calls.append(path)
        assert token == TOKEN
        if path == 'usage':
            return self.payload
        if path == 'profile':
            return {'organization': {'uuid': ORG}}
        if path == 'organizations/' + ORG + '/prepaid/credits':
            if self.balance is None:
                raise OSError('credits unavailable')
            return {'amount': self.balance, 'currency': 'USD'}
        raise AssertionError(path)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        r._PROBED.clear()
        r._RELEASED.clear()
        self.resets = []
        self.tick = [0.0]

    def run_pass(self, rows, provider):
        return r.recover(read=lambda p: rows, reset=lambda cid: self.resets.append(cid) or True,
                         get=provider, now=lambda: NOW, clock=lambda: self.tick[0])

    def test_capped_enabled_funded_stale_cooldown_is_released_on_every_row_of_the_grant(self):
        rows = [grant(), grant('mirror', source='claude_code'), grant('other', token='sk-ant-oat01-' + 'y' * 20, model_cooldowns={})]
        report = self.run_pass(rows, Provider(usage()))
        self.assertEqual(self.resets, ['g1', 'mirror'])
        self.assertEqual(report, [{'outcome': 'released', 'models': [MODEL]}])
        self.assertNotIn(TOKEN, json.dumps(report))
        self.assertNotIn('g1', json.dumps(report))

    def test_provider_refusal_after_release_is_not_bypassed_again(self):
        provider = Provider(usage())
        self.run_pass([grant()], provider)
        self.tick[0] += r.PROBE_EVERY + 1
        report = self.run_pass([grant()], provider)   # Hermes re-armed it: the paid lane refused too
        self.assertEqual(report[0]['outcome'], 'refused_after_release')
        self.assertEqual(self.resets, ['g1'])
        self.tick[0] += r.PROBE_EVERY + 1
        provider.payload = usage(used=900)            # new paid reading: requests did go through meanwhile
        self.assertEqual(self.run_pass([grant()], provider)[0]['outcome'], 'released')

    def test_extra_usage_off_or_unfunded_keeps_the_cooldown(self):
        cases = [(usage(enabled=False), 2500, 'extra_usage_off'),
                 (usage(), 0, 'extra_usage_unfunded'),
                 (usage(used=5000, limit=5000), None, 'extra_usage_unfunded'),
                 ({k: v for k, v in usage().items() if k != 'extra_usage'}, 2500, 'extra_usage_off')]
        for payload, balance, outcome in cases:
            with self.subTest(outcome=outcome, balance=balance):
                r._PROBED.clear()
                self.assertEqual(self.run_pass([grant()], Provider(payload, balance))[0]['outcome'], outcome)
        self.assertEqual(self.resets, [])

    def test_unknown_balance_uses_monthly_cap_headroom(self):
        self.assertEqual(self.run_pass([grant()], Provider(usage(used=100, limit=5000), None))[0]['outcome'], 'released')

    def test_fresh_throttling_and_credential_bench_are_never_cleared(self):
        cases = [(grant(until=NOW + 60), usage(), 'short_cooldown'),                     # per-minute 429
                 (grant(until=NOW + 7200), usage(), 'not_capped'),                       # long, but no capped window ends then
                 (grant(), usage(weekly=80), 'not_capped'),                              # quota not used up
                 (grant(model_cooldowns={MODEL: WEEK_RESET, 'claude-opus-5-5': NOW + 7200}), usage(), 'not_capped'),
                 (grant(last_status='exhausted'), usage(), 'credential_benched')]
        for row, payload, outcome in cases:
            with self.subTest(outcome=outcome):
                r._PROBED.clear()
                self.assertEqual(self.run_pass([row], Provider(payload))[0]['outcome'], outcome)
        self.assertEqual(self.resets, [])

    def test_no_provider_reads_without_a_cooldown_and_at_most_one_per_window(self):
        provider = Provider(usage(enabled=False))
        self.assertEqual(self.run_pass([grant(model_cooldowns={MODEL: NOW - 1})], provider), [])
        self.assertEqual(provider.calls, [])
        self.run_pass([grant()], provider)
        self.run_pass([grant()], provider)
        self.assertEqual(provider.calls, ['usage'])
        self.tick[0] += r.PROBE_EVERY + 1
        self.run_pass([grant()], provider)
        self.assertEqual(provider.calls, ['usage', 'usage'])

    def test_expired_token_and_unreadable_usage_change_nothing(self):
        self.assertEqual(self.run_pass([grant(expires_at_ms=(NOW - 1) * 1000)], Provider(usage()))[0]['outcome'], 'token_expired')
        def broken(path, token):
            raise OSError('HTTP 500 with a private body')
        self.assertEqual(self.run_pass([grant()], broken)[0]['outcome'], 'usage_unreadable')
        self.assertEqual(self.resets, [])

    def test_limits_shape_is_read_too(self):
        payload = {'limits': [{'kind': 'weekly_all', 'percent': 100, 'resets_at': iso(WEEK_RESET)}],
                   'spend': {'enabled': True, 'used': {'amount_minor': 10}, 'limit': {'amount_minor': 1000}}}
        self.assertEqual(self.run_pass([grant()], Provider(payload, 300))[0]['outcome'], 'released')


class StockHermesRehearsal(unittest.TestCase):
    """Real stock pool: the released grant resolves again for the same model; the negative control stays blocked."""

    def setUp(self):
        try:
            import hermes_cli  # noqa: F401
        except ImportError:
            self.skipTest('Hermes is not importable here')
        self.home = tempfile.mkdtemp(prefix='wizard-505-')
        self.env = {k: os.environ.get(k) for k in ('HERMES_HOME', 'ANTHROPIC_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'HOME')}
        for k in ('ANTHROPIC_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'):
            os.environ.pop(k, None)
        os.environ.update(HERMES_HOME=self.home, HOME=self.home)
        r._PROBED.clear()
        r._RELEASED.clear()

    def tearDown(self):
        for k, v in self.env.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)

    def write_pool(self, until):
        now = time.time()
        row = {'id': 'abc123', 'label': 'Work', 'auth_type': 'oauth', 'priority': 0, 'source': 'manual:hermes_pkce',
               'access_token': TOKEN, 'refresh_token': 'r' * 20, 'expires_at_ms': int((now + 3600) * 1000),
               'model_cooldowns': {MODEL: until}}
        Path(self.home, 'auth.json').write_text(json.dumps({'version': 1, 'credential_pool': {'anthropic': [row]}}))

    def resolve(self):
        from agent.anthropic_credentials import resolve_anthropic_token
        return resolve_anthropic_token(model=MODEL)

    def test_same_grant_same_model_is_admitted_after_release(self):
        reset_at = time.time() + 3 * 86400
        payload = usage()
        payload['seven_day']['resets_at'] = iso(reset_at)
        self.write_pool(reset_at)
        self.assertIsNone(self.resolve())   # the issue: blocked before any request
        def get(path, token):
            return payload if path == 'usage' else {'organization': {'uuid': ORG}} if path == 'profile' else {'amount': 2500}
        report = r.recover(get=get)
        self.assertEqual(report, [{'outcome': 'released', 'models': [MODEL]}])
        self.assertEqual(self.resolve(), TOKEN)

    def test_unfunded_stays_blocked_in_stock_hermes(self):
        reset_at = time.time() + 3 * 86400
        payload = usage(enabled=False)
        payload['seven_day']['resets_at'] = iso(reset_at)
        self.write_pool(reset_at)
        self.assertEqual(r.recover(get=lambda path, token: payload)[0]['outcome'], 'extra_usage_off')
        self.assertIsNone(self.resolve())


if __name__ == '__main__':
    unittest.main()
