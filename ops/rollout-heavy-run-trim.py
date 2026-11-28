#!/usr/bin/env python3
"""Parent-reviewed idle-window rollout coordinator; default is READ-ONLY CHECK.

Run on Forum, with an explicit audited pointer/gate adapter plan. Does not guess
where remote RPC configuration lives. Adapters use argv (never shell), exact
setting compare-and-swap, and return no secrets. See resource-lanes.md contract.
No production plan is supplied: persistent RPC owner mapping must be resolved.
"""
import argparse
from contextlib import ExitStack
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess


def load_trim(source):
    spec = importlib.util.spec_from_file_location('rollout_trim', source / 'heavy-run-trim.py')
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def spools(root):
    return (root, root / 'light', root / 'agent-sandbox-v1', root / 'agent-sandbox-v1/light')


def verify_idle(root):
    for spool in spools(root):
        path = spool / 'jobs.sqlite3'
        if not path.exists(): continue
        db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=3)
        try:
            busy = db.execute("SELECT id,state FROM jobs WHERE state NOT IN ('completed','failed','cancelled','interrupted')").fetchall()
            if busy: raise RuntimeError('old spool is not idle: ' + str(busy))
        finally:
            db.close()


def command(argv, payload=None):
    if (not isinstance(argv, list) or not argv or any(not isinstance(a, str) or not a or '\x00' in a for a in argv)
            or not Path(argv[0]).is_absolute()):
        raise ValueError('adapter must be explicit absolute executable argv')
    result = subprocess.run(argv, input=json.dumps(payload) if payload is not None else '',
                            capture_output=True, text=True, timeout=45, check=True)
    if result.stderr: raise RuntimeError('adapter diagnostics; stop for review')
    return json.loads(result.stdout)


def validate(plan):
    for field in ('base', 'spool', 'lock', 'source_scripts', 'release_dir', 'audit_dir'):
        value = Path(plan[field])
        if not value.is_absolute() or '..' in value.parts or value.resolve(strict=False) != value:
            raise ValueError('noncanonical or linked plan path')
    base = Path(plan['base'])
    for key in ('spool', 'lock', 'release_dir', 'audit_dir'):
        if not Path(plan[key]).is_relative_to(base / 'heavy'): raise ValueError('operator state must remain under heavy')
    for key in ('pause', 'gate_read', 'resume'):
        if key not in plan['adapters']: raise ValueError('missing gate adapter')
    for key in ('rpc', 'supervisor'):
        if set(plan['adapters'][key]) != {'read', 'set', 'reload', 'attest'}:
            raise ValueError('incomplete exact-setting adapter')
    if set(plan['release_hashes']) != {'heavy-worker.py', 'heavy-run-trim.py'}:
        raise ValueError('incomplete sealed worker pair')


