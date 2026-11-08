#!/usr/bin/env python3
"""Private Android execution on Thales; never publishes or builds on Linux."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unicodedata
import uuid
from contextlib import contextmanager

P = pathlib.Path
BASE = '/Volumes/ThalesMedia/AndroidBuilds'
SDK = '/opt/homebrew/share/android-commandlinetools'
BUILD_TOOLS = P(SDK) / 'build-tools' / '35.0.0'
EXCLUDED = {
    '.git', '.worktrees', '.ui-generations', '.gradle', '.cxx', 'build',
    'node_modules', '.venv', 'venv', '__pycache__', '.dart_tool', '.idea',
    '.secure-build',
}
PRIVATE_PROPERTY_FILES = {'signing.properties', 'key.properties', 'local.properties'}
SHA256 = re.compile(r'[0-9a-f]{64}')


def run(args, **kw):
    return subprocess.run([str(a) for a in args], check=True, **kw)


def digest(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()


def secret_name(name):
    return (
        name in PRIVATE_PROPERTY_FILES
        or name.startswith('.env')
        or name.endswith(('.jks', '.keystore', '.pem', '.p12', '.key', 'signing.env'))
    )


def private_directory(path):
    """Create a user-owned, non-symlink directory with exact private mode."""
    path = P(path)
    path.mkdir(parents=True, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        raise RuntimeError('private directory is not a real directory')
    before = path.stat()
    if before.st_uid != os.getuid():
        raise RuntimeError('private directory is not owned by the current user')
    os.chmod(path, 0o700)
    after = path.stat()
    if after.st_uid != os.getuid() or stat.S_IMODE(after.st_mode) != 0o700:
        raise RuntimeError('could not secure private directory')
    return path


def write_private_json(path, data):
    """Atomically persist a private JSON record without serializing exceptions."""
    path = P(path)
    private_directory(path.parent)
    tmp = path.with_name('.' + path.name + '.tmp-' + uuid.uuid4().hex)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
            f.write('\n')
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        os.chmod(path, 0o600)
    finally:
        if tmp.exists():
            tmp.unlink()


def open_private(path, mode='w'):
    """Open a private ordinary output file; caller owns closing it."""
    path = P(path)
    private_directory(path.parent)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    return os.fdopen(fd, mode, encoding='utf-8')


def normalize_fingerprint(value):
    if not isinstance(value, str):
        raise RuntimeError('expected signer must be a SHA-256 fingerprint')
    normalized = value.replace(':', '').lower()
    if not SHA256.fullmatch(normalized):
        raise RuntimeError('expected signer must be a SHA-256 fingerprint')
    return normalized


def task_requires_apk(tasks):
    """assemble tasks must produce at least one APK, including qualified tasks."""
    return any(task.rsplit(':', 1)[-1].lower().startswith('assemble') for task in tasks)


def expected_signer_from_config(cfg):
    """Use only the controller-pinned signer value, never a remote default."""
    if cfg.get('signing_env'):
        return normalize_fingerprint(cfg.get('expected_signer'))
    if cfg.get('expected_signer') is not None:
        raise RuntimeError('expected signer requires signing environment')
    return None


def write_sdk_local_properties(gradle):
    """Create the sole machine-local Gradle property in the private copy."""
    props = P(gradle) / 'local.properties'
    props.write_text('sdk.dir=' + SDK + '\n')


def snapshot(source, archive):
    manifest = {}
    folded = set()
    with tarfile.open(archive, 'w:gz') as tar:
        for root, dirs, files in os.walk(source, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d not in EXCLUDED and not secret_name(d))
            for name in sorted(dirs + files):
                p = P(root) / name
                rel = p.relative_to(source).as_posix()
                if secret_name(name):
                    continue
                key = unicodedata.normalize('NFC', rel).casefold()
                if key in folded:
                    raise RuntimeError('case-insensitive source collision: ' + rel)
                folded.add(key)
                if p.is_symlink():
                    target = p.resolve()
                    if not target.is_relative_to(source):
                        raise RuntimeError('source symlink escapes snapshot: ' + rel)
                    # Relocate absolute in-tree links into the isolated snapshot.
                    link = os.path.relpath(target, p.parent)
                    info = tar.gettarinfo(str(p), arcname=rel)
                    info.linkname = link
                    tar.addfile(info)
                    manifest[rel] = {'link': link}
                    continue
                if p.is_dir():
                    tar.add(p, arcname=rel, recursive=False)
                    continue
                if not p.is_file():
                    raise RuntimeError('unsupported source entry: ' + rel)
                before = p.stat()
                sha = digest(p)
                tar.add(p, arcname=rel, recursive=False)
                after = p.stat()
                if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                    raise RuntimeError('source changed during snapshot: ' + rel)
                manifest[rel] = {'sha256': sha, 'mode': before.st_mode & 0o777}
    return manifest


def verify_tree(root, manifest):
    for rel, item in manifest.items():
        p = root / rel
        if P(rel).is_absolute() or '..' in P(rel).parts or not p.resolve().is_relative_to(root):
            raise RuntimeError('unsafe manifest path: ' + rel)
        if 'link' in item:
            if not p.is_symlink() or os.readlink(p) != item['link']:
                raise RuntimeError('link mismatch: ' + rel)
        else:
            if not p.is_file() or p.is_symlink() or digest(p) != item['sha256']:
                raise RuntimeError('source mismatch: ' + rel)
            # Python's data filter deliberately strips group write. Restore only
            # ordinary source permission bits after validating exact contents.
            os.chmod(p, item['mode'] & 0o777)
            if p.stat().st_mode & 0o777 != item['mode']:
                raise RuntimeError('mode mismatch: ' + rel)


def apk_metadata(apk, expected_signer):
    """Verify a remote APK and return minimal aapt2 metadata for the receipt."""
    apksigner = BUILD_TOOLS / 'apksigner'
    aapt2 = BUILD_TOOLS / 'aapt2'
    verified = run(
        [apksigner, 'verify', '--verbose', '--print-certs', apk],
        stdout=subprocess.PIPE,
        text=True,
        stderr=subprocess.STDOUT,
    )
    match = re.search(
        r'^Signer #1 certificate SHA-256 digest:\s*([0-9A-Fa-f:]+)\s*$',
        verified.stdout,
        re.MULTILINE,
    )
    if not match:
        raise RuntimeError('apksigner did not report a signer fingerprint')
    signer = normalize_fingerprint(match.group(1))
    if expected_signer is not None and signer != expected_signer:
        raise RuntimeError('APK signer fingerprint mismatch')

    badging = run(
        [aapt2, 'dump', 'badging', apk],
        stdout=subprocess.PIPE,
        text=True,
        stderr=subprocess.STDOUT,
    ).stdout
    package = re.search(
        r"^package:\s+name='([^']*)'(?:\s+versionCode='([^']*)')?(?:\s+versionName='([^']*)')?",
        badging,
        re.MULTILINE,
    )
    if not package:
        raise RuntimeError('aapt2 did not report package metadata')
    metadata = {
        'package': package.group(1),
        'version_code': package.group(2),
        'version_name': package.group(3),
    }
    label = re.search(r"^application-label(?::|-[^:]+:)'([^']*)'", badging, re.MULTILINE)
    if label:
        metadata['application_label'] = label.group(1)
    return signer, metadata


def is_apk_output(gradle, apk):
    parts = apk.relative_to(gradle).parts
    return any(parts[index:index + 3] == ('build', 'outputs', 'apk') for index in range(len(parts) - 2))


def collect_artifacts(source, gradle, tasks, expected_signer):
    artifacts = []
    for apk in sorted(gradle.rglob('*.apk')):
        if not is_apk_output(gradle, apk):
            continue
        signer, metadata = apk_metadata(apk, expected_signer)
        artifacts.append({
            'path': str(apk.relative_to(source)),
            'sha256': digest(apk),
            'bytes': apk.stat().st_size,
            'signer_sha256': signer,
            'aapt2': metadata,
        })
    if task_requires_apk(tasks) and not artifacts:
        raise RuntimeError('assemble task produced no APK artifacts')
    return artifacts


def failure_receipt(job, cfg, phase, host='thales'):
    """A stable, non-secret terminal record for all route failures."""
    return {
        'status': 'failed',
        'host': host,
        'job': str(job),
        'source_revision': cfg.get('revision'),
        'source_manifest_sha256': cfg.get('manifest_sha256'),
        'tasks': cfg.get('tasks', []),
        'phase': phase,
        'error': 'Android build route failed',
    }


@contextmanager
def shared_worker_lock(wait):
    inherited = os.environ.get('WIZARD_HEAVY_LOCK_FD')
    if inherited:
        fd = int(inherited)
        expected = (P(BASE) / 'worker.lock').stat()
        actual = os.fstat(fd)
        if (expected.st_dev, expected.st_ino) != (actual.st_dev, actual.st_ino):
            raise RuntimeError('inherited lock identity mismatch')
        # Same open file description already owns the exclusive lease.
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    else:
        with (P(BASE) / 'worker.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX if wait else (fcntl.LOCK_EX | fcntl.LOCK_NB))
            yield


def worker(config_path):
    job = P(config_path).parent
    cfg = {}
    try:
        if sys.platform != 'darwin':
            raise RuntimeError('Android worker requires Thales/macOS')
        cfg = json.loads(P(config_path).read_text())
        if not job.resolve().is_relative_to(P(BASE)):
            raise RuntimeError('job outside worker root')
        expected_signer = expected_signer_from_config(cfg)
        with shared_worker_lock(cfg.get('wait_for_lock')):
            if shutil.disk_usage(BASE).free < 20 * 1024 ** 3:
                raise RuntimeError('Thales has insufficient scratch headroom')
            source = private_directory(job / 'source')
            with tarfile.open(job / 'source.tar.gz') as tar:
                tar.extractall(source, filter='data')
            verify_tree(source, cfg['files'])
            gradle = (source / cfg['gradle_dir']).resolve()
            if not gradle.is_relative_to(source) or not (gradle / 'gradlew').is_file():
                raise RuntimeError('invalid Gradle root')
            env = os.environ.copy()
            env.update(
                JAVA_HOME='/opt/homebrew/opt/openjdk@' + cfg['java'] + '/libexec/openjdk.jdk/Contents/Home',
                ANDROID_HOME=SDK,
                ANDROID_SDK_ROOT=SDK,
                GRADLE_USER_HOME=BASE + '/gradle-cache',
                ANDROID_USER_HOME=str(private_directory(job / 'android-user')),
            )
            env['PATH'] = env['JAVA_HOME'] + '/bin:/opt/homebrew/bin:/usr/local/bin:' + env['PATH']
            # No source local.properties reaches Thales. This worker is the sole
            # authority for the SDK location in its private build copy.
            write_sdk_local_properties(gradle)
            if cfg['cap_sync']:
                run(['npm', 'ci', '--no-audit', '--no-fund'], cwd=source, env=env)
                run(['./node_modules/.bin/cap', 'sync', 'android'], cwd=source, env=env)
            command = ['./gradlew', '--no-daemon', '--console=plain', *cfg['tasks']]
            if cfg['signing_env']:
                signing = P(cfg['signing_env'])
                if not signing.is_file() or signing.stat().st_mode & 0o077:
                    raise RuntimeError('signing environment missing or not private')
                script = 'set -eu; set -a; . ' + shlex.quote(str(signing)) + '; set +a; exec ' + shlex.join(command)
                command = ['/bin/bash', '-c', script]
            run(command, cwd=gradle, env=env)
            os.environ.update({k:env[k] for k in ('JAVA_HOME','PATH')})
            artifacts = collect_artifacts(source, gradle, cfg['tasks'], expected_signer)
            receipt = {
                'status': 'ok',
                'host': 'thales',
                'job': str(job),
                'source_revision': cfg['revision'],
                'source_manifest_sha256': cfg['manifest_sha256'],
                'tasks': cfg['tasks'],
                'artifacts': artifacts,
            }
            write_private_json(job / 'receipt.json', receipt)
            print(json.dumps(receipt), flush=True)
    except Exception:
        # Do not serialize an exception or subprocess output: either can contain
        # signing-environment values. A terminal receipt remains available.
        try:
            write_private_json(job / 'receipt.json', failure_receipt(job, cfg, 'worker'))
        except Exception:
            pass
        raise RuntimeError('Android worker failed') from None


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--worker':
        return worker(sys.argv[2])
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--project', type=P, required=True)
    ap.add_argument('--gradle-dir', default='.')
    ap.add_argument('--cap-sync', action='store_true')
    ap.add_argument('--signing-env')
    ap.add_argument('--expected-signer')
    ap.add_argument('--java', choices=['17', '21'], default='21')
    ap.add_argument('--wait-for-lock', action='store_true', help='Queue behind the shared Thales worker lease; default is fail-fast')
    ap.add_argument('--prepare-only', action='store_true', help='Stage source and return a durable remote command; submit it through wizard_heavy_submit instead of waiting here')
    ap.add_argument('--output', type=P, required=True)
    ap.add_argument('tasks', nargs=argparse.REMAINDER)
    a = ap.parse_args()
    source = a.project.resolve()
    tasks = a.tasks
    if tasks and tasks[0] == '--':
        tasks = tasks[1:]
    if not tasks or any(t.startswith('-') for t in tasks):
        ap.error('supply explicit Gradle tasks, no options')
    if P(a.gradle_dir).is_absolute() or '..' in P(a.gradle_dir).parts:
        ap.error('Gradle directory must be relative')
    if not (source / a.gradle_dir / 'gradlew').is_file():
        ap.error('Gradle wrapper missing')
    if bool(a.signing_env) != bool(a.expected_signer):
        ap.error('--signing-env and --expected-signer must be supplied together')
    if a.expected_signer:
        try:
            expected_signer = normalize_fingerprint(a.expected_signer)
        except RuntimeError as exc:
            ap.error(str(exc))
    else:
        expected_signer = None

    output = a.output.resolve()
    if output.is_relative_to(source):
        ap.error('output must be outside source')
    private_directory(output)
    if any(output.iterdir()):
        ap.error('output must be empty')
    os.umask(0o077)
    job = BASE + '/jobs/' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
    cfg = {
        'java': a.java,
        'gradle_dir': a.gradle_dir,
        'tasks': tasks,
        'wait_for_lock': a.wait_for_lock,
        'cap_sync': a.cap_sync,
        'signing_env': a.signing_env,
        'expected_signer': expected_signer,
        'files': {},
        'revision': None,
        'manifest_sha256': None,
    }
    phase = 'preflight'
    ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', 'thales']
    try:
        # Connection preflight before any bulk local staging. No VPS execution fallback.
        run(ssh + ['test -d /Volumes/ThalesMedia && test -x ' + SDK + '/platform-tools/adb && test -x ' + str(BUILD_TOOLS / 'apksigner') + ' && test -x ' + str(BUILD_TOOLS / 'aapt2')])
        tmpbase = private_directory(P.home() / '.hermes/cache/scratch')
        phase = 'snapshot'
        with tempfile.TemporaryDirectory(prefix='android-thales-', dir=tmpbase) as td:
            stage = private_directory(td)
            manifest = snapshot(source, stage / 'source.tar.gz')
            rev = subprocess.run(['git', '-C', str(source), 'rev-parse', 'HEAD'], capture_output=True, text=True)
            cfg.update(
                files=manifest,
                revision=rev.stdout.strip() if rev.returncode == 0 else None,
                manifest_sha256=hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest(),
            )
            write_private_json(stage / 'job.json', cfg)
            shutil.copy2(__file__, stage / 'worker.py')
            os.chmod(stage / 'worker.py', 0o600)
            write_private_json(output / 'source-manifest.json', cfg)
            write_private_json(output / 'job.json', {'host': 'thales', 'job': job, 'status': 'started', 'phase': 'remote-stage'})
            phase = 'remote-stage'
            remote_prepare = (
                'set -eu; umask 077; mkdir -p ' + shlex.quote(BASE + '/jobs') + '; '
                'test -O ' + shlex.quote(BASE + '/jobs') + '; '
                'chmod 700 ' + shlex.quote(BASE + '/jobs') + '; '
                'test "$(stat -f %Lp ' + shlex.quote(BASE + '/jobs') + ')" = 700; '
                'mkdir -m 700 ' + shlex.quote(job) + '; '
                'test -O ' + shlex.quote(job) + '; '
                'test "$(stat -f %Lp ' + shlex.quote(job) + ')" = 700'
            )
            run(ssh + [remote_prepare])
            phase = 'source-copy'
            run(['scp', '-q', stage / 'source.tar.gz', stage / 'job.json', stage / 'worker.py', 'thales:' + job + '/'])
            if a.prepare_only:
                prepared = {'host': 'thales', 'job': job, 'status': 'prepared',
                            'cwd': job, 'argv': ['/opt/homebrew/bin/python3', job + '/worker.py', '--worker', job + '/job.json'],
                            'source_revision': cfg['revision'], 'source_manifest_sha256': cfg['manifest_sha256'],
                            'receipt_path': job + '/receipt.json'}
                write_private_json(output / 'job.json', prepared)
                print(json.dumps(prepared, indent=2))
                return
            phase = 'build'
            with open_private(output / 'build.log') as log:
                run(ssh + ['/opt/homebrew/bin/python3 ' + shlex.quote(job + '/worker.py') + ' --worker ' + shlex.quote(job + '/job.json')], stdout=log, stderr=subprocess.STDOUT)
            phase = 'receipt-copy'
            run(['scp', '-q', 'thales:' + job + '/receipt.json', output / 'receipt.json'])
            os.chmod(output / 'receipt.json', 0o600)
            receipt = json.loads((output / 'receipt.json').read_text())
            if receipt.get('status') != 'ok' or receipt['host'] != 'thales' or receipt['job'] != job or receipt['source_manifest_sha256'] != cfg['manifest_sha256']:
                raise RuntimeError('receipt identity mismatch')
            if task_requires_apk(tasks) and not receipt.get('artifacts'):
                raise RuntimeError('assemble receipt missing artifacts')
            phase = 'artifact-copy'
            for artifact in receipt['artifacts']:
                rel = P(artifact['path'])
                if rel.is_absolute() or '..' in rel.parts:
                    raise RuntimeError('invalid artifact path')
                dest = output / 'artifacts' / rel
                private_directory(dest.parent)
                run(['scp', '-q', 'thales:' + job + '/source/' + rel.as_posix(), dest])
                os.chmod(dest, 0o600)
                if digest(dest) != artifact['sha256'] or dest.stat().st_size != artifact['bytes']:
                    raise RuntimeError('artifact transfer mismatch')
            write_private_json(output / 'job.json', {'host': 'thales', 'job': job, 'status': 'ok', 'phase': 'complete'})
            print(json.dumps(receipt, indent=2))
    except Exception:
        # Persist a terminal, redactable local result for remote/build/copy failures.
        write_private_json(output / 'job.json', {'host': 'thales', 'job': job, 'status': 'failed', 'phase': phase})
        write_private_json(output / 'receipt.json', failure_receipt(job, cfg, phase))
        raise RuntimeError('Android build route failed during ' + phase) from None


if __name__ == '__main__':
    main()
