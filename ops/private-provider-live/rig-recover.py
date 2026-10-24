#!/usr/bin/env python3
"""Bounded recovery of only the existing disposable pp-rig VM.

Invoke under the shared worker lock. Never replaces disks or reads provider data.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

LIMA = '/opt/homebrew/bin/limactl'

def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--project-root', type=Path, required=True)
    args = parser.parse_args()
    root = args.project_root.resolve()
    assert root.name == 'private-providers', 'unexpected project root'
    rig = root / 'rig'
    assert sys.platform == 'darwin'
    assert (rig / 'lima/pp-rig/disk').is_file(), 'existing rig disk absent'
    env = dict(os.environ, LIMA_HOME=str(rig / 'lima'))
    result = {'vm': 'pp-rig', 'attempts': [], 'started_at': time.time()}
    def run(args, deadline=120):
        p = subprocess.run([LIMA, *args], env=env, capture_output=True, text=True, timeout=deadline)
        result['attempts'].append({'argv': args, 'exit_code': p.returncode, 'stdout': p.stdout[-8000:], 'stderr': p.stderr[-8000:]})
        return p
    try:
        # Do not reset: the guest may retain the only copies of past live-run scripts.
        for attempt in range(2):
            p = run(['start', '--timeout=8m', 'pp-rig'], 520)
            if p.returncode == 0:
                break
            if attempt == 0:
                run(['stop', '--force', 'pp-rig'], 90)
        else:
            raise RuntimeError('pp-rig recovery failed after two attempts; disk preserved')
        p = run(['shell', '--workdir', '/home/rig', 'pp-rig', '--', 'python3', '-c',
                 'from pathlib import Path;import os,json;assert Path("/etc/pp-rig").read_text().strip()=="pp-private-providers";assert os.geteuid()==1000;r=Path("/home/rig/pp-candidates");print(json.dumps({"uid":os.geteuid(),"files":[str(p.relative_to(r)) for p in r.iterdir()]}))'])
        assert p.returncode == 0, 'guest marker/nonroot inspection failed'
        result['status'] = 'passed'
    except Exception as e:
        result['status'] = 'blocked'
        result['reason'] = str(e)
    finally:
        out = root / 'pp-launch/live/RIG-RECOVERY.json'
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))
    return 0 if result['status'] == 'passed' else 1

if __name__ == '__main__':
    sys.exit(main())
