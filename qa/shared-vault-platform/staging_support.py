"""Small, no-Docker-required contracts used by the isolated Forum staging runner."""
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import time

SOCKET_LIMIT = 103  # Same conservative bound as server/agent-sockets.mjs.
LOG_LIMIT = 8192


def validate_socket_paths(root):
    paths = [root/'service-private/service.sock']
    paths += [root/('edge-' + s)/'public/agent.sock' for s in ('a', 'b')]
    paths += [root/'agents'/agent/'gateway'/name
              for agent in ('agent-a', 'agent-b') for name in ('gateway.sock', 'ingress.sock')]
    for path in paths:
        size = len(os.fsencode(path))
        if size > SOCKET_LIMIT:
            raise ValueError(f'staging_socket_path_too_long: {size}>{SOCKET_LIMIT}; choose a shorter --output (no symlink aliases)')
    return paths


def sanitize(text, secrets=()):
    # Replace whole values BEFORE truncating. Never retain raw diagnostic files.
    for value in sorted(set(s for s in secrets if s), key=len, reverse=True):
        text = text.replace(value, '[REDACTED]')
    text = re.sub(r'-----BEGIN [^-]*PRIVATE KEY-----.*?(?:-----END [^-]*PRIVATE KEY-----|\Z)', '[REDACTED KEY]', text, flags=re.S)
    text = re.sub(r'(?i)\bsynthetic[-_a-z0-9]+\b', '[REDACTED FIXTURE]', text)
    text = re.sub(r'(?i)\bBearer\s+[^\s\"\']+', 'Bearer [REDACTED]', text)
    return text[-LOG_LIMIT:]


def bounded_output(argv, timeout=8):
    """Drain at most 64 KiB/8s; discard an incomplete last line on truncation."""
    proc = subprocess.Popen([str(a) for a in argv], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    assert proc.stdout is not None
    chunks = bytearray(); capped = False
    try:
        with selectors.DefaultSelector() as sel:
            sel.register(proc.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + timeout
            while True:
                left = deadline - time.monotonic()
                if left <= 0: capped = True; break
                if not sel.select(left): capped = True; break
                data = os.read(proc.stdout.fileno(), min(4096, 65536 - len(chunks)))
                if not data: break
                chunks.extend(data)
                if len(chunks) >= 65536: capped = True; break
    finally:
        if proc.poll() is None: proc.kill()
        proc.wait(timeout=2)
        proc.stdout.close()
    if capped:
        chunks = chunks.rsplit(b'\n', 1)[0] if b'\n' in chunks else bytearray()
    return chunks.decode('utf8', errors='replace') + ('\n[diagnostic output capped]\n' if capped else '')


def capture_failure(root, names, projects=(), proxy=None, secrets=(), error=None, commands=()):
    """Only fixture names and State/logs; no inspect Config, env or home dumps."""
    secrets = list(secrets)
    # A bounded log tail can begin halfway through a PEM; mask its body lines too.
    try:
        key = (root/'service-private/key.pem').read_text()
        secrets.extend([key, *(line for line in key.splitlines() if len(line) >= 12)])
    except OSError: pass
    # A browser step may persist handles and then fail before returning them.
    try:
        handles = json.loads((root/'handles.json').read_text())
        secrets.extend(value for value in handles.values() if isinstance(value, str))
    except (OSError, ValueError, AttributeError): pass
    targets = list(dict.fromkeys(names))
    for project in projects:
        try:
            ids = bounded_output(['docker', 'ps', '-a', '-q', '--filter', 'label=com.docker.compose.project=' + project]).splitlines()
            targets.extend(i for i in ids if re.fullmatch(r'[a-f0-9]{12,64}', i))
        except Exception: pass
    safe_commands = [{key: sanitize(value, secrets) if isinstance(value, str) else value for key, value in item.items()}
                     for item in list(commands)[-4:]]
    report = {'failure': sanitize(str(error), secrets), 'containers': [], 'proxy_stderr': '', 'commands': safe_commands}
    for target in dict.fromkeys(targets):
        entry = {'target': target}
        for key, argv in [('state', ['docker', 'inspect', '--format', '{{json .State}}', target]),
                          ('logs', ['docker', 'logs', '--tail', '60', '--timestamps', target])]:
            try: entry[key] = sanitize(bounded_output(argv), secrets)
            except Exception as failure: entry[key] = 'diagnostic unavailable: ' + type(failure).__name__
        report['containers'].append(entry)
    if proxy and proxy.stderr:
        try:
            os.set_blocking(proxy.stderr.fileno(), False)
            raw = os.read(proxy.stderr.fileno(), 65536)
            # A live writer can leave an incomplete line. Do not persist fragments.
            raw = raw.rsplit(b'\n', 1)[0] if b'\n' in raw else b''
            report['proxy_stderr'] = sanitize(raw.decode('utf8', errors='replace'), secrets)
        except (BlockingIOError, OSError): pass
    path = root/'failure-diagnostics.json'
    path.write_text(json.dumps(report, indent=2)); path.chmod(0o600)
    return path
