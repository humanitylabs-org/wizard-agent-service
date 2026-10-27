"""Synthetic-only tests. Run on the staged remote rig, never a private home."""
import base64
import concurrent.futures
import http.client
import json
from pathlib import Path
import subprocess
import sys
import types
import tempfile
import threading
import unittest
from unittest.mock import patch

import agent_runtime as runtime
from incognito_runtime import IncognitoManager, SEEDS, read_seed

SID = 'incog_' + 'a'*32
OTHER = 'incog_' + 'b'*32
AGENT = {'schema': 1, 'id': 'synthetic', 'privacy': 'private',
         'model': {'provider': 'tinfoil', 'model': 'synthetic-model'},
         'runtime': {'kind': 'container', 'port': 18001, 'app_id': 'agent-synthetic'}}


class Docker:
    def __init__(self):
        self.calls = []
        self.resources = {}
        self.fail = None
        self.seed_output = '{}'

    def __call__(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if self.fail and self.fail(args):
            return subprocess.CompletedProcess(args, 1, '', 'synthetic-sensitive-error')
        out = ''
        if args[:2] == ['ps', '-aq']:
            out = '\n'.join(n for n, kind in self.resources.items() if kind == 'container')
        elif args[:3] == ['network', 'ls', '-q']:
            out = '\n'.join(n for n, kind in self.resources.items() if kind == 'network')
        elif args[0] == 'inspect' or args[:2] == ['network', 'inspect']:
            out = args[-1]
        elif args[:2] == ['network', 'create']:
            self.resources[args[-1]] = 'network'
        elif args[0] in ('create', 'run'):
            self.resources[args[args.index('--name')+1]] = 'container'
        elif args[:2] == ['rm', '-f'] or args[:2] == ['network', 'rm']:
            self.resources.pop(args[-1], None)
        elif args[0] == 'port':
            out = '127.0.0.1:23456\n'
        elif args[:2] == ['exec', '-u']:
            out = self.seed_output
        return subprocess.CompletedProcess(args, 0, out, '')


class IncognitoTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.agents = runtime.Agents(self.root, None)
        home = self.agents.home('synthetic')
        (home / 'memories').mkdir(parents=True)
        (home / 'memories/MEMORY.md').write_text('Favourite colour: ultraviolet-TEST')
        (home / 'SOUL.md').write_text('Synthetic prompt')
        (home / 'state.db').write_bytes(b'NEVER COPY')
        (home / '.env').write_text('DO_NOT_COPY=synthetic')
        self.driver = runtime.ComposeDriver(self.agents, runtime.DEFAULT_IMAGE, runtime.DEFAULT_PROXY_IMAGE)
        self.docker = Docker()
        self.now = 0
        self.keys = patch.object(self.agents, 'tinfoil_key', return_value='synthetic-provider-key')
        self.keys.start()
        self.addCleanup(self.keys.stop)
        self.manager = self.make_manager()
        self.addCleanup(self.manager.close)

    def make_manager(self):
        return IncognitoManager(self.driver, docker=self.docker, failure=runtime.RuntimeFailure,
                                image=runtime.DEFAULT_IMAGE, proxy_image=runtime.DEFAULT_PROXY_IMAGE,
                                container_for=lambda *a: 'synthetic-source', clock=lambda: self.now,
                                background=False, ready=lambda *a: None)

    def test_no_disk_writes_no_docker_secrets_or_persistent_mounts(self):
        before = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        with patch('builtins.open', side_effect=AssertionError('host write')), patch('os.mkdir', side_effect=AssertionError('host mkdir')):
            result = self.manager.start(AGENT, SID)
        self.assertEqual(result['origin'], 'http://127.0.0.1:23456')
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()})
        for args, _ in self.docker.calls:
            self.assertNotIn('synthetic-provider-key', ' '.join(args))
            self.assertNotIn(result['key'], ' '.join(args))
            self.assertFalse({'--volume', '-v', '--mount', '--env-file'} & set(args))
            if args[0] in ('run', 'create'):
                self.assertIn('--read-only', args)
                self.assertEqual(args[args.index('--log-driver')+1], 'none')
                self.assertEqual(args[args.index('--restart')+1], 'no')
        payload = next(json.loads(kw['input_text']) for args, kw in self.docker.calls if args[:2] == ['exec', '-i'])
        files = payload['files']
        self.assertEqual(set(files), {'SOUL.md', 'memories/MEMORY.md', 'config.yaml', '.env'})
        cfg = json.loads(base64.b64decode(files['config.yaml']))
        self.assertEqual(cfg['platform_toolsets']['api_server'], [])
        self.assertEqual(cfg['mcp_servers'], {})
        self.assertEqual(cfg['plugins']['enabled'], [])
        self.assertEqual(cfg['fallback_providers'], [])
        self.manager.stop('synthetic', SID)
        self.assertEqual(self.docker.resources, {})

    def test_seed_allowlist_symlinks_and_size(self):
        home = self.agents.home('synthetic')
        self.assertEqual(set(read_seed(home)), {'SOUL.md', 'memories/MEMORY.md'})
        (home / 'AGENTS.md').symlink_to(home / 'state.db')
        with self.assertRaises(OSError):
            read_seed(home)
        (home / 'AGENTS.md').unlink()
        (home / 'memories/MEMORY.md').unlink()
        (home / 'memories').rmdir()
        (home / 'memories').symlink_to(home, target_is_directory=True)
        with self.assertRaises(OSError):
            read_seed(home)
        (home / 'memories').unlink()
        (home / 'SOUL.md').write_bytes(b'x'*(128*1024+1))
        with self.assertRaises(ValueError):
            read_seed(home)

    def test_inaccessible_seed_uses_read_only_exec(self):
        self.docker.seed_output = json.dumps({'SOUL.md': base64.b64encode(b'synthetic').decode()})
        with patch('incognito_runtime.read_seed', side_effect=PermissionError):
            self.manager.start(AGENT, SID)
        args = next(args for args, _ in self.docker.calls if args[:2] == ['exec', '-u'])
        self.assertIn('synthetic-source', args)
        self.assertNotIn('--mount', args)
        self.assertIn('O_NOFOLLOW', args[-1])

    def test_fail_closed_policy(self):
        for agent in ({**AGENT, 'privacy': 'standard'}, {**AGENT, 'model': {'provider': 'openai', 'model': 'x'}}):
            with self.assertRaises(runtime.RuntimeFailure):
                self.manager.start(agent, SID)
        with self.assertRaises(runtime.RuntimeFailure):
            self.manager.start(AGENT, '../invalid')
        self.assertEqual(self.docker.resources, {})

    def test_every_start_failure_cleans_resources(self):
        for command in ('create', 'run', 'exec', 'port'):
            with self.subTest(command=command):
                self.docker.fail = lambda args: args[0] == command
                with self.assertRaises(runtime.RuntimeFailure):
                    self.manager.start(AGENT, SID)
                self.assertEqual(self.docker.resources, {})
        self.docker.fail = None
        self.manager.ready = lambda *a: (_ for _ in ()).throw(RuntimeError('synthetic'))
        with self.assertRaises(RuntimeError):
            self.manager.start(AGENT, SID)
        self.assertEqual(self.docker.resources, {})

    def test_concurrent_start_single_session_and_stop_race(self):
        def start(sid):
            try:
                self.manager.start(AGENT, sid)
                return True
            except runtime.RuntimeFailure:
                return False
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            results = list(pool.map(start, [SID, OTHER]))
        self.assertEqual(sum(results), 1)
        self.manager.stop('other-agent', SID)
        self.assertEqual(len(self.manager.sessions), 1)
        self.manager.stop('synthetic', SID)
        self.manager.stop('synthetic', OTHER)
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            starts = pool.submit(start, SID)
            stop = pool.submit(self.manager.stop, 'synthetic', SID)
            starts.result(); stop.result()
        self.manager.stop('synthetic', SID)
        self.assertEqual(self.docker.resources, {})

    def test_lease_ttl_and_hard_deadline(self):
        self.manager.start(AGENT, SID)
        self.now = 89
        self.manager.lease('synthetic', SID)
        self.now = 178
        self.manager.sweep()
        self.assertEqual(len(self.manager.sessions), 1)
        self.now = 179
        with self.assertRaises(runtime.RuntimeFailure):
            self.manager.lease('synthetic', SID)
        self.assertEqual(self.docker.resources, {})
        self.manager.start(AGENT, SID)
        for _ in range(20):
            self.now += 89
            self.manager.lease('synthetic', SID)
        self.now = 1979
        self.manager.sweep()
        self.assertEqual(self.docker.resources, {})

    def test_startup_crash_cleanup_and_periodic_orphans(self):
        self.manager.start(AGENT, SID)
        recovery = self.make_manager()
        self.addCleanup(recovery.close)
        self.assertEqual(self.docker.resources, {})
        recovery.start(AGENT, SID)
        active = dict(self.docker.resources)
        self.docker.resources['synthetic-orphan'] = 'container'
        self.docker.resources['synthetic-orphan-network'] = 'network'
        recovery.sweep()
        self.assertEqual(self.docker.resources, active)
        recovery.close()
        self.assertEqual(self.docker.resources, {})
        with self.assertRaises(runtime.RuntimeFailure):
            recovery.start(AGENT, SID)

    def test_real_runtipi_driver_http_routes(self):
        wam = types.ModuleType('wam')
        wam.cli, wam.private = object(), object()
        with patch.dict(sys.modules, {'wam': wam}), patch.object(sys, 'path', list(sys.path)):
            self.driver = runtime.RuntipiDriver(self.agents, runtime.DEFAULT_IMAGE,
                                               runtime.DEFAULT_PROXY_IMAGE, self.root / 'fake-wam', 'alongside')
        with patch.object(self.driver, 'apply', side_effect=AssertionError('must not restart normal agent')):
            self.test_real_compose_driver_http_routes()

    def test_real_compose_driver_http_routes(self):
        (self.root / 'synthetic/agent.json').write_text(json.dumps(AGENT))
        with patch.object(runtime, 'docker', self.docker), patch.object(IncognitoManager, '_ready', return_value=None):
            handler = runtime.make_handler('test-token', self.agents, self.driver)
            server = runtime.ThreadingHTTPServer(('127.0.0.1', 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                for action in ('start', 'lease', 'stop', 'stop'):
                    conn = http.client.HTTPConnection(*server.server_address)
                    conn.request('POST', '/agents/synthetic/incognito/'+action, json.dumps({'session_id': SID}),
                                 {'Authorization': 'Bearer test-token', 'Content-Type': 'application/json'})
                    response = conn.getresponse()
                    body = json.loads(response.read())
                    self.assertEqual(response.status, 200, body)
                    self.assertTrue(body['ok'])
                    conn.close()
                self.assertEqual(self.docker.resources, {})
            finally:
                server.shutdown()
                handler.incognito_manager.close()
                server.server_close()
                thread.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
