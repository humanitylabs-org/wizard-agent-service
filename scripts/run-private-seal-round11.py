#!/usr/bin/env python3
"""Parent-admitted, revision-bound native forum entrypoint. No live operations."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def command(args, *, env=None, timeout=900, log=None, check=True):
    if log:
        with log.open('w') as stream:
            p = subprocess.run(args, cwd=ROOT, env=env, stdout=stream, stderr=subprocess.STDOUT, timeout=timeout)
    else:
        p = subprocess.run(args, cwd=ROOT, env=env, capture_output=True, text=True, timeout=timeout)
    if check and p.returncode: raise RuntimeError('command_failed:' + args[0] + ':' + str(p.returncode))
    return p


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''): h.update(block)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--source', required=True); args = parser.parse_args()
    assert platform.machine() == 'x86_64' and str(ROOT).startswith('/srv/work/incog-seal-r11-')
    manifest = json.loads((ROOT / 'SOURCE.json').read_text())
    assert manifest['source_head'] == args.source
    assert len(args.source) == 40 and all(c in '0123456789abcdef' for c in args.source)
    for name, expected in manifest['files'].items():
        p = (ROOT / name).resolve(); assert p.is_relative_to(ROOT) and digest(p) == expected, name
    qa = ROOT / 'qa/round11-control'
    if qa.exists() or (ROOT/'qa/round11').exists() or (ROOT/'work-round11').exists():
        raise SystemExit('refuse_existing_round11_work_or_evidence')
    qa.mkdir(parents=True)
    env = {**os.environ, 'R11_SOURCE_HEAD':args.source, 'R11_DOCKER_GATEWAY':'1',
           'R11_GATEWAY_IMAGE':'restricted-agent-sidecars:round11-' + args.source[:12],
           'R11_EDGE_IMAGE':'wizard-private-network-edge:round11-' + args.source[:12],
           'R11_KEY_IMAGE':'wizard-private-network-edge:round11-' + args.source[:12],
           'PYTHONDONTWRITEBYTECODE':'1', 'TMPDIR':str(ROOT/'work-tmp-round11')}
    Path(env['TMPDIR']).mkdir()
    owner = 'wizard.qa.round11=' + args.source[:12]
    # No shared preview tag is rebuilt, no existing daemon/container is touched.
    result = {'source_head':args.source,'manifest_sha256':digest(ROOT/'SOURCE.json'),
              'synthetic_only':True,'live_touched':False,'migration_admitted':False,'errors':{}}
    try:
        assert command(['docker','ps','-aq','--filter','label='+owner]).stdout.strip() == ''
        # Existing selected daemon image archive; import only, never run a host daemon.
        unzip = subprocess.Popen(['gzip','-dc',str(ROOT/'deps/app-manager-image.tar.gz')], stdout=subprocess.PIPE)
        try:
            load = subprocess.run(['docker','load'], stdin=unzip.stdout, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL, timeout=300)
            unzip.stdout.close(); assert unzip.wait(timeout=30) == load.returncode == 0
        finally:
            if unzip.poll() is None: unzip.kill(); unzip.wait()
        expected = {'ghcr.io/humanitylabs-org/hermes-agent:v2026.9.24-wizard2':'sha256:06833b65195fc0dbe7cd136705da29defe42e2474eff2391e66ab00db3744476',
                    'ghcr.io/tinfoilsh/tinfoil-proxy:0.2.3':'sha256:cbfababef82676898b0700a5f4895479a92468e99671156cb41fd7d685ee60e2',
                    'wizard-app-manager:grants-fix-fead192e9fb2-amd64':'sha256:f2e1be459cf8e8ffc41225a3a676c7a704db6fd96c857a5e2b774c8eee6446d4'}
        result['images'] = {}
        for image, identity in expected.items():
            found = command(['docker','image','inspect','--format','{{.Id}}',image]).stdout.strip()
            assert found == identity, 'image_identity_changed:' + image
            result['images'][image] = found
        for image in ('python:3.12-slim','docker:28-dind'):
            command(['docker','pull',image], log=qa/('pull-'+image.split(':')[0]+'.log'), timeout=600)
            result['images'][image] = command(['docker','image','inspect','--format','{{.Id}} {{json .RepoDigests}}',image]).stdout.strip()
        command(['docker','build','-t',env['R11_EDGE_IMAGE'],'-f','ops/agent-runtime/Dockerfile.provider-egress','ops/agent-runtime'],log=qa/'edge-build.log')
        command(['docker','build','-t',env['R11_GATEWAY_IMAGE'],'ops/agent-runtime/restricted-agent/sidecars'],log=qa/'gateway-build.log')
        for image in (env['R11_EDGE_IMAGE'],env['R11_GATEWAY_IMAGE']):
            result['images'][image] = command(['docker','image','inspect','--format','{{.Id}}',image]).stdout.strip()
        command(['npm','install','--ignore-scripts','--no-package-lock'],log=qa/'npm-install.log',timeout=600)
        tests = command(['./node_modules/.bin/vitest','run','tests/sealed-private-gateway.test.ts','--reporter=json',
                         '--outputFile='+str(qa/'gateway-vitest.json')],env=env,log=qa/'gateway-vitest.log',timeout=300,check=False)
        report = json.loads((qa/'gateway-vitest.json').read_text())
        result['gateway'] = {'exit_code':tests.returncode,'success':report.get('success'),
                             'passed':report.get('numPassedTests'),'failed':report.get('numFailedTests'),
                             'scope':'Existing Service grant test through an actual inhibited-bridge Docker client and restricted Unix-socket edge; synthetic apps only.'}
        result['gateway']['passed_gate'] = tests.returncode == 0 and report.get('success') is True and report.get('numFailedTests') == 0 and report.get('numPassedTests') == 2
        phase = command(['python3','scripts/private-seal-round11.py'],env=env,log=qa/'runtime.log',timeout=2700,check=False)
        result['runtime_exit_code'] = phase.returncode
        runtime = json.loads((ROOT/'qa/round11/receipt.json').read_text())
        result['checks'] = runtime.get('checks',{})
        result['required_unmet'] = runtime['admission']['required_unmet']
        if not result['gateway']['passed_gate']: result['required_unmet'].append('actual_container_scoped_app_gateway')
        # Do not misrepresent a deterministic fake provider as a real attested
        # Tinfoil completion, stopped-provider classification, or vision model.
        result['required_unmet'].extend(['attested_tinfoil_stock_recovery_and_image_semantics_not_measured',
                                        'combined_exact_selected_source_rehearsal_not_run',
                                        'live_credential_rotation_and_old_backups_owner_gate'])
    except Exception as exc:
        result['errors']['entrypoint'] = {'class':type(exc).__name__,'reason':str(exc)[:240]}
        result.setdefault('required_unmet',[]).append('entrypoint_failed')
    finally:
        # Exact job ownership only. Never prune Docker or stop unrelated VMs.
        ids = command(['docker','ps','-aq','--filter','label='+owner],check=False).stdout.split()
        if ids: command(['docker','rm','-f',*ids],timeout=180,check=False)
        networks = command(['docker','network','ls','-q','--filter','label='+owner],check=False).stdout.split()
        if networks: command(['docker','network','rm',*networks],check=False)
        left = command(['docker','ps','-aq','--filter','label='+owner],check=False).stdout.split()
        nets = command(['docker','network','ls','-q','--filter','label='+owner],check=False).stdout.split()
        result['leftover_containers'] = len(left); result['leftover_networks'] = len(nets)
        if left or nets: result.setdefault('required_unmet',[]).append('owned_resource_cleanup')
        (qa/'receipt.json').write_text(json.dumps(result,indent=2,sort_keys=True)+'\n')
        print(json.dumps(result,sort_keys=True))
    return 2 if result.get('required_unmet') or result['errors'] else 0


if __name__ == '__main__': sys.exit(main())
