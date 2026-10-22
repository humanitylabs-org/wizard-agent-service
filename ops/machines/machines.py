#!/usr/bin/env python3
"""Opt-in Machines preview: semantic Unix relay; no live service integration.

Only stdlib. Linux relay requires kernel peer credentials. Target is POSIX.
Policy is owner/admin authored; run presets execute with the ENTIRE limited UID.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import selectors
import shutil
import signal
import socket
import socketserver
import stat
import struct
import subprocess
import sys
import threading
import time
import uuid

FRAME = 8192
OUTPUT = 262144
AUDIT_LIMIT = 8 * 1024 * 1024
ID = re.compile(r"[a-z][a-z0-9-]{0,31}\Z")


class Denied(Exception):
    pass


def require(ok, code):
    if not ok:
        raise Denied(code)


def ident(value):
    require(isinstance(value, str) and ID.fullmatch(value), 'invalid_id')
    return value


def private_dir(path):
    path = Path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    s = path.lstat()
    require(stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode)
            and s.st_uid == os.geteuid() and s.st_mode & 0o077 == 0, 'unsafe_directory')
    return path


def secure_json(path, uid=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as f:
        s = os.fstat(f.fileno())
        require(stat.S_ISREG(s.st_mode) and s.st_uid == (os.geteuid() if uid is None else uid)
                and s.st_mode & 0o022 == 0 and s.st_nlink == 1 and s.st_size <= 262144, 'unsafe_config')
        if uid is None:
            require(s.st_mode & 0o077 == 0, 'unsafe_config')
        return json.load(f)


def atomic(path, value):
    path = Path(path)
    temp = path.with_name('.' + uuid.uuid4().hex)
    fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f, separators=(',', ':'))
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


class Registry:
    def __init__(self, root):
        self.root = private_dir(root)
        self.path = self.root / 'registry.json'

    def read(self):
        return secure_json(self.path) if self.path.exists() else {'version': 1, 'machines': {}, 'grants': {}}

    @contextlib.contextmanager
    def edit(self):
        fd = os.open(self.root / 'registry.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            data = self.read()
            yield data
            atomic(self.path, data)
        finally:
            os.close(fd)

    def register(self, machine, config):
        ident(machine)
        require(set(config) == {'label', 'agent', 'privacy', 'host', 'port', 'user', 'identity', 'known_hosts'}, 'invalid_machine')
        ident(config['agent'])
        ident(config['user'])
        require(config['privacy'] in ('personal', 'worker'), 'invalid_class')
        require(isinstance(config['label'], str) and 0 < len(config['label']) <= 80, 'invalid_label')
        require(isinstance(config['host'], str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{0,252}', config['host']), 'invalid_host')
        require(type(config['port']) is int and 1 <= config['port'] <= 65535, 'invalid_port')
        for key in ('identity', 'known_hosts'):
            p = Path(config[key])
            require(p.is_absolute(), 'invalid_key_path')
            fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                s = os.fstat(fd)
                require(stat.S_ISREG(s.st_mode) and s.st_uid == os.geteuid() and s.st_mode & 0o077 == 0, 'unsafe_key')
            finally:
                os.close(fd)
        with self.edit() as data:
            require(machine not in data['machines'], 'already_registered')
            # No aliases of one login may masquerade as isolated principals.
            require(not any((m['host'], m['port'], m['user']) == (config['host'], config['port'], config['user'])
                            for m in data['machines'].values()), 'principal_already_registered')
            data['machines'][machine] = config

    def grant(self, machine, agent, caps, presets, seconds):
        ident(machine)
        ident(agent)
        require(set(caps) <= {'status', 'run', 'fetch-file'} and caps, 'invalid_capabilities')
        require(type(seconds) is int and 0 < seconds <= 86400, 'invalid_expiry')
        require(all(ID.fullmatch(x) for x in presets), 'invalid_preset')
        with self.edit() as data:
            m = data['machines'].get(machine)
            require(m and m['agent'] == agent, 'principal_mismatch')
            require(m['privacy'] != 'personal' or set(caps) <= {'status'}, 'personal_status_only')
            data['grants'][machine] = {'agent': agent, 'caps': sorted(set(caps)), 'presets': sorted(set(presets)),
                                       'expires': time.time() + seconds, 'generation': uuid.uuid4().hex}

    def revoke(self, machine):
        with self.edit() as data:
            data['grants'].pop(machine, None)

    def authorize(self, agent, machine, operation, preset=None, generation=None):
        data = self.read()
        m, g = data['machines'].get(machine), data['grants'].get(machine)
        require(m and g and g['agent'] == agent and m['agent'] == agent, 'not_granted')
        require(g['expires'] > time.time(), 'expired')
        require(operation in g['caps'], 'capability_denied')
        require(m['privacy'] in ('worker', 'personal'), 'invalid_class')
        require(m['privacy'] != 'personal' or operation == 'status', 'personal_status_only')
        if operation == 'run':
            require(preset in g['presets'], 'preset_denied')
        if generation is not None:
            require(g['generation'] == generation, 'revoked_remote_unknown')
        return m, g

    def listing(self, agent):
        data = self.read()
        result = []
        for machine, m in data['machines'].items():
            g = data['grants'].get(machine, {})
            if m['agent'] == agent and g.get('agent') == agent and g.get('expires', 0) > time.time():
                result.append({'id': machine, 'label': m['label'], 'privacy': m['privacy'],
                               'capabilities': g['caps'], 'presets': g['presets'], 'generation': g['generation']})
        return result


def bounded_process(argv, *, timeout, env, cwd=None, current=lambda: True, limit=OUTPUT, preexec=None):
    """Capture bounded pipes; kill the local process group on timeout/revocation.

    Killing SSH is NOT a remote process termination guarantee.
    """
    current()
    p = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, preexec_fn=preexec)
    return p


def communicate(p, body, timeout, current=lambda: None, limit=OUTPUT):
    deadline = time.monotonic() + timeout
    buffers = {p.stdout.fileno(): bytearray(), p.stderr.fileno(): bytearray()}
    selector = selectors.DefaultSelector()
    try:
        p.stdin.write(body)
        p.stdin.close()
        for pipe in (p.stdout, p.stderr):
            os.set_blocking(pipe.fileno(), False)
            selector.register(pipe, selectors.EVENT_READ)
        while selector.get_map() or p.poll() is None:
            current()
            require(time.monotonic() < deadline, 'timeout_remote_unknown')
            for key, _ in selector.select(0.05):
                chunk = os.read(key.fd, 8192)
                if not chunk:
                    selector.unregister(key.fileobj)
                else:
                    buffers[key.fd].extend(chunk)
                    require(sum(map(len, buffers.values())) <= limit, 'output_limit')
        current()
        return p.returncode, bytes(buffers[p.stdout.fileno()]), bytes(buffers[p.stderr.fileno()])
    finally:
        if p.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(p.pid, signal.SIGKILL)
        p.wait()
        selector.close()
        p.stdout.close()
        p.stderr.close()


def read_frame(stream):
    line = stream.readline(FRAME + 1)
    require(len(line) <= FRAME and line.endswith(b'\n'), 'invalid_frame')
    value = json.loads(line)
    require(isinstance(value, dict), 'invalid_frame')
    return value


def validate_request(value):
    op = value.get('op')
    fields = {'status': {'op'}, 'run': {'op', 'preset'}, 'fetch-file': {'op', 'path'}}
    require(op in fields and set(value) == fields[op], 'invalid_request')
    if op == 'run':
        ident(value['preset'])
    if op == 'fetch-file':
        path_parts(value['path'])
    return op


def path_parts(relative):
    require(isinstance(relative, str) and 0 < len(relative) <= 512 and '\\' not in relative
            and not any(ord(c) < 32 for c in relative), 'invalid_path')
    parts = relative.split('/')
    require(all(p not in ('', '.', '..') for p in parts), 'invalid_path')
    return parts


def read_confined(root, relative, limit=OUTPUT):
    parts = path_parts(relative)
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        target = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(target, 'rb') as f:
            s = os.fstat(f.fileno())
            require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_size <= limit, 'invalid_file')
            data = f.read(limit + 1)
            require(len(data) <= limit, 'file_limit')
            return {'bytes': len(data), 'base64': base64.b64encode(data).decode(), 'untrusted': True}
    finally:
        os.close(fd)


def receiver(policy_path, agent, request):
    require(os.geteuid() != 0, 'root_runtime_forbidden')
    policy = secure_json(policy_path, uid=0)
    require(policy['agent'] == agent, 'target_principal_mismatch')
    require(policy['privacy'] in ('worker', 'personal'), 'invalid_class')
    root = Path(policy['workspace'])
    require(root.is_absolute() and root.resolve() == root, 'unsafe_workspace')
    require(set(request) == {'agent', 'request'} and request['agent'] == agent, 'target_principal_mismatch')
    request = request['request']
    require(isinstance(request, dict), 'invalid_request')
    op = validate_request(request)
    require(policy['privacy'] != 'personal' or op == 'status', 'personal_status_only')
    if op == 'status':
        disk = shutil.disk_usage(root)
        return {'version': 1, 'agent': agent, 'platform': platform.system().lower(),
                'workspace_disk': {'free': disk.free, 'total': disk.total}}
    if op == 'fetch-file':
        return read_confined(root, request['path'])
    preset = policy.get('presets', {}).get(request['preset'])
    require(preset is not None, 'catalog_miss')
    argv = preset['argv']
    require(isinstance(argv, list) and argv and all(isinstance(a, str) and '\0' not in a for a in argv)
            and Path(argv[0]).is_absolute(), 'invalid_preset')
    timeout = preset.get('timeout', 30)
    require(type(timeout) is int and 1 <= timeout <= 120, 'invalid_timeout')
    # Root-owned home lock cannot be replaced by user code in workspace.
    lock = os.open(policy_path + '.run-lock', os.O_RDONLY | os.O_NOFOLLOW)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Denied('busy') from None
        def ceilings():
            import resource
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024, 16 * 1024 * 1024))
            resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
            resource.setrlimit(resource.RLIMIT_CPU, (120, 120))
            resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
        env = {'HOME': str(root), 'TMPDIR': str(root), 'PATH': '/usr/bin:/bin', 'LANG': 'C'}
        p = bounded_process(argv, timeout=timeout, env=env, cwd=root, preexec=ceilings)
        code, out, err = communicate(p, b'', timeout)
        return {'exit': code, 'stdout_base64': base64.b64encode(out).decode(),
                'stderr_base64': base64.b64encode(err).decode(), 'bytes': len(out) + len(err), 'untrusted': True}
    finally:
        os.close(lock)


def ssh_argv(m):
    return ['/usr/bin/ssh', '-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'GlobalKnownHostsFile=/dev/null',
            '-o', 'UserKnownHostsFile=' + m['known_hosts'], '-o', 'ForwardAgent=no',
            '-o', 'ClearAllForwardings=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
            '-o', 'ProxyCommand=none', '-o', 'PermitLocalCommand=no', '-o', 'PasswordAuthentication=no',
            '-o', 'KbdInteractiveAuthentication=no', '-o', 'ConnectTimeout=5',
            '-o', 'ServerAliveInterval=3', '-o', 'ServerAliveCountMax=2',
            '-i', m['identity'], '-p', str(m['port']), '-l', m['user'], m['host'], 'wizard-machines-v1']


class Relay:
    def __init__(self, root, agent):
        self.registry = Registry(root)
        self.agent = ident(agent)
        self.audit_lock = threading.Lock()
        self.run_lock = threading.Lock()

    def audit(self, rid, machine, operation, state, code=None):
        row = {'request': rid, 'agent': self.agent, 'machine': machine, 'operation': operation,
               'state': state, 'at': time.time(), 'code': code}
        with self.audit_lock:
            fd = os.open(self.registry.root / 'audit.jsonl', os.O_CREAT | os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'a') as f:
                s = os.fstat(f.fileno())
                require(stat.S_ISREG(s.st_mode) and s.st_uid == os.geteuid() and s.st_mode & 0o077 == 0
                        and s.st_nlink == 1 and s.st_size < AUDIT_LIMIT, 'audit_unavailable')
                fcntl.flock(f, fcntl.LOCK_EX)
                require(os.fstat(f.fileno()).st_size < AUDIT_LIMIT, 'audit_unavailable')
                f.write(json.dumps(row, separators=(',', ':')) + '\n')
                f.flush()
                os.fsync(f.fileno())

    def dispatch(self, value):
        rid = uuid.uuid4().hex
        machine, op = value.get('machine'), value.get('op')
        # Sanitized metadata only, including denial records.
        safe_machine = machine if isinstance(machine, str) and ID.fullmatch(machine) else None
        safe_op = op if op in ('list', 'status', 'run', 'fetch-file') else None
        try:
            require(self.run_lock.acquire(blocking=False), 'busy')
            try:
                return self._dispatch(value, rid, machine, op)
            finally:
                self.run_lock.release()
        except Exception as exc:
            code = str(exc) if isinstance(exc, Denied) else 'unavailable'
            try:
                self.audit(rid, safe_machine, safe_op, 'denied', code)
            except Exception:
                code = 'audit_unavailable'
            return {'ok': False, 'error': code, 'request': rid}

    def _dispatch(self, value, rid, machine, op):
        if value == {'op': 'list'}:
            return {'ok': True, 'machines': self.registry.listing(self.agent)}
        ident(machine)
        op = validate_request({k: v for k, v in value.items() if k not in ('machine', 'generation')})
        require(set(value) <= {'op', 'machine', 'generation', 'preset', 'path'}, 'invalid_request')
        body = {k: v for k, v in value.items() if k not in ('machine', 'generation')}
        m, g = self.registry.authorize(self.agent, machine, op, value.get('preset'), value.get('generation'))
        generation = g['generation']
        def current():
            try:
                self.registry.authorize(self.agent, machine, op, value.get('preset'), generation)
            except Denied:
                raise Denied('revoked_remote_unknown') from None
        self.audit(rid, machine, op, 'admitted')
        env = {'HOME': str(self.registry.root), 'PATH': '/usr/bin:/bin', 'LANG': 'C'}
        envelope = {'agent': self.agent, 'request': body}
        wire = json.dumps(envelope, separators=(',', ':')).encode() + b'\n'
        require(len(wire) <= FRAME, 'invalid_frame')
        p = bounded_process(ssh_argv(m), timeout=130, env=env, current=current)
        code, out, err = communicate(p, wire, 130, current, OUTPUT * 2)
        require(code == 0, 'transport_failed')  # Never disclose raw SSH errors/host paths.
        result = json.loads(out)
        require(isinstance(result, dict) and result.get('ok') is True and 'result' in result, 'target_denied')
        current()
        self.audit(rid, machine, op, 'completed')
        return {'ok': True, 'request': rid, 'result': result['result'], 'untrusted': True}


class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    block_on_close = True
    request_queue_size = 8

    def __init__(self, path, relay, peer_uid):
        require(hasattr(socket, 'SO_PEERCRED') and sys.platform == 'linux', 'peer_credentials_unavailable')
        self.relay, self.peer_uid = relay, peer_uid
        self.clients = threading.BoundedSemaphore(8)
        super().__init__(str(path), Handler)

    def verify_request(self, request, client_address):
        pid, uid, gid = struct.unpack('3i', request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        return uid == self.peer_uid and self.clients.acquire(blocking=False)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.clients.release()


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(5)
        try:
            request = read_frame(self.rfile)
            self.connection.settimeout(140)
            response = self.server.relay.dispatch(request)
        except Exception:
            try:
                self.server.relay.audit(uuid.uuid4().hex, None, None, 'denied', 'invalid_frame')
                response = {'ok': False, 'error': 'invalid_frame'}
            except Exception:
                response = {'ok': False, 'error': 'audit_unavailable'}
        with contextlib.suppress(OSError):
            self.wfile.write(json.dumps(response, separators=(',', ':')).encode() + b'\n')


def serve(root, agent, socket_path, peer_uid):
    require(os.geteuid() != 0, 'root_runtime_forbidden')
    path = Path(socket_path)
    private_dir(path.parent)
    require(len(os.fsencode(path)) <= 103 and not path.exists() and not path.is_symlink(), 'unsafe_socket')
    relay = Relay(root, agent)
    with UnixServer(path, relay, peer_uid) as server:
        os.chmod(path, 0o600)
        try:
            server.serve_forever(poll_interval=0.1)
        finally:
            path.unlink(missing_ok=True)


def call(path, value):
    payload = json.dumps(value).encode() + b'\n'
    require(len(payload) <= FRAME, 'invalid_frame')
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(145)
        sock.connect(str(path))
        sock.sendall(payload)
        with sock.makefile('rb') as f:
            raw = f.readline(OUTPUT * 3)
            require(raw.endswith(b'\n'), 'invalid_response')
            return json.loads(raw)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    for action in ('register', 'grant', 'revoke', 'serve'):
        p = sub.add_parser(action)
        p.add_argument('--root', required=True)
        if action != 'serve':
            p.add_argument('--machine', required=True)
        if action == 'register':
            p.add_argument('--config', required=True)
        elif action == 'grant':
            p.add_argument('--agent', required=True)
            p.add_argument('--caps', nargs='+', required=True)
            p.add_argument('--presets', nargs='*', default=[])
            p.add_argument('--seconds', type=int, default=3600)
        elif action == 'serve':
            p.add_argument('--agent', required=True)
            p.add_argument('--socket', required=True)
            p.add_argument('--peer-uid', required=True, type=int)
    p = sub.add_parser('call')
    p.add_argument('--socket', required=True)
    p.add_argument('--json', required=True)
    p = sub.add_parser('receive')
    p.add_argument('--policy', required=True)
    p.add_argument('--agent', required=True)
    args = parser.parse_args()
    try:
        if args.action == 'register':
            Registry(args.root).register(args.machine, secure_json(args.config))
        elif args.action == 'grant':
            Registry(args.root).grant(args.machine, args.agent, args.caps, args.presets, args.seconds)
        elif args.action == 'revoke':
            Registry(args.root).revoke(args.machine)
        elif args.action == 'serve':
            serve(args.root, args.agent, args.socket, args.peer_uid)
        elif args.action == 'call':
            print(json.dumps(call(args.socket, json.loads(args.json))))
        elif args.action == 'receive':
            require(os.environ.get('SSH_ORIGINAL_COMMAND', '') in ('', 'wizard-machines-v1'), 'command_denied')
            result = receiver(args.policy, args.agent, read_frame(sys.stdin.buffer))
            print(json.dumps({'ok': True, 'result': result}, separators=(',', ':')))
        else:
            raise Denied('invalid_action')
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': str(exc) if isinstance(exc, Denied) else 'unavailable'}))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
