"""Shared stock-Hermes lock. Canonical source: wizard-os tools/hermes_lock.py.

Vendor unchanged with releases/hermes-lock.json in App Manager and Agent Service.
No discovery, promotion, restart or runtime mutation happens in this module.
"""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re


def _exact(value, pattern):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def validate(doc, now=None):
    if not isinstance(doc, dict) or doc.get('schema') != 1:
        raise ValueError('Hermes lock: unsupported schema')
    if doc.get('automatic_updates') != 'paused' or doc.get('minimum_release_age_days') != 7:
        raise ValueError('Hermes lock: automatic updates must stay paused; seven-day gate required')
    h = doc.get('hermes') or {}
    if not _exact(h.get('tag'), r'v\d+\.\d+\.\d+') or not _exact(h.get('commit'), r'[0-9a-f]{40}'):
        raise ValueError('Hermes lock: final tag and exact upstream commit required')
    im = h.get('image') or {}
    if im.get('ref') != 'docker.io/nousresearch/hermes-agent:' + h['tag'] or not _exact(im.get('digest'), r'sha256:[0-9a-f]{64}'):
        raise ValueError('Hermes lock: exact official image required')
    recipe = doc.get('agent_recipe') or {}
    if recipe.get('app') != 'hermes-agent' or not _exact(recipe.get('commit'), r'[0-9a-f]{40}') or not _exact(recipe.get('repo'), r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+'):
        raise ValueError('Hermes lock: exact agent recipe required')
    if not _exact(doc.get('runtime_image'), r'ghcr\.io/humanitylabs-org/hermes-agent@sha256:[0-9a-f]{64}'):
        raise ValueError('Hermes lock: exact runtime image required')
    p = doc.get('promotion')
    if doc.get('state') == 'frozen' and p is None and doc.get('previous') is None:
        return doc
    if doc.get('state') != 'approved' or not isinstance(p, dict) or not _exact(p.get('id'), r'[a-z0-9][a-z0-9.-]{0,63}'):
        raise ValueError('Hermes lock: reviewed promotion required')
    for key in ('recommendation', 'approval', 'acceptance', 'canary', 'bug_review', 'rollback'):
        if not _exact(p.get(key), r'https://[^\s]+'):
            raise ValueError('Hermes lock: missing promotion evidence: ' + key)
    try:
        published = datetime.fromisoformat(p['published_at'].replace('Z', '+00:00'))
        approved = datetime.fromisoformat(p['approved_at'].replace('Z', '+00:00'))
        if published.tzinfo is None or approved.tzinfo is None:
            raise ValueError()
        if approved < published + timedelta(days=7) or approved > (now or datetime.now(timezone.utc)):
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise ValueError('Hermes lock: approval must follow seven full days after publication and not be future-dated') from None
    _previous(doc)
    return doc


def _previous(doc):
    # The pin this promotion replaced. Stable keeps it until the promoted release has soaked, so releases that
    # still pin it stay valid (wizard-app-manager#856); it is never what a new install of a new release gets.
    prev = doc.get('previous')
    if prev is None:
        return None
    h, recipe = (prev.get('hermes') or {}, prev.get('agent_recipe') or {}) if isinstance(prev, dict) else ({}, {})
    im = h.get('image') or {}
    if (not _exact(h.get('tag'), r'v\d+\.\d+\.\d+') or not _exact(h.get('commit'), r'[0-9a-f]{40}')
            or im.get('ref') != 'docker.io/nousresearch/hermes-agent:' + h['tag']
            or not _exact(im.get('digest'), r'sha256:[0-9a-f]{64}')
            or recipe.get('app') != 'hermes-agent' or not _exact(recipe.get('commit'), r'[0-9a-f]{40}')
            or not _exact(recipe.get('repo'), r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+')
            or not _exact(prev.get('runtime_image'), r'ghcr\.io/humanitylabs-org/hermes-agent@sha256:[0-9a-f]{64}')):
        raise ValueError('Hermes lock: previous needs the exact replaced pin, recipe and runtime image')
    if (h['tag'], h['commit']) == (doc['hermes']['tag'], doc['hermes']['commit']):
        raise ValueError('Hermes lock: previous must differ from the locked pin')
    return prev


def load(path=None):
    local = Path(__file__).with_name('hermes-lock.json')
    path = Path(path) if path else (local if local.is_file() else Path(__file__).resolve().parents[1] / 'releases/hermes-lock.json')
    return validate(json.loads(path.read_text()))


def check_pin(pin, doc=None):
    doc = load() if doc is None else validate(doc)
    locked = doc['hermes']
    if not isinstance(pin, dict) or any(pin.get(k) != locked[k] for k in ('tag', 'commit')) or pin.get('image') != locked['image']:
        raise ValueError('Hermes is frozen: release differs from the shared exact lock')
    return pin


def check_release(release, doc=None):
    """A release pins the locked Hermes and recipe, or both of the pin the promotion replaced (`previous`)."""
    doc = load() if doc is None else validate(doc)
    prev = _previous(doc)
    if prev is not None and _same(release, prev['hermes'], prev['agent_recipe']):
        return release
    check_pin(release.get('hermes'), doc)
    recipe = (release.get('default_apps') or {}).get('agent')
    if recipe is not None and any(recipe.get(k) != doc['agent_recipe'][k] for k in ('app', 'repo', 'commit')):
        raise ValueError('Hermes is frozen: release agent recipe differs from the shared lock')
    return release


def _same(release, pin, agent):
    h = release.get('hermes')
    recipe = (release.get('default_apps') or {}).get('agent')
    return (isinstance(h, dict) and all(h.get(k) == pin[k] for k in ('tag', 'commit', 'image'))
            and (recipe is None or all(recipe.get(k) == agent[k] for k in ('app', 'repo', 'commit'))))


def authorize(doc=None):
    doc = load() if doc is None else validate(doc)
    p = doc.get('promotion')
    if not p or doc['state'] != 'approved' or os.environ.get('WIZARD_HERMES_PROMOTION') != p['id']:
        raise ValueError('Hermes updates are paused: a reviewed promotion and explicit WIZARD_HERMES_PROMOTION id are required')
    return p['id']
