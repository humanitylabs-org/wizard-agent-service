#!/usr/bin/env python3
"""Standalone, model-blind Caddy default-error encoder activation only.

REUSE: owner-proof-rotation.py protection/snapshot/controller helpers and the
parent-admitted native fixture. No route, grant, Service source or UI changes.
The original mixed receipt remains accepted:false. This component gate is not
About browser acceptance. Run prepare, then apply --audited-scoped-apply.
"""
import argparse
import copy
import fcntl
import glob
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import time

spec = importlib.util.spec_from_file_location('rotation', Path(__file__).with_name('owner-proof-rotation.py'))
assert spec is not None and spec.loader is not None
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
BINARY = r.HOME / '.local/bin/caddy-private-gateway'
HEADER_FIELDS = ['request>headers>X-Wizard-Owner-Proof', 'request>headers>x-wizard-owner-proof']


def block(candidate):
    text = candidate.decode()
    a = text.index('    log default {')
    b = re.search(r'^\s*admin off', text[a:], re.MULTILINE)
    r.require(b is not None, 'fixture_admin_marker_missing')
    value = text[a:a + b.start()].rstrip() + '\n'
    expected = ('    log default {\n        format filter {\n            wrap json\n'
                '            fields {\n                request>headers>X-Wizard-Owner-Proof delete\n'
                '                request>headers>x-wizard-owner-proof delete\n'
                '            }\n        }\n    }\n')
    r.require(value == expected, 'unexpected_fixture_logger')
    return value.encode()


def env_for(pid):
    return dict(x.split(b'=', 1) for x in Path('/proc', str(pid), 'environ').read_bytes().split(b'\0') if b'=' in x)


def adapt(path, pid):
    p = subprocess.run([str(BINARY), 'adapt', '--config', str(path), '--adapter', 'caddyfile', '--validate'],
                       env=env_for(pid), capture_output=True, timeout=30)
    r.require(p.returncode == 0, 'caddy_validation_failed')
    return json.loads(p.stdout)


def normalize_candidate_hide(value, path):
    """Adapt hides its input filename; substitute only that exact generated entry."""
    value = copy.deepcopy(value)
    count = 0
    def visit(x):
        nonlocal count
        if isinstance(x, dict):
            if x.get('handler') == 'file_server' and str(path) in x.get('hide', []):
                r.require(str(r.GATEWAY) not in x['hide'], 'ambiguous_generated_hide')
                x['hide'] = sorted(str(r.GATEWAY) if v == str(path) else v for v in x['hide'])
                count += 1
            for v in x.values():
                visit(v)
        elif isinstance(x, list):
            for v in x:
                visit(v)
    visit(value)
    r.require(count > 0, 'candidate_generated_hide_missing')
    return value


def closure():
    files, patterns = {}, {}
    def visit(path):
        path = Path(path).resolve(strict=True)
        if str(path) in files:
            return
        text = path.read_text()
        files[str(path)] = r.hashfile(path)
        for line in text.splitlines():
            match = re.match(r'^\s*import\s+(\S+)', line)
            if not match:
                continue
            token = match[1].strip('"')
            if '/' not in token and '.' not in token:
                continue  # named Caddy snippet, not a file
            r.require('{' not in token and '$' not in token, 'dynamic_import_refused')
            pattern = str(path.parent / token) if not token.startswith('/') else token
            names = sorted(glob.glob(pattern))
            patterns[pattern] = names
            for name in names:
                visit(name)
    visit(r.GATEWAY)
    return {'files': files, 'patterns': patterns}


def identity():
    pid = r.unit('private-gateway-https.service')['pid']
    proc = Path('/proc', str(pid))
    return {'pid': pid, 'start_ticks': proc.joinpath('stat').read_text().split()[21],
            'argv_sha256': r.sha(proc.joinpath('cmdline').read_bytes()),
            'binary_sha256': r.hashfile(BINARY), 'exe_sha256': r.hashfile(proc / 'exe'),
            'unit_exec_sha256': r.sha(r.cmd(['systemctl', '--user', 'show', 'private-gateway-https.service', '-p', 'ExecStart']))}


def snapshot():
    value = r.snapshot()
    value['gateway_identity'] = identity()
    value['imports'] = closure()
    value['controls'] = {str(p): r.hashfile(p) for p in [
        r.HOME / 'worktrees/private-portfolio/private-routes.json',
        r.HOME / 'worktrees/private-portfolio/private-route-adapter.mjs']}
    return value


