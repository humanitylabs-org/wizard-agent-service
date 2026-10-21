#!/usr/bin/env python3
"""Single durable-worker command: build/reset the isolated private-provider rig.

Requires admission by wizard_heavy_submit; never invoke over a foreground SSH call.
All subprocesses are foreground, with hard deadlines. Does not acquire another lock.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

VM = 'pp-rig'  # short: Lima socket paths must stay under 104 chars
IMAGE_URL = 'https://cloud-images.ubuntu.com/releases/noble/release-20260615/ubuntu-24.04-server-cloudimg-arm64.img'
IMAGE_SHA = 'cafa1a965b591b7c4184b484ffd8e625981a79d48f9b4ae8a4adf7b4c5ade927'


def main():
    p = argparse.ArgumentParser(__doc__)
    p.add_argument('--rig-root', required=True, type=Path)
    modes = p.add_mutually_exclusive_group()
    modes.add_argument('--reset', action='store_true')
    modes.add_argument('--recreate-failed', action='store_true', help='delete only pp-rig when provisioning failed before a baseline')
    p.add_argument('--validate', action='store_true')
    a = p.parse_args()
    root = a.rig_root.resolve()
    assert str(root).startswith('/Volumes/ThalesMedia/') and root.name == 'rig'
    stage = root / 'stage'
    for file in ['source-manifest.json', 'service.tar', 'wam.tar', 'guest-setup.py', 'runtipi-setup.sh']:
        assert (stage / file).is_file(), 'missing stage file: ' + file
    manifest = json.loads((stage / 'source-manifest.json').read_text())
    for file, sha in manifest['sha256'].items():
        assert hashlib.sha256((stage / file).read_bytes()).hexdigest() == sha, 'stage hash mismatch: ' + file
    print('STAGE_VALID', json.dumps(manifest), flush=True)
    if a.validate:
        return
    # Durable runner owns the shared worker.lock; no detached process or second flock here.
    # Admission is mandatory and this command is only handed to that runner.
    assert os.uname().sysname == 'Darwin'
    env = {**os.environ, 'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
           'LIMA_HOME': str(root / 'lima'), 'LIMA_CACHE_HOME': str(root / 'cache'),
           'TMPDIR': str(root / 'tmp')}
    for d in ['lima', 'cache', 'tmp', 'evidence']:
        (root / d).mkdir(exist_ok=True)
    log = (root / 'evidence' / ('reset.log' if a.reset else 'provision.log')).open('ab', buffering=0)

    def run(*argv, timeout=600, capture=False):
        print('+', ' '.join(argv), flush=True)
        log.write(('\n+ ' + ' '.join(argv) + '\n').encode())
        result = subprocess.run(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
        log.write(result.stdout)
        if not capture:
            print(result.stdout.decode(errors='replace'), flush=True)
        if result.returncode:
            raise RuntimeError('step failed with exit ' + str(result.returncode) + ': ' + argv[0])
        return result.stdout

    def shell(*args, **kw):
        return run('limactl', 'shell', '--workdir', '/home/rig', VM, '--', *args, **kw)

    def health():
        for port, path in [(18787, '/wizard/health'), (17795, '/healthz'), (18480, '/api/health')]:
            for attempt in range(30):
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}', timeout=3) as r:
                        assert r.status == 200
                    print('FORWARDED_HEALTH', port, 200, flush=True)
                    break
                except OSError:
                    if attempt == 29:
                        raise
                    time.sleep(2)

    def record():
        ready = json.loads(shell('python3', '-c', 'from pathlib import Path; print(Path("/opt/pp-rig/ready.json").read_text())', capture=True))
        ready.update({'vm': VM, 'lima_home': env['LIMA_HOME'], 'ports': {'agent_service': 18787, 'runtime': 17795, 'wam': 17790, 'runtipi': 18480},
                      'baseline': str(root / 'baseline'), 'verified_at_unix': time.time()})
        (root / 'evidence/ready.json').write_text(json.dumps(ready, indent=2) + '\n')
        health()
        print('READY', json.dumps(ready), flush=True)

    vm = root / 'lima' / VM
    baseline = root / 'baseline'
    if a.recreate_failed:
        assert not baseline.exists(), 'clean baseline exists; use --reset instead'
        assert not (root / 'evidence/ready.json').exists(), 'ready rig exists; refuse failed-rig recreation'
        assert vm.is_dir(), 'failed rig missing'
        marker = shell('cat', '/etc/pp-rig', capture=True).decode().strip()
        assert marker == 'pp-private-providers', 'refuse unmarked guest'
        run('limactl', 'stop', VM, timeout=180)
        run('limactl', 'delete', '--force', VM, timeout=180)
    if a.reset:
        assert (baseline / 'manifest.json').is_file(), 'no clean baseline'
        run('limactl', 'stop', VM, timeout=180)
        for name in json.loads((baseline / 'manifest.json').read_text())['files']:
            assert name in ('disk', 'vz-efi', 'diffdisk', 'basedisk')
            target = vm / name
            target.unlink(missing_ok=True)
            run('cp', '-c', str(baseline / name), str(target), timeout=120)
        run('limactl', 'start', '--timeout=8m', VM, timeout=540)
        record()
        return
    assert not vm.exists(), 'VM already exists: inspect evidence or submit --reset; never overwrite it'
    run('df', '-h', '/', '/Volumes/ThalesMedia')
    run('uptime')
    run('limactl', 'list')
    assert shutil.disk_usage(root).free > 80 * 1024**3, 'need 80GiB free on ThalesMedia'
    image = root / 'cache' / 'ubuntu-24.04-server-cloudimg-arm64.img'
    # Reuse the exact cached Ubuntu base used by agents-mvp, without cloning any guest's state/secrets.
    if not image.exists():
        cache = Path.home() / 'Library/Caches/lima/download/by-url-sha256/884d1dfa889893dece195c36e38bd93fed5182f7f399a7d7679009b0a334f377/data'
        if cache.is_file():
            shutil.copyfile(cache, image)
            print('REUSED_BASE', str(cache), flush=True)
        else:
            urllib.request.urlretrieve(IMAGE_URL, image)
    with image.open('rb') as f:
        assert hashlib.file_digest(f, 'sha256').hexdigest() == IMAGE_SHA, 'Ubuntu base checksum mismatch'
    config = {
        'vmType': 'vz', 'arch': 'aarch64', 'cpus': 4, 'memory': '6GiB', 'disk': '40GiB',
        'vmOpts': {'vz': {'rosetta': {'enabled': True, 'binfmt': True}}},
        'images': [{'location': str(image), 'arch': 'aarch64', 'digest': 'sha256:' + IMAGE_SHA}],
        'user': {'name': 'rig', 'home': '/home/rig', 'uid': 1000, 'shell': '/bin/bash'},
        'mounts': [{'location': str(stage), 'mountPoint': '/mnt/pp-stage', 'writable': False}],
        'containerd': {'system': False, 'user': False},
        'ssh': {'localPort': 0, 'loadDotSSHPubKeys': False, 'forwardAgent': False},
        'hostResolver': {'enabled': True}, 'mountType': 'virtiofs',
        'portForwards': [
            {'guestIP': '127.0.0.1', 'guestPort': guest, 'hostIP': '127.0.0.1', 'hostPort': host}
            for guest, host in [(8787, 18787), (7790, 17790), (7795, 17795), (8480, 18480)]
        ] + [{'guestIP': '0.0.0.0', 'guestPortRange': [1, 65535], 'ignore': True}],
    }
    yaml = root / 'vm.yaml'
    # JSON is a valid YAML subset, avoids a host dependency on PyYAML.
    yaml.write_text(json.dumps(config, indent=2) + '\n')
    run('limactl', 'create', '--tty=false', '--name=' + VM, str(yaml), timeout=600)
    run('limactl', 'start', '--timeout=8m', VM, timeout=540)
    shell('env', 'PP_STAGE=/mnt/pp-stage', 'python3', '/mnt/pp-stage/guest-setup.py', timeout=5400)
    # Stop only this VM and create a crash-consistent APFS clone baseline before any candidate/key is installed.
    run('limactl', 'stop', VM, timeout=180)
    baseline.mkdir(exist_ok=False)
    names = [n for n in ['disk', 'vz-efi', 'diffdisk', 'basedisk'] if (vm / n).is_file()]
    assert 'disk' in names, 'no VZ disk found'
    for name in names:
        run('cp', '-c', str(vm / name), str(baseline / name), timeout=120)
    (baseline / 'manifest.json').write_text(json.dumps({'vm': VM, 'files': names, 'source': manifest, 'provider_key_present': False}, indent=2) + '\n')
    run('limactl', 'start', '--timeout=8m', VM, timeout=540)
    record()
    run('limactl', 'list', '--json')


if __name__ == '__main__':
    main()
