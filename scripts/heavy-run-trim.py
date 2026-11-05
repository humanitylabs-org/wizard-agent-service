#!/usr/bin/env python3
"""Completion-only Forum bulk disposal. No historical sweep or background timer.

Authority lives outside runs. Policy baseline names are forever excluded. Unknown
birthtime, process/loop state, evidence or identity => retain, never guess.
"""
from contextlib import contextmanager
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
import sys
import time
import uuid

VERSION = 2
SLOTS = ('build', 'cache', 'tmp', 'intermediates')
PROTECTED = re.compile(r'result|evidence|report|manifest|receipt|submission|admission|preflight|log|screenshot|weekly[-_ ]?launch', re.I)
FORBIDDEN = {'wizard-local', '.wizard-secure', 'AndroidBuilds', 'android-sdk'}
RESERVED = FORBIDDEN | {'heavy', 'agents', 'lost+found'}
EVIDENCE_SUFFIXES = {'.json', '.jsonl', '.log', '.png', '.jpg', '.jpeg', '.webp', '.md', '.txt', '.html', '.xml', '.csv'}
TEXT_SUFFIXES = EVIDENCE_SUFFIXES - {'.png', '.jpg', '.jpeg', '.webp'}
PROFILE_NAMES = {'browser-profile', 'chrome-profile', 'chromium-profile', 'firefox-profile', 'playwright-profile', '.playwright-profile', 'user-data-dir'}
DISKS = {'.qcow2', '.vmdk', '.raw', '.img'}
NOFOLLOW = os.O_NOFOLLOW | os.O_CLOEXEC


def write_new(path, value):
    path = Path(path)
    temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex + '.new')
    try:
        with temporary.open('x') as stream:
            os.chmod(temporary, 0o600)
            json.dump(value, stream, sort_keys=True)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        os.link(temporary, path, follow_symlinks=False)
    finally:
        if temporary.exists():
            temporary.unlink()
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def roots(base):
    return base / 'heavy/managed-runs-v1', base / 'heavy/run-ownership-v1'


def plain_directory(path):
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


def read_record(path, limit=4 * 1024 * 1024):
    fd = os.open(path, os.O_RDONLY | NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            raise ValueError('unsafe ownership record')
        return json.loads(os.read(fd, limit + 1))
    finally:
        os.close(fd)


def registry_directory(base):
    plain_directory(base)
    _, registry = roots(base)
    for folder in (base / 'heavy', registry):
        folder.mkdir(mode=0o700, exist_ok=True)
        plain_directory(folder)
    return registry


@contextmanager
def registry_lock(base):
    registry = registry_directory(base)
    fd = os.open(registry / 'admission.lock', os.O_RDWR | os.O_CREAT | NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode) or os.fstat(fd).st_nlink != 1:
            raise ValueError('unsafe registry lock')
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield registry
    finally:
        os.close(fd)


def birthtime_ns(path):
    """Linux statx ABI: no ctime/mtime substitute, including on unsupported FS."""
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        buf = ctypes.create_string_buffer(256)
        call = libc.statx
        call.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_uint, ctypes.c_void_p]
        call.restype = ctypes.c_int
        if call(-100, os.fsencode(path), 0x100, 0xFFF, buf) != 0:
            return None
        if not struct.unpack_from('=I', buf.raw, 0)[0] & 0x800:
            return None
        seconds, nanos = struct.unpack_from('=qI', buf.raw, 80)
        return seconds * 1_000_000_000 + nanos
    except (AttributeError, OSError, ValueError):
        return None


def release_hashes():
    folder = Path(__file__).resolve().parent
    return {name: hashlib.sha256((folder / name).read_bytes()).hexdigest()
            for name in ('heavy-worker.py', 'heavy-run-trim.py')}


def stage_policy(base):
    """One-time frozen baseline. Read names only; NEVER walks old work trees."""
    with registry_lock(base) as registry:
        info = base.stat()
        baseline = sorted(p.name for p in base.iterdir())
        value = {'version': VERSION, 'base': str(base), 'device': info.st_dev,
                 'inode': info.st_ino, 'baseline_names': baseline,
                 'cutoff_ns': time.time_ns(), 'release': release_hashes()}
        write_new(registry / 'activation.json', value)
        return value