def equivalent(before, after, gateway_changed=False):
    for key in ['release', 'revision', 'service', 'units', 'containers', 'apps_count',
                'apps_rows_sha256', 'settings_sha256', 'base_url', 'gateway_identity', 'controls']:
        r.require(before[key] == after[key], 'identity_drift_' + key)
    r.require(before['keeper']['pid'] == after['keeper']['pid'], 'keeper_drift')
    a, b = copy.deepcopy(before['source_hashes']), copy.deepcopy(after['source_hashes'])
    if gateway_changed:
        a.pop(str(r.GATEWAY)); b.pop(str(r.GATEWAY))
    r.require(a == b, 'source_drift')
    a, b = copy.deepcopy(before['imports']), copy.deepcopy(after['imports'])
    if gateway_changed:
        a['files'].pop(str(r.GATEWAY)); b['files'].pop(str(r.GATEWAY))
    r.require(a == b, 'import_closure_drift')
    r.require(after['apps_count'] == 29, 'app_census_mismatch')


def evidence(root, fixture):
    raw = root / 'receipt.raw.json'
    receipt = json.loads(raw.read_bytes())
    manifest = fixture / 'manifest.json'
    m = json.loads(manifest.read_bytes())
    r.require(receipt['manifest_sha256'] == r.hashfile(manifest), 'receipt_manifest_mismatch')
    for name, h in m['inputs'].items():
        r.require(r.hashfile(fixture / name) == h, 'fixture_input_drift')
    s, f = receipt['source_regressions'], receipt['fixture']
    r.require(receipt['accepted'] is False and s['accepted'] and s['test_count'] == 11
              and s['skipped'] == s['errors'] == s['failures'] == 0, 'source_acceptance')
    r.require(f['accepted'] and f['all_processes_stopped'] and f['check_count'] == len(f['checks']) == 43
              and all(x['pass'] for x in f['checks']), 'native_fixture_acceptance')
    r.require(all(f['redaction'][k] for k in ['byte_identical_client_request', 'only_encoder_changed',
              'unfiltered_proof_and_control_present', 'filtered_control_retained',
              'filtered_proof_key_and_value_absent', 'actual_unfiltered_negative_rejected']), 'discriminating_evidence')
    spec = importlib.util.spec_from_file_location('fixture', fixture / 'forum_qa.py')
    assert spec is not None and spec.loader is not None
    oracle = importlib.util.module_from_spec(spec); spec.loader.exec_module(oracle)
    original = json.loads((root / 'forum-error.unfiltered.json').read_bytes())
    filtered = json.loads((root / 'forum-error.filtered.json').read_bytes())
    r.require(oracle.redaction_pair(original, filtered), 'actual_pair_failed')
    rejected = False
    try:
        oracle.redaction_pair(original, original)
    except AssertionError:
        rejected = True
    r.require(rejected, 'actual_negative_control_not_rejected')
    logger = block((fixture / 'Caddyfile.candidate').read_bytes())
    native = (root / 'forum-fixture.filtered.caddy').read_bytes()
    r.require(block(native) == logger, 'native_logger_bytes_mismatch')
    review = json.loads((root / 'opus-raw.json').read_bytes())
    r.require(not review.get('is_error') and not review.get('permission_denials')
              and review['result'].startswith('**APPROVE**'), 'independent_judgment_missing')
    return {'scope': 'security component only; About UI unverified', 'original_accepted': False,
            'receipt_sha256': r.hashfile(raw), 'manifest_sha256': r.hashfile(manifest),
            'source_units': 11, 'native_checks': 43, 'logger_sha256': r.sha(logger),
            'actual_pair_sha256': [r.hashfile(root / n) for n in ['forum-error.unfiltered.json', 'forum-error.filtered.json']],
            'fixture_candidate_sha256': r.hashfile(fixture / 'Caddyfile.candidate'),
            'review_sha256': r.hashfile(root / 'opus-raw.json'),
            'carrier_guard': 'canonical live config hash + import closure sealed; About owner must rebase from this loaded config',
            'other_logger_adjudication': 'existing access file captures original inbound client request, not injected producer proof; no debug sinks; preserved unchanged'}, logger


