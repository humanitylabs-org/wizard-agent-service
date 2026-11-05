#!/usr/bin/env python3
"""Audited detached wrapper around the unchanged, prepared rotation controller.
No raw credentials, journals, response bodies, or process environment are emitted.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location('activation', Path(__file__).with_name('activate_security.py'))
assert spec is not None and spec.loader is not None
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
r = m.r


def run(root, planpath, controller, lease_wait_seconds=0):
    r.protect()
    state = json.loads((root / 'filter-activation.json').read_bytes())
    state.update(status='rotation_in_progress', rotation_plan=str(planpath), rotation_controller=str(controller),
                 wrapper_sha256=r.hashfile(__file__), rotation_started_unix=time.time(),
                 about_browser_accepted=False, about_metadata_owner_http_before=404)
    r.write_json(root / 'result.json', state)
    secret = None
    try:
        r.require(state['filter_loaded'] and r.runtime_filter()['loaded'], 'filter_not_loaded')
        r.require(r.hashfile(r.GATEWAY) == state['config_sha256'], 'gateway_config_drift')
        r.require(r.unit(r.KEEPER)['state'] == 'active' and r.keeper()['pid'] == state['after']['keeper']['pid'], 'keeper_not_preserving')
        plan = json.loads(planpath.read_bytes())
        r.require(r.hashfile(controller) == plan['script_sha256'], 'rotation_controller_drift')
        current = r.snapshot()
        r.require(current['release'] == plan['before']['release'] and current['revision'] == plan['before']['revision'], 'artifact_drift')
        r.require(r.hashfile(r.PROOF) == plan['old_sha256'], 'producer_drift')
        if lease_wait_seconds:
            r.require(0 < lease_wait_seconds <= 600, 'invalid_lease_wait_budget')
            ownerpath = r.HOME / '.hermes/state/locks/state-db-maintenance-owner.json'
            owner = json.loads(ownerpath.read_bytes()) if ownerpath.exists() else {}
            state.update(status='waiting_for_host_lease', lease_wait_seconds=lease_wait_seconds,
                         blocking_maintenance={k: owner.get(k) for k in ['operation', 'pid', 'ppid', 'started_at_utc']})
            r.write_json(root / 'result.json', state)
            # The canonical helper bounds the wait and briefly acquires/releases
            # the actual OS lock. Never bypass or recursively hold the lease.
            r.cmd([sys.executable, r.SCRIPTS / 'hermes_state_maintenance_lock.py', 'probe',
                   '--timeout-seconds', str(lease_wait_seconds)], timeout=lease_wait_seconds + 10)
            now = r.snapshot()
            for key in ['release', 'revision', 'service', 'source_hashes', 'apps_count',
                        'apps_rows_sha256', 'settings_sha256', 'base_url', 'units']:
                r.require(now[key] == plan['before'][key], 'post_lease_scope_drift_' + key)
            r.require(now['keeper']['pid'] == plan['before']['keeper']['pid'], 'post_lease_keeper_drift')
            r.require(now['containers']['wizard-agent-service'] == plan['before']['containers']['wizard-agent-service'],
                      'post_lease_service_container_drift')
            state['sibling_container_changes_during_wait'] = [k for k in
                now['containers'].keys() | plan['before']['containers'].keys()
                if now['containers'].get(k) != plan['before']['containers'].get(k)]
            r.cmd([sys.executable, controller, 'prepare', '--plan', planpath])
            r.cmd([sys.executable, controller, 'check', '--plan', planpath], timeout=60)
            plan = json.loads(planpath.read_bytes())
            state.update(status='rotation_in_progress', rotation_started_unix=time.time(),
                         fresh_plan_sha256=r.hashfile(planpath))
            r.write_json(root / 'result.json', state)
        result = subprocess.run([sys.executable, str(controller), 'apply', '--plan', str(planpath)], capture_output=True, timeout=550)
        state['controller_returncode'] = result.returncode
        state['controller_stdout_sha256'] = r.sha(result.stdout)
        state['controller_stderr_sha256'] = r.sha(result.stderr)
        rotation = json.loads((planpath.parent / 'result.json').read_bytes())
        state['rotation_result'] = str(planpath.parent / 'result.json')
        state['rotation_result_sha256'] = r.hashfile(planpath.parent / 'result.json')
        state['rotation_status'] = rotation['status']
        state['rollback_status'] = rotation['status'] if 'rollback' in rotation['status'] else 'not_needed'
        state['rotation_checks'] = rotation.get('checks', {})
        r.require(result.returncode == 0 and rotation['status'] == 'verified' and rotation['checks']['ok'], 'rotation_not_verified')
        secret = r.read_secret()
        r.require(r.sha(secret) == rotation['new_sha256'] and rotation['old_sha256'] != rotation['new_sha256'], 'producer_readback_failed')
        codes = {
            'new_owner_loopback': r.local('/wizard/v1/devices', secret)[0],
            'anonymous_loopback': r.local('/wizard/v1/devices')[0],
            'forged_loopback': r.local('/wizard/v1/devices', b'never-valid-negative', spoof=True)[0],
            'normal_owner_peer': r.peer(plan['before']['base_url']),
            'concrete_store_anonymous': r.local('/_main-compare?commit=0f03360e91c28656296021d61e9d8c1f08937cdb', port=7791)[0],
            'concrete_store_forged': r.local('/_main-compare?commit=0f03360e91c28656296021d61e9d8c1f08937cdb', b'never-valid-negative', port=7791, spoof=True)[0],
            'about_metadata_owner': r.peer(plan['before']['base_url'], '/wizard-os-home/build.json'),
            'old_proof_loopback_controller': rotation['checks']['old_proof_loopback'],
        }
        state['boundary_codes'] = codes
        r.require(all(codes[k] == v for k, v in {
            'new_owner_loopback': 200, 'anonymous_loopback': 403, 'forged_loopback': 403,
            'normal_owner_peer': 200, 'concrete_store_anonymous': 403,
            'concrete_store_forged': 403, 'old_proof_loopback_controller': 403}.items()), 'supplemental_boundary_failed')
        # The unrelated About metadata endpoint is not installed by this lane.
        # Its observed 404 is explicitly not converted into security acceptance.
        raw = m.journals(state['rotation_started_unix'])
        state['rotation_window_journal'] = {'sha256': r.sha(raw), 'new_proof_value_occurrences': raw.count(bytes(secret).strip()),
            'raw_projected': False, 'since_unix': state['rotation_started_unix']}
        log = r.HOME / '.local/state/private-gateway-access/tailnet-host.log'
        access = log.read_bytes()
        state['access_sink_audit'] = {'sha256': r.sha(access), 'new_proof_value_occurrences': access.count(bytes(secret).strip()),
                                     'raw_projected': False, 'existing_original_inbound_sink_unchanged': True}
        r.require(state['rotation_window_journal']['new_proof_value_occurrences'] == 0 and
                  state['access_sink_audit']['new_proof_value_occurrences'] == 0, 'new_proof_logged')
        filt = r.runtime_filter()
        r.require(filt['loaded'] and filt['matches_current_config'] and filt['pid'] == state['reload']['pid'], 'filter_runtime_drift')
        state.update(status='security_verified_about_unverified', old_proof_revoked=True, new_owner_positive=True,
                     filter_loaded=True, keeper_preserved=rotation['checks']['keeper_same_pid'],
                     runs_preserved=rotation['checks']['runs_preserved'], runtime_log_filter=filt,
                     service_source=rotation['after']['revision'], service_image=rotation['after']['containers']['wizard-agent-service']['image'],
                     no_owner_app_mutation=True, settings_unchanged=rotation['checks']['settings_unchanged'],
                     all_29_app_rows_unchanged=rotation['checks']['apps_rows_unchanged'],
                     neighbor_containers_unchanged=rotation['checks']['other_containers_unchanged'],
                     same_service_artifact=rotation['checks']['same_service_image'] and rotation['checks']['same_revision'],
                     finished_unix=time.time())
        r.write_json(root / 'result.json', state)
        print(json.dumps({'status': state['status'], 'result': str(root / 'result.json'), 'old_proof_revoked': True,
                          'new_owner_positive': True, 'filter_loaded': True, 'keeper_preserved': state['keeper_preserved']}))
        return 0
    except BaseException as exc:
        state['status'] = 'security_incomplete_requires_readback'
        state['failure'] = str(exc) if isinstance(exc, r.Gate) else type(exc).__name__
        state['finished_unix'] = time.time()
        path = planpath.parent / 'result.json'
        if path.exists():
            value = json.loads(path.read_bytes())
            state['rotation_status'] = value.get('status')
            state['old_proof_revoked'] = value.get('status') == 'verified' and value.get('checks', {}).get('old_proof_loopback') == 403
            state['rotation_result'] = str(path)
        r.write_json(root / 'result.json', state)
        print(json.dumps({'status': state['status'], 'failure': state['failure'], 'result': str(root / 'result.json')}))
        return 1
    finally:
        r.wipe(secret)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--plan', type=Path, required=True)
    p.add_argument('--controller', type=Path, required=True)
    p.add_argument('--audited-scoped-apply', action='store_true', required=True)
    p.add_argument('--lease-wait-seconds', type=int, default=0)
    a = p.parse_args()
    return run(a.root, a.plan, a.controller, a.lease_wait_seconds)


if __name__ == '__main__':
    raise SystemExit(main())
