#!/usr/bin/env python3
"""Owner-run Linux bootstrap; NEVER run on a live host for preview QA.

Requires target administrator. No sudo calls, sshd edits or service restarts.
Refuses existing accounts; leaves partial state for explicit owner recovery.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import sys


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--agent', required=True)
    p.add_argument('--user', default='wizard-agent')
    p.add_argument('--public-key', required=True)
    p.add_argument('--privacy', choices=['worker', 'personal'], required=True)
    p.add_argument('--presets', required=True, help='Reviewed JSON catalog, no secrets; use {} for status only')
    p.add_argument('--confirm-create-limited-user', action='store_true')
    a = p.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0 or not a.confirm_create_limited_user:
        p.error('Linux target administrator and explicit confirmation required')
    for value in (a.agent, a.user):
        if not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', value):
            p.error('invalid agent/user id')
    try:
        pwd.getpwnam(a.user)
    except KeyError:
        pass
    else:
        p.error('existing account refused; do not adopt an owner login')
    key = Path(a.public_key).read_text().strip().split()
    if len(key) < 2 or key[0] != 'ssh-ed25519' or '\n' in Path(a.public_key).read_text().strip():
        p.error('one plain ed25519 public key required, no key options')
    try:
        raw = base64.b64decode(key[1], validate=True)
        if len(raw) != 51 or raw[:19] != b'\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20':
            raise ValueError('not ed25519')
    except ValueError:
        p.error('invalid ed25519 public key')
    presets = json.loads(Path(a.presets).read_text())
    if not isinstance(presets, dict) or (a.privacy == 'personal' and presets):
        p.error('personal enrollment must have an empty preset catalog')
    for name, value in presets.items():
        if not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', name) or not isinstance(value, dict) or set(value) - {'argv', 'timeout'}:
            p.error('invalid preset catalog')
        argv = value.get('argv')
        if not isinstance(argv, list) or not argv or not all(isinstance(x, str) and '\0' not in x for x in argv) or not argv[0].startswith('/'):
            p.error('preset must have literal argv with an absolute executable')
        timeout = value.get('timeout', 30)
        if type(timeout) is not int or not 1 <= timeout <= 120:
            p.error('preset timeout must be 1..120 seconds')
    # Fixed safe paths: no owner-supplied command/path interpolation.
    home = Path('/var/lib/wizard-machines') / a.user
    install = Path('/usr/local/lib/wizard-machines')
    policies = Path('/etc/wizard-machines')
    policy = policies / (a.user + '.json')
    if home.exists() or policy.exists():
        p.error('partial enrollment exists; owner recovery required')
    for folder in (home.parent, install, policies):
        folder.mkdir(parents=True, mode=0o755, exist_ok=True)
        s = folder.lstat()
        if folder.is_symlink() or s.st_uid != 0 or s.st_mode & 0o022:
            p.error('unsafe installation directory')
    script = Path(__file__).with_name('machines.py')
    receiver = install / 'machines.py'
    if receiver.exists():
        # Never overwrite a receiver used by another enrolled principal.
        if receiver.is_symlink() or receiver.read_bytes() != script.read_bytes():
            p.error('receiver version already installed; upgrade separately')
    else:
        fd = os.open(receiver, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o755)
        with os.fdopen(fd, 'wb') as f:
            f.write(script.read_bytes())
    print('Creating new limited account; failures leave state for manual recovery.', file=sys.stderr)
    subprocess.run(['/usr/sbin/useradd', '--home-dir', str(home), '--shell', '/bin/sh',
                    '--no-create-home', '--user-group', '--password', '*', a.user], check=True)
    user = pwd.getpwnam(a.user)
    home.mkdir(mode=0o755)
    workspace = home / 'work'
    workspace.mkdir(mode=0o700)
    os.chown(workspace, user.pw_uid, user.pw_gid)
    ssh = home / '.ssh'
    ssh.mkdir(mode=0o755)
    # Root-owned .ssh and home prevent the target user replacing the forced key.
    command = f'/usr/bin/python3 -I {receiver} receive --policy {policy} --agent {a.agent}'
    authorized = f'restrict,command="{command}" {key[0]} {key[1]} wizard-machines-{a.agent}\n'
    fd = os.open(ssh / 'authorized_keys', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    with os.fdopen(fd, 'w') as f:
        f.write(authorized)
    fd = os.open(policy, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    with os.fdopen(fd, 'w') as f:
        json.dump({'version': 1, 'agent': a.agent, 'privacy': a.privacy,
                   'workspace': str(workspace), 'presets': presets}, f)
    fd = os.open(str(policy) + '.run-lock', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o640)
    os.fchown(fd, 0, user.pw_gid)
    os.close(fd)
    print(json.dumps({'user': a.user, 'agent': a.agent, 'privacy': a.privacy,
                      'workspace': str(workspace), 'policy': str(policy), 'root_runtime': False}))
    print('No SSH service or owner account changed. Enable SSH separately if needed. Confirm the host key out of band.', file=sys.stderr)
    print('A limited user is NOT a sandbox: world-readable data, process metadata and LAN remain accessible.', file=sys.stderr)
    print('Revoke by removing the target authorized key first; preserve work/account until separate owner cleanup.', file=sys.stderr)


if __name__ == '__main__':
    main()
