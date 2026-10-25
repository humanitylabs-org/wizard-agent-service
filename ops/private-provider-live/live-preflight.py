#!/usr/bin/env python3
"""Read-only launch preflight. Does not constitute a launch or a rig acceptance.

Only docker inspect/exec sha256sum, systemctl show, filesystem metadata/release
receipts and authenticated Runtipi GET are permitted here. Never reads agents/.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

URN = 'wizard-tinfoil_private:wizardapps'
CONTAINERS = ['wizard-agent-service', 'runtipi']
UNITS = ['wizard-mobile', 'wizard-api', 'hermes-gateway', 'wizard-agent-runtime', 'wizard-app-manager-api']


def command(argv):
    p = subprocess.run(argv, capture_output=True, text=True, timeout=30)
    if p.returncode:
        raise RuntimeError('command failed: ' + argv[0])
    return p.stdout


def inspect():
    data = json.loads(command(['docker', 'inspect', 'runtipi']))
    if Path('/etc/pp-rig').exists():
        # The marked guest runs the real Service as an owner systemd process,
        # not a daemon-container lookalike. Fingerprint that actual selection.
        raw=command(['systemctl','--user','show','wizard-mobile','--property=MainPID,ExecMainStartTimestampMonotonic'])
        result={x['Name'].lstrip('/'): {'id':x['Id'],'image':x['Config']['Image'],'image_id':x['Image'],'started_at':x['State']['StartedAt'],'running':x['State']['Running']} for x in data}
        result['wizard-agent-service']={'execution':'host-systemd','unit_fingerprint':raw}
        return result
    data += json.loads(command(['docker', 'inspect', 'wizard-agent-service']))
    return {x['Name'].lstrip('/'): {
        'id': x['Id'], 'image': x['Config']['Image'], 'image_id': x['Image'],
        'started_at': x['State']['StartedAt'], 'running': x['State']['Running'],
    } for x in data}


def units():
    rows = {}
    for name in UNITS:
        raw = command(['systemctl', '--user', 'show', name,
                       '--property=MainPID,ActiveState,ExecMainStartTimestampMonotonic']) if not Path('/etc/pp-rig').exists() or name in ['wizard-mobile','wizard-agent-runtime','wizard-app-manager-api'] else 'ActiveState=absent'
        rows[name] = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
    return rows


def releases(home):
    roots = {'service': home / '.local/share/wizard-mobile-server/current',
             'runtime': home / '.local/share/wizard-agent-runtime/current'}
    result = {}
    for name, path in roots.items():
        sha = (path / 'RELEASE_SHA').read_text().strip()
        assert len(sha) == 40 and all(c in '0123456789abcdef' for c in sha)
        result[name] = {'sha': sha, 'resolved': str(path.resolve()),
                        'repo': (path / 'SOURCE_REPO').read_text().strip()}
    return result


def ui_fingerprint(home):
    root = home / 'apps/wizard-mobile/.ui-live'
    digest = hashlib.sha256()
    count = 0
    if not root.exists():
        return {'present': False}
    for folder, dirs, files in os.walk(root, followlinks=False):
        dirs.sort()
        for name in sorted(dirs + files):
            path = Path(folder) / name
            relative = str(path.relative_to(root))
            if path.is_symlink():
                digest.update((relative + '\0link\0' + os.readlink(path)).encode())
            elif path.is_file():
                digest.update(relative.encode() + b'\0' + hashlib.sha256(path.read_bytes()).digest())
                count += 1
    return {'present': True, 'resolved': str(root.resolve()), 'files': count, 'sha256': digest.hexdigest()}


def fingerprint(home):
    from live_sources import discover
    from python_rollout import tree_hash
    shell=home/'apps/wizard-os-home/web'
    return {'containers': inspect(), 'units': units(), 'releases': releases(home),
            'ui': ui_fingerprint(home), 'shell':{'resolved':str(shell.resolve()),'sha256':tree_hash(shell.resolve())},'wam_sources': discover(home)}


def main():
    p = argparse.ArgumentParser(__doc__)
    p.add_argument('--dry-run', required=True, action='store_true')
    p.add_argument('--home', type=Path, default=Path.home())
    p.add_argument('--wam-source', type=Path)
    p.add_argument('--rig-evidence', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    a.output.parent.mkdir(parents=True, exist_ok=True)
    report = {'mode': 'read-only-dry-run', 'started_at': time.time(), 'blockers': []}
    before = fingerprint(a.home)
    report['before'] = before
    try:
        assert os.geteuid() == 1000, 'requires owner uid1000'
        report['runtipi_ownership'] = {
            n: {'uid': q.stat().st_uid, 'gid': q.stat().st_gid,
                'mode': oct(q.stat().st_mode & 0o777), 'writable': os.access(q, os.W_OK)}
            for n in ['user-config', 'app-data', 'apps', 'state']
            for q in [a.home / 'runtipi' / n]
        }
        report['wam_main_sha256'] = command(['docker', 'exec', 'runtipi', 'sha256sum', '/app/main.mjs']).split()[0]
        wam = a.wam_source or a.home / 'workspace/wizard-app-manager'
        sys.path.insert(0, str(wam))
        # Do not call Config().runtipi(): ensure_operator can POST on a 401.
        from wam.runtipi import Runtipi
        rt = Runtipi.from_install(a.home / 'runtipi')
        installed = rt.installed()  # GET /apps/installed, never install/update/pull
        matching = [x for x in installed if 'wizard-tinfoil_private' in json.dumps(x)]
        report['provider_app_present'] = bool(matching)
        report['runtipi_authenticated_get'] = True
        if not a.rig_evidence.is_file():
            report['blockers'].append('Exact-release rehearsal evidence absent; all acceptance checks remain unproven.')
        else:
            evidence = json.loads(a.rig_evidence.read_text())
            report['rig_evidence_sha256'] = hashlib.sha256(a.rig_evidence.read_bytes()).hexdigest()
            spec = __import__('importlib.util', fromlist=['spec_from_file_location'])
            module_spec = spec.spec_from_file_location('launch_admission', Path(__file__).with_name('live-run-all.py'))
            assert module_spec and module_spec.loader
            admission = spec.module_from_spec(module_spec)
            module_spec.loader.exec_module(admission)
            report['blockers'].extend(admission.validate_rig(evidence))
            if evidence.get('wam_image_id') != before['containers']['runtipi']['image_id']:
                report['blockers'].append('Rig/live WAM image parity unproven or stale.')
            if evidence.get('wam_main_sha256') != report['wam_main_sha256']:
                report['blockers'].append('Rig/live WAM daemon source parity unproven or stale.')
        report['blockers'].append('Complete live-run-all promotion/rollback tooling is not rebuilt; this preflight cannot authorize a restart.')
    except Exception as e:
        report['blockers'].append(type(e).__name__ + ': prerequisite failed (details withheld)')
    after = fingerprint(a.home)
    report['after'] = after
    report['live_fingerprint_unchanged'] = before == after
    if before != after:
        report['blockers'].append('Concurrent live drift observed during dry-run; repeat discovery before any future promotion.')
    report['status'] = 'blocked' if report['blockers'] else 'passed'
    report['finished_at'] = time.time()
    a.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    return 1 if report['blockers'] else 0


if __name__ == '__main__':
    sys.exit(main())
