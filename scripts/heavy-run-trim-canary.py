#!/usr/bin/env python3
"""Parent-only native light canary. No production policy/configuration changes.

The existing stage itself is NEVER trim-eligible. A one-shot new runtime inside
it models a fresh /srv/work, baseline epoch and subsequent future top-level cwd.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--stage', required=True, type=Path)
    stage = parser.parse_args().stage.resolve(strict=True)
    source = Path(__file__).resolve().parents[1]
    if os.environ.get('WIZARD_WORKER_LANE') != 'light':
        raise SystemExit('native light-lane admission required')
    os.fstat(int(os.environ['WIZARD_HEAVY_LOCK_FD']))
    manifest = json.loads((stage / 'staged-hashes.json').read_text())
    for name, digest in manifest['files'].items():
        assert hashlib.sha256((source / name).read_bytes()).hexdigest() == digest, name
    runtime = stage / 'runtime'; runtime.mkdir(mode=0o700, exist_ok=False)
    evidence = stage / 'evidence'; evidence.mkdir(mode=0o700, exist_ok=False)
    scratch = runtime / 'test-tmp'; scratch.mkdir()
    env = {**os.environ, 'WIZARD_HEAVY_ROOT': str(runtime), 'WIZARD_HEAVY_HOST': 'forum',
           'TMPDIR': str(scratch), 'PYTHONDONTWRITEBYTECODE': '1'}
    suites = ('tests/heavy-worker-trim.unit.py', 'tests/heavy-run-rollout.unit.py',
              'tests/test_heavy_worker_sandbox.py', 'tests/heavy-worker.remote.py')
    for name in suites:
        with (evidence / (Path(name).name + '.log')).open('xb') as stream:
            result = subprocess.run([sys.executable, str(source / name)], env=env,
                                    stdout=stream, stderr=subprocess.STDOUT, timeout=300)
        assert result.returncode == 0, name
    trim = load('trim_canary', source / 'scripts/heavy-run-trim.py')
    fixture = load('trim_fixture', source / 'scripts/heavy-run-trim-fixture.py')
    os.environ.update({'WIZARD_HEAVY_ROOT': str(runtime), 'WIZARD_HEAVY_HOST': 'forum'})
    # Baseline is captured once, before creating any eligible fixture runs.
    legacy = runtime / 'old-top'; legacy.mkdir()
    (legacy / 'source').mkdir(); (legacy / 'source/old.py').write_bytes(b'frozen legacy bytes')
    legacy_before = hashlib.sha256((legacy / 'source/old.py').read_bytes()).hexdigest()
    policy = trim.stage_policy(runtime); trim.enable_policy(runtime)
    time.sleep(.05)  # synthetic fixture clears coarse filesystem birthtime tick
    (evidence / 'fixture-activation.json').write_text(json.dumps(policy, indent=2))
    spool, lock = runtime / 'spool', runtime / 'worker.lock'
    command = [sys.executable, str(source / 'scripts/heavy-worker.py'), '--root', str(spool), '--lock', str(lock)]

    def rpc(action, job, spec=None):
        value = {'action': action, 'job_id': job}
        if spec is not None: value['spec'] = spec
        result = subprocess.run(command, input=json.dumps(value), env=env, capture_output=True, text=True, timeout=90)
        assert result.returncode == 0, result.stdout + result.stderr
        return json.loads(result.stdout)

    def wait(job, predicate):
        deadline = time.monotonic() + 90; row = None
        while time.monotonic() < deadline:
            row = rpc('status', job)
            if predicate(row): return row
            time.sleep(0.1)
        raise AssertionError(f'job did not settle: {job}: {row}')

    def report_for(record, job):
        path = trim.roots(runtime)[1] / (record['run_id'] + '.' + job + '.trim.json')
        deadline = time.monotonic() + 80
        while not path.exists() and time.monotonic() < deadline: time.sleep(0.1)
        return json.loads(path.read_text())

    def check_evidence(run, seeded):
        for name, digest in seeded['retained_sha256'].items():
            assert hashlib.sha256((run / name).read_bytes()).hexdigest() == digest, name

    lifecycle = []
    for lane, purpose, code in [('light', 'automatic', 0), ('heavy', 'automatic', 7),
                                 ('light', 'ephemeral', 0), ('light', 'weekly-launch', 0),
                                 ('light', 'retained', 0)]:
        if purpose == 'automatic':
            run = runtime / ('fresh-' + uuid.uuid4().hex); run.mkdir()
            record = None
        else:
            record = trim.prepare(runtime, purpose); run = Path(record['path'])
        seeded = fixture.seed(run, bytes_per_file=2 * 1024 * 1024)  # 40 MiB real bulk per case
        job = 'heavy_' + uuid.uuid4().hex
        spec = {'cwd': str(run), 'argv': [sys.executable, '-c', f"print('published source/published.bin'); raise SystemExit({code})"],
                'timeout_seconds': 30, 'host': 'forum', 'lane': lane}
        raw_spec_hash = trim.spec_hash(spec)
        submission = rpc('submit', job, spec)
        if record is None:
            found = trim.ownership(runtime, str(run)); assert found is not None
            record = found[1]
            assert record['mode'] == 'automatic' and record['birthtime_ns'] > policy['cutoff_ns']
        (evidence / (job + '.submission.json')).write_text(json.dumps(submission, sort_keys=True))
        row = wait(job, lambda r: r['state'] in ('completed', 'failed'))
        report = report_for(record, job)
        expected = 'retained' if purpose in ('weekly-launch', 'retained') else 'trimmed'
        assert report['status'] == expected, report
        assert row['receipt']['exit_code'] == code and row['receipt']['spec_sha256'] == raw_spec_hash, row
        assert report['before_logical_bytes'] > 40 * 1024 * 1024
        assert report['before_logical_bytes'] - report['after_logical_bytes'] == report['bytes_unlinked']
        assert all((run / p).exists() == (expected != 'trimmed') for p in seeded['bulk']), report
        if expected == 'trimmed': assert report['bytes_unlinked'] >= 40 * 1024 * 1024, report
        check_evidence(run, seeded)
        assert hashlib.sha256(Path(row['receipt']['log_path']).read_bytes()).hexdigest() == row['receipt']['log_sha256']
        assert rpc('submit', job, spec) == row  # duplicate never executes/rewrites result
        assert rpc('status', job) == row
        (evidence / (job + '.receipt.json')).write_text(json.dumps(row, indent=2, sort_keys=True))
        lifecycle.append({'job_id': job, 'lane': lane, 'purpose': purpose, 'receipt': row,
                          'report': report, 'seed': seeded})

    # Cross-lane reuse while the first job is RUNNING must succeed and retain.
    shared = runtime / 'fresh-shared'; shared.mkdir(); seeded = fixture.seed(shared, bytes_per_file=128)
    gate = evidence / 'shared-release'
    first, second = ['heavy_' + uuid.uuid4().hex for _ in range(2)]
    shared_spec = {'cwd': str(shared), 'argv': [sys.executable, '-c',
        "import pathlib,time; p=pathlib.Path(" + repr(str(gate)) + "); print('running',flush=True)\nwhile not p.exists(): time.sleep(.05)"],
        'timeout_seconds': 30, 'host': 'forum', 'lane': 'light'}
    rpc('submit', first, shared_spec); wait(first, lambda r: r['state'] == 'running')
    next_spec = {**shared_spec, 'argv': ['/usr/bin/true'], 'lane': 'heavy'}
    rpc('submit', second, next_spec)
    assert all((shared / p).exists() for p in seeded['bulk'])
    gate.touch()
    shared_record = trim.ownership(runtime, str(shared))[1]
    shared_reports = []
    for job in (first, second):
        wait(job, lambda r: r['state'] == 'completed')
        report = report_for(shared_record, job)
        assert report['reason'] == 'multiple_submissions_permanent_retention', report
        shared_reports.append(report)
    assert all((shared / p).exists() for p in seeded['bulk']); check_evidence(shared, seeded)

    # Old top-level children remain unowned even if newly created after epoch.
    (legacy / 'new-child').mkdir()
    legacy_job = 'heavy_' + uuid.uuid4().hex
    legacy_spec = {'cwd': str(legacy / 'new-child'), 'argv': ['/usr/bin/true'], 'timeout_seconds': 10, 'host': 'forum', 'lane': 'light'}
    rpc('submit', legacy_job, legacy_spec); wait(legacy_job, lambda r: r['state'] == 'completed')
    assert trim.ownership(runtime, legacy_spec['cwd']) is None
    assert hashlib.sha256((legacy / 'source/old.py').read_bytes()).hexdigest() == legacy_before

    # Unrelated fixture process with cwd/fd must veto deletion. No discovered PID
    # is killed: this canary owns and terminates only its exact Popen child.
    busy = runtime / 'fresh-busy'; busy.mkdir(); (busy / 'build').mkdir()
    obj = busy / 'build/a.o'; obj.write_bytes(b'busy bulk')
    child = subprocess.Popen([sys.executable, '-c',
        "import pathlib,time; f=open('build/a.o'); pathlib.Path('ready').touch(); time.sleep(60)"],
        cwd=busy, env=env, start_new_session=True)
    try:
        deadline = time.monotonic() + 10
        while not (busy / 'ready').exists() and time.monotonic() < deadline: time.sleep(.02)
        assert (busy / 'ready').exists() and trim.process_busy(busy)
        job = 'heavy_' + uuid.uuid4().hex
        spec = {'cwd': str(busy), 'argv': ['/usr/bin/true'], 'timeout_seconds': 10, 'host': 'forum'}
        trim.admit(runtime, spec, job)
        busy_report = trim.trim(runtime, spec, job)
        assert busy_report['reason'] == 'process_busy_or_unknown' and obj.exists(), busy_report
    finally:
        child.kill(); child.wait(timeout=5)
    assert not trim.process_busy(busy), 'cannot certify idle with current lsof permissions/diagnostics'
    assert not trim.loop_busy(busy), 'cannot certify idle loop state with existing permissions'

    summary = {'source_commit': manifest['source_commit'], 'files': manifest['files'], 'lifecycle': lifecycle,
               'shared_reports': shared_reports, 'busy_report': busy_report,
               'synthetic_legacy_sha256': legacy_before, 'production_activation': False,
               'existing_stage_trimmed': False, 'native_admission': 'light', 'passed': True}
    (evidence / 'summary.json').write_text(json.dumps(summary, indent=2, sort_keys=True))
    print(json.dumps(summary, sort_keys=True), flush=True)


if __name__ == '__main__':
    main()
