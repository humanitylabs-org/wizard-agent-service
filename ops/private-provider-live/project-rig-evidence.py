#!/usr/bin/env python3
"""Project one collected full rig job into the engine's a-f rig-evidence schema.

Every pass is derived from an asserted detailed receipt extracted from the job's
own hash-verified guest evidence archive. Nothing is copied from older seeds; a
missing or failing assertion raises, so a blocked job can never be projected.
"""
import argparse, hashlib, json, tarfile
from pathlib import Path


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while c := f.read(1048576): h.update(c)
    return h.hexdigest()


def project(receipt_path, archive, workdir):
    rig = json.loads(Path(receipt_path).read_text())
    assert rig.get('status') == 'passed', 'rig job did not pass'
    assert rig['guest_evidence']['sha256'] == sha(archive), 'guest evidence archive hash differs from receipt'
    workdir = Path(workdir); workdir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as tf: tf.extractall(workdir, filter='data')
    full = rig['full_result']; runs = full['runs']
    assert [r['status'] for r in runs] == ['passed', 'rolled_back'], 'normal pass + forced rollback pair missing'
    normal = workdir / 'pp-live-receipts' / runs[0]['attempt']; forced = workdir / 'pp-live-receipts' / runs[1]['attempt']
    load = lambda d, n: json.loads((d / n).read_text())
    install, privacy, migrate, verify, regression = (load(normal, n + '.json') for n in ['install', 'privacy', 'migrate', 'verify', 'regression'])
    removal = load(normal, 'provider-removal.json'); rollback = load(forced, 'rollback.json'); failure = load(forced, 'forced-postseal-failure.json')
    run_receipt = load(normal, 'receipt.json')
    for r in [install, privacy, migrate, verify, regression, rollback]: assert r.get('status') == 'passed', r.get('operation')
    mr = verify['migration_readback']
    checks = {
        'a': install.get('app_status') == 'running' and install.get('canonical_registry_unique') is True and install.get('dependency_parity') is True,
        'b': privacy.get('checks_passed') == 6 and all(v == 'passed' for v in privacy['checks'].values()) and privacy['capture'].get('ehbp_header') is True and privacy['capture'].get('codeword_absent') is True and privacy['capture'].get('drops') == 0,
        'c': mr.get('sealed') is True and mr.get('retirement_status') == 'completed' and mr.get('credential_matches') == 0,
        'd': verify.get('completed_migrated_request') is True,
        'e': all(removal.get(k) is True for k in ['provider_removed', 'sealed_record_retained', 'legacy_sidecar_absent', 'sealed_request_recovered_after_reinstall']) and removal.get('visible_unavailable_http') == 503,
        'f': regression.get('other_agent_chat_completed') is True and regression.get('vision_helper_completed') is True and regression.get('colour') == 'red',
    }
    assert all(checks.values()), 'derived checks failed: ' + ','.join(k for k, v in checks.items() if not v)
    assert failure.get('completed_migrated_request') is True and failure['migration_readback']['credential_matches'] == 0
    assert rollback.get('postseal_legacy_restored') is True and rollback.get('completed_legacy_request_after_rollback') is True
    reset = rig['reset']
    assert reset.get('provider_key_present') is False and reset.get('apps') == 0 and reset.get('provider_volumes') == [] and reset.get('remaining_synthetic_containers') == [] and reset.get('remaining_synthetic_agent_dirs') == []
    sources = [Path(receipt_path)] + [normal / (n + '.json') for n in ['privacy', 'regression', 'verify', 'provider-removal', 'install']] + [forced / 'forced-postseal-failure.json', forced / 'rollback.json']
    out = dict(rig)
    out.update(projection_schema=1,
               projection_description='Projection of job-%s detailed receipts; each pass is derived from asserted receipts in its own hash-verified guest evidence.' % rig['job_label'],
               checks={k: 'passed' for k in checks}, privacy_checks_passed=6,
               wam_image_id=run_receipt['before']['containers']['runtipi']['image_id'],
               evidence={'privacy': {**privacy, 'privacy_checks_passed': 6}, 'd-verified': verify,
                         'key-migrated': {'checks': {'key-location': 'passed'}, 'method': 'authenticated trusted-runtime credential-location scan after sealing; global/shared configuration scan is in privacy receipt', 'predicate': 'sealed is true AND retirement_status == completed AND credential_matches == 0', 'migration_readback': mr, 'derived_from': str(normal / 'verify.json')},
                         'f-verified': regression, 'e-verified': removal},
               source_receipts=[{'path': str(p), 'sha256': sha(p)} for p in sources] + [{'path': str(archive), 'sha256': sha(archive)}])
    return out


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--receipt', type=Path, required=True); p.add_argument('--archive', type=Path, required=True)
    p.add_argument('--workdir', type=Path, required=True); p.add_argument('--output', type=Path, required=True)
    a = p.parse_args(); data = project(a.receipt, a.archive, a.workdir)
    assert not a.output.exists(), 'refusing to overwrite an existing projection'
    a.output.write_text(json.dumps(data, indent=2) + '\n'); a.output.chmod(0o600)
    print(json.dumps({'output': str(a.output), 'sha256': sha(a.output), 'checks': data['checks'], 'full_live_run_all': {k: data['full_live_run_all'][k] for k in ['normal_status', 'forced_failure_status', 'provider_image_id']}}))


if __name__ == '__main__':
    main()
