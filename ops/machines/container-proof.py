#!/usr/bin/env python3
"""Run INSIDE a disposable Linux container only. Creates fixture users there.

Invoked by run-container-proof.py, never directly on an owner host.
"""
import base64
import importlib.util
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import time

if not Path('/.dockerenv').exists() or os.environ.get('MACHINES_DISPOSABLE_PROOF') != 'yes' or os.geteuid() != 0:
    raise SystemExit('disposable root container only; do not run on owner hosts')
HERE = Path(__file__).parent
PY = str(HERE / 'machines.py')
case = Path('/case')
case.mkdir(mode=0o755, exist_ok=True)

def cmd(argv, **kwargs):
    return subprocess.run(argv, check=True, capture_output=True, text=True, **kwargs)

def check(ok, label):
    if not ok:
        raise SystemExit('FAIL ' + label)
    print('PASS ' + label, flush=True)

def as_user(user, argv, **kwargs):
    return cmd(['/usr/sbin/runuser', '-u', user, '--', *argv], **kwargs)

cmd(['/usr/sbin/useradd', '--create-home', '--password', '*', 'controller'])
uid = pwd.getpwnam('controller').pw_uid
control = case / 'control'
control.mkdir(mode=0o700)
os.chown(control, uid, uid)
for key in ('identity', 'host'):
    cmd(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(case / key)])
shutil.copy(case / 'identity', control / 'identity')
os.chown(control / 'identity', uid, uid)
(control / 'identity').chmod(0o600)
pub = (case / 'host.pub').read_text().split()
known = control / 'known_hosts'
known.write_text('[127.0.0.1]:2222 ' + ' '.join(pub[:2]) + '\n')
known.chmod(0o600)
os.chown(known, uid, uid)

presets = case / 'presets.json'
presets.write_text(json.dumps({
    'build': {'argv': ['/usr/bin/python3', '-c', "from pathlib import Path; Path('result.txt').write_text('machine proof\\n'); print('built')"], 'timeout': 5},
    'slow': {'argv': ['/usr/bin/python3', '-c', "from pathlib import Path; import time; Path('running').write_text('started'); time.sleep(4); Path('continued').write_text('remote may continue')"], 'timeout': 10},
    'noisy': {'argv': ['/usr/bin/python3', '-c', "print('x'*300000)"], 'timeout': 5}
}))
for agent, user, privacy in [('alpha', 'wizard-alpha', 'worker'), ('beta', 'wizard-beta', 'worker'), ('personal', 'wizard-personal', 'personal')]:
    catalog = presets
    if privacy == 'personal':
        catalog = case / 'empty.json'
        catalog.write_text('{}')
    cmd(['/usr/bin/python3', str(HERE / 'enroll-linux.py'), '--agent', agent, '--user', user,
         '--public-key', str(case / 'identity.pub'), '--privacy', privacy, '--presets', str(catalog), '--confirm-create-limited-user'])
    info = pwd.getpwnam(user)
    groups = cmd(['/usr/bin/id', '-nG', user]).stdout.strip().split()
    check(groups == [user] and info.pw_uid != 0, user + ' limited UID and no supplementary groups')
    check(Path(info.pw_dir).stat().st_uid == 0 and (Path(info.pw_dir) / '.ssh/authorized_keys').stat().st_uid == 0, user + ' immutable forced key parent')
    check(Path('/etc/wizard-machines/' + user + '.json').stat().st_uid == 0, user + ' immutable target policy')
# Existing owner-like account must never be adopted.
r = subprocess.run(['/usr/bin/python3', str(HERE / 'enroll-linux.py'), '--agent', 'alpha', '--user', 'controller', '--public-key', str(case / 'identity.pub'), '--privacy', 'worker', '--presets', str(presets), '--confirm-create-limited-user'], capture_output=True)
check(r.returncode != 0, 'existing account enrollment refused')

