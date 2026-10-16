"""Read-only account projection. Runs INSIDE Hermes; never exports credentials.

Use the stock store reader, not load_pool(): enumeration must not seed or persist
credentials. Quota requests explicitly name each credential and forbid refresh.
No provider-wide OAuth start/logout routes are exposed as account operations.
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


def provider_accounts(provider, read=None, fetch=None):
    slug = PROVIDERS[provider]
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
        # Prefer an independent manual login over a singleton mirror.
        row, claims = sorted(reversed(aliases), key=lambda a: not str(a[0].get('source', '')).startswith('manual:'))[0]
        plan, usage = _quota(slug, row, fetch)
        auth = claims.get('https://api.openai.com/auth') or {}
        profile = claims.get('https://api.openai.com/profile') or {}
        email = _masked(profile.get('email') or claims.get('email') or row.get('label'))
        state = str(row.get('last_status') or 'ready')
        state = state if state in {'ready', 'ok', 'exhausted', 'rate_limited', 'invalid', 'disabled'} else 'needs_attention'
        return {'id': key, 'name': _text(row.get('label'), _NAMES[provider] + ' subscription'),
                'email': email, 'plan': plan or _text(auth.get('chatgpt_plan_type'), '') or None,
                'status': state, 'usage': usage, 'credentialCount': len(aliases),
                'usageStatus': 'ok' if usage else 'unavailable',
                'credentials': [{'id': r['id'], 'name': _text(r.get('label'), 'Grant'),
                                 'managed': str(r.get('source', '')).startswith('manual:') and not str(r['id']).isdigit()}
                                for r, _ in aliases if r.get('id')],
                'actions': {'reconnect': True, 'remove': True}}

    with ThreadPoolExecutor(max_workers=4) as executor:
        accounts = list(executor.map(project, grouped.items()))
    # No full response cache: additions/removals are visible on every request.
    return {'provider': provider, 'name': _NAMES[provider], 'owner': 'hermes',
            'accounts': accounts, 'accountCount': len(accounts),
            'actions': {'add': True},
            'management': {'status': 'available',
                           'message': 'Reconnect signs in again and retains existing grants. Use a different OpenAI account to add quota; signing in to the same account can invalidate its older grants.',
                           'addCommand': 'hermes auth add ' + slug + ' --type oauth'},
            'error': None}
