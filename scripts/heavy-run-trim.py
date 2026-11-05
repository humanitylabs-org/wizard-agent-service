#!/usr/bin/env python3
"""Future-only Forum run ownership. No sweeper, historical adoption or recursive rm.

Worker loads this sibling module only at preparation/finalization. Authority is an
exclusive-created registry entry, NOT a job-writable manifest or directory age.
Deletion is fd-relative, regular-file-only, and confined to explicit bulk slots.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import subprocess
import time
import uuid

VERSION = 1
SLOTS = ('build', 'cache', 'tmp')
# Intentionally narrow. Archives, source, disks, images, packages and unknowns stay.
SUFFIXES = {'.o', '.obj', '.class', '.pyc', '.pyo', '.bc'}
PROTECTED = re.compile(r'result|evidence|manifest|receipt|submission|admission|preflight|log|screenshot|output|artifact|weekly[-_ ]?launch', re.I)
FORBIDDEN = {'wizard-local', '.wizard-secure', 'AndroidBuilds', 'android-sdk'}
NOFOLLOW = os.O_NOFOLLOW | os.O_CLOEXEC


def write_new(path, value):
    path = Path(path)
    temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex + '.new')
    try:
        with temporary.open('x') as stream:
            os.chmod(temporary, 0o600)
            json.dump(value, stream, sort_keys=True)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        # Atomic publication with no overwrite; readers never see partial JSON.
        os.link(temporary, path, follow_symlinks=False)
    finally:
        if temporary.exists():
            temporary.unlink()  # only this call's exclusive-created temporary
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def roots(base):
    return base / 'heavy/managed-runs-v1', base / 'heavy/run-ownership-v1'


def plain_directory(path):
    """Reject every alias, including a symlink in any parent component."""
    if not path.is_absolute() or '..' in path.parts or path.resolve(strict=True) != path:
        raise ValueError('run path must be canonical')
    cursor = Path(path.anchor)
    for part in path.parts[1:]:
        cursor /= part
        if not stat.S_ISDIR(cursor.lstat().st_mode):
            raise ValueError('run path must contain plain directories only')
    if FORBIDDEN.intersection(path.parts):
        raise ValueError('protected tree')
    return path


def read_record(path):
    fd = os.open(path, os.O_RDONLY | NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 65536:
            raise ValueError('unsafe ownership record')
        return json.loads(os.read(fd, 65537))
    finally:
        os.close(fd)


def prepare(base, purpose='retained', disposable=()):
    if sys.platform != 'linux' or os.environ.get('WIZARD_HEAVY_HOST') != 'forum':
        raise ValueError('managed trimming is Forum Linux only')
    plain_directory(base)
    if purpose not in ('retained', 'ephemeral', 'weekly-launch') or any(s not in SLOTS for s in disposable):
        raise ValueError('invalid run policy')
    runs, registry = roots(base)
    for folder in (base / 'heavy', runs, registry):
        folder.mkdir(mode=0o700, exist_ok=True)
        plain_directory(folder)
    run_id = uuid.uuid4().hex
    run = runs / run_id
    run.mkdir(mode=0o700)  # Exclusive creation: no adoption of pre-existing folders.
    info = run.stat()
    record = {'version': VERSION, 'run_id': run_id, 'path': str(run),
              'device': info.st_dev, 'inode': info.st_ino, 'uid': info.st_uid,
              'created_at': time.time(), 'purpose': purpose,
              'disposable': sorted(set(disposable))}
    for name in record['disposable']:
        (run / name).mkdir(mode=0o700)
    (run / '.run.lock').touch(mode=0o600, exist_ok=False)
    record['lease_inode'] = (run / '.run.lock').stat().st_ino
    # An empty retain list is explicit. Operators/jobs can only ADD retention;
    # this file cannot expand disposal authority held outside the job tree.
    write_new(run / 'retain.json', {'paths': []})
    write_new(run / 'run-manifest.json', record)
    write_new(registry / (run_id + '.json'), record)  # publish authority last
    return record


def ownership(base, cwd):
    runs, registry = roots(base)
    relative = Path(cwd).relative_to(runs)
    run_id = relative.parts[0]
    if not re.fullmatch('[0-9a-f]{32}', run_id):
        raise ValueError('not a managed run')
    run = plain_directory(runs / run_id)
    plain_directory(registry)
    record = read_record(registry / (run_id + '.json'))
    info = run.stat()
    if (record.get('version') != VERSION or record.get('run_id') != run_id
            or record.get('path') != str(run)
            or (record.get('device'), record.get('inode'), record.get('uid'))
            != (info.st_dev, info.st_ino, info.st_uid)
            or record.get('purpose') not in ('retained', 'ephemeral', 'weekly-launch')
            or not isinstance(record.get('disposable'), list)
            or any(s not in SLOTS for s in record['disposable'])):
        raise ValueError('ownership identity mismatch')
    return run, record


def admit(base, spec, job_id):
    """One future run, one exact submission. Queued reuse is refused as well."""
    if not re.fullmatch(r'heavy_[0-9a-f]{32}', job_id):
        raise ValueError('invalid job identity')
    run, record = ownership(base, spec['cwd'])
    _, registry = roots(base)
    value = {'job_id': job_id, 'run_id': record['run_id'],
             'spec_sha256': hashlib.sha256(json.dumps(spec, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}
    with (registry / 'admission.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = registry / (record['run_id'] + '.admission.json')
        if path.exists():
            if read_record(path) != value:
                raise ValueError('managed runs are single-submission only')
        else:
            write_new(path, value)


def run_lease(base, spec):
    """Every managed executor holds a shared lease (also light vs heavy)."""
    if os.environ.get('WIZARD_HEAVY_HOST') != 'forum' or 'agent_id' in spec:
        return None
    runs, _ = roots(base)
    if not Path(spec['cwd']).is_relative_to(runs):
        return None
    run, record = ownership(base, spec['cwd'])  # malformed managed run fails execution closed
    fd = os.open(run / '.run.lock', os.O_RDONLY | NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_ino != record.get('lease_inode') or info.st_dev != record['device']):
            raise ValueError('unsafe run lease')
        fcntl.flock(fd, fcntl.LOCK_SH)
        return fd
    except BaseException:
        os.close(fd)
        raise


def mountpoints():
    def decode(s):
        return re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), s)
    return [Path(decode(line.split()[4])) for line in Path('/proc/self/mountinfo').read_text().splitlines()]


def process_busy(run):
    """Read-only privileged lsof sees root/container descendants too.

    No sudo, lsof diagnostic, timeout or indeterminate exit => retain. Never
    infer idleness from an unprivileged /proc scan (root fds are unreadable).
    Our own descriptors pin the run and lease, so exclude only this exact PID.
    """
    try:
        probe = subprocess.run(
            ['/usr/bin/sudo', '-n', '--', '/usr/bin/lsof', '-nP', '-F', 'p', '+D', str(run)],
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30,
            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})
        if probe.returncode not in (0, 1) or probe.stderr:
            return True
        pids = []
        for line in probe.stdout.splitlines():
            if not re.fullmatch(r'p[0-9]+', line):
                return True
            pids.append(int(line[1:]))
        if (probe.returncode == 0 and not pids) or (probe.returncode == 1 and pids):
            return True
        return any(pid != os.getpid() for pid in pids)
    except (OSError, subprocess.SubprocessError, ValueError):
        return True


def inventory(fd, device, prefix='', limit=100000):
    """No symlinks, hardlinks, special files or device crossings anywhere in run.

    Keep descriptors rooted at the registered inode; never follow a job's path
    replacement. A suspicious entry blocks the whole pass before first unlink.
    """
    items = []
    for name in sorted(os.listdir(fd)):
        relative = prefix + name
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if info.st_dev != device or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
            raise ValueError('link, special file or device crossing')
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=fd)
            try:
                if os.fstat(child).st_ino != info.st_ino:
                    raise ValueError('directory changed')
                items.extend(inventory(child, device, relative + '/', limit - len(items)))
            finally:
                os.close(child)
        else:
            if info.st_nlink != 1:
                raise ValueError('hardlink present')
            items.append((relative, info))
        if len(items) > limit:
            raise ValueError('inventory limit')
    return items


def read_text_same(fd, relative, expected):
    parent = os.dup(fd)
    stream = None
    try:
        for name in Path(relative).parts[:-1]:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
        stream = os.open(Path(relative).name, os.O_RDONLY | NOFOLLOW, dir_fd=parent)
        current = os.fstat(stream)
        if (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) != (
                expected.st_dev, expected.st_ino, expected.st_size, expected.st_mtime_ns):
            raise ValueError('evidence changed')
        with os.fdopen(os.dup(stream), 'rb') as reader:
            content = reader.read(8 * 1024 * 1024 + 1)
        if len(content) != expected.st_size:
            raise ValueError('evidence changed or oversized')
        return content.decode('utf-8')
    finally:
        if stream is not None:
            os.close(stream)
        os.close(parent)


def unlink_same(fd, relative, expected):
    parts = Path(relative).parts
    parent = os.dup(fd)
    try:
        for name in parts[:-1]:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
        info = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
        if (info.st_dev, info.st_ino, info.st_nlink, info.st_size, info.st_mtime_ns) != (
                expected.st_dev, expected.st_ino, 1, expected.st_size, expected.st_mtime_ns):
            raise ValueError('file changed')
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('not a regular disposable file')
        os.unlink(parts[-1], dir_fd=parent)
    finally:
        os.close(parent)


def trim(base, spec, job_id, evidence_paths=()):
    """Best effort only, after the durable terminal receipt. Never retry/sweep."""
    if (sys.platform != 'linux' or os.environ.get('WIZARD_HEAVY_HOST') != 'forum'
            or 'agent_id' in spec):
        return None
    runs, registry = roots(base)
    if not Path(spec['cwd']).is_relative_to(runs):
        return None  # legacy folders, however old/large/completed, are NEVER visited
    run, record = ownership(base, spec['cwd'])
    admission = read_record(registry / (record['run_id'] + '.admission.json'))
    if not re.fullmatch(r'heavy_[0-9a-f]{32}', job_id):
        raise ValueError('invalid job identity')
    if (admission.get('job_id') != job_id or admission.get('spec_sha256') !=
            hashlib.sha256(json.dumps(spec, sort_keys=True, separators=(',', ':')).encode()).hexdigest()):
        raise ValueError('trim admission mismatch')
    if (registry / (record['run_id'] + '.' + job_id + '.trim.json')).exists():
        raise ValueError('trim already finalized; no retry')
    report = {'version': VERSION, 'job_id': job_id, 'run_id': record['run_id'],
              'policy': 'future-only-explicit-bulk',
              'at': time.time(), 'removed': [], 'bytes_unlinked': 0, 'status': 'retained'}
    fd = os.open(run, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW)
    lease = None
    try:
        if (os.fstat(fd).st_dev, os.fstat(fd).st_ino) != (record['device'], record['inode']):
            raise ValueError('run replaced')
        lease = os.open('.run.lock', os.O_RDONLY | NOFOLLOW, dir_fd=fd)
        if (os.fstat(lease).st_nlink != 1 or not stat.S_ISREG(os.fstat(lease).st_mode)
                or os.fstat(lease).st_ino != record.get('lease_inode')
                or os.fstat(lease).st_dev != record['device']):
            raise ValueError('unsafe run lease')
        fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Explicit purpose is mandatory; weekly-launch and default retained always win.
        if record['purpose'] != 'ephemeral' or re.search(r'weekly[-_ /]*launch', ' '.join(spec['argv']), re.I):
            report['reason'] = 'retained_purpose_or_weekly_launch'
        elif (run / 'RETAIN').exists():
            report['reason'] = 'retain_marker'
        elif any(p == run or p.is_relative_to(run) for p in mountpoints()):
            report['reason'] = 'mounted_tree'
        elif process_busy(run):
            report['reason'] = 'process_busy_or_unknown'
        else:
            items = inventory(fd, record['device'])
            retained = read_record(run / 'retain.json').get('paths')
            if (not isinstance(retained, list) or any(not isinstance(p, str) or not p
                    or Path(p).is_absolute() or '..' in Path(p).parts for p in retained)):
                raise ValueError('invalid retain list')
            # Preserve linked outputs named in retained text/JSON/logs. Large or
            # undecodable textual evidence fails closed, never silently truncates.
            references = []
            scanned = 0
            for evidence in evidence_paths:
                if evidence.exists():
                    scanned += evidence.stat().st_size
                    if scanned > 16 * 1024 * 1024:
                        raise ValueError('reference scan limit')
                    references.append(evidence.read_text())
            for relative, info in items:
                if Path(relative).suffix.lower() in ('.json', '.jsonl', '.log', '.txt', '.md', '.csv', '.xml', '.html'):
                    scanned += info.st_size
                    if info.st_size > 8 * 1024 * 1024 or scanned > 16 * 1024 * 1024:
                        raise ValueError('reference scan limit')
                    references.append(read_text_same(fd, relative, info))
            text = '\n'.join(references)
            candidates = []
            for relative, info in items:
                path = Path(relative)
                if (len(path.parts) < 2 or path.parts[0] not in record['disposable']
                        or path.suffix.lower() not in SUFFIXES or PROTECTED.search(relative)
                        or any(relative == p or path.is_relative_to(p) for p in retained)
                        or relative in text or str(run / relative) in text or path.name in text):
                    continue
                candidates.append((relative, info))
            if candidates:
                # Durable pre-delete intent survives interruption/out-of-space;
                # publication failure vetoes all unlinking. Never overwrite it.
                write_new(registry / (record['run_id'] + '.' + job_id + '.trim-intent.json'),
                          {'run_id': record['run_id'], 'job_id': job_id, 'at': time.time(),
                           'files': [{'path': relative, 'device': info.st_dev,
                                      'inode': info.st_ino, 'bytes': info.st_size,
                                      'mtime_ns': info.st_mtime_ns} for relative, info in candidates]})
            for relative, info in candidates:
                unlink_same(fd, relative, info)
                report['removed'].append({'path': relative, 'bytes': info.st_size})
                report['bytes_unlinked'] += info.st_size
            report['status'] = 'trimmed' if report['removed'] else 'retained'
            report['reason'] = 'explicit_bulk_only'
    except Exception as error:
        report['status'] = 'skipped' if not report['removed'] else 'partial'
        report['reason'] = type(error).__name__ + ': ' + str(error)
    finally:
        if lease is not None:
            os.close(lease)
        os.close(fd)
    # Separate evidence, not a mutation of the job result/receipt. Never overwrite.
    write_new(registry / (record['run_id'] + '.' + job_id + '.trim.json'), report)
    return report
