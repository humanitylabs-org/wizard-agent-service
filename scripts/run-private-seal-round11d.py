#!/usr/bin/env python3
"""Focused manager-only follow-up. Parent admits on forum; never live admission."""
import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
from private_seal_round11_inherit import digest, validate_inheritance
from private_seal_round11_protocol import catalog_build_context

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--manifest-sha256', required=True)
    args = parser.parse_args()
    assert platform.machine() == 'x86_64' and str(ROOT).startswith('/srv/work/incog-seal-r11d-')
    assert os.getuid() != 0 and os.getgid() != 0
    assert len(args.source) == 40 and all(c in '0123456789abcdef' for c in args.source)
    assert digest(ROOT/'SOURCE.json') == args.manifest_sha256
    manifest = json.loads((ROOT/'SOURCE.json').read_text())
    assert manifest['source_head'] == args.source
    for name, expected in manifest['files'].items():
        p = (ROOT/name).resolve()
        assert p.is_relative_to(ROOT) and digest(p) == expected, 'source_drift:' + name
    for name in ('qa/round11d-control','qa/round11d-manager','work-round11d-manager'):
        assert not (ROOT/name).exists(), 'refuse_existing_followup:' + name
    qa = ROOT/'qa/round11d-control'; qa.mkdir(parents=True)
    (qa/'tmp').mkdir()
    result = {'source_head':args.source,'manifest_sha256':args.manifest_sha256,
              'synthetic_only':True,'live_touched':False,'migration_admitted':False,'errors':{},
              'required_unmet':['attested_tinfoil_stock_recovery_and_image_semantics_not_measured',
                                'combined_exact_selected_source_rehearsal_not_run',
                                'live_credential_rotation_and_old_backups_owner_gate']}
    env = {**os.environ,'PYTHONDONTWRITEBYTECODE':'1','TMPDIR':str(qa/'tmp'),'R11_SOURCE_HEAD':args.source,
           'R11_CATALOG_IMAGE':'round11-synthetic-catalog:' + args.source[:12]}
    owner = 'wizard.qa.round11=' + args.source[:12]
    resources_owned = False

    def command(argv, *, timeout=60, log=None, check=True):
        if log:
            with (qa/log).open('w') as stream:
                p = subprocess.run(argv,cwd=ROOT,env=env,stdout=stream,stderr=subprocess.STDOUT,timeout=timeout)
        else:
            p = subprocess.run(argv,cwd=ROOT,env=env,capture_output=True,text=True,timeout=timeout)
        if check and p.returncode: raise RuntimeError('command_failed:' + argv[0] + ':' + str(p.returncode))
        return p

    try:
        result['inherited'] = validate_inheritance(ROOT)
        # No npm install, stock startup/prompts, gateway build or suite rerun.
        command(['python3','-m','unittest','discover','-s','scripts/ci','-p','test_private_seal_round11_protocol.py','-v'],
                log='protocol-regressions.log',timeout=120)
        old_images = result['inherited']['images']
        for image, identity in old_images.items():
            actual = command(['docker','image','inspect','--format','{{.Id}}',image]).stdout.strip()
            assert actual == identity.split()[0], 'inherited_image_drift:' + image
        env['R11_EDGE_IMAGE'] = next(i for i in old_images if i.startswith('wizard-private-network-edge:'))
        env['R11_KEY_IMAGE'] = env['R11_EDGE_IMAGE']
        assert command(['docker','ps','-aq','--filter','label='+owner]).stdout.strip() == ''
        assert command(['docker','network','ls','-q','--filter','label='+owner]).stdout.strip() == ''
        resources_owned = True
        ctx = catalog_build_context(ROOT,qa/'catalog-build')
        command(['docker','build','--pull=false','-t',env['R11_CATALOG_IMAGE'],str(ctx)],timeout=600,log='catalog-build.log')
        result['catalog_image_id'] = command(['docker','image','inspect','--format','{{.Id}}',env['R11_CATALOG_IMAGE']]).stdout.strip()
        phase = command(['python3','scripts/private-seal-round11.py','--manager-only'],timeout=2700,log='manager.log',check=False)
        result['manager_exit_code'] = phase.returncode
        manager = json.loads((ROOT/'qa/round11d-manager/receipt.json').read_text())
        assert manager['source_head'] == args.source and manager['synthetic_only'] is True and manager['live_touched'] is False
        result['manager_receipt_sha256'] = digest(ROOT/'qa/round11d-manager/receipt.json')
        result['fresh_manager'] = manager
        result['checks'] = {**result['inherited']['checks'],**manager['checks']}
        result['required_unmet'].extend(manager['admission']['required_unmet'])
        if phase.returncode and not manager['admission']['required_unmet']:
            result['required_unmet'].append('manager_process_failed')
        if manager.get('security_vulnerability'):
            result['security_vulnerability'] = manager['security_vulnerability']
    except Exception as exc:
        result['errors']['entrypoint'] = {'class':type(exc).__name__,'reason':str(exc)[:300]}
        result['required_unmet'].append('entrypoint_failed')
    finally:
        if resources_owned:
            ids = command(['docker','ps','-aq','--filter','label='+owner],check=False).stdout.split()
            if ids: command(['docker','rm','-f',*ids],timeout=180,check=False)
            nets = command(['docker','network','ls','-q','--filter','label='+owner],check=False).stdout.split()
            if nets: command(['docker','network','rm',*nets],check=False)
        result['leftover_containers'] = len(command(['docker','ps','-aq','--filter','label='+owner]).stdout.split())
        result['leftover_networks'] = len(command(['docker','network','ls','-q','--filter','label='+owner]).stdout.split())
        if result['leftover_containers'] or result['leftover_networks']: result['required_unmet'].append('owned_cleanup_failed')
        # If the phase was killed by its outer cap, never silently claim cleanup
        # of root-owned generated credentials; preserve this unmet obligation.
        work = ROOT/'work-round11d-manager'
        if resources_owned and not result['leftover_containers'] and work.exists():
            # Timeout recovery is confined to this exact generated bind, after
            # the owned nested engine has been removed. Never owner paths.
            cleanup = command(['docker','run','--rm','--network','none','--read-only','--log-driver','none',
                '-v',str(work)+':/cleanup','python:3.12-slim','python3','-c',
                "import pathlib,shutil;p=pathlib.Path('/cleanup');[(shutil.rmtree(x) if x.is_dir() and not x.is_symlink() else x.unlink()) for x in p.iterdir()]"],check=False,timeout=120)
            if cleanup.returncode == 0: work.rmdir()
        result['synthetic_secret_work_removed'] = not work.exists()
        if work.exists(): result['required_unmet'].append('synthetic_secret_work_remains')
        result['required_unmet'] = sorted(set(result['required_unmet']))
        (qa/'receipt.json').write_text(json.dumps(result,indent=2,sort_keys=True)+'\n')
        print(json.dumps({k:v for k,v in result.items() if k not in ('inherited','fresh_manager')},sort_keys=True))
    return 2 if result['required_unmet'] or result['errors'] else 0


if __name__ == '__main__': sys.exit(main())