Path('/run/sshd').mkdir(exist_ok=True)
sshd_config = case / 'sshd_config'
sshd_config.write_text('Port 2222\nListenAddress 127.0.0.1\nHostKey /case/host\nPidFile /case/sshd.pid\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nStrictModes yes\nLogLevel ERROR\n')
sshd = subprocess.Popen(['/usr/sbin/sshd', '-D', '-e', '-f', str(sshd_config)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
relay = None
try:
    # Readiness probe of owned daemon, bounded; not a shared worker wait.
    import socket
    for attempt in range(100):
        try:
            with socket.create_connection(('127.0.0.1', 2222), timeout=0.1):
                break
        except OSError:
            if sshd.poll() is not None:
                raise RuntimeError('sshd exited')
            time.sleep(0.02)
    else:
        raise RuntimeError('sshd not ready')
    def cli(*args):
        return as_user('controller', ['/usr/bin/python3', PY, *args])
    def config(mid, agent, user, privacy='worker'):
        file = control / (mid + '.json')
        file.write_text(json.dumps({'label': mid, 'agent': agent, 'privacy': privacy, 'host': '127.0.0.1', 'port': 2222,
                                    'user': user, 'identity': str(control / 'identity'), 'known_hosts': str(known)}))
        file.chmod(0o600)
        os.chown(file, uid, uid)
        cli('register', '--root', str(control / 'registry'), '--machine', mid, '--config', str(file))
    config('worker', 'alpha', 'wizard-alpha')
    config('other', 'beta', 'wizard-beta')
    config('personal', 'personal', 'wizard-personal', 'personal')
    for machine, agent, caps in [('worker', 'alpha', ['status', 'run', 'fetch-file']), ('other', 'beta', ['status', 'run', 'fetch-file']), ('personal', 'personal', ['status'])]:
        cli('grant', '--root', str(control / 'registry'), '--machine', machine, '--agent', agent, '--caps', *caps, '--presets', 'build', 'slow', 'noisy')
    sock = control / 'sockets' / 'alpha.sock'
    relay = subprocess.Popen(['/usr/sbin/runuser', '-u', 'controller', '--', '/usr/bin/python3', PY, 'serve', '--root', str(control / 'registry'), '--agent', 'alpha', '--socket', str(sock), '--peer-uid', str(uid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        if sock.exists():
            break
        if relay.poll() is not None:
            raise RuntimeError('relay exited')
        time.sleep(0.02)
    def call(value):
        return json.loads(cli('call', '--socket', str(sock), '--json', json.dumps(value)).stdout)
    # Actual foreign-UID caller: root bypasses filesystem modes but not SO_PEERCRED.
    foreign = subprocess.run(['/usr/bin/python3', PY, 'call', '--socket', str(sock), '--json', '{"op":"list"}'], capture_output=True, text=True)
    check(foreign.returncode != 0, 'actual foreign kernel peer UID refused')
    check([x['id'] for x in call({'op': 'list'})['machines']] == ['worker'], 'agent sees only its grant, no endpoint/keys')
    check(call({'op': 'status', 'machine': 'worker'})['result']['agent'] == 'alpha', 'real Unix to SSH limited-user status')
    run = call({'op': 'run', 'machine': 'worker', 'preset': 'build'})
    check(run['ok'] and run['result']['exit'] == 0, 'named run executes through forced command')
    fetched = call({'op': 'fetch-file', 'machine': 'worker', 'path': 'result.txt'})
    check(fetched['ok'] and base64.b64decode(fetched['result']['base64']) == b'machine proof\n', 'fetch exact generated bytes through relay SSH')
    for value in ({'op': 'status', 'machine': 'other'}, {'op': 'run', 'machine': 'worker', 'preset': 'shell'}, {'op': 'status', 'machine': 'worker', 'agent': 'beta'}, {'op': 'fetch-file', 'machine': 'worker', 'path': '../.ssh/authorized_keys'}):
        check(not call(value)['ok'], 'cross-agent, catalog, identity or path attack denied')
    check(not call({'op': 'run', 'machine': 'worker', 'preset': 'noisy'})['ok'], 'remote output ceiling denies excess bytes')
    workspace = Path('/var/lib/wizard-machines/wizard-alpha/work')
    as_user('wizard-alpha', ['/bin/ln', '-s', '/etc', str(workspace / 'escape')])
    check(not call({'op': 'fetch-file', 'machine': 'worker', 'path': 'escape/passwd'})['ok'], 'target symlink traversal denied')
    # Direct target receiver mismatched identity, even with transport deliberately wrong.
    denied = subprocess.run(['/usr/sbin/runuser', '-u', 'wizard-alpha', '--', '/usr/bin/python3', PY, 'receive', '--policy', '/etc/wizard-machines/wizard-alpha.json', '--agent', 'alpha'], input='{"agent":"beta","request":{"op":"status"}}\n', text=True, capture_output=True)
    check(denied.returncode != 0 and 'target_principal_mismatch' in denied.stdout, 'immutable target identity rejects relay misbinding')
    # Kernel user boundary: beta's workspace is inaccessible to alpha, not just string filtering.
    denied = subprocess.run(['/usr/sbin/runuser', '-u', 'wizard-alpha', '--', '/bin/ls', '/var/lib/wizard-machines/wizard-beta/work'], capture_output=True)
    check(denied.returncode != 0, 'separate target UIDs enforce workspace privacy')
    # Sibling principals cannot hold alpha's immutable run lock (Linux read-only flock).
    lock_denied = subprocess.run(['/usr/sbin/runuser', '-u', 'wizard-beta', '--', '/usr/bin/python3', '-c', "import os; os.open('/etc/wizard-machines/wizard-alpha.json.run-lock', os.O_RDONLY)"], capture_output=True)
    check(lock_denied.returncode != 0, 'sibling UID cannot open or flock another principal run lock')
    # Target enforces personal status-only independently of relay grants.
    for operation, allowed in [({'op': 'status'}, True), ({'op': 'run', 'preset': 'build'}, False), ({'op': 'fetch-file', 'path': 'result.txt'}, False)]:
        personal = subprocess.run(['/usr/sbin/runuser', '-u', 'wizard-personal', '--', '/usr/bin/python3', '-I', PY, 'receive', '--policy', '/etc/wizard-machines/wizard-personal.json', '--agent', 'personal'], input=json.dumps({'agent': 'personal', 'request': operation}) + '\n', capture_output=True, text=True)
        check((personal.returncode == 0) == allowed, 'personal target independently limits ' + operation['op'])
    # Change pinned known-host key to a different fixture key, then restore.
    original_known = known.read_text()
    cmd(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(case / 'wrong-host')])
    known.write_text('[127.0.0.1]:2222 ' + ' '.join((case / 'wrong-host.pub').read_text().split()[:2]) + '\n')
    check(call({'op': 'status', 'machine': 'worker'})['error'] == 'transport_failed', 'pinned host key mismatch aborts')
    known.write_text(original_known)
    # Start slow job via actual daemon; revoke from owner CLI and verify no bytes return.
    slow = subprocess.Popen(['/usr/sbin/runuser', '-u', 'controller', '--', '/usr/bin/python3', PY, 'call', '--socket', str(sock), '--json', '{"op":"run","machine":"worker","preset":"slow"}'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    for _ in range(100):
        if (workspace / 'running').exists():
            break
        time.sleep(0.02)
    check((workspace / 'running').exists(), 'in-flight real remote job observed before revoke')
    cli('revoke', '--root', str(control / 'registry'), '--machine', 'worker')
    out, _ = slow.communicate(timeout=5)
    revoked = json.loads(out)
    check(not revoked['ok'] and 'result' not in revoked, 'mid-job revoke suppresses all result bytes')
    # Wait only for a bounded fixture we started; demonstrate unknown remote termination honestly.
    time.sleep(4.2)
    print('OBSERVED remote child after local SSH revoke: ' + ('continued' if (workspace / 'continued').exists() else 'not observed; remote state unknown'), flush=True)
    audit = (control / 'registry/audit.jsonl').read_text()
    check('machine proof' not in audit and '127.0.0.1' not in audit and 'identity' not in audit, 'metadata audit contains no output, endpoints or key paths')
    print('MACHINES_CONTAINER_PROOF_OK', flush=True)
finally:
    if relay:
        relay.terminate()
        relay.wait(timeout=5)
    sshd.terminate()
    sshd.wait(timeout=5)