def enable_policy(base):
    # Caller must first prove the RPC and supervisor point at this exact release.
    with registry_lock(base) as registry:
        policy = read_record(registry / 'activation.json')
        if policy['release'] != release_hashes():
            raise ValueError('activation release mismatch')
        digest = hashlib.sha256((registry / 'activation.json').read_bytes()).hexdigest()
        write_new(registry / 'enabled.json', {'activation_sha256': digest})


def active_policy(base):
    _, registry = roots(base)
    try:
        policy = read_record(registry / 'activation.json')
        enabled = read_record(registry / 'enabled.json')
        info = base.stat()
        if (enabled != {'activation_sha256': hashlib.sha256((registry / 'activation.json').read_bytes()).hexdigest()}
                or policy.get('version') != VERSION or policy.get('base') != str(base)
                or (policy.get('device'), policy.get('inode')) != (info.st_dev, info.st_ino)
                or policy.get('release') != release_hashes()
                or not isinstance(policy.get('cutoff_ns'), int)
                or not isinstance(policy.get('baseline_names'), list)
                or any(not isinstance(n, str) or '/' in n or n in ('', '.', '..') for n in policy['baseline_names'])):
            return None
        return policy
    except (OSError, ValueError, KeyError, TypeError):
        return None


def supported(spec=None):
    return (sys.platform == 'linux' and os.environ.get('WIZARD_HEAVY_HOST') == 'forum'
            and (spec is None or 'agent_id' not in spec))


def prepare(base, purpose='ephemeral', disposable=()):
    if not supported():
        raise ValueError('managed trimming is Forum Linux only')
    if purpose not in ('retained', 'ephemeral', 'weekly-launch') or any(s not in SLOTS for s in disposable):
        raise ValueError('invalid run policy')
    with registry_lock(base) as registry:
        runs, _ = roots(base)
        runs.mkdir(mode=0o700, exist_ok=True); plain_directory(runs)
        run_id = uuid.uuid4().hex
        run = runs / run_id; run.mkdir(mode=0o700)
        info = run.stat()
        record = {'version': VERSION, 'run_id': run_id, 'path': str(run), 'mode': 'prepared',
                  'device': info.st_dev, 'inode': info.st_ino, 'uid': info.st_uid,
                  'birthtime_ns': birthtime_ns(run),
                  'created_at': time.time(), 'purpose': purpose, 'disposable': list(SLOTS)}
        # Flags remain API-compatible; all NEW v2 runs get broad classification.
        for name in set(disposable):
            (run / name).mkdir(mode=0o700)
        write_new(run / 'retain.json', {'paths': []})
        write_new(run / 'run-manifest.json', record)
        write_new(registry / (run_id + '.json'), record)
        return record


def record_location(base, cwd):
    runs, registry = roots(base)
    raw = Path(cwd)
    try:
        plain_directory(raw)
        if raw.is_relative_to(runs):
            run_id = raw.relative_to(runs).parts[0]
            if not re.fullmatch('[0-9a-f]{32}', run_id):
                return None
            return runs / run_id, registry / (run_id + '.json')
        relative = raw.relative_to(base)
        if not relative.parts or relative.parts[0] in RESERVED:
            return None
        run = base / relative.parts[0]
        run_id = hashlib.sha256(str(run).encode()).hexdigest()[:32]
        return run, registry / (run_id + '.json')
    except (ValueError, OSError):
        return None


def ownership(base, cwd):
    location = record_location(base, cwd)
    if location is None:
        return None
    run, path = location
    if not path.exists():
        return None
    record = read_record(path)
    # Pre-v2 prepared records are historical and must continue executing untrimmed.
    if record.get('version') != VERSION:
        return None
    plain_directory(run)
    info = run.stat()
    if (record.get('path') != str(run) or (record.get('device'), record.get('inode'), record.get('uid'))
            != (info.st_dev, info.st_ino, info.st_uid)):
        raise ValueError('ownership identity mismatch')
    if record.get('mode') == 'prepared' and record.get('birthtime_ns') is not None:
        if birthtime_ns(run) != record['birthtime_ns']:
            raise ValueError('ownership birthtime mismatch')
    if record.get('mode') == 'automatic':
        policy = active_policy(base)
        if (policy is None or run.name in policy['baseline_names']
                or birthtime_ns(run) != record.get('birthtime_ns')):
            return None
    return run, record


