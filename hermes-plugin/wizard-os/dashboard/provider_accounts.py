"""Read-only account projection. Runs INSIDE Hermes; never exports credentials.

Use the stock store reader, not load_pool(): enumeration must not seed or persist
credentials. Quota requests explicitly name each credential and forbid refresh.
No provider-wide OAuth start/logout routes are exposed as account operations.

Hermes renews a pool sign-in only when a turn uses it, so an idle subscription's stored
access token expires and its usage read fails. Before reading usage for a row whose token
has expired (or is about to), ask stock Hermes to renew exactly that row
(`load_pool(slug).try_refresh_matching(credential_id=...)`: its cross-process single-use
refresh lock, persisted result), at most once per row per _REFRESH_INTERVAL. A refused
renewal (dead grant) reports the row `expired` so the app offers Reconnect.
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timezone

PROVIDERS = {"chatgpt": "openai-codex", "claude": "anthropic"}
_NAMES = {"chatgpt": "ChatGPT", "claude": "Claude"}
_CACHE = {}
_LOCK = threading.Lock()
_REFRESH_SKEW = 120  # seconds: renew a little before expiry, like Hermes' own proactive refresh
_REFRESH_INTERVAL = 300  # seconds between renewal attempts for one row, whatever the outcome
_REFRESHED = {}  # (slug, credential id) -> (monotonic time of the last attempt, outcome)
_EXPIRED_ERROR = {'code': 'expired', 'message': 'This sign-in expired and could not be renewed. Reconnect it.'}
# Hermes' pool states (`ok` is a working sign-in) as the connection apps' row states.
_STATES = {'ok': 'ready', 'ready': 'ready', 'dead': 'expired', 'exhausted': 'exhausted',
           'rate_limited': 'rate_limited', 'invalid': 'invalid', 'disabled': 'disabled'}
_MESSAGES = {
    'chatgpt': 'Reconnect signs in again and retains existing grants. Use a different OpenAI account to add quota; '
               'signing in to the same account can invalidate its older grants.',
    'claude': 'Add signs in to a separate Claude subscription in the Hermes Anthropic pool. '
              'The existing Claude Code login is unchanged.',
}


def _claims(token):
    try:
        part = token.split('.')[1]
        result = json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))
        return result if isinstance(result, dict) else {}
    except (ValueError, IndexError, TypeError):
        return {}


def _masked(value):
    value = str(value or '')
    if '@' not in value:
        return None
    local, domain = value.rsplit('@', 1)
    return (local[:1] + '***@' + domain[:1] + '***') if local and domain else None


def _text(value, fallback):
    value = str(value or '')
    if '@' in value:
        return _masked(value) or fallback
    # Labels are user data, not a channel to return credential-shaped strings.
    if len(value) > 80 or re.search(r'(sk-|eyJ|Bearer\s)', value, re.I):
        return fallback
    return re.sub(r'[\x00-\x1f\x7f]', '', value).strip() or fallback


def _iso(value):
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


_CLAUDE_TIERS = {'default_claude_max_20x': 'Max 20x', 'default_claude_max_5x': 'Max 5x', 'default_claude_pro': 'Pro'}
_CLAUDE_SUBSCRIPTIONS = {'max': 'Max', 'pro': 'Pro', 'team': 'Team', 'enterprise': 'Enterprise', 'free': 'Free'}
_CLAUDE_WINDOWS = (('five_hour', 'Session'), ('seven_day', 'All models · weekly'),
                   ('seven_day_opus', 'Opus · weekly'), ('seven_day_sonnet', 'Sonnet · weekly'))


class _NoRedirect(__import__('urllib.request').request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise OSError('redirect refused')


def _anthropic_get(path, token):
    import urllib.request
    req = urllib.request.Request('https://api.anthropic.com/api/oauth/' + path, method='GET', headers={
        'Authorization': 'Bearer ' + token, 'Accept': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.0'})
    with urllib.request.build_opener(_NoRedirect).open(req, timeout=15) as res:
        data = json.loads(res.read(1 << 20).decode('utf-8'))
    return data if isinstance(data, dict) else {}


def _pct_row(id_, label, used, resets):
    if isinstance(used, bool) or not isinstance(used, (int, float)) or not math.isfinite(used):
        return None
    used = min(100, max(0, used))
    when = None
    if isinstance(resets, str) and resets.strip():
        try:
            from datetime import datetime
            when = _iso(datetime.fromisoformat(resets.strip().replace('Z', '+00:00')))
        except ValueError:
            when = None
    return {'id': id_, 'label': label, 'usedPercent': round(used, 1),
            'remainingPercent': math.floor(100 - used), 'resetsAt': when}


def _anthropic_quota(token):
    """Claude usage the way Claude Code reads it: `limits[].percent` or `utilization` are already
    percentages (0-100). Stock account_usage scales values <= 1 as fractions, so 1% read as 100%."""
    from datetime import datetime
    payload = _anthropic_get('usage', token)
    rows = []
    for i, entry in enumerate(payload.get('limits') or []):
        if not isinstance(entry, dict):
            continue
        model = str(((entry.get('scope') or {}).get('model') or {}).get('display_name') or '').strip()[:40]
        kind = str(entry.get('kind') or '').strip()[:40]
        label = {'session': (model + ' · session') if model else 'Session', 'weekly_all': 'All models · weekly',
                 'weekly_scoped': (model + ' · weekly') if model else 'Scoped · weekly'}.get(kind, model or kind or 'Limit')
        row = _pct_row('%s:%s' % (kind or 'limit', model or entry.get('group') or i), _text(label, 'Limit'),
                       entry.get('percent'), entry.get('resets_at'))
        if row:
            rows.append(row)
    if not rows:
        for key, label in _CLAUDE_WINDOWS:
            window = payload.get(key)
            if isinstance(window, dict):
                row = _pct_row(key, label, window.get('utilization'), window.get('resets_at'))
                if row:
                    rows.append(row)
    plan = email = None
    try:
        prof = _anthropic_get('profile', token)
        raw = str((prof.get('account') or {}).get('email') or '').strip()
        # The pattern already bounds the length; keep the exact address so emailHash matches the app's own hash.
        email = raw if re.fullmatch(r'[^@\s]{1,64}@[^@\s]{1,120}', raw) else None
        org = prof.get('organization') or {}
        kind = str(org.get('organization_type') or '').strip().lower()
        kind = kind[len('claude_'):] if kind.startswith('claude_') else kind
        plan = _CLAUDE_TIERS.get(str(org.get('rate_limit_tier') or '')) or _CLAUDE_SUBSCRIPTIONS.get(kind)
    except Exception:
        pass  # A missing label never breaks usage.
    usage = {'fetchedAt': _iso(datetime.now(timezone.utc)), 'limits': rows, 'paid': None} if rows else None
    return plan, usage, email


def _quota(provider, row, fetch):
    token = row.get('access_token') or ''
    # Empty tokens must never fall through to the singleton/account selector.
    if not token:
        return None, None
    key = (provider, hashlib.sha256(token.encode()).hexdigest())
    with _LOCK:
        cached = _CACHE.get(key)
    if cached and time.monotonic() - cached[0] < 60:
        return cached[1]
    if provider == 'anthropic':
        try:
            plan, usage, email = _anthropic_quota(token)
            value = (plan, usage)
            with _LOCK:
                _CACHE[('email',) + key[1:]] = email
        except Exception:
            value = (None, None)  # Do not leak provider exception bodies or tokens.
        with _LOCK:
            if len(_CACHE) > 256:
                _CACHE.clear()
            _CACHE[key] = (time.monotonic(), value)
        return value
    try:
        # Fixed canonical endpoint: never send credentials to store-controlled URLs.
        snap = fetch(provider, api_key=token, read_only=True,
                     base_url='https://chatgpt.com/backend-api/codex' if provider == 'openai-codex' else None)
        limits = []
        for i, window in enumerate(getattr(snap, 'windows', ()) or ()):
            used = window.used_percent
            if isinstance(used, bool) or not isinstance(used, (int, float)) or not math.isfinite(used):
                continue
            used = min(100, max(0, used))
            limits.append({'id': str(i), 'label': _text(window.label, 'Quota'),
                           'usedPercent': used, 'remainingPercent': math.floor(100-used),
                           'resetsAt': _iso(window.reset_at)})
        value = (_text(getattr(snap, 'plan', None), '') or None,
                 {'fetchedAt': _iso(snap.fetched_at), 'limits': limits, 'paid': None}
                 if limits and not getattr(snap, 'unavailable_reason', None) else None)
    except Exception:
        value = (None, None)  # Do not leak provider exception bodies or tokens.
    with _LOCK:
        if len(_CACHE) > 256:
            _CACHE.clear()
        _CACHE[key] = (time.monotonic(), value)
    return value


def _seconds_left(row, claims):
    """Seconds until the stored access token expires, or None when the row carries no expiry."""
    ms = row.get('expires_at_ms')
    if isinstance(ms, (int, float)) and not isinstance(ms, bool) and ms > 0:
        return ms / 1000 - time.time()
    exp = claims.get('exp')
    if isinstance(exp, (int, float)) and not isinstance(exp, bool) and exp > 0:
        return exp - time.time()
    return None


def _expiring(row, claims):
    left = _seconds_left(row, claims)
    return left is not None and left <= _REFRESH_SKEW


def _stock_refresh(slug, credential_id):
    """Renew one pool row through stock Hermes. True renewed, False refused (dead grant), None could not ask."""
    try:
        from agent.credential_pool import load_pool
        refresh = getattr(load_pool(slug), 'try_refresh_matching', None)
        if refresh is None:
            return None
        return refresh(credential_id=credential_id) is not None
    except Exception:
        return None  # Lock timeout, older Hermes, network: transient; never leak the exception text.


def _renew(slug, row, refresh):
    """At most one renewal attempt per row per interval, single-flight across concurrent listings.

    'renewed': Hermes stored a new token. 'refused': Hermes could not renew it (dead grant); remembered
    until the interval passes. 'pending': another listing is renewing it, or the attempt was inconclusive."""
    key = (slug, str(row.get('id') or ''))
    now = time.monotonic()
    with _LOCK:
        last = _REFRESHED.get(key)
        if last and now - last[0] < _REFRESH_INTERVAL:
            return 'refused' if last[1] == 'refused' else 'pending'
        if len(_REFRESHED) > 256:
            _REFRESHED.clear()
        _REFRESHED[key] = (now, 'running')
    result = refresh(slug, row.get('id'))
    outcome = 'renewed' if result is True else 'refused' if result is False else 'pending'
    with _LOCK:
        _REFRESHED[key] = (now, outcome)
    return outcome


def provider_accounts(provider, read=None, fetch=None, refresh=None):
    slug = PROVIDERS[provider]
    if refresh is None:
        refresh = _stock_refresh
    if read is None:
        from hermes_cli.auth import read_credential_pool
        read = read_credential_pool
    if fetch is None:
        from agent.account_usage import fetch_account_usage
        fetch = fetch_account_usage
    rows = [r for r in read(slug) if isinstance(r, dict) and r.get('auth_type') == 'oauth']
    grouped = {}
    for row in rows:
        claims = _claims(row.get('access_token') or '')
        auth = claims.get('https://api.openai.com/auth') or {}
        principal = (auth.get('chatgpt_account_id'), claims.get('sub'))
        # Deduplicate only provider-attested identity; never by email or nickname.
        identity = json.dumps(principal) if provider == 'chatgpt' and all(principal) else str(row.get('id') or '')
        if not identity:
            continue
        key = hashlib.sha256((slug + ':' + identity).encode()).hexdigest()[:24]
        grouped.setdefault(key, []).append((row, claims))

    def project(item):
        key, aliases = item
        # Prefer a live grant over an expired or dead one, then an independent manual login over a singleton mirror.
        row, claims = sorted(reversed(aliases), key=lambda a: (
            str(a[0].get('last_status') or '') == 'dead', _expiring(*a),
            not str(a[0].get('source', '')).startswith('manual:')))[0]
        renewal = None
        # Hermes renews a pool row only when a turn uses it, so an idle subscription's stored token goes stale and
        # its usage read fails. Renew exactly this row through stock Hermes first. The claude_code mirror is the
        # Claude app's own login: that app renews it, and its row stands for this one.
        if (_expiring(row, claims) and row.get('refresh_token') and str(row.get('last_status') or '') != 'dead'
                and str(row.get('source', '')) != 'claude_code'):
            renewal = _renew(slug, row, refresh)
            if renewal == 'renewed':
                fresh = next((r for r in read(slug) if isinstance(r, dict) and r.get('id') == row.get('id')), None)
                if fresh and fresh.get('access_token'):
                    row, claims = fresh, _claims(fresh.get('access_token') or '')
        left = _seconds_left(row, claims)
        # A token already past expiry cannot read usage; don't spend a provider call proving it.
        plan, usage = (None, None) if left is not None and left <= 0 else _quota(slug, row, fetch)
        auth = claims.get('https://api.openai.com/auth') or {}
        profile = claims.get('https://api.openai.com/profile') or {}
        raw = profile.get('email') or claims.get('email')
        if not raw and slug == 'anthropic' and row.get('access_token'):
            with _LOCK:
                raw = _CACHE.get(('email', hashlib.sha256(row['access_token'].encode()).hexdigest()))
        email = _masked(raw or row.get('label'))
        extra = {}
        # A short one-way hash of the exact email lets the connection app tell "the same account" apart from two
        # accounts that only share a mask (h***@g***), e.g. its original Claude Code sign-in vs. an agent row.
        # Only a provider-attested email (token claim or profile lookup) is hashed: a label is owner-typed text,
        # and hashing it would fold an unrelated account into whichever real sign-in uses that address.
        exact = str(raw or '').strip().lower()
        if exact and re.fullmatch(r'[^@\s]{1,64}@[^@\s]{1,120}', exact):
            extra['emailHash'] = hashlib.sha256(exact.encode()).hexdigest()[:16]
        state = _STATES.get(str(row.get('last_status') or 'ready'), 'needs_attention')
        error = _EXPIRED_ERROR if state == 'expired' else None
        if renewal == 'refused':
            state, error = 'expired', _EXPIRED_ERROR
        if slug == 'anthropic' and all(str(r.get('source', '')) == 'claude_code' for r, _ in aliases):
            # Hermes' mirror of the host Claude Code login: the Claude app already shows that login
            # (with its usage) as its own row, so it folds this pool grant into that row.
            extra['mirror'] = 'claude-code'
        return {**extra, 'id': key, 'name': _text(row.get('label'), _NAMES[provider] + ' subscription'),
                'email': email, 'plan': plan or _text(auth.get('chatgpt_plan_type'), '') or None,
                'status': state, 'error': error, 'usage': usage, 'credentialCount': len(aliases),
                'usageStatus': 'ok' if usage else 'unavailable',
                'credentials': [{'id': r['id'], 'name': _text(r.get('label'), 'Grant'),
                                 'managed': str(r.get('source', '')).startswith('manual:') and not str(r['id']).isdigit()}
                                for r, _ in aliases if r.get('id')],
                'actions': {'reconnect': True, 'remove': True}}

    with ThreadPoolExecutor(max_workers=4) as executor:
        accounts = list(executor.map(project, grouped.items()))
    # No full response cache: additions/removals are visible on every request.
    # `identity` tells a connection app this listing reports `emailHash` wherever the provider attested an email,
    # so a row without one is a different/unknown account (not a cue to fall back to comparing masked emails).
    return {'provider': provider, 'name': _NAMES[provider], 'owner': 'hermes',
            'identity': {'emailHash': 'sha256-16'},
            'accounts': accounts, 'accountCount': len(accounts),
            'actions': {'add': True},
            'management': {'contract': 'wizard.account-management/1', 'status': 'available',
                           'message': _MESSAGES[provider],
                           'addCommand': 'hermes auth add ' + slug + ' --type oauth'},
            'error': None}
