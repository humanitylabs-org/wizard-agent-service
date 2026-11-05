#!/usr/bin/env python3
"""Parent-admitted REAL native light-lane canary; never run via direct SSH.

All RPC process fixtures use isolated spools/locks under this new staging root.
No production configuration, spool, old work directory or task state is changed.
Every generated result/log/run stays in this canary root for independent review.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', required=True, type=Path)
    args = parser.parse_args()
    stage = args.stage.resolve(strict=True)
    source = Path(__file__).resolve().parents[1]
    # Require native light admission, but do not borrow or reacquire its lock.
    if os.environ.get('WIZARD_WORKER_LANE') != 'light':
        raise SystemExit('native light-lane admission required')
    fd = int(os.environ['WIZARD_HEAVY_LOCK_FD'])
    os.fstat(fd)
    manifest = json.loads((stage / 'staged-hashes.json').read_text())
    for name, digest in manifest['files'].items():
        assert hashlib.sha256((source / name).read_bytes()).hexdigest() == digest, name
    runtime = stage / 'runtime'
    runtime.mkdir(mode=0o700, exist_ok=False)  # new one-shot canary only
    evidence = stage / 'evidence'
    evidence.mkdir(mode=0o700, exist_ok=False)
    scratch = runtime / 'test-tmp'; scratch.mkdir()
    env = {**os.environ, 'WIZARD_HEAVY_ROOT': str(runtime), 'WIZARD_HEAVY_HOST': 'forum',
           'TMPDIR': str(scratch), 'PYTHONDONTWRITEBYTECODE': '1'}
    for name in ('tests/heavy-worker-trim.unit.py', 'tests/test_heavy_worker_sandbox.py', 'tests/heavy-worker.remote.py'):
        log = evidence / (Path(name).name + '.log')
        with log.open('xb') as stream:
            result = subprocess.run([sys.executable, str(source / name)], env=env,
                                    stdout=stream, stderr=subprocess.STDOUT, timeout=300)
        assert result.returncode == 0, f'{name}: see {log}'
    worker = source / 'scripts/heavy-worker.py'
    spool, lock = runtime / 'spool', runtime / 'worker.lock'
    command = [sys.executable, str(worker), '--root', str(spool), '--lock', str(lock)]

    def rpc(action, job, spec=None, success=True):
        value = {'action': action, 'job_id': job}
        if spec is not None:
            value['spec'] = spec
        result = subprocess.run(command, input=json.dumps(value), env=env,
                                capture_output=True, text=True, timeout=15)
        assert (result.returncode == 0) == success, result.stdout + result.stderr
        return json.loads(result.stdout)

    def wait(job, predicate):
        deadline = time.monotonic() + 50
        row = None
        while time.monotonic() < deadline:
            row = rpc('status', job)
            if predicate(row):
                return row
            time.sleep(0.1)
        raise AssertionError(f'job did not settle: {job}: {row}')

    def prepare(purpose='ephemeral'):
        result = subprocess.run(command + ['--prepare-run', '--run-purpose', purpose,
                                           '--disposable', 'build', '--disposable', 'cache'],
                                env=env, capture_output=True, text=True, timeout=15, check=True)
        return json.loads(result.stdout)

    lifecycle = []
    for lane, purpose, code, expected in (
            ('light', 'ephemeral', 0, 'trimmed'), ('heavy', 'ephemeral', 7, 'trimmed'),
            ('light', 'weekly-launch', 0, 'retained'), ('light', 'retained', 0, 'retained')):
        record = prepare(purpose); run = Path(record['path'])
        obj = run / 'build/disposable.o'; obj.write_bytes(b'bulk' * 1024)
        evidence_files = {}
        for name in ('results.json', 'evidence.json', 'manifest.json', 'receipt.json',
                     'submission.json', 'admission.json', 'preflight.json', 'run.log', 'screenshot.png'):
            target = run / 'build' / name
            target.write_bytes(b'preserved evidence\n')
            evidence_files[str(target)] = hashlib.sha256(target.read_bytes()).hexdigest()
        (run / 'build/unknown.bin').write_bytes(b'unknown retained')
        job = 'heavy_' + uuid.uuid4().hex
        spec = {'cwd': str(run), 'argv': [sys.executable, '-c', f"print('lifecycle done'); raise SystemExit({code})"],
                'timeout_seconds': 30, 'lane': lane, 'host': 'forum'}
        submission = rpc('submit', job, spec)
        (evidence / (job + '.submission.json')).write_text(json.dumps(submission, sort_keys=True))
        row = wait(job, lambda row: row['state'] in ('completed', 'failed'))
        assert row['receipt']['exit_code'] == code, row
        report_path = runtime / 'heavy/run-ownership-v1' / (record['run_id'] + '.' + job + '.trim.json')
        deadline = time.monotonic() + 40
        while not report_path.exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        report = json.loads(report_path.read_text())
        assert report['status'] == expected, report
        assert obj.exists() == (expected != 'trimmed'), report
        assert (run / 'build/unknown.bin').read_bytes() == b'unknown retained'
        for name, digest in evidence_files.items():
            assert hashlib.sha256(Path(name).read_bytes()).hexdigest() == digest, name
        assert hashlib.sha256(Path(row['receipt']['log_path']).read_bytes()).hexdigest() == row['receipt']['log_sha256']
        assert rpc('submit', job, spec) == row  # no reexecution on duplicate
        different = 'heavy_' + uuid.uuid4().hex
        rpc('submit', different, spec, success=False)  # no queued cross-job/cross-lane run reuse
        assert rpc('status', different) is None
        assert rpc('status', job) == row  # cleanup did not rewrite native result
        (evidence / (job + '.receipt.json')).write_text(json.dumps(row, sort_keys=True))
        lifecycle.append({'job_id': job, 'lane': lane, 'purpose': purpose, 'receipt': row,
                          'trim_report': str(report_path), 'evidence_sha256': evidence_files})

    # Real read-only root-aware process probe: an unrelated (same-owner) escaped
    # session with cwd+fd inside a NEW run must prevent trimming; never kill a
    # discovered PID, only the exact Popen child created here.
    module_spec = importlib.util.spec_from_file_location('trim_canary', source / 'scripts/heavy-run-trim.py')
    assert module_spec is not None and module_spec.loader is not None
    trim = importlib.util.module_from_spec(module_spec); module_spec.loader.exec_module(trim)
    os.environ.update({'WIZARD_HEAVY_ROOT': str(runtime), 'WIZARD_HEAVY_HOST': 'forum'})
    record = prepare(); run = Path(record['path'])
    obj = run / 'build/busy.o'; obj.write_text('active object')
    child = subprocess.Popen([sys.executable, '-c', "import pathlib,time; f=open('build/busy.o'); pathlib.Path('ready').touch(); time.sleep(60)"],
                             cwd=run, env=env, start_new_session=True)
    try:
        deadline = time.monotonic() + 5
        while not (run / 'ready').exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert (run / 'ready').exists()
        assert trim.process_busy(run), 'root-aware lsof missed active cwd/fd'
        job = 'heavy_' + uuid.uuid4().hex
        spec = {'cwd': str(run), 'argv': ['/usr/bin/true'], 'timeout_seconds': 10, 'host': 'forum'}
        trim.admit(runtime, spec, job)
        report = trim.trim(runtime, spec, job)
        assert report['reason'] == 'process_busy_or_unknown' and obj.exists(), report
    finally:
        child.kill(); child.wait(timeout=5)
    # Verify successful release without doing a later sweep/retry on that run.
    assert not trim.process_busy(run), 'root-aware lsof cannot certify idle run'

    summary = {'source_commit': manifest['source_commit'], 'files': manifest['files'],
               'lifecycle': lifecycle, 'escaped_process_report': report,
               'legacy_directories_touched': False, 'production_activation': False,
               'native_admission': 'light', 'passed': True}
    (evidence / 'summary.json').write_text(json.dumps(summary, indent=2, sort_keys=True))
    print(json.dumps(summary, sort_keys=True), flush=True)


if __name__ == '__main__':
    main()
