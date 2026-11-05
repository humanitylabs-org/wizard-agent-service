#!/usr/bin/env python3
"""Coordinated generated-proof rotation; no credentials in output or argv.

Prepare a host-local hash-only plan, then run --apply through the host's supported
restart reporter. No Service/auth implementation or gateway config is changed.
Existing CMS custody is mandatory. A loaded gateway runtime deletion filter is a
prerequisite, because a restart's 502 must not log the newly generated proof.
"""
from __future__ import annotations

import argparse
import base64
import ctypes
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import resource
import secrets
import signal
import socket
import stat
import subprocess
import sys
import time

HOME = Path.home()
SCRIPTS = HOME / '.hermes/scripts'
PROOF = HOME / '.config/private-gateway/owner-proof'
CURRENT = HOME / '.local/share/wizard-mobile-server/current'
GATEWAY = HOME / '.config/private-gateway/Caddyfile'
CERT = HOME / '.hermes/backup_keys/hermes_backup_public_cert.pem'
KEY = HOME / '.hermes/backup_keys/hermes_backup_private_key.pem'
PASSFILE = HOME / '.hermes/backup_keys/hermes_backup_passphrase.txt'
HEADER = 'X-Wizard-Owner-Proof'
SERVICE = 'wizard-mobile.service'
KEEPER = 'wizard-run-keeper.service'
OLD_STATUSES = {'running', 'queued', 'launching', 'waiting_for_approval', 'stopping'}
UNITS = [KEEPER, 'hermes-gateway.service', 'private-gateway-https.service',
         'private-app-route-adapter.service', 'private-tailnet-auth.service',
         'tailscale-private-gateway.service', 'wizard-heavy-rpc.service']


class Gate(Exception):
    """Fixed diagnostic identifiers only. Never wrap arbitrary error strings."""


def require(ok, code):
    if not ok:
        raise Gate(code)


def protect():
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    require(ctypes.CDLL(None).prctl(4, 0) == 0, 'process_not_protected')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def hashfile(path):
    return sha(Path(path).read_bytes())


def write_json(path, value):
    path = Path(path)
    tmp = path.with_name('.' + path.name + '.' + secrets.token_hex(6))
    with open(tmp, 'x', encoding='utf-8') as f:
        json.dump(value, f, sort_keys=True, indent=2)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def cmd(argv, *, data=None, timeout=30):
    # Raw subprocess output is retained only in memory and never incorporated into
    # an exception, report or log. This includes failed HTTP/crypto/controllers.
    r = subprocess.run([str(x) for x in argv], input=data, capture_output=True, timeout=timeout)
    require(r.returncode == 0, 'command_failed_' + Path(str(argv[0])).name)
    return r.stdout


def unit(name):
    raw = cmd(['systemctl', '--user', 'show', name,
               '--property=MainPID,ActiveState,ExecMainStartTimestampMonotonic'])
    fields = dict(line.split('=', 1) for line in raw.decode().splitlines() if '=' in line)
    return {'pid': int(fields['MainPID']), 'state': fields['ActiveState'],
            'start': fields['ExecMainStartTimestampMonotonic']}


def keeper():
    c = http.client.HTTPConnection('localhost', timeout=5)
    c.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    c.sock.settimeout(5)
    c.sock.connect(str(HOME / '.hermes/state/wizard-mobile/run-stream-keeper.sock'))
    try:
        c.request('GET', '/health')
        r = c.getresponse()
        v = json.loads(r.read())
        require(r.status == 200 and v.get('ok') is True, 'keeper_unhealthy')
        return {k: v[k] for k in ('pid', 'streams', 'detached')}
    finally:
        c.close()