def spec_hash(spec):
    return hashlib.sha256(json.dumps(spec, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def pin_registered_references(registry, spec, job_id):
    """Also pin already-owned roots referenced from another job's argv/cwd.

    This scans only the flat durable registry, never historical work trees.
    Opaque aliases/external links still require explicit declared retention.
    """
    for path in registry.iterdir():
        if not re.fullmatch(r'[0-9a-f]{32}\.json', path.name):
            continue
        record = read_record(path)
        if record.get('version') != VERSION:
            continue
        run = record['path']
        referenced = (spec['cwd'] == run or spec['cwd'].startswith(run + '/') or
                      any(re.search(re.escape(run) + r'(?=/|[\s\"\'\),;]|$)', arg) for arg in spec['argv']))
        if not referenced:
            continue
        first = registry / (record['run_id'] + '.admission.json')
        if not first.exists():
            continue
        admission = read_record(first)
        if admission['job_id'] != job_id or admission['spec_sha256'] != spec_hash(spec):
            retained = registry / (record['run_id'] + '.shared.json')
            if not retained.exists():
                write_new(retained, {'reason': 'multiple_submissions_permanent_retention',
                          'next': {'job_id': job_id, 'spec_sha256': spec_hash(spec), 'reference': 'cwd_or_argv'}})


def admit(base, spec, job_id, raw_cwd=None):
    """Durable admission BEFORE spool insertion; registry flock also fences trim.

    Reuse never rejects normal execution: a second job/spec permanently retains
    the root across BOTH lanes, even if that second submission later fails.
    """
    if not supported(spec):
        return None
    if not re.fullmatch(r'heavy_[0-9a-f]{32}', job_id):
        raise ValueError('invalid job identity')
    with registry_lock(base) as registry:
        pin_registered_references(registry, spec, job_id)
        found = ownership(base, spec['cwd'])
        if found is None:
            if raw_cwd is not None and str(raw_cwd) != spec['cwd']:
                return None  # aliases gain no NEW authority, but must pin existing ownership
            location = record_location(base, spec['cwd'])
            policy = active_policy(base)
            if location is None or policy is None:
                return None
            run, path = location
            # Prepared namespaces and existing records cannot be auto-adopted.
            if run.is_relative_to(roots(base)[0]) or path.exists() or run.name in policy['baseline_names']:
                return None
            info = run.stat(); btime = birthtime_ns(run)
            if info.st_dev != policy['device'] or btime is None or btime <= policy['cutoff_ns']:
                return None
            record = {'version': VERSION, 'run_id': path.stem, 'path': str(run), 'mode': 'automatic',
                      'device': info.st_dev, 'inode': info.st_ino, 'uid': info.st_uid,
                      'birthtime_ns': btime, 'purpose': 'ephemeral', 'created_at': time.time()}
            write_new(path, record)
        else:
            run, record = found
        value = {'job_id': job_id, 'run_id': record['run_id'], 'spec_sha256': spec_hash(spec)}
        first = registry / (record['run_id'] + '.admission.json')
        if first.exists():
            if read_record(first) != value:
                retained = registry / (record['run_id'] + '.shared.json')
                if not retained.exists():
                    write_new(retained, {'reason': 'multiple_submissions_permanent_retention', 'next': value})
        else:
            write_new(first, value)
        per_job = registry / (record['run_id'] + '.' + job_id + '.admission.json')
        if not per_job.exists():
            write_new(per_job, value)
        return record


def lease_fd(base, record):
    _, registry = roots(base)
    fd = os.open(registry / (record['run_id'] + '.lease'), os.O_RDWR | os.O_CREAT | NOFOLLOW, 0o600)
    if not stat.S_ISREG(os.fstat(fd).st_mode) or os.fstat(fd).st_nlink != 1:
        os.close(fd); raise ValueError('unsafe run lease')
    return fd


def run_lease(base, spec):
    if not supported(spec):
        return None
    found = ownership(base, spec['cwd'])
    if found is None:
        return None
    fd = lease_fd(base, found[1])
    fcntl.flock(fd, fcntl.LOCK_SH)
    return fd


def mountpoints():
    def decode(s):
        return re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), s)
    return [Path(decode(line.split()[4])) for line in Path('/proc/self/mountinfo').read_text().splitlines()]


