"""Wizard OS dashboard API, mounted by stock Hermes at /api/plugins/wizard-os/ (dashboard login required).

GET /ai-usage/chatgpt -> this agent's own ChatGPT (openai-codex) usage in the wizard.ai-connection/1 `usage`
shape, so the ChatGPT connection app can report usage without ever holding a token. Read-only: Hermes' own
usage reader with read_only=True (no refresh, rotation or store write). Never returns a token.
"""
from __future__ import annotations

import math
import time
from datetime import timezone

from fastapi import APIRouter, HTTPException
from importlib.util import spec_from_file_location, module_from_spec
from pathlib import Path

_spec = spec_from_file_location('wizard_provider_accounts', Path(__file__).with_name('provider_accounts.py'))
assert _spec is not None and _spec.loader is not None
_accounts = module_from_spec(_spec)
_spec.loader.exec_module(_accounts)

router = APIRouter()
_CACHE: dict = {"at": 0.0, "value": None}
_TTL = 60.0


def _iso(dt):
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def chatgpt_usage(fetch=None) -> dict:
    """{"ok": true, "plan", "usage": {fetchedAt, limits, paid}} or {"ok": false, "reason"}."""
    if fetch is None:
        from agent.account_usage import fetch_account_usage
        fetch = fetch_account_usage
    snap = fetch("openai-codex", read_only=True)
    if snap is None or getattr(snap, "unavailable_reason", None) or not getattr(snap, "windows", ()):
        reason = getattr(snap, "unavailable_reason", None) if snap is not None else None
        return {"ok": False, "reason": str(reason or "ChatGPT usage is not available right now.")[:200]}
    limits = []
    for i, w in enumerate(snap.windows):
        used = w.used_percent
        if not isinstance(used, (int, float)) or not math.isfinite(used):
            continue
        used = min(100.0, max(0.0, float(used)))
        label = str(w.label or "Limit")[:60]
        limits.append({"id": f"{label.lower().replace(' ', '-')}:{i}", "label": label,
                       "usedPercent": round(used, 1), "remainingPercent": math.floor(100 - used),
                       "resetsAt": _iso(w.reset_at)})
    paid = None
    credits = ((snap.raw or {}).get("credits") or {}) if isinstance(snap.raw, dict) else {}
    if credits.get("has_credits") is True:
        bal = credits.get("balance")
        try:
            bal_minor = round(float(bal) * 100)
        except (TypeError, ValueError):
            bal_minor = None
        paid = {"type": "credits", "enabled": True, "currency": "USD", "exponent": 2, "usedMinor": None,
                "limitMinor": None, "balanceMinor": bal_minor, "unlimited": credits.get("unlimited") is True}
    return {"ok": True, "plan": (str(snap.plan)[:40] if snap.plan else None),
            "usage": {"fetchedAt": _iso(snap.fetched_at), "limits": limits, "paid": paid}}


@router.get("/ai-usage/chatgpt")
def get_chatgpt_usage():
    now = time.monotonic()
    if _CACHE["value"] is not None and now - _CACHE["at"] < _TTL:
        return _CACHE["value"]
    try:
        value = chatgpt_usage()
    except Exception as e:  # noqa: BLE001 - report, never raise a token-bearing traceback
        value = {"ok": False, "reason": f"ChatGPT usage read failed ({type(e).__name__})."}
    _CACHE.update(at=now, value=value)
    return value


@router.get('/provider-accounts/{provider}')
def get_provider_accounts(provider: str):
    if provider not in _accounts.PROVIDERS:
        raise HTTPException(404, 'Unknown provider')
    try:
        return _accounts.provider_accounts(provider)
    except Exception:
        raise HTTPException(503, 'Hermes account inventory unavailable') from None
