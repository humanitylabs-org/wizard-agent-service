#!/usr/bin/env python3
"""Disposable, no-host-mount/no-published-port enrollment + SSH E2E proof.

Needs Docker on a local Linux daemon. Installs only into a throwaway container.
Keys never leave the container; no host ~/.ssh/.hermes or existing users touched.
"""
import argparse
import os
from pathlib import Path
import subprocess
import uuid


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, **kwargs)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--image', default='python:3.12-slim', help='Use a reviewed local/pinned Python Debian image')
    a = p.parse_args()
    name = 'machines-proof-' + uuid.uuid4().hex[:12]
    # No host mounts, host network, added capabilities, host ports or Docker socket.
    run(['docker', 'run', '--rm', '-d', '--name', name, '--memory', '512m', '--cpus', '1', '--pids-limit', '128', a.image, 'sleep', '300'], stdout=subprocess.DEVNULL)
    try:
        run(['docker', 'exec', name, 'sh', '-c', 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends openssh-server openssh-client python3 >/dev/null'], timeout=120)
        run(['docker', 'network', 'disconnect', 'bridge', name])
        run(['docker', 'cp', str(Path(__file__).parent), name + ':/proof'])
        run(['docker', 'exec', '-e', 'MACHINES_DISPOSABLE_PROOF=yes', name, '/usr/bin/python3', '/proof/container-proof.py'], timeout=60)
    finally:
        subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
