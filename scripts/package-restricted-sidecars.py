#!/usr/bin/env python3
"""Light-lane packaging only. Run on Thales, never the VPS. No publication/login."""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys


def run(argv, **kw):
    return subprocess.run(argv, check=True, text=True, **kw)


def main():
    configured = os.environ.get('WIZARD_HEAVY_ROOT') or os.environ.get('WIZARD_WORK_ROOT')
    if not configured:
        raise SystemExit('WIZARD_HEAVY_ROOT or WIZARD_WORK_ROOT required')
    work_root = Path(configured).resolve()
    if (platform.system() != 'Darwin' or not work_root.is_relative_to('/Volumes')
            or len(work_root.parts) < 3 or not Path.cwd().is_relative_to(work_root)):
        raise SystemExit('remote macOS external-volume packaging required')
    if len(sys.argv) != 4:
        raise SystemExit('usage: package-restricted-sidecars.py SOURCE_SHA IMAGE_TAG OUTPUT_DIR')
    sha, image, output = sys.argv[1:]
    out = Path(output).resolve()
    if not out.is_relative_to(work_root) or out.exists():
        raise SystemExit('new external output directory required')
    source = run(['git', 'rev-parse', 'HEAD'], capture_output=True).stdout.strip()
    if source != sha or run(['git', 'status', '--porcelain', '--untracked-files=normal'], capture_output=True).stdout:
        raise SystemExit('pushed source SHA must match a clean checkout')
    # Use the existing Colima endpoint, never switch contexts/restart/install/prune.
    docker = ['/opt/homebrew/bin/docker']
    endpoint = Path.home() / '.colima/default/docker.sock'
    if not endpoint.exists():
        raise SystemExit('existing Docker socket unavailable')
    os.environ['DOCKER_HOST'] = 'unix://' + str(endpoint)
    runtime = Path('ops/agent-runtime/restricted-agent')
    for test in ('test_declared_tcp.py', 'egress_selftest.py', 'test_edge_heavy.py'):
        run([sys.executable, str(runtime / 'conformance' / test)])
    out.mkdir(parents=True)
    try:
        # All base/runtime layers and sources are already audited; no native compilation.
        run([*docker, 'build', '--platform=linux/amd64', '--label', 'org.opencontainers.image.revision=' + sha,
             '--label', 'org.opencontainers.image.source=https://github.com/humanitylabs-org/wizard-agent-service',
             '-t', image, str(runtime / 'sidecars')])
        inspect = json.loads(run([*docker, 'image', 'inspect', image], capture_output=True).stdout)[0]
        if inspect['Architecture'] != 'amd64':
            raise RuntimeError('wrong image architecture')
        expected = hashlib.sha256((runtime / 'sidecars/egress.py').read_bytes()).hexdigest()
        code = 'import hashlib; print(hashlib.sha256(open("/srv/egress.py","rb").read()).hexdigest())'
        actual = run([*docker, 'run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL',
                      '--security-opt=no-new-privileges:true', '--entrypoint=python3', image, '-c', code],
                     capture_output=True).stdout.strip()
        if actual != expected:
            raise RuntimeError('sidecar source mismatch')
        tar = out / 'restricted-sidecars-amd64.tar'
        run([*docker, 'save', '-o', str(tar), image])
        with tar.open('rb') as f:
            tar_hash = hashlib.file_digest(f, 'sha256').hexdigest()
        receipt = {'source_revision': sha, 'image_tag': image, 'image_id': inspect['Id'],
                   'architecture': inspect['Architecture'], 'egress_sha256': expected,
                   'artifact': str(tar), 'artifact_bytes': tar.stat().st_size, 'artifact_sha256': tar_hash,
                   'tests_exit_code': 0, 'build_exit_code': 0, 'source_image_match': True}
        (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(json.dumps(receipt), flush=True)
    except BaseException:
        print(json.dumps({'source_revision': sha, 'failed': True, 'output': str(out)}), flush=True)
        raise


if __name__ == '__main__':
    main()