def process_busy(run):
    try:
        probe = subprocess.run(['/usr/bin/sudo', '-n', '--', '/usr/bin/lsof', '-nP', '-F', 'p', '+D', str(run)],
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


def loop_busy(run):
    try:
        probe = subprocess.run(['/usr/bin/sudo', '-n', '--', '/usr/sbin/losetup', '--list', '--json', '--output', 'BACK-FILE'],
                               stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=15)
        if probe.returncode or probe.stderr:
            return True
        rows = json.loads(probe.stdout)['loopdevices']
        if not isinstance(rows, list):
            return True
        for row in rows:
            backing = row['back-file']
            if not isinstance(backing, str) or not backing.startswith('/'):
                return True
            path = Path(backing.removesuffix(' (deleted)'))
            # Read-only canonicalization catches a loop configured via an outside
            # symlink alias. Neither alias nor backing target is ever modified.
            if path.is_relative_to(run) or path.resolve(strict=False).is_relative_to(run):
                return True
        return False
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        return True


def inventory(fd, device, prefix='', limit=250000):
    items = []
    for name in sorted(os.listdir(fd)):
        relative = prefix + name
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if info.st_dev != device:
            raise ValueError('device crossing')
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=fd)
            try:
                if os.fstat(child).st_ino != info.st_ino:
                    raise ValueError('directory changed')
                items.extend(inventory(child, device, relative + '/', limit - len(items)))
            finally:
                os.close(child)
        elif stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            items.append((relative, info))  # links stay; never follow or read
        else:
            raise ValueError('special file')
        if len(items) > limit:
            raise ValueError('inventory limit')
    return items


def read_text_same(fd, relative, expected):
    parent = os.dup(fd); stream = None
    try:
        for name in Path(relative).parts[:-1]:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=parent)
            os.close(parent); parent = child
        stream = os.open(Path(relative).name, os.O_RDONLY | NOFOLLOW, dir_fd=parent)
        current = os.fstat(stream)
        if (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) != (
                expected.st_dev, expected.st_ino, expected.st_size, expected.st_mtime_ns):
            raise ValueError('evidence changed')
        content = os.read(stream, 8 * 1024 * 1024 + 1)
        if len(content) != expected.st_size:
            raise ValueError('evidence changed or oversized')
        return content.decode('utf-8')
    finally:
        if stream is not None:
            os.close(stream)
        os.close(parent)


def unlink_same(fd, relative, expected):
    parts = Path(relative).parts; parent = os.dup(fd)
    try:
        for name in parts[:-1]:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=parent)
            os.close(parent); parent = child
        info = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
        if (info.st_dev, info.st_ino, info.st_nlink, info.st_size, info.st_mtime_ns) != (
                expected.st_dev, expected.st_ino, 1, expected.st_size, expected.st_mtime_ns):
            raise ValueError('file changed')
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('not a regular disposable file')
        os.unlink(parts[-1], dir_fd=parent)
        os.fsync(parent)
    finally:
        os.close(parent)


def evidence_name(relative):
    path = Path(relative)
    return (bool(PROTECTED.search(relative)) or path.suffix.lower() in EVIDENCE_SUFFIXES
            or bool(FORBIDDEN.intersection(path.parts)))


def classified(relative, profiles):
    p = Path(relative); parts = p.parts
    if len(parts) < 2:
        # Root archives/runner scripts stay; explicitly disposable disks do not.
        return p.suffix.lower() in DISKS and 'disposable' in p.name.lower()
    first = parts[0]
    if (first in {'source', 'src', 'candidate', 'baseline', 'checkouts', *SLOTS}
            or re.fullmatch(r'(source|candidate|baseline)-[A-Za-z0-9][A-Za-z0-9._-]*', first)):
        return True
    if 'node_modules' in parts[:-1]:
        return True
    if any(p.is_relative_to(profile) for profile in profiles):
        return True
    return (p.suffix.lower() in DISKS and
            (first in {'guests', 'vms', 'disposable-vms'} or 'disposable' in p.name.lower()))


