#!/usr/bin/env python3
"""Seed a per-agent memory-only Claude CLI config from an owner-managed ro secret.

No token in env/argv/logs or the durable agent home. No refresh token is granted;
owner setup-tokens must be replaced explicitly when revoked/expired upstream.
"""
import json
import os
from pathlib import Path
import stat
import tempfile


def seed(source=Path('/run/secrets/claude.token'), target=Path('/run/claude-login')):
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
                or not 0 < info.st_size <= 16385):
            raise ValueError('invalid secret file')
        token = os.read(fd, 16386).decode('utf-8').strip()
        if not token or len(token) > 16384 or any(c.isspace() or ord(c) < 33 or ord(c) == 127 for c in token):
            raise ValueError('invalid secret value')
    finally:
        os.close(fd)
    # The mount root cannot be replaced by the agent. Replace (never follow) an
    # existing credential symlink/FIFO; fchmod/fchown only the fresh exclusive fd.
    os.chown(target, 10000, 10000)
    os.chmod(target, 0o700)
    fd, name = tempfile.mkstemp(prefix='.seed-', dir=target)
    try:
        with os.fdopen(fd, 'w') as output:
            os.fchmod(output.fileno(), 0o600)
            os.fchown(output.fileno(), 10000, 10000)
            json.dump({'claudeAiOauth': {
                'accessToken': token,
                # setup-token has no local refresh flow; server expiry is authoritative.
                'expiresAt': 4102444800000,
                'scopes': ['user:inference', 'user:profile'],
            }}, output)
        os.replace(name, target / '.credentials.json')
    finally:
        if os.path.exists(name):
            os.unlink(name)


if __name__ == '__main__':
    try:
        seed()
    except Exception:
        raise SystemExit('Claude credential initialization failed') from None
    # A local-driver tmpfs loses its contents when the last container unmounts.
    # Retain this no-network, no-home seeder mount for the agent's lifetime.
    import signal
    signal.pause()
