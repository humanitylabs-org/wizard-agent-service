"""Claude extra usage after a capped subscription (issue 505). Runs INSIDE Hermes; never exports credentials.

When a Claude subscription's included quota (a session or weekly window) is used up, Anthropic refuses that model
and stock Hermes records a model cooldown on the grant until the window resets (days for a weekly window). If the
owner then turns on extra usage and funds it, the account can serve that model again at once, but the local
cooldown keeps Hermes from even trying: every send fails before any request with "Anthropic credentials are
rate-limited for <model>".

This module clears such a cooldown with stock Hermes' own targeted control (`CredentialPool.reset_status`, what
`hermes auth reset anthropic <id>` runs) only when the provider's own usage read for THAT grant proves all of:
  * every active model cooldown on the grant ends at the reset of an included window that reads 100% used
    (a capped subscription, not a fresh per-minute throttle, which ends long before and matches no capped window);
  * extra usage is enabled on that account; and
  * it is funded: purchased credits above zero, or, when the credit balance can't be read, monthly spend below
    the monthly cap.
A grant benched credential-wide (auth, billing, dead) is never touched. Nothing changes the sign-in, the model or
the provider. If the provider refuses again after a release, Hermes re-arms the cooldown and this module leaves it
alone until the paid reading changes, so a real refusal is never bypassed in a loop.
"""
from __future__ import annotations

import json
import math
import re
import threading
import time
import urllib.request
from datetime import datetime

USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
TICK = 60               # seconds between pool checks (a local file read; no provider call without a cooldown)
PROBE_EVERY = 300       # at most one provider usage read per grant per 5 min while a long cooldown stands
MIN_LEFT = 15 * 60      # cooldowns ending sooner are left to lift on their own
MATCH = 30 * 60         # a cooldown "is" a window's cap when it ends within 30 min of that window's reset
_ORG = re.compile(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')
_LOCK = threading.Lock()
_PROBED = {}     # grant id -> monotonic time of the last usage read
_RELEASED = {}   # grant id -> paid signature at the last release (loop guard)
_STATE: dict = {'thread': None, 'last': None}


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _epoch(value):
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        when = datetime.fromisoformat(value.strip().replace('Z', '+00:00'))
    except ValueError:
        return None
    return when.timestamp() if when.tzinfo is not None else None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise OSError('redirect refused')


def oauth_get(path, token, timeout=6):
    """GET one Anthropic OAuth read with this grant's stored token (no refresh). Raises on any failure."""
    req = urllib.request.Request(USAGE_URL.rsplit('/', 1)[0] + '/' + path, method='GET', headers={
        'Authorization': 'Bearer ' + token, 'Accept': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.0'})
    with urllib.request.build_opener(_NoRedirect).open(req, timeout=timeout) as res:
        data = json.loads(res.read(1 << 20).decode('utf-8'))
    return data if isinstance(data, dict) else {}


def capped_resets(payload):
    """Reset times (epoch seconds) of included windows that read 100% used."""
    resets = []
    for entry in payload.get('limits') or []:
        if isinstance(entry, dict) and _finite(entry.get('percent')) and entry['percent'] >= 100:
            when = _epoch(entry.get('resets_at'))
            if when is not None:
                resets.append(when)
    for key, window in payload.items():
        # Legacy windows only (five_hour, seven_day, seven_day_opus, ...): extra_usage has its own utilization,
        # which is the paid meter, not an included window.
        if not re.fullmatch(r'(?:five_hour|seven_day)[a-z0-9_]*', str(key)):
            continue
        if isinstance(window, dict) and _finite(window.get('utilization')) and window['utilization'] >= 100:
            when = _epoch(window.get('resets_at'))
            if when is not None:
                resets.append(when)
    return resets


def paid_state(payload):
    """(enabled, used_minor, limit_minor) from the usage read, or None when it reports no extra usage."""
    spend = payload.get('spend')
    if isinstance(spend, dict):
        used = (spend.get('used') or {}).get('amount_minor') if isinstance(spend.get('used'), dict) else None
        limit = (spend.get('limit') or {}).get('amount_minor') if isinstance(spend.get('limit'), dict) else None
        if _finite(used) or _finite(limit):
            return (spend.get('enabled') is True, used if _finite(used) else None, limit if _finite(limit) else None)
    extra = payload.get('extra_usage')
    if isinstance(extra, dict) and (_finite(extra.get('used_credits')) or _finite(extra.get('monthly_limit'))):
        used, limit = extra.get('used_credits'), extra.get('monthly_limit')
        return (extra.get('is_enabled') is True, used if _finite(used) else None, limit if _finite(limit) else None)
    return None


def credit_balance(token, get):
    """Purchased credits left on this grant's organization (provider units), or None when unreadable."""
    try:
        profile = get('profile', token)
        org = (profile.get('organization') or {}).get('uuid')
        if not isinstance(org, str) or not _ORG.fullmatch(org):
            return None
        amount = get('organizations/' + org + '/prepaid/credits', token).get('amount')
        return amount if _finite(amount) else None
    except Exception:
        return None


def funded(paid, balance):
    enabled, used, limit = paid
    if not enabled:
        return False
    if balance is not None:
        return balance > 0
    return used is not None and limit is not None and used < limit


def _expired(row, now):
    ms = row.get('expires_at_ms')
    return _finite(ms) and ms <= now * 1000


def _active(row, now):
    values = row.get('model_cooldowns') or {}
    if not isinstance(values, dict):
        return {}
    return {m: u for m, u in values.items() if isinstance(m, str) and _finite(u) and u > now}


def decide(row, payload, balance, now):
    """Pure: 'release' or the reason a grant's cooldowns stay. Never reads or writes anything."""
    cooldowns = _active(row, now)
    if not cooldowns:
        return 'no_cooldown'
    if row.get('last_status') not in (None, 'ok'):
        return 'credential_benched'   # auth/billing/dead: not a model window
    if min(cooldowns.values()) - now < MIN_LEFT:
        return 'short_cooldown'       # a fresh throttle lifts on its own
    resets = capped_resets(payload)
    if not resets:
        return 'not_capped'
    if not all(any(abs(until - when) <= MATCH for when in resets) for until in cooldowns.values()):
        return 'not_capped'           # some cooldown is not a capped included window
    paid = paid_state(payload)
    if paid is None or not paid[0]:
        return 'extra_usage_off'
    if not funded(paid, balance):
        return 'extra_usage_unfunded'
    return 'release'


def _stock_reset(cid):
    """`hermes auth reset anthropic <id>`: clears only that grant's local error state and model cooldowns."""
    from agent.credential_pool import load_pool
    return load_pool('anthropic').reset_status(cid) is not None


def _stock_renew(cid):
    """Renew one expired grant through stock Hermes (single-use refresh lock), as the account listing does."""
    from agent.credential_pool import load_pool
    return bool(load_pool('anthropic').try_refresh_matching(credential_id=cid))


def _groups(rows):
    by_token = {}
    for r in rows:
        if isinstance(r, dict) and isinstance(r.get('id'), str) and r['id'] and r.get('auth_type') == 'oauth' \
                and isinstance(r.get('access_token'), str) and r['access_token']:
            by_token.setdefault(r['access_token'], []).append(r)
    return by_token


def recover(read=None, reset=None, get=None, renew=None, now=time.time, clock=time.monotonic):
    """One pass over the anthropic pool. Returns [{outcome, models}] without ids, tokens or amounts."""
    if read is None:
        from hermes_cli.auth import read_credential_pool
        read = read_credential_pool
    reset = reset or _stock_reset
    renew = renew or _stock_renew
    get = get or oauth_get
    t = now()
    report = []
    for token, group in _groups(read('anthropic') or []).items():
        cooled = [r for r in group if _active(r, t)]
        if not cooled:
            continue
        cid = cooled[0]['id']
        models = sorted({m for r in cooled for m in _active(r, t)})
        # Short cooldowns and credential-wide benches are never released: decide that before any provider call.
        if any(min(_active(r, t).values()) - t < MIN_LEFT for r in cooled):
            report.append({'outcome': 'short_cooldown', 'models': models})
            continue
        if any(r.get('last_status') not in (None, 'ok') for r in cooled):
            report.append({'outcome': 'credential_benched', 'models': models})
            continue
        with _LOCK:
            last = _PROBED.get(cid)
            if last is not None and clock() - last < PROBE_EVERY:
                continue
            _PROBED[cid] = clock()
            if len(_PROBED) > 256:
                _PROBED.clear()
        if any(_expired(r, t) for r in group):
            # The cooldown stops Hermes from using (and so renewing) this grant; a weekly cooldown can outlive
            # its access token. Renew it the stock way, then read the renewed row.
            try:
                renewed = renew(cid)
            except Exception:
                renewed = False
            fresh = None
            if renewed:
                fresh = next((g for g in _groups(read('anthropic') or []).values()
                              if any(r['id'] == cid for r in g)), None)
            if not fresh or any(_expired(r, t) for r in fresh):
                report.append({'outcome': 'token_expired', 'models': models})
                continue
            group = fresh
            token = group[0]['access_token']
            cooled = [r for r in group if _active(r, t)]
            if not cooled:
                report.append({'outcome': 'no_cooldown', 'models': models})
                continue
        try:
            payload = get('usage', token)
        except Exception:
            report.append({'outcome': 'usage_unreadable', 'models': models})
            continue
        paid = paid_state(payload)
        balance = credit_balance(token, get) if paid is not None and paid[0] else None
        outcome = 'release'
        for r in cooled:
            outcome = decide(r, payload, balance, t)
            if outcome != 'release':
                break
        signature = (paid, balance)
        if outcome == 'release' and _RELEASED.get(cid) == signature:
            outcome = 'refused_after_release'   # the provider re-armed it on the same paid reading
        if outcome == 'release':
            ok = True
            for r in cooled:   # every row sharing this key: Hermes blocks the token if any of them is cooled
                try:
                    ok = bool(reset(r['id'])) and ok
                except Exception:
                    ok = False
            if ok:
                with _LOCK:
                    _RELEASED[cid] = signature
                    if len(_RELEASED) > 256:
                        _RELEASED.clear()
                        _RELEASED[cid] = signature
            outcome = 'released' if ok else 'reset_failed'
        report.append({'outcome': outcome, 'models': models})
    _STATE['last'] = {'at': t, 'grants': report}
    return report


def _loop(interval):
    time.sleep(min(30, interval))
    while True:
        try:
            recover()
        except Exception:
            pass   # never leak provider errors or tokens; try again next tick
        time.sleep(interval)


def start(interval=TICK):
    """Start the background pass once per process (idempotent)."""
    with _LOCK:
        if _STATE['thread'] is not None:
            return _STATE['thread']
        thread = threading.Thread(target=_loop, args=(interval,), name='wizard-claude-cooldown-recovery', daemon=True)
        _STATE['thread'] = thread
    thread.start()
    return thread