def retained_paths(fd, items, record):
    retained = []; retain_all = False; references = []; scanned = 0
    for relative, info in items:
        path = Path(relative)
        if path.name in ('RETAIN', '.retain'):
            retain_all = True
        if not stat.S_ISREG(info.st_mode):
            # An evidence symlink cannot be scanned without following it.
            if evidence_name(relative):
                raise ValueError('linked reference evidence')
            continue
        if path.suffix.lower() in TEXT_SUFFIXES:
            scanned += info.st_size
            if info.st_size > 8 * 1024 * 1024 or scanned > 32 * 1024 * 1024:
                raise ValueError('reference scan limit')
            text = read_text_same(fd, relative, info)
            if relative == 'run-manifest.json':
                # Our generated identity is not a published link to all inputs.
                identity = json.loads(text)
                if isinstance(identity, dict) and all(identity.get(key) == value for key, value in record.items()):
                    for key in ('version', 'run_id', 'path', 'mode', 'device', 'inode', 'uid',
                                'created_at', 'purpose', 'disposable', 'birthtime_ns'):
                        identity.pop(key, None)
                    references.append((json.dumps(identity), path.parent))
                else:
                    references.append((text, path.parent))
            else:
                references.append((text, path.parent))
            if path.name == 'retain.json':
                value = json.loads(text); paths = value.get('paths')
                if (not isinstance(paths, list) or any(not isinstance(p, str) or not p
                        or Path(p).is_absolute() or '..' in Path(p).parts for p in paths)):
                    raise ValueError('invalid retain list')
                # retain.json entries always relative to run root, not its parent.
                retained.extend(paths)
            if 'manifest' in path.name.lower() and path.suffix.lower() == '.json':
                value = json.loads(text)
                if isinstance(value, dict) and (value.get('retain') is True or value.get('purpose') in ('retained', 'weekly-launch')):
                    retain_all = True
    # Retained textual evidence can have a nonstandard extension. Mandatory text
    # suffixes above must decode; positively binary types below are never parsed.
    binary_suffixes = (EVIDENCE_SUFFIXES - TEXT_SUFFIXES) | DISKS | {
        '.zip', '.gz', '.tar', '.iso', '.apk', '.aab', '.pdf', '.mp4', '.mp3', '.woff', '.woff2'}
    explicit = {Path(p).as_posix() for p in retained}
    for relative, info in items:
        path = Path(relative)
        declared = any(p.as_posix() in explicit for p in (path, *path.parents))
        if declared and stat.S_ISLNK(info.st_mode):
            raise ValueError('linked retained reference')
        if (not stat.S_ISREG(info.st_mode) or path.suffix.lower() in TEXT_SUFFIXES | binary_suffixes
                or not (evidence_name(relative) or declared)):
            continue
        scanned += info.st_size
        if info.st_size > 8 * 1024 * 1024 or scanned > 32 * 1024 * 1024:
            raise ValueError('reference scan limit')
        try:
            text = read_text_same(fd, relative, info)
        except UnicodeDecodeError:
            continue  # positively binary retained evidence
        if '\x00' not in text:
            references.append((text, path.parent))
            if 'manifest' in path.name.lower():
                try:
                    value = json.loads(text)
                except ValueError:
                    value = None
                if isinstance(value, dict) and value.get('retain') is True:
                    retain_all = True
    return retained, retain_all, references, scanned


def profile_roots(items):
    names = {name for name, _ in items}
    profiles = set()
    # A known directory name PLUS a browser marker, never a generic Default dir.
    for name in names:
        path = Path(name)
        for parent in path.parents:
            if parent.name in PROFILE_NAMES or parent.parent.name == 'profiles':
                markers = ('Local State', 'Default/Preferences', 'Preferences', 'prefs.js', 'compatibility.ini')
                if any((parent / marker).as_posix() in names for marker in markers):
                    profiles.add(parent)
    return profiles