def rollout(plan, apply=False):
    validate(plan)
    base, spool = Path(plan['base']), Path(plan['spool'])
    source, release = Path(plan['source_scripts']), Path(plan['release_dir'])
    trim = load_trim(source); trim.plain_directory(base); trim.plain_directory(source)
    if not trim.supported(): raise ValueError('Forum Linux rollout only')
    actual = {name: hashlib.sha256((source / name).read_bytes()).hexdigest() for name in plan['release_hashes']}
    if actual != plan['release_hashes']: raise ValueError('source seal mismatch')
    verify_idle(spool)  # FIRST, before even pausing upstream admission
    adapters = plan['adapters']
    before = {key: command(adapters[key]['read']) for key in ('rpc', 'supervisor')}
    if any(set(value) != {'target'} or not isinstance(value['target'], str) for value in before.values()):
        raise ValueError('pointer adapter must expose only exact target')
    if not apply:
        return {'checked': True, 'applied': False, 'before': before, 'release_hashes': actual}
    if release.exists(): raise ValueError('release destination must be NEW')
    registry = trim.roots(base)[1]
    if (registry / 'activation.json').exists(): raise ValueError('one-time policy already exists; manual recovery required')
    audit = Path(plan['audit_dir']); audit.mkdir(mode=0o700, parents=True, exist_ok=False)
    trim.write_new(audit / 'plan.json', plan); trim.write_new(audit / 'before.json', before)
    changed = []
    command(adapters['pause'])
    if command(adapters['gate_read']) != {'paused': True}: raise RuntimeError('admission gate not closed')
    with ExitStack() as locks:
        # No process signals, resource-limit changes or global permission edits.
        # Existing exec/resource locks must be free; never wait out active jobs.
        paths = [Path(plan['lock']), spool / 'light/packaging.lock']
        paths += [p / 'dispatcher.lock' for p in spools(spool)]
        for path in paths:
            if not path.exists(): continue
            stream = locks.enter_context(path.open('r'))
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        verify_idle(spool)
        policy = trim.stage_policy(base)  # baseline names and cutoff, never walks old roots
        trim.write_new(audit / 'baseline.json', policy)
        release.mkdir(parents=True, mode=0o700, exist_ok=False)
        for name, digest in actual.items():
            shutil.copyfile(source / name, release / name)
            if hashlib.sha256((release / name).read_bytes()).hexdigest() != digest: raise ValueError('release copy mismatch')
        target = str(release / 'heavy-worker.py')
        try:
            for key in ('rpc', 'supervisor'):
                if command(adapters[key]['read']) != before[key]: raise RuntimeError('pointer changed concurrently')
                # Log intent FIRST so ambiguous update failures are included in rollback.
                changed.append(key)
                command(adapters[key]['set'], {'expected': before[key]['target'], 'target': target})
                if command(adapters[key]['read']) != {'target': target}: raise RuntimeError('pointer readback mismatch')
                command(adapters[key]['reload'])
            for key in ('rpc', 'supervisor'):
                if command(adapters[key]['attest']) != {'target': target, 'release_hashes': actual}:
                    raise RuntimeError('effective running release mismatch: ' + key)
            verify_idle(spool)
            if command(adapters['gate_read']) != {'paused': True}: raise RuntimeError('admission gate reopened early')
            trim.enable_policy(base)  # ONLY after both effective release attestations
            if trim.active_policy(base) != policy: raise RuntimeError('policy readback mismatch')
            trim.write_new(audit / 'enabled.json', {'target': target, 'release_hashes': actual})
        except Exception as error:
            # Leave admission PAUSED. Preserve one-time baseline, source and audit.
            # Never undo unrelated settings or overwrite a concurrent pointer.
            rollback = []
            with trim.registry_lock(base) as registry:
                enabled = registry / 'enabled.json'
                expected_enable = {'activation_sha256': hashlib.sha256((registry / 'activation.json').read_bytes()).hexdigest()}
                if enabled.exists():
                    if trim.read_record(enabled) != expected_enable:
                        raise RuntimeError('concurrent enable marker; admission remains paused') from error
                    enabled.unlink()
                    directory = os.open(registry, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                    try: os.fsync(directory)
                    finally: os.close(directory)
            for key in reversed(changed):
                try:
                    current = command(adapters[key]['read'])
                    if current == {'target': target}:
                        command(adapters[key]['set'], {'expected': target, 'target': before[key]['target']})
                        command(adapters[key]['reload'])
                    elif current != before[key]:
                        raise RuntimeError('concurrent pointer: manual recovery required')
                    if command(adapters[key]['read']) != before[key]: raise RuntimeError('rollback readback failed')
                    rollback.append({'key': key, 'restored': True})
                except Exception as failure:
                    rollback.append({'key': key, 'error': str(failure)})
            # The exact enable marker is removed above on failure; the immutable
            # epoch and all audit records remain. Recovery is parent-reviewed.
            trim.write_new(audit / 'failed.json', {'error': str(error), 'rollback': rollback, 'admission_paused': True})
            raise
    command(adapters['resume'])
    if command(adapters['gate_read']) != {'paused': False}: raise RuntimeError('admission resume unconfirmed')
    trim.write_new(audit / 'complete.json', {'target': target, 'release_hashes': actual, 'applied': True})
    return {'applied': True, 'target': target, 'audit': str(audit)}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--plan', required=True, type=Path)
    parser.add_argument('--apply', action='store_true', help='PARENT APPROVAL ONLY; default check changes nothing')
    args = parser.parse_args()
    print(json.dumps(rollout(json.loads(args.plan.read_text()), args.apply), sort_keys=True))


if __name__ == '__main__': main()
