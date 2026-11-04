#!/usr/bin/env python3
"""Read-only app-login projector; no network, refresh chain, env token or home.

Follow atomic app credential replacements every two seconds. Remove the
projection on logout/invalid data/expiry. Renewal belongs to the official
Claude Code login/test flow in wizard-claude, never this consumer.
"""
import json
import math
import os
from pathlib import Path
import stat
import sys
import tempfile
import time

SOURCE = Path('/claude-app')
TARGET = Path('/run/claude-login')
INTERVAL = 2


def credential(source=SOURCE):
    directory = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fd = os.open('.credentials.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
                    or not 0 < info.st_size <= 65536):
                raise ValueError('invalid login')
            raw = os.read(fd, 65537)
            if len(raw) > 65536:
                raise ValueError('invalid login')
            auth = json.loads(raw)['claudeAiOauth']
        finally:
            os.close(fd)
    finally:
        os.close(directory)
    token, expiry = auth.get('accessToken'), auth.get('expiresAt')
    if (not isinstance(token, str) or not 0 < len(token) <= 16384
            or any(not 33 <= ord(c) <= 126 for c in token)
            or type(expiry) not in (int, float) or not math.isfinite(expiry)
            or expiry <= time.time() * 1000):
        raise ValueError('invalid login')
    result = {'accessToken': token, 'expiresAt': expiry}
    scopes = auth.get('scopes')
    if not isinstance(scopes, list) or not scopes or len(scopes) > 64 or any(
            not isinstance(s, str) or len(s) > 128 for s in scopes):
        raise ValueError('invalid login')
    result['scopes'] = scopes
    for key in ('subscriptionType', 'rateLimitTier'):
        value = auth.get(key)
        if isinstance(value, str) and len(value) <= 128:
            result[key] = value
    # Explicit allowlist: never clone refreshToken or arbitrary CLI config.
    return {'claudeAiOauth': result}


def seed(source=SOURCE, target=TARGET):
    try:
        value = credential(source)
    except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError):
        (target / '.credentials.json').unlink(missing_ok=True)
        return False
    os.chown(target, 10000, 10000)
    os.chmod(target, 0o700)
    fd, name = tempfile.mkstemp(prefix='.seed-', dir=target)
    try:
        with os.fdopen(fd, 'w') as output:
            os.fchmod(output.fileno(), 0o600)
            os.fchown(output.fileno(), 10000, 10000)
            json.dump(value, output)
        os.replace(name, target / '.credentials.json')
    finally:
        if os.path.exists(name):
            os.unlink(name)
    return True


def main():
    if sys.argv[1:] == ['--check']:
        try:
            credential()
        except Exception:
            return 1
        return 0
    # Missing credentials are a status warning, not unhealthy/crash-looping.
    while True:
        try:
            seed()
            (TARGET / '.initialized').touch(mode=0o600, exist_ok=True)
        except Exception:
            # Fail closed: never leave a stale projection behind a dead projector.
            try:
                (TARGET / '.credentials.json').unlink(missing_ok=True)
            except OSError:
                pass
            raise SystemExit('Claude login projection failed') from None
        time.sleep(INTERVAL)


if __name__ == '__main__':
    raise SystemExit(main())