def atomic(path, data, mode):
    temp = path.with_name('.security-' + secrets.token_hex(8))
    try:
        fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
        with os.fdopen(fd, 'wb') as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
        os.chmod(temp, mode); os.replace(temp, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        temp.unlink(missing_ok=True)


def journals(start):
    return r.cmd(['journalctl', '--user', '-u', 'private-gateway-https.service', '--since', '@' + str(start),
                  '--no-pager', '-o', 'cat'], timeout=15)


def reload(pid):
    start = time.time(); os.kill(pid, signal.SIGUSR1)
    for _ in range(60):
        r.require(r.unit('private-gateway-https.service')['pid'] == pid, 'gateway_pid_changed')
        raw = journals(start)
        events = []
        for line in raw.splitlines():
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get('msg') == 'successfully reloaded config from file':
                events.append({'event': d['msg'], 'timestamp': d.get('ts')})
        if events:
            return {'pid': pid, 'same_pid': True, 'positive_event_count': len(events), 'events': events,
                    'journal_sha256': r.sha(raw), 'raw_journal_projected': False}
        time.sleep(.2)
    raise r.Gate('positive_reload_event_missing')


def is_error_logger(name):
    return name == 'http.log.error' or name.startswith('http.log.error.')


def canary(root, base):
    # An already-existing, already-closed upstream; no listener/route changes.
    marker = 'security-logger-' + secrets.token_hex(10)
    path = '/extensions/e-ink-skin/assets/' + marker + '.txt'
    proof = 'never-valid-live-' + secrets.token_hex(24)
    start = time.time()
    import shlex
    command = ('curl --silent --max-time 15 --output /dev/null --write-out %{http_code} '
               + '-H ' + shlex.quote('X-Wizard-Owner-Proof: ' + proof) + ' -H '
               + shlex.quote('X-Redaction-Control: ' + marker) + ' ' + shlex.quote(base + path))
    code = r.cmd(['ssh', '-oBatchMode=yes', '-oConnectTimeout=8', 'thales', command], timeout=25).decode().strip()
    r.require(code == '502', 'existing_canary_upstream_no_longer_closed')
    raw, events = b'', []
    for _ in range(20):
        raw = journals(start); events = []
        for line in raw.splitlines():
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get('request', {}).get('uri') == path and is_error_logger(d.get('logger', '')):
                events.append(d)
        if events:
            break
        time.sleep(.1)
    r.require(len(events) == 1, 'canary_event_count')
    d = events[0]; headers = {k.lower(): v for k, v in d['request']['headers'].items()}
    r.require(d['status'] == 502 and headers.get('x-redaction-control') == [marker]
              and 'x-wizard-owner-proof' not in headers and proof.encode() not in raw, 'live_canary_deletion_failed')
    return {'http': 502, 'actual_error_events': len(events), 'path_retained': True, 'control_retained': True,
            'proof_key_absent': True, 'proof_value_absent': True, 'journal_sha256': r.sha(raw),
            'no_route_added': True, 'synthetic_only': True}


def prepare(root, fixture):
    admitted, logger = evidence(root, fixture)
    before = snapshot(); live = r.GATEWAY.read_bytes()
    r.require(live.startswith(b'{\n') and b'log default {' not in live, 'global_logger_already_present_or_shape_changed')
    token = r.read_secret()
    try:
        r.require(bytes(token).strip() not in live, 'literal_secret_in_config')
    finally:
        r.wipe(token)
    target = live[:2] + logger + live[2:]
    mode = r.GATEWAY.stat().st_mode & 0o777
    atomic(root / 'Caddyfile.security.candidate', target, 0o600)
    pid = before['gateway_identity']['pid']
    old = adapt(r.GATEWAY, pid)
    new = normalize_candidate_hide(adapt(root / 'Caddyfile.security.candidate', pid), root / 'Caddyfile.security.candidate')
    r.require(old == json.loads(Path(before['runtime_log_filter']['autosave_path']).read_bytes()), 'autosave_not_current')
    reduced = copy.deepcopy(new)
    encoder = reduced['logging']['logs']['default'].pop('encoder')
    r.require(reduced == old, 'non_encoder_runtime_delta')
    r.require(encoder == {'format': 'filter', 'wrap': {'format': 'json'},
              'fields': {name: {'filter': 'delete'} for name in HEADER_FIELDS}}, 'unexpected_encoder')
    # Other sink stays byte-equivalent. Error logger inherits default; no debug
    # logging is enabled. Access uses original inbound snapshot, independently
    # established by the native fixture and audited for real proof below.
    r.require(all(v.get('level', 'INFO') != 'DEBUG' for v in old['logging']['logs'].values()), 'debug_sink_refused')
    r.write_json(root / 'activation-plan.json', {'before': before, 'evidence': admitted,
                 'before_sha256': r.sha(live), 'candidate_sha256': r.sha(target), 'mode': mode,
                 'script_sha256': r.hashfile(__file__), 'fixture': str(fixture), 'prepared_unix': time.time()})
    r.write_json(root / 'component-acceptance.json', admitted)
    return {'status': 'prepared_security_component_only', 'filter_loaded': False,
            'same_artifact_service': before['revision'], 'fixture_checks': 43, 'source_units': 11}


def apply(root):
    plan = json.loads((root / 'activation-plan.json').read_bytes())
    r.require(r.hashfile(__file__) == plan['script_sha256'], 'script_drift')
    admitted, _ = evidence(root, Path(plan['fixture']))
    r.require(admitted == plan['evidence'], 'evidence_drift')
    result = {'status': 'preflight', 'scope': admitted['scope'], 'old_proof_revoked': False,
              'started_unix': time.time(), 'rollback_status': 'not_needed'}
    r.write_json(root / 'result.json', result)
    with (r.HOME / '.local/state/wizard-app-promotions/wam.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        before = r.GATEWAY.read_bytes(); target = (root / 'Caddyfile.security.candidate').read_bytes()
        r.require(r.sha(before) == plan['before_sha256'] and r.sha(target) == plan['candidate_sha256'], 'config_cas_drift')
        equivalent(plan['before'], snapshot())
        pid = plan['before']['gateway_identity']['pid']
        expected = normalize_candidate_hide(adapt(root / 'Caddyfile.security.candidate', pid), root / 'Caddyfile.security.candidate')
        r.require(r.hashfile(r.GATEWAY) == plan['before_sha256'], 'late_config_drift')
        changed = False
        try:
            atomic(r.GATEWAY, target, plan['mode']); changed = True
            result['reload'] = reload(pid)
            after = snapshot()
            equivalent(plan['before'], after, gateway_changed=True)
            r.require(r.GATEWAY.read_bytes() == target and after['runtime_log_filter']['loaded']
                      and after['runtime_log_filter']['matches_current_config'], 'loaded_filter_mismatch')
            loaded = json.loads(Path(after['runtime_log_filter']['autosave_path']).read_bytes())
            r.require(loaded == expected, 'loaded_json_mismatch')
            result['canary'] = canary(root, after['base_url'])
            r.require(r.peer(after['base_url']) == 200, 'owner_peer_failed')
            r.require(r.local('/wizard/v1/devices')[0] == 403 and
                      r.local('/wizard/v1/devices', b'never-valid-forged', spoof=True)[0] == 403, 'boundary_changed')
            result.update(status='filter_loaded_verified_rotation_pending', filter_loaded=True,
                same_gateway_pid=True, service_unchanged=True, all_29_app_rows_unchanged=True,
                neighbor_containers_unchanged=True, settings_unchanged=True, after=after,
                config_sha256=r.hashfile(r.GATEWAY), evidence=admitted)
            r.write_json(root / 'result.json', result)
            return result
        except BaseException as exc:
            result['failure'] = str(exc) if isinstance(exc, r.Gate) else type(exc).__name__
            if changed:
                if r.GATEWAY.read_bytes() != target:
                    result['rollback_status'] = 'refused_sibling_drift'
                else:
                    try:
                        atomic(r.GATEWAY, before, plan['mode']); reload(pid)
                        r.require(r.GATEWAY.read_bytes() == before and r.runtime_filter()['matches_current_config'], 'rollback_readback')
                        result['rollback_status'] = 'own_cas_restored_verified'
                    except BaseException as rollback:
                        result['rollback_status'] = 'recovery_required'
                        result['rollback_failure'] = str(rollback) if isinstance(rollback, r.Gate) else type(rollback).__name__
            result['status'] = 'activation_failed_no_rotation'
            r.write_json(root / 'result.json', result)
            raise


def main():
    r.protect()
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['prepare', 'apply'])
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--fixture', type=Path)
    p.add_argument('--audited-scoped-apply', action='store_true')
    a = p.parse_args()
    r.require(a.root.is_dir(), 'root_missing')
    if a.action == 'prepare':
        r.require(a.fixture is not None, 'fixture_required')
        out = prepare(a.root, a.fixture)
    else:
        r.require(a.audited_scoped_apply, 'explicit_scoped_apply_required')
        out = apply(a.root)
    print(json.dumps({k: out[k] for k in ['status', 'filter_loaded', 'old_proof_revoked'] if k in out}))


if __name__ == '__main__':
    try:
        main()
    except BaseException as exc:
        if isinstance(exc, SystemExit):
            raise
        print(json.dumps({'status': 'blocked', 'failure': str(exc) if isinstance(exc, r.Gate) else type(exc).__name__}))
        raise SystemExit(1)