def local(path, token=None, port=8923, spoof=False):
    headers = {}
    if token is not None:
        headers[HEADER] = bytes(token).decode().strip()
    if spoof:
        headers.update({'Origin': 'https://attacker.invalid',
                        'Tailscale-User-Login': 'forged@example.invalid',
                        'X-Forwarded-User': 'owner'})
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=8)
    try:
        c.request('GET', path, headers=headers)
        r = c.getresponse()
        # Bodies and headers never escape this private function except the health
        # boolean or explicitly selected run status. No response/header tracing.
        data = r.read(8 * 1024 * 1024)
        return r.status, data
    finally:
        headers.clear()
        c.close()


def peer(base, path='/wizard/v1/devices'):
    # Actual peer's ordinary trusted-TLS request; no identity or proof injection.
    url = base + path
    import shlex
    argv = ['ssh', '-oBatchMode=yes', '-oConnectTimeout=8', 'thales',
            'curl --silent --max-time 15 --output /dev/null --write-out %{http_code} ' + shlex.quote(url)]
    out = cmd(argv, timeout=30).decode().strip()
    require(out.isdigit(), 'peer_no_http_status')
    return int(out)


def read_secret():
    st = PROOF.lstat()
    require(stat.S_ISREG(st.st_mode) and stat.S_IMODE(st.st_mode) == 0o600
            and st.st_uid == os.getuid() and st.st_nlink == 1, 'proof_file_protection')
    fd = os.open(PROOF, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        require(os.fstat(fd).st_ino == st.st_ino, 'proof_changed_during_open')
        data = bytearray(os.read(fd, 4096))
    finally:
        os.close(fd)
    require(32 <= len(data.strip()) <= 1024, 'proof_length')
    return data


def wipe(buf):
    if isinstance(buf, bytearray):
        buf[:] = b'\x00' * len(buf)


def cas_replace(expected, new):
    # Existing host + deployment leases serialize this operation with supported
    # maintenance. Also lock the old inode and recheck path+digest immediately
    # before the atomic rename; temp is 0600 in the existing protected directory.
    fd = os.open(PROOF, os.O_RDONLY | os.O_NOFOLLOW)
    tmp = PROOF.with_name('.owner-proof.rotate-' + secrets.token_hex(8))
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        st = os.fstat(fd)
        require(stat.S_IMODE(st.st_mode) == 0o600 and st.st_nlink == 1, 'cas_mode')
        require(sha(os.read(fd, 4096)) == expected, 'cas_digest')
        out = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            view = memoryview(new)
            while view:
                view = view[os.write(out, view):]
            os.fsync(out)
        finally:
            os.close(out)
        live = PROOF.lstat()
        require((st.st_ino, st.st_dev) == (live.st_ino, live.st_dev)
                and hashfile(PROOF) == expected, 'cas_path_changed')
        os.replace(tmp, PROOF)
        dfd = os.open(PROOF.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
        require(hashfile(PROOF) == sha(new), 'cas_readback')
    finally:
        tmp.unlink(missing_ok=True)
        os.close(fd)


def crypto(old, new, recovery):
    require(not recovery.exists(), 'recovery_already_exists')
    # Private values enter OpenSSL through anonymous pipes only. Recovery is
    # ciphertext from its first byte; no plaintext backup/staging artifact.
    payload = bytearray(json.dumps({'old': bytes(old).decode(), 'new': bytes(new).decode()}).encode())
    restored = None
    try:
        encrypted = cmd(['openssl', 'cms', '-encrypt', '-binary', '-aes-256-cbc',
                         '-outform', 'DER', CERT], data=payload)
        with open(recovery, 'xb') as f:
            f.write(encrypted)
            f.flush()
            os.fsync(f.fileno())
        restored = bytearray(cmd(['openssl', 'cms', '-decrypt', '-binary', '-inform', 'DER',
                                 '-recip', CERT, '-inkey', KEY, '-passin', 'file:' + str(PASSFILE)], data=encrypted))
        require(secrets.compare_digest(payload, restored), 'encrypted_recovery_roundtrip')
        return {'path': str(recovery), 'sha256': sha(encrypted), 'roundtrip': True,
                'certificate_sha256': hashfile(CERT)}
    finally:
        wipe(payload)
        wipe(restored)


def runtime_filter():
    u = unit('private-gateway-https.service')
    require(u['state'] == 'active', 'gateway_inactive')
    env = dict(x.split(b'=', 1) for x in Path('/proc/' + str(u['pid']) + '/environ').read_bytes().split(b'\0') if b'=' in x)
    confroot = Path(env.get(b'XDG_CONFIG_HOME', str(HOME / '.config').encode()).decode())
    autosave = confroot / 'caddy/autosave.json'
    loaded = json.loads(autosave.read_bytes())
    adapted = json.loads(cmd([HOME / '.local/bin/caddy-private-gateway', 'adapt',
                              '--config', GATEWAY, '--adapter', 'caddyfile']))
    encoder = loaded.get('logging', {}).get('logs', {}).get('default', {}).get('encoder', {})
    fields = encoder.get('fields', {})
    deleted = all(fields.get('request>headers>' + name, {}).get('filter') == 'delete'
                  for name in ('X-Wizard-Owner-Proof', 'x-wizard-owner-proof'))
    return {'loaded': encoder.get('format') == 'filter' and deleted,
            'autosave_path': str(autosave), 'autosave_sha256': hashfile(autosave),
            'matches_current_config': adapted == loaded,
            'pid': u['pid']}


def containers():
    values = json.loads(cmd(['docker', 'inspect', *cmd(['docker', 'ps', '-q']).decode().split()]))
    # Project before any persistence; never dump inspect.Env or mount contents.
    projected = {}
    for x in values:
        name = x['Name'].lstrip('/')
        cfg = x.get('Config', {})
        value = {'id': x['Id'], 'image': x['Image'], 'started': x['State']['StartedAt'],
                 'revision': (cfg.get('Labels') or {}).get('org.opencontainers.image.revision', '')}
        if name == 'wizard-agent-service':
            env = dict(v.split('=', 1) for v in cfg.get('Env', []) if '=' in v)
            value['proof_file_bound'] = env.get('WIZARD_OWNER_PROOF_FILE') == str(PROOF)
            value['entry_sha256'] = sha(json.dumps([cfg.get('Entrypoint'), cfg.get('Cmd')]).encode())
        projected[name] = value
    return projected


def runs():
    data = json.loads(cmd([sys.executable, SCRIPTS / 'wizard_drain_restart.py', 'status']))
    return [{k: r[k] for k in ('session_id', 'status', 'run_id')} for r in data['active_runs']]


def source_hashes():
    root = CURRENT.resolve(strict=True)
    paths = [root / 'server' / x for x in ('index.mjs', 'principals.mjs', 'run-stream-keeper.mjs',
             'locked-run-bridge.mjs', 'service-lifetime.mjs', 'service.mjs')]
    paths += [root / 'SERVER_TREE', root / 'RELEASE_SHA',
              HOME / '.config/systemd/user/wizard-mobile.service',
              HOME / '.config/wizard-mobile/runtime.env',
              GATEWAY, HOME / '.config/private-gateway/wizard-scroll-diagnostics.Caddyfile',
              SCRIPTS / 'wizard_drain_restart.py', SCRIPTS / 'wizard_restart_report.py',
              HOME / '.local/bin/wizard-agent-service-container']
    dropins = HOME / '.config/systemd/user/wizard-mobile.service.d'
    if dropins.is_dir():
        paths += sorted(dropins.glob('*.conf'))
    return {str(p): hashfile(p) for p in paths}


def snapshot():
    settings = json.loads((HOME / '.wizard-os/settings.json').read_bytes())
    apps = json.loads((HOME / '.wizard-os/apps.json').read_bytes())['apps']
    root = CURRENT.resolve(strict=True)
    return {'release': str(root), 'revision': (root / 'RELEASE_SHA').read_text().strip(),
            'service': unit(SERVICE), 'units': {n: unit(n) for n in UNITS},
            'keeper': keeper(), 'source_hashes': source_hashes(), 'containers': containers(),
            'apps_count': len(apps), 'apps_rows_sha256': sha(json.dumps(apps, sort_keys=True).encode()),
            'settings_sha256': hashfile(HOME / '.wizard-os/settings.json'),
            'base_url': settings['network']['base_url'].rstrip('/'), 'runs': runs(),
            'runtime_log_filter': runtime_filter()}


def store_path(before):
    import re
    revision = before['containers']['wizard-interface-candidate']['revision']
    require(re.fullmatch(r'[0-9a-f]{40}', revision) is not None, 'shell_revision_unavailable')
    return '/wizard-os-home/store-install/_main-compare?commit=' + revision


def preflight(plan):
    require(hashfile(PROOF) == plan['old_sha256'], 'old_proof_drift')
    before = plan['before']
    live = snapshot()
    for key in ('release', 'revision', 'source_hashes', 'containers', 'apps_count',
                'apps_rows_sha256', 'settings_sha256', 'base_url'):
        require(live[key] == before[key], 'preflight_drift_' + key)
    require(live['service'] == before['service'], 'preflight_service_identity_drift')
    require(live['units'] == before['units'], 'preflight_neighbor_identity_drift')
    require(live['keeper']['pid'] == before['keeper']['pid'], 'keeper_identity_drift')
    require(live['units'][KEEPER]['state'] == 'active', 'keeper_not_active')
    require(live['runtime_log_filter']['loaded']
            and live['runtime_log_filter']['matches_current_config'], 'runtime_proof_header_redaction_not_loaded')
    require(live['containers']['wizard-agent-service']['proof_file_bound'], 'consumer_file_binding_mismatch')
    require(peer(before['base_url']) == 200, 'preflight_owner_peer')
    require(local('/_main-compare', port=7791)[0] == 403, 'preflight_store_root_peer_boundary')
    require(peer(before['base_url'], store_path(before)) == 200, 'preflight_store_owner_peer')
    token = read_secret()
    try:
        require(local('/wizard/v1/devices', token)[0] == 200, 'preflight_captured_verifier')
        require(local('/wizard/v1/devices')[0] == 403
                and local('/wizard/v1/devices', b'rotation-negative-forged-not-a-credential', spoof=True)[0] == 403,
                'preflight_private_boundary')
    finally:
        wipe(token)
    return live


def restart():
    require(unit(KEEPER)['state'] == 'active', 'keeper_lost_before_restart')
    keeper()
    cmd([sys.executable, SCRIPTS / 'wizard_drain_restart.py', 'restart', 'wizard-mobile'], timeout=150)
    deadline = time.monotonic() + 40
    while True:
        try:
            code, data = local('/wizard/health')
            value = json.loads(data)
            if code == 200 and value.get('status') == 'ok' and value.get('upstream_reachable') is True:
                return
        except Exception:
            pass
        require(time.monotonic() < deadline, 'service_health_timeout')
        time.sleep(0.5)


def verify(plan, old, new):
    before = plan['before']
    newcode, _ = local('/wizard/v1/devices', new)
    oldcode, _ = local('/wizard/v1/devices', old)
    anonymous, _ = local('/wizard/v1/devices')
    forged, _ = local('/wizard/v1/devices', b'rotation-negative-forged-not-a-credential', spoof=True)
    shell, _ = local('/wizard/hermes/v1/agents', b'rotation-negative-forged-not-a-credential', port=8928, spoof=True)
    realpeer = peer(before['base_url'])
    store_denied, _ = local('/_main-compare', port=7791)
    store_owner = peer(before['base_url'], store_path(before))
    after = snapshot()
    others_before = {k: v for k, v in before['containers'].items() if k != 'wizard-agent-service'}
    others_after = {k: v for k, v in after['containers'].items() if k != 'wizard-agent-service'}
    results = {'new_proof_loopback': newcode, 'old_proof_loopback': oldcode,
               'anonymous_loopback': anonymous, 'forged_loopback': forged,
               'forged_shell': shell, 'real_peer_owner': realpeer,
               'store_direct_root_peer_only_boundary': store_denied, 'store_real_peer_owner': store_owner,
               'same_revision': after['revision'] == before['revision'],
               'same_release': after['release'] == before['release'],
               'same_service_image': after['containers']['wizard-agent-service']['image'] == before['containers']['wizard-agent-service']['image'],
               'same_service_entry': after['containers']['wizard-agent-service']['entry_sha256'] == before['containers']['wizard-agent-service']['entry_sha256'],
               'consumer_file_binding_correct': after['containers']['wizard-agent-service']['proof_file_bound'],
               'source_hashes_unchanged': after['source_hashes'] == before['source_hashes'],
               'service_restarted': after['service']['pid'] != before['service']['pid'],
               'keeper_same_pid': after['keeper']['pid'] == before['keeper']['pid'],
               'neighbor_units_unchanged': after['units'] == before['units'],
               'gateway_loaded_config_unchanged': after['runtime_log_filter']['autosave_sha256'] == before['runtime_log_filter']['autosave_sha256'],
               'other_containers_unchanged': others_after == others_before,
               'apps_count': after['apps_count'],
               'apps_rows_unchanged': after['apps_rows_sha256'] == before['apps_rows_sha256'],
               'settings_unchanged': after['settings_sha256'] == before['settings_sha256']}
    statuses = []
    for r in before['runs']:
        if not r['run_id']:
            statuses.append({'session_id': r['session_id'], 'was': r['status'],
                             'retained_in_queue': any(x['session_id'] == r['session_id'] for x in after['runs'])})
            continue
        code, data = local('/wizard/hermes/v1/runs/' + r['run_id'], new)
        status = json.loads(data).get('status') if code == 200 else None
        statuses.append({'run_id': r['run_id'], 'was': r['status'], 'http': code, 'now': status})
    results['run_statuses'] = statuses
    results['runs_preserved'] = all(x.get('retained_in_queue', x.get('http') == 200 and x.get('now') in
                                             {'running', 'completed', 'waiting_for_approval', 'queued', 'stopping'}) for x in statuses)
    assertions = [newcode == 200, oldcode == 403, anonymous == 403, forged == 403,
                  shell == plan.get('shell_negative_expected', 404), realpeer == 200,
                  store_denied == 403, store_owner == 200, results['apps_count'] == 29]
    assertions += [v for k, v in results.items() if isinstance(v, bool)]
    results['ok'] = all(assertions)
    return results, after


def operate(plan_path):
    plan = json.loads(plan_path.read_bytes())
    statepath = plan_path.parent / 'result.json'
    sys.path.insert(0, str(SCRIPTS))
    from hermes_state_maintenance_lock import maintenance_lock
    old = new = None
    mutated = False
    state = {'status': 'preflight', 'plan': str(plan_path), 'started_unix': time.time(),
             'old_sha256': plan['old_sha256']}
    write_json(statepath, state)
    try:
        with maintenance_lock('generated-owner-proof-coordinated-rotation'):
            lock = open(HOME / '.local/state/wizard-agent-service-deploy.lock', 'a')
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                actual = preflight(plan)
                state['before_actual_runs'] = actual['runs']
                # Include newly arrived runs, not just those present at preparation.
                plan['before']['runs'] = actual['runs']
                old = read_secret()
                new = bytearray(base64.urlsafe_b64encode(secrets.token_bytes(48)).rstrip(b'='))
                state['new_sha256'] = sha(new)
                recovery = HOME / '.hermes/secure/owner-proof-rotation' / (str(int(time.time())) + '.cms')
                recovery.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                state['recovery'] = crypto(old, new, recovery)
                # Seal everything before the first write; no plaintext in this journal.
                state['status'] = 'armed'
                write_json(statepath, state)
                preflight(plan)
                cas_replace(plan['old_sha256'], new)
                mutated = True
                state['status'] = 'producer_replaced_restart_in_progress'
                write_json(statepath, state)
                restart()
                checks, after = verify(plan, old, new)
                state.update(checks=checks, after=after)
                require(checks['ok'], 'post_restart_acceptance_failed')
                state['status'] = 'verified'
                state['finished_unix'] = time.time()
                write_json(statepath, state)
                return 0
            except BaseException as exc:
                state['failure'] = str(exc) if isinstance(exc, Gate) else type(exc).__name__
                if mutated:
                    # Compensation is coordinated too: never return a restored producer
                    # while knowingly leaving the new captured verifier serving.
                    try:
                        cas_replace(sha(new), old)
                        restart()
                        require(local('/wizard/v1/devices', old)[0] == 200
                                and local('/wizard/v1/devices', new)[0] == 403, 'rollback_verifier_mismatch')
                        require(peer(plan['before']['base_url']) == 200, 'rollback_peer_failed')
                        state['status'] = 'rolled_back_consistent_security_not_contained'
                    except BaseException as recovery_error:
                        # Align the producer to whichever captured verifier is actually
                        # serving. This read-only check never sends credentials to Caddy.
                        aligned = False
                        for candidate in (new, old):
                            try:
                                if local('/wizard/v1/devices', candidate)[0] == 200:
                                    livehash = hashfile(PROOF)
                                    if livehash != sha(candidate):
                                        cas_replace(livehash, candidate)
                                    aligned = True
                                    break
                            except BaseException:
                                pass
                        state['status'] = 'recovery_required'
                        state['producer_matches_serving_verifier'] = aligned
                        state['recovery_failure'] = str(recovery_error) if isinstance(recovery_error, Gate) else type(recovery_error).__name__
                else:
                    state['status'] = 'blocked_before_mutation'
                state['finished_unix'] = time.time()
                write_json(statepath, state)
                return 1
            finally:
                lock.close()
    except BaseException as exc:
        state.update(status='blocked_before_mutation', failure=str(exc) if isinstance(exc, Gate) else type(exc).__name__)
        write_json(statepath, state)
        return 1
    finally:
        wipe(old)
        wipe(new)


def main():
    protect()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'check', 'apply'])
    parser.add_argument('--plan', type=Path, required=True)
    args = parser.parse_args()
    args.plan.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(Gate('termination_requested')))
    if args.action == 'prepare':
        secret = read_secret()
        try:
            value = {'version': 1, 'old_sha256': sha(secret), 'before': snapshot(),
                     'script_sha256': hashfile(__file__)}
            write_json(args.plan, value)
        finally:
            wipe(secret)
        print(json.dumps({'status': 'prepared', 'plan': str(args.plan)}))
        return 0
    if args.action == 'check':
        value = json.loads(args.plan.read_bytes())
        try:
            preflight(value)
            status = {'status': 'ready', 'plan': str(args.plan)}
            rc = 0
        except BaseException as exc:
            status = {'status': 'blocked', 'blocker': str(exc) if isinstance(exc, Gate) else type(exc).__name__,
                      'plan': str(args.plan), 'producer_unchanged': hashfile(PROOF) == value['old_sha256']}
            rc = 1
        write_json(args.plan.parent / 'preflight.json', status)
        print(json.dumps(status))
        return rc
    require(hashfile(__file__) == json.loads(args.plan.read_bytes())['script_sha256'], 'script_hash_drift')
    return operate(args.plan)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Gate as exc:
        print(json.dumps({'status': 'blocked', 'blocker': str(exc)}))
        raise SystemExit(1)
    except Exception as exc:
        # No traceback/raw exception strings can reveal HTTP headers or secrets.
        print(json.dumps({'status': 'blocked', 'blocker_class': type(exc).__name__}))
        raise SystemExit(1)
