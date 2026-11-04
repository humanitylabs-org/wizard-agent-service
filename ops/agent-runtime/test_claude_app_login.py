"""Synthetic app metadata only; every Docker call mocked, no real login reads."""
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


class ClaudeLoginTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.agent = agent_folder(self.root, 'daily', {'uplink': '10.250.0.16/28', 'sandbox': '10.251.0.16/28'})
        self.agent['privacy'] = 'standard'
        self.folder = self.root / 'daily'; self.agents = ar.Agents(self.root, None)
        self.driver = ar.RestrictedDriver(self.agents, ar.RESTRICTED_DIR, '')
        self.calls = []; self.installed = True; self.connected = True; self.seeder = True; self.kind = 'volume'
        self.patch = mock.patch.object(ar, 'docker', side_effect=self.fake)
        self.patch.start(); self.addCleanup(self.patch.stop)

    def fake(self, args, timeout=0, env=None, check=True):
        self.calls.append((args, env))
        output, code = '', 0
        if args[0] == 'ps':
            if 'label=com.docker.compose.service=wizard-claude-engine' in args:
                output = 'app-engine' if self.installed else ''
            elif 'label=com.docker.compose.service=claude-init' in args:
                output = 'fixture-seeder' if self.seeder else ''
        if args[0] == 'inspect':
            mount = {'Type': self.kind, 'Name': ar.CLAUDE_LOGIN_VOLUME,
                     'Source': '/srv/app-data/core/wizard-claude/data/claude', 'Destination': '/claude'}
            self.assertIn('--format', args)
            self.assertNotIn('.Config.Env', args[args.index('--format') + 1])
            output = json.dumps({'Config': {'Labels': {'com.docker.compose.service': 'wizard-claude-engine'}},
                                 'State': {'Running': True}, 'Mounts': [mount]})
        if args[0] == 'exec': code = int(not self.connected)
        return subprocess.CompletedProcess(args, code, output, '')

    def compose_call(self):
        return next((args, env) for args, env in reversed(self.calls) if args[0] == 'compose')

    def test_legacy_and_share_source_are_read_only_and_not_on_agent(self):
        for kind in ('volume','bind'):
            self.kind = kind; self.driver._compose(self.agent, 'config', timeout=30)
            args, env = self.compose_call()
            self.assertIn(str(ar.RESTRICTED_DIR / 'compose.claude-login.yml'), args)
            source = json.loads((self.folder/'runtime/claude-source.json').read_text())
            self.assertEqual(set(source['services']), {'claude-init'})
            mount = source['services']['claude-init']['volumes'][0]
            self.assertTrue(mount['read_only']); self.assertEqual(mount['target'], '/claude-app')
            self.assertEqual(mount['type'], kind)
            self.assertEqual(env['CLAUDE_CODE_OAUTH_TOKEN'], '')
            self.assertEqual(env['CLAUDE_TOKEN_FILE'], '')

    def test_private_unknown_unrestricted_and_other_provider_never_inspect_app(self):
        for changes in ({'privacy':'private'}, {'privacy':'unknown'}, {'privacy':None},
                        {'model':{'provider':'tinfoil'}}, {'runtime':{'isolation':'container', 'network':self.agent['runtime']['network']}}):
            self.calls.clear(); self.driver._compose({**self.agent, **changes}, 'config', timeout=30)
            args, env = self.compose_call()
            self.assertNotIn(str(ar.RESTRICTED_DIR/'compose.claude-login.yml'), args)
            self.assertFalse(any(a[0] == 'inspect' for a,e in self.calls))

    def test_ambient_secret_or_path_does_not_authorize(self):
        self.installed = False
        with mock.patch.dict(os.environ, {'CLAUDE_CODE_OAUTH_TOKEN':'SYNTHETIC-ambient',
                                          'CLAUDE_TOKEN_FILE':'/ungranted/secret', 'CLAUDE_LOGIN_VOLUME':'foreign'}):
            self.driver._compose(self.agent, 'config', timeout=30)
        args, env = self.compose_call()
        self.assertNotIn(str(ar.RESTRICTED_DIR/'compose.claude-login.yml'), args)
        self.assertNotIn('SYNTHETIC-ambient', json.dumps(self.calls))
        self.assertEqual(env['CLAUDE_TOKEN_FILE'], '')

    def test_apply_stops_before_seeder_removal_home_sync_and_up(self):
        result = self.driver.apply(self.agent); self.assertEqual(result['last_error'], '')
        commands = [a for a,e in self.calls]
        stopping = next(i for i,a in enumerate(commands) if 'stop' in a)
        removal = commands.index(['rm','-f','fixture-seeder'])
        sync = next(i for i,a in enumerate(commands) if a[0] == 'run')
        up = next(i for i,a in enumerate(commands) if 'up' in a)
        self.assertLess(stopping,removal); self.assertLess(removal,sync); self.assertLess(sync,up)
        self.assertIn('--force-recreate', commands[up]); self.assertIn('--remove-orphans', commands[up])

    def test_private_or_revoked_stop_still_removes_old_seeder(self):
        for privacy in ('standard','private'):
            self.calls.clear(); self.driver.stop({**self.agent,'privacy':privacy})
            commands=[a for a,e in self.calls]
            self.assertLess(next(i for i,a in enumerate(commands) if a[-1]=='stop'), commands.index(['rm','-f','fixture-seeder']))
            query=next(a for a in commands if 'label=com.docker.compose.service=claude-init' in a)
            self.assertIn('label=com.docker.compose.project=agent-daily',query)

    def test_failed_stop_does_not_revoke_running_agents_login(self):
        with mock.patch.object(self.driver,'_compose',side_effect=ar.RuntimeFailure('docker_failed')):
            with self.assertRaises(ar.RuntimeFailure): self.driver.stop(self.agent)
        self.assertEqual(self.calls,[])

    def test_absent_disconnected_or_missing_seeder_start_without_crash_loop(self):
        for installed, connected, seeder in ((False,False,False),(True,False,True),(True,True,False)):
            self.installed,self.connected,self.seeder=installed,connected,seeder
            with mock.patch.object(self.driver,'_prepare'):
                result=self.driver.start(self.agent)
            self.assertTrue(result['ok']); self.assertEqual(result['status_detail'],'claude_login_missing')
            self.assertEqual(result['last_error'],'claude_login_missing')

    def test_metadata_or_check_timeout_is_missing_login_not_failed_start(self):
        with mock.patch.object(ar, 'docker', side_effect=subprocess.TimeoutExpired('docker', 30)):
            self.assertIsNone(self.driver.claude_source(self.agent))
            self.assertEqual(self.driver.claude_status(self.agent)['status_detail'], 'claude_login_missing')
        with mock.patch.object(self.driver, 'claude_source', return_value={'type':'volume','source':ar.CLAUDE_LOGIN_VOLUME}), \
                mock.patch.object(ar, 'docker', side_effect=subprocess.TimeoutExpired('docker',30)):
            self.assertEqual(self.driver.claude_status(self.agent)['status_detail'], 'claude_login_missing')

    def test_reconnected_login_clears_warning_and_private_has_no_warning(self):
        self.assertEqual(self.driver.claude_status(self.agent),{'last_error':'','status_detail':''})
        self.calls.clear()
        self.assertEqual(self.driver.claude_status({**self.agent,'privacy':'private'})['status_detail'],'')
        self.assertEqual(self.calls,[])

    def test_retired_cli_rejected_without_reading_stdin(self):
        result=subprocess.run([sys.executable,ar.__file__,'--agents-dir',str(self.root),'set-secret','daily','claude.token'],
                              input='SYNTHETIC-input',capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0); self.assertNotIn('SYNTHETIC-input',result.stdout+result.stderr)
        self.assertFalse((self.folder/'claude.token').exists()); self.assertFalse(hasattr(self.agents,'set_secret'))

    def test_login_not_in_home_sync(self):
        self.driver.sync_home(self.agent)
        self.assertNotIn(':/claude-app',json.dumps(self.calls))
        self.assertNotIn('claude.token',json.dumps(self.calls))

    def test_custom_aliases_exact_and_invalid_aliases_before_docker(self):
        with mock.patch.dict(os.environ,{'EGRESS_PASSTHROUGH_HOSTS':'platform.claude.com'}):
            self.driver._compose(self.agent,'config',timeout=30)
        self.assertIn('aliases: !override ["platform.claude.com"]',(self.folder/'runtime/passthrough.yml').read_text())
        for host in ('agent','edge','egress','localhost','agent-service-host','bad-.example.com'):
            self.calls.clear()
            with mock.patch.dict(os.environ,{'EGRESS_PASSTHROUGH_HOSTS':host}), self.assertRaises(ValueError):
                self.driver._compose(self.agent,'config',timeout=30)
            self.assertEqual(self.calls,[])

    def test_secret_has_no_http_route(self):
        handler=object.__new__(ar.make_handler('fixture-auth',self.agents,self.driver))
        handler.path='/agents/daily/set-secret'; handler.headers=Message()
        handler.headers['Authorization']='Bearer fixture-auth'; handler._json=mock.Mock()
        handler.do_POST(); handler._json.assert_called_once_with(404,{'error':'not_found'})

    def test_service_keeps_missing_login_warning_and_clears_after_start(self):
        script = r'''
import { createAgentRegistry } from './server/agents.mjs';
import { readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import assert from 'node:assert/strict';
let missing = true, prepared = 0, starts = 0;
const servers = new Map();
const result = () => {
  assert.equal(prepared, ++starts, 'socket reconciliation must precede runtime apply/start');
  return {ok: true, last_error: missing ? 'claude_login_missing' : ''};
};
const registry = createAgentRegistry({
  agentsDir: process.argv[1], isolation: 'restricted',
  mainProviders: async () => [{id: 'anthropic', models: ['claude-sonnet-4-6', 'claude-opus-4-6']}],
  beforeRestrictedStart: async id => {
    prepared++;
    if (servers.has(id)) return;
    const gateway = join(process.argv[1], id, 'gateway');
    mkdirSync(gateway, {recursive: true, mode: 0o700});
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url === '/health' ? {status: 'ok'} : {data: [], has_more: false}));
    });
    servers.set(id, server);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(join(gateway, 'ingress.sock'), resolve); });
    chmodSync(join(gateway, 'ingress.sock'), 0o600);
  },
  runtime: {apply: async () => result(), start: async () => result(), stop: async () => ({ok: true})},
  fetchImpl: async () => new Response('{}', {status: 200})
});
try {
const {agent} = await registry.create({label: 'Login', model: {provider: 'anthropic', model: 'claude-sonnet-4-6'}});
assert.equal(JSON.parse(readFileSync(join(process.argv[1], agent.id, 'service-state.json'))).last_error, 'claude_login_missing');
assert.deepEqual(await registry.status(agent, {fresh: true}), {status: 'running', status_detail: 'claude_login_missing'});
await registry.update(agent.id, {model: {provider: 'anthropic', model: 'claude-opus-4-6'}});
assert.equal(prepared, 2);
assert.equal(JSON.parse(readFileSync(join(process.argv[1], agent.id, 'service-state.json'))).last_error, 'claude_login_missing');
missing = false;
await registry.setRunning(agent.id, true);
assert.deepEqual(await registry.status(agent, {fresh: true}), {status: 'running', status_detail: ''});
assert.equal(JSON.parse(readFileSync(join(process.argv[1], agent.id, 'service-state.json'))).last_error, '');
assert.equal(prepared, 3);
} finally {
  await Promise.all([...servers.values()].map(server => new Promise(resolve => server.close(resolve))));
}
'''
        run = subprocess.run(['node', '--input-type=module', '-e', script, str(self.root / 's')],
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