def trim(base, spec, job_id, evidence_paths=()):
    if not supported(spec):
        return None
    # This SAME global lock is held through final unlink. Durable admissions
    # precede both spool inserts; even a queued cross-lane job prevents deletion.
    with registry_lock(base) as registry:
        found = ownership(base, spec['cwd'])
        if found is None:
            return None
        run, record = found; run_id = record['run_id']
        admission = read_record(registry / (run_id + '.admission.json'))
        shared = (registry / (run_id + '.shared.json')).exists()
        per_job = read_record(registry / (run_id + '.' + job_id + '.admission.json'))
        if per_job != {'job_id': job_id, 'run_id': run_id, 'spec_sha256': spec_hash(spec)}:
            raise ValueError('trim admission mismatch')
        if not shared and admission != {'job_id': job_id, 'run_id': run_id, 'spec_sha256': spec_hash(spec)}:
            raise ValueError('trim admission mismatch')
        report_path = registry / (run_id + '.' + job_id + '.trim.json')
        intent = registry / (run_id + '.' + job_id + '.trim-intent.json')
        if report_path.exists() or intent.exists():
            raise ValueError('trim already finalized; no retry')
        report = {'version': VERSION, 'job_id': job_id, 'run_id': run_id, 'policy': 'future-only-broad-bulk',
                  'at': time.time(), 'removed': [], 'bytes_unlinked': 0, 'status': 'retained',
                  'before_logical_bytes': None, 'after_logical_bytes': None}
        fd = os.open(run, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW); lease = None
        try:
            if (os.fstat(fd).st_dev, os.fstat(fd).st_ino) != (record['device'], record['inode']):
                raise ValueError('run replaced')
            lease = lease_fd(base, record); fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            items = inventory(fd, record['device'])
            report['before_logical_bytes'] = sum(i.st_size for _, i in items if stat.S_ISREG(i.st_mode))
            retained, retain_all, references, scanned = retained_paths(fd, items, record)
            if shared:
                report['reason'] = 'multiple_submissions_permanent_retention'
            elif (record['purpose'] != 'ephemeral' or re.search(r'weekly[-_ /]*launch', ' '.join([spec['cwd'], *spec['argv']]), re.I)):
                report['reason'] = 'retained_purpose_or_weekly_launch'
            elif retain_all or any((run / marker).exists() or (run / marker).is_symlink() for marker in ('RETAIN', '.retain')):
                report['reason'] = 'retain_marker_or_manifest'
            elif any(p == run or p.is_relative_to(run) for p in mountpoints()):
                report['reason'] = 'mounted_tree'
            elif process_busy(run):
                report['reason'] = 'process_busy_or_unknown'
            elif loop_busy(run):
                report['reason'] = 'loop_busy_or_unknown'
            else:
                for evidence in evidence_paths:
                    if evidence.exists():
                        info = evidence.lstat()
                        if not stat.S_ISREG(info.st_mode) or info.st_size > 8 * 1024 * 1024:
                            raise ValueError('unsafe external evidence')
                        scanned += info.st_size
                        if scanned > 32 * 1024 * 1024:
                            raise ValueError('reference scan limit')
                        references.append((evidence.read_text(), Path(spec['cwd']).relative_to(run)))
                # Directory references retain descendants, including in native log.
                tokens = set(); linked = set()
                for text, origin in references:
                    local_tokens = set(re.findall(r'[^\s\x00\"\'<>\[\]{},;()=]+', text))
                    tokens.update(local_tokens)
                    for token in local_tokens:
                        token = token.rstrip('.:').removeprefix('file://')
                        if token in ('', '.', '..', '/'):
                            continue
                        path = Path(token)
                        if path.is_absolute():
                            if path.is_relative_to(run):
                                linked.add(path.relative_to(run).as_posix())
                        else:
                            # Both root-relative and document/cwd-relative links.
                            # Lexical normalization only; never follow a link.
                            for parent in (Path('.'), origin):
                                normalized = Path(os.path.normpath(str(parent / path)))
                                if '..' not in normalized.parts and normalized != Path('.'):
                                    linked.add(normalized.as_posix())
                profiles = profile_roots(items); candidates = []
                keep_paths = linked | {Path(p).as_posix() for p in retained}
                for relative, info in items:
                    path = Path(relative)
                    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or evidence_name(relative)
                            or not classified(relative, profiles)
                            or any(p.as_posix() in keep_paths for p in (path, *path.parents))
                            or path.name in tokens):
                        continue
                    candidates.append((relative, info))
                if candidates:
                    write_new(intent, {'run_id': run_id, 'job_id': job_id, 'at': time.time(),
                              'files': [{'path': r, 'device': i.st_dev, 'inode': i.st_ino, 'bytes': i.st_size,
                                         'mtime_ns': i.st_mtime_ns} for r, i in candidates]})
                for relative, info in candidates:
                    unlink_same(fd, relative, info)
                    report['removed'].append({'path': relative, 'bytes': info.st_size})
                    report['bytes_unlinked'] += info.st_size
                report['status'] = 'trimmed' if report['removed'] else 'retained'
                report['reason'] = 'classified_bulk_only'
        except Exception as error:
            report['status'] = 'partial' if report['removed'] else 'skipped'
            report['reason'] = type(error).__name__ + ': ' + str(error)
        finally:
            if report['before_logical_bytes'] is not None:
                try:
                    after_items = inventory(fd, record['device'])
                    report['after_logical_bytes'] = sum(i.st_size for _, i in after_items if stat.S_ISREG(i.st_mode))
                except Exception as error:
                    report['after_observation_error'] = str(error)
            if lease is not None:
                os.close(lease)
            os.close(fd)
        write_new(report_path, report)
        return report
