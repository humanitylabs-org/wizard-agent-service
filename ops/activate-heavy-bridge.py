#!/usr/bin/env python3
"""Retarget the user SSH bridge and verify systemd's effective command.

Usage: python3 ops/activate-heavy-bridge.py RELEASE [--check-only]
No worker configuration or queue state is changed. Run only in an idle release window.
"""
import argparse
from pathlib import Path
import re
import shlex
import subprocess

UNIT = 'wizard-heavy-rpc.service'
SCRIPT = '/server/heavy-rpc-server.mjs'


def systemctl(*args):
    return subprocess.run(['systemctl', '--user', *args], check=True,
                          capture_output=True, text=True).stdout.strip()


def effective():
    # Read manager-loaded properties, not a guessed drop-in ordering.
    text = systemctl('show', UNIT, '-p', 'ExecStart', '--value')
    matches = re.findall(r'argv\[\]=(.*?) ; ignore_errors=', text)
    if len(matches) != 1:
        raise RuntimeError('bridge must have exactly one effective ExecStart')
    argv = shlex.split(matches[0])
    scripts = [i for i, arg in enumerate(argv) if arg.endswith(SCRIPT)]
    if len(scripts) != 1:
        raise RuntimeError('unrecognized bridge effective ExecStart')
    return argv, scripts[0]


def activate(release, check_only=False):
    release = Path(release).resolve(strict=True)
    target = str(release) + SCRIPT
    if not Path(target).is_file() or re.search(r'[\s\x00-\x1f"\\%$]', target):
        raise ValueError('invalid immutable bridge release')
    argv, index = effective()
    expected = [*argv]; expected[index] = target
    if check_only:
        if argv != expected:
            raise RuntimeError(f'bridge ExecStart mismatch: expected {target}, got {argv[index]}')
        return target
    dropins = shlex.split(systemctl('show', UNIT, '-p', 'DropInPaths', '--value'))
    folder = Path.home() / '.config/systemd/user' / (UNIT + '.d')
    folder.mkdir(parents=True, exist_ok=True)
    override = folder / 'zz-wizard-release.conf'
    files = {Path(p) for p in dropins} | {override}
    backups = {p: p.read_bytes() if p.exists() else None for p in files}
    try:
        # Retarget historical pins too: agent-relay.conf sorts AFTER 99-*.conf.
        for path in files - {override}:
            text = path.read_text()
            updated = re.sub(r'[^\s="\']+' + re.escape(SCRIPT), target, text)
            if updated != text:
                path.write_text(updated)
        # Keep the effective interpreter/flags; never assume PATH or rewrite env files.
        command = ' '.join('"' + a.replace('\\', '\\\\').replace('"', '\\"') + '"' for a in expected)
        override.write_text('[Service]\nExecStart=\nExecStart=' + command + '\n')
        systemctl('daemon-reload')
        actual, _ = effective()
        if actual != expected:
            raise RuntimeError(f'bridge ExecStart mismatch after daemon-reload: {actual}')
        systemctl('restart', UNIT)
        if systemctl('is-active', UNIT) != 'active':
            raise RuntimeError('bridge did not become active')
        if effective()[0] != expected:
            raise RuntimeError('bridge ExecStart changed during restart')
    except Exception:
        for path, data in backups.items():
            if data is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(data)
        systemctl('daemon-reload')
        systemctl('restart', UNIT)
        raise
    return target


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('release')
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    print(activate(args.release, args.check_only))
