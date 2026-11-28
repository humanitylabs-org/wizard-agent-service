#!/usr/bin/env python3
"""Shared canary data builder; only writes inside its new synthetic run."""
import hashlib
from pathlib import Path

BULK = ('source/main.py', 'src/main.rs', 'candidate/a.cpp', 'baseline/a.c', 'checkouts/tree/a.sh',
        'source-v2/a', 'candidate-v2/a', 'baseline-v2/a', 'node_modules/lib/index.js',
        'nested/node_modules/lib/index.js', 'tmp/scratch', 'build/temporary.bin', 'cache/data',
        'intermediates/data', 'profiles/chrome/Default/History', 'guests/vm/disk.qcow2',
        'vms/disk.vmdk', 'disposable-vms/disk.raw', 'vms/disk.img', 'disposable-guest.img')
EVIDENCE = ('build/app.apk', 'checkouts/retained-repo/.git/objects/pack/keep.pack',
            'checkouts/retained-repo/uncommitted.py', 'source/results/keep.bin', 'candidate/evidence/keep.bin', 'baseline/reports/keep.bin',
            'node_modules/pkg/package.json', 'node_modules/pkg/license.txt', 'tmp/preflight.json',
            'build/result.jsonl', 'build/receipt.bin', 'build/submission.bin', 'build/admission.bin',
            'build/log.bin', 'build/screenshot.png', 'source/report.md', 'source/report.html',
            'source/report.xml', 'source/photo.jpg', 'source/photo.webp', 'logs/native.log',
            'screenshots/keep.bin', 'receipts/keep.bin', 'results/keep.bin', 'evidence/keep.bin',
            'build/manifest.bin')
UNKNOWN = ('owner-tool', 'source.tar', 'runner.py', 'unknown/disk.qcow2', 'profiles/unknown/data')
LINKED = ('source/published.bin', 'build/declared.bin', 'candidate/linked/a.bin')


def seed(run, bytes_per_file=4 * 1024 * 1024):
    run = Path(run)
    def put(name, data):
        path = run / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
    for name in BULK:
        put(name, b'\x95' * bytes_per_file)
    put('profiles/chrome/Local State', b'profile marker')
    put('profiles/chrome/Default/Preferences', b'profile marker')
    for name in EVIDENCE:
        put(name, b'{}\n' if name.endswith(('.json', '.jsonl')) else b'evidence exact bytes\n')
    for name in (*UNKNOWN, *LINKED):
        put(name, b'unknown or linked retained\n')
    put('retain.json', b'{"paths":["build/declared.bin"]}\n')
    put('evidence.json', b'{"published_directory":"candidate/linked"}\n')
    retained = (*EVIDENCE, *UNKNOWN, *LINKED, 'retain.json', 'evidence.json')
    return {'bulk': [*BULK, 'profiles/chrome/Local State', 'profiles/chrome/Default/Preferences'],
            'retained_sha256': {name: hashlib.sha256((run / name).read_bytes()).hexdigest() for name in retained}}
