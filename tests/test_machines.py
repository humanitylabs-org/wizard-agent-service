#!/usr/bin/env python3
"""Lightweight regression suite; no Docker, account or owner-state mutation."""
import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('machines', Path(__file__).parents[1] / 'ops/machines/machines.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Machines(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='wm-', dir=os.environ['TMPDIR'])
        self.root = Path(self.tmp.name)
        self.reg = m.Registry(self.root / 'config')
        for name in ('identity', 'known_hosts'):
            p = self.root / name
            p.write_text('fixture only; never SSHed')
            p.chmod(0o600)
        self.config = {'label': 'Worker', 'agent': 'alpha', 'privacy': 'worker', 'host': 'worker.invalid',
                       'port': 22, 'user': 'wizard-agent', 'identity': str(self.root / 'identity'),
                       'known_hosts': str(self.root / 'known_hosts')}
        self.reg.register('worker', self.config)
        self.reg.grant('worker', 'alpha', ['status', 'run', 'fetch-file'], ['build'], 60)

    def tearDown(self):
        self.tmp.cleanup()

    def denied(self, code, fn, *args, **kwargs):
        with self.assertRaisesRegex(m.Denied, code):
            fn(*args, **kwargs)

    def test_grants_no_identity_spoof_and_stale_generation(self):
        self.denied('not_granted', self.reg.authorize, 'beta', 'worker', 'status')
        self.denied('principal_mismatch', self.reg.grant, 'worker', 'beta', ['status'], [], 60)
        self.denied('preset_denied', self.reg.authorize, 'alpha', 'worker', 'run', 'shell')
        generation = self.reg.listing('alpha')[0]['generation']
        self.reg.grant('worker', 'alpha', ['status'], [], 60)
        self.denied('revoked_remote_unknown', self.reg.authorize, 'alpha', 'worker', 'status', generation=generation)
        self.reg.revoke('worker')
        self.denied('not_granted', self.reg.authorize, 'alpha', 'worker', 'status')
        self.assertEqual(self.reg.listing('beta'), [])

    def test_expiry_personal_and_no_transport_on_denial(self):
        self.reg.revoke('worker')
        with self.reg.edit() as data:
            data['machines']['worker']['privacy'] = 'personal'
        self.denied('personal_status_only', self.reg.grant, 'worker', 'alpha', ['run'], ['build'], 60)
        self.reg.grant('worker', 'alpha', ['status'], [], 60)
        relay = m.Relay(self.reg.root, 'alpha')
        with patch.object(m.subprocess, 'Popen') as process:
            self.assertFalse(relay.dispatch({'machine': 'worker', 'op': 'run', 'preset': 'build'})['ok'])
            process.assert_not_called()
        with self.reg.edit() as data:
            data['grants']['worker']['expires'] = time.time() - 1
        self.denied('expired', self.reg.authorize, 'alpha', 'worker', 'status')

    def test_schema_and_fixed_destination(self):
        for bad in ({'op': 'run', 'preset': 'build', 'argv': ['sh']}, {'op': 'status', 'agent': 'beta'}, {'op': 'shell'}):
            self.denied('invalid_request', m.validate_request, bad)
        for host in ('-oProxyCommand=bad', 'a b', 'a\ncommand', 'x;touch'):
            self.denied('invalid_host', self.reg.register, 'other', {**self.config, 'host': host})
        self.denied('principal_already_registered', self.reg.register, 'other', self.config)
        argv = m.ssh_argv(self.config)
        self.assertIn('StrictHostKeyChecking=yes', argv)
        self.assertIn('ForwardAgent=no', argv)
        self.assertIn('ClearAllForwardings=yes', argv)
        self.assertEqual(argv[-1], 'wizard-machines-v1')
        self.assertEqual(argv[1:3], ['-F', '/dev/null'])

    def test_frames_caps(self):
        self.denied('invalid_frame', m.read_frame, io.BytesIO(b'{}'))
        self.denied('invalid_frame', m.read_frame, io.BytesIO(b'x' * (m.FRAME + 1) + b'\n'))
        self.denied('invalid_frame', m.read_frame, io.BytesIO(b'[]\n'))
        self.assertEqual(m.read_frame(io.BytesIO(b'{"op":"status"}\n')), {'op': 'status'})

    def test_fetch_no_escape_symlinks_hardlinks_special_or_oversize(self):
        work = self.root / 'work'
        work.mkdir()
        (work / 'out').mkdir()
        payload = b'hello\x00world'
        (work / 'out' / 'result').write_bytes(payload)
        self.assertEqual(base64.b64decode(m.read_confined(work, 'out/result')['base64']), payload)
        for path in ('/etc/passwd', '../identity', 'out/../result', 'out//result', 'out/./result', 'x\\y', 'x\n'):
            self.denied('invalid_path', m.read_confined, work, path)
        (work / 'sym').symlink_to(self.root, target_is_directory=True)
        (work / 'link').symlink_to(self.root / 'identity')
        for path in ('sym/identity', 'link'):
            with self.assertRaises((OSError, m.Denied)):
                m.read_confined(work, path)
        os.link(self.root / 'identity', work / 'hard')
        self.denied('invalid_file', m.read_confined, work, 'hard')
        os.mkfifo(work / 'fifo')
        self.denied('invalid_file', m.read_confined, work, 'fifo')
        (work / 'large').write_bytes(b'x' * (m.OUTPUT + 1))
        self.denied('invalid_file', m.read_confined, work, 'large')

    def test_secure_config_permissions_and_symlink(self):
        path = self.reg.path
        path.chmod(0o644)
        self.denied('unsafe_config', self.reg.read)
        path.chmod(0o600)
        link = self.root / 'link-config'
        link.symlink_to(path)
        with self.assertRaises(OSError):
            m.secure_json(link)
        (self.root / 'unsafe').mkdir(mode=0o755)
        self.denied('unsafe_directory', m.private_dir, self.root / 'unsafe')

    def test_actual_unix_peer_credentials_mount_identity_and_client_caps(self):
        if not hasattr(socket, 'SO_PEERCRED'):
            self.skipTest('Linux kernel peer credentials required')
        relay = m.Relay(self.reg.root, 'alpha')
        sockets = self.root / 's'
        sockets.mkdir(mode=0o700)
        server = m.UnixServer(sockets / 'a', relay, os.geteuid())
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            response = m.call(sockets / 'a', {'op': 'list'})
            self.assertEqual([x['id'] for x in response['machines']], ['worker'])
            wire = json.dumps(response)
            self.assertNotIn('identity', wire)
            self.assertNotIn('worker.invalid', wire)
            self.assertNotIn('wizard-agent', wire)
            denied = m.call(sockets / 'a', {'op': 'status', 'machine': 'worker', 'agent': 'beta'})
            self.assertEqual(denied['error'], 'invalid_request')
            with socket.socket(socket.AF_UNIX) as raw:
                raw.settimeout(2)
                raw.connect(str(sockets / 'a'))
                raw.sendall(b'[' * 8000 + b'\n')
                response = json.loads(raw.makefile('rb').readline())
                self.assertEqual(response['error'], 'invalid_frame')
            server.peer_uid = os.geteuid() + 1
            with self.assertRaises((OSError, ValueError, m.Denied)):
                m.call(sockets / 'a', {'op': 'list'})
            server.peer_uid = os.geteuid()
            held = [server.clients.acquire(False) for _ in range(8)]
            self.assertTrue(all(held))
            with self.assertRaises((OSError, ValueError, m.Denied)):
                m.call(sockets / 'a', {'op': 'list'})
            for _ in held:
                server.clients.release()
            relay.run_lock.acquire()
            try:
                self.assertEqual(m.call(sockets / 'a', {'op': 'status', 'machine': 'worker'})['error'], 'busy')
            finally:
                relay.run_lock.release()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_subprocess_timeout_output_and_generation_change_suppress_result(self):
        env = {'PATH': '/usr/bin:/bin'}
        p = m.bounded_process(['/usr/bin/python3', '-c', 'print("x"*10000)'], timeout=1, env=env)
        self.denied('output_limit', m.communicate, p, b'', 1, limit=100)
        p = m.bounded_process(['/bin/sleep', '3'], timeout=1, env=env)
        self.denied('timeout_remote_unknown', m.communicate, p, b'', 0.05)
        p = m.bounded_process(['/bin/sleep', '3'], timeout=1, env=env)
        def revoked():
            raise m.Denied('revoked_remote_unknown')
        self.denied('revoked_remote_unknown', m.communicate, p, b'', 1, current=revoked)
        self.assertIsNotNone(p.returncode)

    def test_relay_rechecks_actual_registry_while_child_runs(self):
        relay = m.Relay(self.reg.root, 'alpha')
        with patch.object(m, 'ssh_argv', return_value=['/bin/sleep', '3']):
            thread = threading.Thread(target=lambda: (time.sleep(0.1), self.reg.revoke('worker')))
            thread.start()
            try:
                result = relay.dispatch({'machine': 'worker', 'op': 'status'})
            finally:
                thread.join()
        self.assertFalse(result['ok'])
        self.assertNotIn('result', result)
        rows = [json.loads(x) for x in (self.reg.root / 'audit.jsonl').read_text().splitlines()]
        self.assertEqual([x['state'] for x in rows], ['admitted', 'denied'])
        self.assertNotIn('worker.invalid', json.dumps(rows))

    def test_audit_failure_blocks_transport(self):
        (self.reg.root / 'audit.jsonl').symlink_to(self.root / 'identity')
        relay = m.Relay(self.reg.root, 'alpha')
        with patch.object(m.subprocess, 'Popen') as process:
            response = relay.dispatch({'op': 'status', 'machine': 'worker'})
            self.assertEqual(response['error'], 'audit_unavailable')
            process.assert_not_called()

    def test_fable_schema_and_target_envelope_regressions(self):
        relay = m.Relay(self.reg.root, 'alpha')
        for path in ([], {'host': 'bad'}, '', 'x' * 513, '../escape'):
            with patch.object(m.subprocess, 'Popen') as process:
                result = relay.dispatch({'op': 'fetch-file', 'machine': 'worker', 'path': path})
                self.assertEqual(result['error'], 'invalid_path')
                process.assert_not_called()
        unicode_path = '\U0001f600' * 512
        m.validate_request({'op': 'fetch-file', 'path': unicode_path})
        wire = json.dumps({'agent': 'alpha', 'request': {'op': 'fetch-file', 'path': unicode_path}}, separators=(',', ':')).encode() + b'\n'
        self.assertLessEqual(len(wire), m.FRAME)
        with patch.object(m, 'ssh_argv', return_value=['/usr/bin/python3', '-c', 'print("[]")']):
            result = relay.dispatch({'op': 'status', 'machine': 'worker'})
            self.assertEqual(result['error'], 'target_denied')
        with patch.object(m, 'ssh_argv', side_effect=m.subprocess.SubprocessError('fixture')):
            result = relay.dispatch({'op': 'status', 'machine': 'worker'})
            self.assertEqual(result['error'], 'unavailable')
        states = [json.loads(x)['state'] for x in (self.reg.root / 'audit.jsonl').read_text().splitlines()]
        self.assertEqual(states[-4:], ['admitted', 'denied', 'admitted', 'denied'])

    def test_proof_guard_survives_python_optimization(self):
        import subprocess
        import sys
        script = Path(__file__).parents[1] / 'ops/machines/container-proof.py'
        env = {**os.environ, 'MACHINES_DISPOSABLE_PROOF': ''}
        r = subprocess.run([sys.executable, '-O', str(script)], capture_output=True, text=True, env=env, timeout=2)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('disposable root container only', r.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
