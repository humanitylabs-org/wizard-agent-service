"""Attempt-scoped release-pointer/text snapshots, compare-and-swap and rollback.

This is a filesystem adapter, not a complete launch plan. It deliberately never
opens agent homes, app data, environment files, credentials, or mutable databases.
Caller must still provide lifecycle, API and privacy acceptance adapters.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re

class Drift(RuntimeError):
    pass


def atomic(path, data, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.pending')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as file:
        os.fchmod(file.fileno(), mode)
        file.write(data)
        file.flush()
        os.fsync(file.fileno())
    os.replace(tmp, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def identity(path):
    path = Path(path)
    if path.is_symlink():
        return {'kind': 'link', 'target': os.readlink(path)}
    if not path.exists():
        return {'kind': 'absent'}
    if not path.is_file():
        raise ValueError('only release pointers and reviewed text files are supported')
    return {'kind': 'file', 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'mode': path.stat().st_mode & 0o777}


def permitted(home, path):
    home, path = Path(home).absolute(), Path(path).absolute()
    if not path.is_relative_to(home):
        return False
    name = path.relative_to(home).as_posix()
    return name in {
        '.local/share/wizard-mobile-server/current',
        '.local/share/wizard-agent-runtime/current',
        '.local/share/wam-python/current',
        '.local/bin/wam',
        '.config/systemd/user/wizard-app-manager-api.service.d/connection-fork-registry.conf',
        '.config/systemd/user/wizard-agent-runtime.service.d/99-pp-launch-wam.conf',
    }


class Transaction:
    def __init__(self, home, root, attempt):
        if not re.fullmatch(r'[a-f0-9]{32}', attempt):
            raise ValueError('invalid attempt')
        self.home = Path(home).absolute()
        self.root = Path(root) / attempt
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root.chmod(0o700)
        self.path = self.root / 'filesystem-transaction.json'
        self.attempt = attempt
        if self.path.exists():
            self.data = json.loads(self.path.read_text())
            if self.data.get('attempt') != attempt or self.data.get('home') != str(self.home):
                raise ValueError('foreign snapshot')
        else:
            self.data = {'schema': 1, 'attempt': attempt, 'home': str(self.home), 'targets': {}}

    def save(self):
        atomic(self.path, (json.dumps(self.data, indent=2) + '\n').encode())

    def target(self, path):
        path = Path(path).absolute()
        if not permitted(self.home, path):
            raise ValueError('target outside reviewed release-control allowlist')
        # Never permit an intermediate symlink to redirect a target into data.
        parent = path.parent
        if parent.resolve() != parent:
            raise ValueError('symlinked parent is not a reviewed release control')
        return path

    def snapshot(self, paths):
        if self.data['targets']:
            raise ValueError('snapshot is immutable once created')
        targets = {}
        for value in paths:
            path = self.target(value)
            before = identity(path)
            record = {'before': before, 'owned': None, 'pending': None}
            if before['kind'] == 'file':
                raw = path.read_bytes()
                # These are executable launcher/drop-in source, not env storage.
                if re.search(rb'(?im)^\s*(?:export\s+|Environment=)?(?:[A-Z_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)[A-Z_]*)\s*=', raw):
                    raise ValueError('credential-like assignment in release control')
                if hashlib.sha256(raw).hexdigest() != before['sha256']:
                    raise Drift('target changed while taking snapshot')
                record['content_b64'] = base64.b64encode(raw).decode()
            targets[str(path)] = record
        self.data['targets'] = targets
        self.save()
        return self.readback()

    def readback(self):
        saved = json.loads(self.path.read_text())
        if saved != self.data:
            raise Drift('snapshot readback differs')
        return {'attempt': self.attempt, 'targets': len(saved['targets']), 'readback': True}

    def install(self, path, *, link=None, text=None, mode=0o600):
        path = self.target(path)
        record = self.data['targets'][str(path)]
        if record['owned'] is not None or record['pending'] is not None:
            raise ValueError('target already claimed by this attempt')
        if identity(path) != record['before']:
            raise Drift('release target drifted after snapshot')
        if (link is None) == (text is None):
            raise ValueError('exactly one payload is required')
        if link is not None:
            target = Path(link)
            if not target.is_absolute() or not target.is_dir():
                raise ValueError('candidate release target must be an existing absolute directory')
            if path.name != 'current' or not target.resolve().is_relative_to(path.parent / 'releases'):
                raise ValueError('candidate pointer must stay within its own release store')
            expected = {'kind': 'link', 'target': str(target)}
        else:
            assert isinstance(text, bytes)
            expected = {'kind': 'file', 'sha256': hashlib.sha256(text).hexdigest(), 'mode': mode}
        record['pending'] = expected
        self.save()  # write-ahead ownership survives interruption after replacement
        self._write(path, expected, text)
        if identity(path) != expected:
            raise Drift('candidate release readback failed')
        record['owned'], record['pending'] = expected, None
        self.save()
        return expected

    def _write(self, path, expected, raw=None):
        if expected['kind'] == 'link':
            pending = path.with_name(path.name + '.pp-' + self.attempt)
            if pending.exists() or pending.is_symlink():
                raise Drift('attempt pending link already exists')
            pending.symlink_to(expected['target'])
            os.replace(pending, path)
        elif expected['kind'] == 'file':
            atomic(path, raw, expected['mode'])
        elif expected['kind'] == 'absent':
            path.unlink(missing_ok=True)
        else:
            raise ValueError('unsupported release control')
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def rollback(self):
        # Prevalidate ALL targets before restoring any. Foreign post-promotion
        # drift is never overwritten. A pending write may not have happened yet.
        changes = []
        for value, record in self.data['targets'].items():
            path = self.target(value)
            actual = identity(path)
            before = record['before']
            owned = record['pending'] or record['owned']
            if actual == before:
                continue
            if owned is None or actual != owned:
                raise Drift('foreign target drift; rollback refused')
            changes.append((path, record))
        for path, record in reversed(changes):
            before = record['before']
            raw = base64.b64decode(record['content_b64']) if before['kind'] == 'file' else None
            self._write(path, before, raw)
            if identity(path) != before:
                raise Drift('rollback exact-target readback failed')
            record['owned'], record['pending'] = None, None
            self.save()
        if any(identity(Path(value)) != record['before'] for value, record in self.data['targets'].items()):
            raise Drift('rollback final readback failed')
        return {'attempt': self.attempt, 'status': 'passed', 'targets_restored': len(changes), 'readback': True}
