#!/usr/bin/env python3
"""API-only host recovery entrypoint. No GatewayRunner, scheduler or messaging.

Uses the pinned Hermes APIServerAdapter, as the existing Wizard standalone API
does; this is not a mock API and does not patch installed Hermes source.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import signal
import sys


def configure(manifest):
    # Preserve host user-bus access but discard inherited provider, bot, plugin,
    # profile and API settings. Source .env is never read by this process.
    allow = ('USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'XDG_RUNTIME_DIR',
             'DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK', 'DOCKER_HOST', 'DOCKER_CONTEXT')
    env = {k: os.environ[k] for k in allow if k in os.environ}
    home, runtime = Path(manifest['home']), Path(manifest['runtime'])
    owner = Path(manifest['owner_home'])
    env.update(HOME=str(owner), HERMES_HOME=str(home), PYTHONDONTWRITEBYTECODE='1',
               PATH=os.pathsep.join(map(str, (runtime / 'venv/bin', owner / 'bin', owner / '.local/bin',
                                             '/usr/local/bin', '/usr/bin', '/bin'))))
    os.environ.clear()
    os.environ.update(env)
    sys.path.insert(0, str(runtime / 'code'))
    from dotenv import dotenv_values
    # Only prepare's selected-provider allowlist plus our API key are present.
    values = dotenv_values(home / '.env', interpolate=False)
    os.environ.update({k: v for k, v in values.items() if v is not None})
    return home


async def serve(manifest):
    configure(manifest)
    from gateway.config import PlatformConfig
    from gateway.platforms.api_server import APIServerAdapter
    adapter = APIServerAdapter(PlatformConfig(enabled=True, extra={
        'host': '127.0.0.1', 'port': manifest['port'],
        'key': os.environ['API_SERVER_KEY'], 'model_name': manifest['model'],
    }))
    if not await adapter.connect():
        return 1
    stop = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        asyncio.get_running_loop().add_signal_handler(sig, stop.set)
    try:
        await stop.wait()
    finally:
        await adapter.disconnect()
    return 0


if __name__ == '__main__':
    manifest = json.loads(Path(sys.argv[1]).read_text())
    raise SystemExit(asyncio.run(serve(manifest)))
