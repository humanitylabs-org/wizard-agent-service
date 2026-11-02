"""Offline identical-source regression fixture. Never invokes credentials or a provider.

ACCOUNTS_SOURCE_ROOT permits replay against an immutable collaborator checkout.
"""
import hashlib
import importlib.util
import io
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import tempfile
import unittest

ROOT = Path(os.environ.get('ACCOUNTS_SOURCE_ROOT', Path(__file__).resolve().parents[1]))


def load(filename):
    spec = importlib.util.spec_from_file_location('safety_' + filename[:-3], ROOT / 'hermes-plugin/wizard-os/dashboard' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def grants():
    return [dict(id=cid, auth_type='oauth', source='manual:dashboard_pkce',
                 access_token='synthetic-' + cid, organization=org, last_status='ok')
            for cid, org in [('aa11bb', 'synthetic-org-a'), ('cc33dd', 'synthetic-org-b')]]


def reconcile(tmp_path, stop=None, expire=False, interrupt_at=None):
    m = load('account_lifecycle.py')
    rows = grants()
    commands = []
    lookups = []
    proc = SimpleNamespace(returncode=0, stdin=io.BytesIO(), stdout=io.BytesIO(),
                           poll=lambda: 0, wait=lambda **kw: 0)
    lease = os.open(tmp_path / 'lease', os.O_CREAT | os.O_RDWR, 0o600)
    job = dict(id='synthetic', provider='claude', action='add', target=None, status='running',
               expiresAt=0 if expire else 99999999999, stop=stop, proc=proc, lease=lease,
               before={'aa11bb'}, credentialIds=[], duplicateOf=None, duplicateRemoved=False, duplicateEmailHintOf=None,
               url=None, userCode=None, inputRequired=False, submitted=False)
    b = m.Broker(read=lambda _: rows, command=['never-execute'])
    b.jobs[job['id']] = job

    def identify(row):
        lookups.append(row['id'])
        if interrupt_at == len(lookups):
            if stop == 'during-expiry':
                job['expiresAt'] = 0
                job['stop'] = None
            else:
                job['stop'] = 'cancelled'
        return 'same-email-hint'

    if stop == 'during-expiry':
        job['stop'] = None
    b.identify = identify

    def command(argv, **kwargs):
        commands.append(argv[1:])
        if argv[2] == 'remove':
            rows[:] = [r for r in rows if r['id'] != argv[-1]]
        return SimpleNamespace(returncode=0)

    with patch.object(b, '_kill'), patch.object(m.subprocess, 'run', command), \
            patch.object(m.subprocess, 'Popen', side_effect=AssertionError('unexpected credential child')):
        b._run(job)
    return job, rows, commands, lookups


def check_successful_add_never_refreshes_or_removes_any_grant(tmp_path):
    job, rows, commands, _ = reconcile(tmp_path)
    assert commands == [], 'post-add credential commands are forbidden'
    assert rows == grants()
    assert job['status'] == 'succeeded'
    assert job['credentialIds'] == ['cc33dd']
    assert job['duplicateOf'] is None  # Legacy UI must not mistake the grant as discarded.
    assert job['duplicateEmailHintOf'] == 'aa11bb'  # Hint only, even across organizations.
    assert job['duplicateRemoved'] is False


def check_cancelled_or_expired_reconciliation_starts_no_credential_child(tmp_path, stop, expire):
    job, rows, commands, lookups = reconcile(tmp_path, stop=stop, expire=expire)
    assert commands == []
    assert lookups == []
    assert rows == grants()
    assert job['duplicateEmailHintOf'] is None
    assert job['duplicateRemoved'] is False


def check_interrupt_during_identity_cannot_start_credential_child(tmp_path, stop, interrupt_at):
    # Original PR keeps running credential commands after either lookup changes the job.
    job, rows, commands, _ = reconcile(tmp_path, stop=None if stop == 'cancelled' else stop, interrupt_at=interrupt_at)
    assert commands == []
    assert rows == grants()
    assert job['duplicateOf'] is None
    assert job['duplicateEmailHintOf'] is None
    assert job['duplicateRemoved'] is False


def check_same_email_different_organizations_keep_separate_projection_and_targets():
    m = load('provider_accounts.py')
    rows = grants()
    def get(path, token):
        org = 'synthetic-org-a' if token.endswith('aa11bb') else 'synthetic-org-b'
        return {'account': {'email': 'same@example.invalid'},
                'organization': {'uuid': org, 'organization_type': 'claude_team'}} if path == 'profile' else {}
    with patch.object(m, '_anthropic_get', get):
        out = m.provider_accounts('claude', read=lambda _: rows, fetch=lambda *a, **kw: None,
                                  renew=lambda *a: (_ for _ in ()).throw(AssertionError('unexpected renewal')))
    assert out['accountCount'] == 2
    assert len({a['id'] for a in out['accounts']}) == 2
    assert len({a['emailHash'] for a in out['accounts']}) == 1
    assert [a['credentialCount'] for a in out['accounts']] == [1, 1]
    assert [[c['id'] for c in a['credentials']] for a in out['accounts']] == [['aa11bb'], ['cc33dd']]
    assert rows == grants()


def check_email_advisory_cache_miss_never_fetches_provider():
    m = load('provider_accounts.py')
    calls = []
    with patch.object(m, '_anthropic_get', lambda *args: calls.append(args) or {'account': {'email': 'same@example.invalid'}}):
        result = m.email_hash_of(grants()[0])
    assert calls == []
    assert result is None


def check_email_advisory_cache_hit_and_hash_extraction_are_bounded():
    m = load('provider_accounts.py')
    row = grants()[0]
    digest = hashlib.sha256(row['access_token'].encode()).hexdigest()
    m._CACHE[('email', digest)] = ' Same@Example.invalid '
    with patch.object(m, '_anthropic_get', side_effect=AssertionError('provider call')):
        assert m.email_hash_of(row) == hashlib.sha256(b'same@example.invalid').hexdigest()[:16]
        assert m.email_hash_of({}) is None
        assert m._hash_email('not-an-email') is None


class AccountAddSafetyTests(unittest.TestCase):
    """Standard-library runner, also collected by the existing focused pytest lane."""


def install_case(name, check, *args, temporary=True):
    def test(self):
        if temporary:
            with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
                check(Path(directory), *args)
        else:
            check(*args)
    setattr(AccountAddSafetyTests, 'test_' + name, test)


install_case('successful_add', check_successful_add_never_refreshes_or_removes_any_grant)
for stop, expire in [('cancelled', False), (None, True)]:
    install_case('stopped_' + str(stop) + '_' + str(expire),
                 check_cancelled_or_expired_reconciliation_starts_no_credential_child, stop, expire)
for stop in ['cancelled', 'during-expiry']:
    for at in [1, 2]:
        install_case('interrupt_' + stop + '_' + str(at),
                     check_interrupt_during_identity_cannot_start_credential_child, stop, at)
install_case('same_email_distinct_orgs',
             check_same_email_different_organizations_keep_separate_projection_and_targets, temporary=False)
install_case('cache_miss', check_email_advisory_cache_miss_never_fetches_provider, temporary=False)
install_case('cache_hit', check_email_advisory_cache_hit_and_hash_extraction_are_bounded, temporary=False)


if __name__ == '__main__':
    unittest.main()
