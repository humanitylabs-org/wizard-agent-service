"""Per-agent Claude secret grant; synthetic fixtures only, no real Docker invocations."""
import io
from email.message import Message
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent_runtime as ar
from test_agent_runtime import agent_folder


class ClaudeTokenTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.agent = agent_folder(self.root, 'daily', {'uplink': '10.250.0.16/28', 'sandbox': '10.251.0.16/28'})
        self.agent['privacy'] = 'standard'
        self.folder = self.root / 'daily'
        self.agents = ar.Agents(self.root, None)
        self.driver = ar.RestrictedDriver(self.agents, ar.RESTRICTED_DIR, '', 8929)
        self.calls = []
        self.patch = mock.patch.object(ar, 'docker', side_effect=self.fake)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def fake(self, args, timeout=0, env=None):
        self.calls.append((args, env))
        return subprocess.CompletedProcess(args, 0, '', '')

    def set_token(self):
        self.agents.set_secret('daily', 'claude.token', 'fixture-claude-value')

    def test_standard_anthropic_token_only_override(self):
        self.set_token()
        self.driver._compose(self.agent, 'config', timeout=30)
        args, env = self.calls[-1]
        self.assertIn(str(ar.RESTRICTED_DIR / 'compose.claude-token.yml'), args)
        self.assertEqual(env['CLAUDE_CODE_OAUTH_TOKEN'], '')
        self.assertEqual(env['CLAUDE_TOKEN_FILE'], str(self.folder / 'claude.token'))
        self.assertNotIn('fixture-claude-value', json.dumps(env))
        self.assertNotIn('fixture-claude-value', ' '.join(args))
        self.assertNotIn('claude-login', ' '.join(args))
        # Host-side readable owner secrets need not share the helper's effective uid.
        with mock.patch.object(ar.os, 'geteuid', return_value=-1):
            self.assertEqual(self.driver.env(self.agent)['CLAUDE_TOKEN_FILE'], str(self.folder / 'claude.token'))

    def test_private_unknown_and_other_provider_never_receive_token(self):
        self.set_token()
        for changes in ({'privacy': 'private'}, {'privacy': 'unknown'}, {'privacy': None},
                        {'model': {'provider': 'tinfoil', 'id': 'm'}}):
            self.driver._compose({**self.agent, **changes}, 'config', timeout=30)
            args, env = self.calls[-1]
            self.assertNotIn(str(ar.RESTRICTED_DIR / 'compose.claude-token.yml'), args)
            self.assertEqual(env['CLAUDE_CODE_OAUTH_TOKEN'], '')
            self.assertEqual(env['CLAUDE_TOKEN_FILE'], '')

    def test_ambient_token_does_not_authorize(self):
        with mock.patch.dict(os.environ, {'CLAUDE_CODE_OAUTH_TOKEN': 'fixture-ambient',
                                          'CLAUDE_TOKEN_FILE': '/ungranted/claude.token'}):
            self.assertEqual(self.driver.env(self.agent)['CLAUDE_CODE_OAUTH_TOKEN'], '')
            self.assertEqual(self.driver.env(self.agent)['CLAUDE_TOKEN_FILE'], '')

    def test_apply_recreates_seeder_before_home_sync_and_up(self):
        self.set_token()
        def fake(args, **kw):
            result = self.fake(args, **kw)
            if args[0] == 'ps': result.stdout = 'synthetic-seeder-id\n'
            return result
        with mock.patch.object(ar, 'docker', side_effect=fake):
            self.driver.apply(self.agent)
        commands = [args for args, _ in self.calls]
        removal = commands.index(['rm', '-f', 'synthetic-seeder-id'])
        stopping = next(i for i, a in enumerate(commands) if 'stop' in a)
        sync = next(i for i, a in enumerate(commands) if a[0] == 'run')
        up = next(i for i, a in enumerate(commands) if 'up' in a)
        self.assertLess(stopping, removal)
        self.assertLess(removal, sync)
        self.assertLess(sync, up)
        selected = next(a for a in commands if a[0] == 'ps')
        self.assertIn('label=com.docker.compose.project=agent-daily', selected)
        self.assertIn('label=com.docker.compose.service=claude-init', selected)
        self.assertNotIn('fixture-claude-value', json.dumps(self.calls))

    def test_revoked_and_private_stop_remove_old_seeder(self):
        for private in (False, True):
            if private: self.agent['privacy'] = 'private'
            def fake(args, **kw):
                result = self.fake(args, **kw)
                if args[0] == 'ps': result.stdout = 'synthetic-seeder-id\n'
                return result
            self.calls.clear()
            with mock.patch.object(ar, 'docker', side_effect=fake):
                self.driver.stop(self.agent)
            self.assertIn(['rm', '-f', 'synthetic-seeder-id'], [a for a, _ in self.calls])
            commands = [a for a, _ in self.calls]
            self.assertLess(next(i for i, a in enumerate(commands) if a[-1] == 'stop'),
                            commands.index(['rm', '-f', 'synthetic-seeder-id']))

    def test_failed_stop_does_not_remove_a_running_agents_seeder(self):
        self.set_token()
        with mock.patch.object(self.driver, '_compose', side_effect=ar.RuntimeFailure('docker_failed')):
            with self.assertRaises(ar.RuntimeFailure):
                self.driver.stop(self.agent)
        self.assertEqual(self.calls, [])

    def test_start_removes_orphans_on_grant_revocation(self):
        with mock.patch.object(self.driver, '_prepare'):
            self.driver.start(self.agent)
        self.assertEqual(self.calls[-1][0][-3:], ['up', '-d', '--remove-orphans'])

    def test_reserved_custom_aliases_never_reach_compose(self):
        for host in ('agent', 'edge', 'egress', 'localhost', 'agent-service-host', 'bad-.example.com'):
            self.calls.clear()
            with mock.patch.dict(os.environ, {'EGRESS_PASSTHROUGH_HOSTS': host}), self.assertRaises(ValueError):
                self.driver._compose(self.agent, 'config', timeout=30)
            self.assertEqual(self.calls, [])

    def test_missing_token_starts_without_crash_loop(self):
        with mock.patch.object(self.driver, '_prepare'):
            result = self.driver.start(self.agent)
        self.assertTrue(result['ok'])
        self.assertEqual(result['last_error'], 'claude_token_missing')
        self.assertEqual(result['status_detail'], 'claude_token_missing')
        self.assertNotIn(str(ar.RESTRICTED_DIR / 'compose.claude-token.yml'), self.calls[-1][0])

    def test_missing_token_apply_succeeds(self):
        result = self.driver.apply(self.agent)
        self.assertTrue(result['ok'])
        self.assertEqual(result['last_error'], 'claude_token_missing')

    def test_token_clears_warning(self):
        self.set_token()
        self.assertEqual(self.driver.claude_status(self.agent), {'last_error': '', 'status_detail': ''})

    def test_private_has_no_missing_token_warning(self):
        self.agent['privacy'] = 'private'
        self.assertEqual(self.driver.claude_status(self.agent)['status_detail'], '')

    def test_secret_0600_atomic_outside_home(self):
        self.set_token()
        path = self.folder / 'claude.token'
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        ino = path.stat().st_ino
        self.agents.set_secret('daily', 'claude.token', 'fixture-rotated')
        self.assertNotEqual(path.stat().st_ino, ino)
        self.assertFalse((self.folder / 'home' / 'claude.token').exists())
        self.assertEqual(list(self.folder.glob('.claude.token-*')), [])

    def test_symlink_read_refused_and_write_replaces_not_follows(self):
        target = self.root / 'synthetic-other'
        target.write_text('unchanged')
        (self.folder / 'claude.token').symlink_to(target)
        self.assertEqual(self.agents.secret('daily', 'claude.token'), '')
        self.set_token()
        self.assertEqual(target.read_text(), 'unchanged')
        self.assertFalse((self.folder / 'claude.token').is_symlink())

    def test_public_secret_mode_and_fifo_refused(self):
        self.set_token()
        token = self.folder / 'claude.token'
        token.chmod(0o644)
        self.assertEqual(self.agents.secret('daily', 'claude.token'), '')
        token.unlink()
        os.mkfifo(token, 0o600)
        self.assertEqual(self.agents.secret('daily', 'claude.token'), '')
        token.unlink()
        token.write_bytes(b'\xff')
        token.chmod(0o600)
        self.assertEqual(self.agents.secret('daily', 'claude.token'), '')

    def test_bad_secret_input_and_traversal(self):
        for name, value in (('gateway.key', 'fixture'), ('claude.token', ''),
                            ('claude.token', 'a b'), ('claude.token', 'x' * 16385)):
            with self.assertRaises(ar.RuntimeFailure):
                self.agents.set_secret('daily', name, value)
        with self.assertRaises(ar.RuntimeFailure):
            self.agents.set_secret('../escape', 'claude.token', 'fixture')

    def test_cli_stdin_no_http_or_docker(self):
        result = subprocess.run([sys.executable, str(Path(ar.__file__)), '--agents-dir', str(self.root),
                                 'set-secret', 'daily', 'claude.token'],
                                input='fixture-cli-value\n', capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '')
        self.assertNotIn('fixture-cli-value', result.stderr)
        self.assertEqual(self.agents.secret('daily', 'claude.token'), 'fixture-cli-value')

    def test_secret_not_in_home_sync(self):
        self.set_token()
        self.driver.sync_home(self.agent)
        self.assertNotIn('fixture-claude-value', json.dumps(self.calls))
        self.assertNotIn('claude.token', json.dumps(self.calls))

    def test_custom_passthrough_exact_override(self):
        with mock.patch.dict(os.environ, {'EGRESS_PASSTHROUGH_HOSTS': 'platform.claude.com'}):
            self.driver._compose(self.agent, 'config', timeout=30)
        path = self.folder / 'runtime' / 'passthrough.yml'
        self.assertIn(str(path), self.calls[-1][0])
        self.assertIn('aliases: !override ["platform.claude.com"]', path.read_text())

    def test_secret_has_no_http_route(self):
        handler_type = ar.make_handler('fixture-auth', self.agents, self.driver)
        handler = object.__new__(handler_type)
        handler.path = '/agents/daily/set-secret'
        handler.headers = Message()
        handler.headers['Authorization'] = 'Bearer fixture-auth'
        handler._json = mock.Mock()
        handler.do_POST()
        handler._json.assert_called_once_with(404, {'error': 'not_found'})

    def test_service_keeps_missing_token_warning_and_clears_after_start(self):
        script = r'''
import { createAgentRegistry } from './server/agents.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
let missing = true;
const result = () => ({ok: true, last_error: missing ? 'claude_token_missing' : ''});
const registry = createAgentRegistry({
  agentsDir: process.argv[1], isolation: 'restricted',
  mainProviders: async () => [{id: 'anthropic', models: ['claude-sonnet-4-6']}],
  runtime: {apply: async () => result(), start: async () => result(), stop: async () => ({ok: true})},
  fetchImpl: async () => new Response('{}', {status: 200})
});
const {agent} = await registry.create({label: 'Token fixture', model: {provider: 'anthropic', model: 'claude-sonnet-4-6'}});
assert.equal(JSON.parse(readFileSync(join(process.argv[1], agent.id, 'service-state.json'))).last_error, 'claude_token_missing');
assert.deepEqual(await registry.status(agent, {fresh: true}), {status: 'running', status_detail: 'claude_token_missing'});
missing = false;
await registry.setRunning(agent.id, true);
assert.deepEqual(await registry.status(agent, {fresh: true}), {status: 'running', status_detail: ''});
assert.equal(JSON.parse(readFileSync(join(process.argv[1], agent.id, 'service-state.json'))).last_error, '');
'''
        run = subprocess.run(['node', '--input-type=module', '-e', script, str(self.root / 'service-fixture')],
                             cwd=Path(__file__).resolve().parents[2], capture_output=True, text=True, timeout=15)
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_docker_error_never_logs_secret_stderr(self):
        self.patch.stop()
        try:
            with mock.patch.object(ar.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'fixture-secret')), \
                    mock.patch.object(ar.sys, 'stderr', new_callable=io.StringIO) as stderr:
                with self.assertRaises(ar.RuntimeFailure):
                    ar.docker(['compose', 'config'])
                self.assertNotIn('fixture-secret', stderr.getvalue())
        finally:
            self.patch.start()


if __name__ == '__main__':
    unittest.main()
