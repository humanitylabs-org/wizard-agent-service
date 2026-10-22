"""Agent worker confinement; no worker/spool outside temporary fixtures is used.

python3 tests/test_heavy_worker_sandbox.py
Optional local image proof: WIZARD_HEAVY_TEST_IMAGE=<already-present-python-image>
Run under the Docker group; no image is ever pulled. Container is labelled s2d-test.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/heavy-worker.py'
module = importlib.util.spec_from_file_location('worker', SCRIPT)
assert module is not None and module.loader is not None
worker = importlib.util.module_from_spec(module)
module.loader.exec_module(worker)
JOB = 'heavy_' + 'a' * 32
IMAGE = 'fixture-image:approved'
IMAGE_CONFIG = {'Env': ['PATH=/image/bin:/usr/bin'], 'Volumes': None}


class SandboxTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.alpha = self.root / 'agents/alpha'
        self.project = self.alpha / 'project'
        self.project.mkdir(parents=True)
        self.beta = self.root / 'agents/beta/project'
        self.beta.mkdir(parents=True)
        self.home = self.root / 'fixture-home'
        (self.home / '.ssh').mkdir(parents=True)
        (self.home / '.ssh/fixture-key').write_text('fixture-key-not-for-agent')
        self.spec = {'agent_id': 'alpha', 'cwd': str(self.project), 'argv': ['python3', '-c', 'pass'], 'timeout_seconds': 10}
        self.env = patch.dict(os.environ, {'WIZARD_HEAVY_ROOT': str(self.root),
            'WIZARD_HEAVY_AGENT_IMAGE': IMAGE, 'WIZARD_HEAVY_DOCKER_BIN': '/fixture/docker',
            'HOME': str(self.home), 'WORKER_FIXTURE_SECRET': 'fixture-host-only-secret'})
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_unix_socket_only_client_environment_never_container_env(self):
        host = 'unix:///disk/colima/docker.sock'
        with patch.dict(os.environ, {'WIZARD_HEAVY_DOCKER_HOST': host}), \
                patch.object(worker.subprocess, 'run', return_value=Mock(stdout=json.dumps(IMAGE_CONFIG))) as inspect, \
                patch.object(worker.subprocess, 'Popen') as popen:
            self.assertEqual(worker.docker_environment(), {'DOCKER_HOST': host})
            worker.launch_command(self.spec, JOB, 45, 'fixture-log')
            self.assertEqual(inspect.call_args.kwargs['env'], {'DOCKER_HOST': host})
            self.assertEqual(popen.call_args.kwargs['env'], {'DOCKER_HOST': host})
            self.assertNotIn(host, popen.call_args.args[0])
        for bad in ['', 'tcp://localhost:2375', 'unix:///disk/../socket', 'unix:///disk/sock\nBAD=1']:
            with patch.dict(os.environ, {'WIZARD_HEAVY_DOCKER_HOST': bad}), self.assertRaises(ValueError):
                worker.docker_environment()

    def test_traversal_and_foreign_absolute_cwd(self):
        for cwd in (str(self.project / '../../beta/project'), str(self.beta), str(self.home), 'relative'):
            with self.subTest(cwd=cwd), self.assertRaises(ValueError):
                worker.validate({**self.spec, 'cwd': cwd})

    def test_symlink_escape_even_if_a_later_component_returns(self):
        (self.alpha / 'alias').symlink_to(self.beta, target_is_directory=True)
        (self.beta / 'back').symlink_to(self.project, target_is_directory=True)
        for cwd in (self.alpha / 'alias', self.alpha / 'alias/back'):
            with self.subTest(cwd=cwd), self.assertRaises(ValueError):
                worker.validate({**self.spec, 'cwd': str(cwd)})

    def test_agent_root_cannot_alias_beta(self):
        shutil.rmtree(self.alpha)
        self.alpha.symlink_to(self.beta.parent, target_is_directory=True)
        with self.assertRaises(ValueError):
            worker.validate(self.spec)

    def test_missing_sandbox_and_invalid_identity_never_fall_back(self):
        for image in ('', '--privileged', 'bad image'):
            with patch.dict(os.environ, {'WIZARD_HEAVY_AGENT_IMAGE': image}), self.assertRaises(ValueError):
                worker.validate(self.spec)
        for agent in (None, '', '../beta', 'hermes'):
            with self.assertRaises(ValueError):
                worker.validate({**self.spec, 'agent_id': agent})

    def test_exact_docker_command_no_host_env_or_other_mounts(self):
        with patch.object(worker.subprocess, 'run', return_value=Mock(stdout=json.dumps(IMAGE_CONFIG))) as inspect:
            command = worker.agent_command(self.spec, JOB)
        inspect.assert_called_once_with(['/fixture/docker', 'image', 'inspect', '--format', '{{json .Config}}', IMAGE],
            env={}, check=True, capture_output=True, text=True, timeout=15)
        self.assertEqual(command, ['/fixture/docker', 'run', '--rm', '--init', '--pull', 'never',
            '--name', 'wizard-agent-' + JOB, '--user', '10000:10000', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges', '--pids-limit', '512', '--memory', '4g',
            '-v', str(self.alpha) + ':/work', '-w', '/work/project', '-e', 'HOME=/work',
            '-e', 'PATH=/image/bin:/usr/bin', IMAGE, *self.spec['argv']])
        self.assertEqual(command.count('-v'), 1)
        self.assertNotIn(str(self.home), command)
        self.assertNotIn('WORKER_FIXTURE_SECRET', ' '.join(command))
        self.assertNotIn('--env-file', command)

    def test_image_volumes_and_missing_image_path_are_refused(self):
        for config in ({**IMAGE_CONFIG, 'Volumes': {'/other': {}}}, {'Env': []}):
            with patch.object(worker.subprocess, 'run', return_value=Mock(stdout=json.dumps(config))):
                with self.assertRaises(ValueError):
                    worker.agent_command(self.spec, JOB)

    def test_probe_key_and_env_are_not_exposed_by_launch(self):
        probe = ['python3', '-c', 'import os,pathlib; assert not pathlib.Path(os.environ["HOME"],".ssh/fixture-key").exists(); assert "WORKER_FIXTURE_SECRET" not in os.environ']
        spec = {**self.spec, 'argv': probe}
        with patch.object(worker.subprocess, 'run', return_value=Mock(stdout=json.dumps(IMAGE_CONFIG))), \
             patch.object(worker.subprocess, 'Popen') as popen:
            worker.launch_command(spec, JOB, 45, 'fixture-log')
        args, kwargs = popen.call_args
        self.assertEqual(kwargs, {'env': {}, 'stdout': 'fixture-log', 'stderr': subprocess.STDOUT, 'stdin': subprocess.DEVNULL})
        command = args[0]
        image_at = command.index(IMAGE)
        self.assertEqual(command[image_at + 1:], probe)
        envs = [command[i + 1] for i, flag in enumerate(command[:image_at]) if flag == '-e']
        self.assertEqual(envs, ['HOME=/work', 'PATH=/image/bin:/usr/bin'])
        mounts = [command[i + 1] for i, flag in enumerate(command[:image_at]) if flag == '-v']
        self.assertEqual(mounts, [str(self.alpha) + ':/work'])
        self.assertNotIn(str(self.home), mounts)

    def test_hermes_path_has_identical_popen_args_and_environment(self):
        spec = {k: v for k, v in self.spec.items() if k != 'agent_id'}
        with patch.object(worker.subprocess, 'Popen') as popen:
            worker.launch_command(spec, JOB, 45, 'fixture-log')
        popen.assert_called_once_with(spec['argv'], cwd=spec['cwd'], stdout='fixture-log',
            env={**os.environ, 'WIZARD_HEAVY_LOCK_FD': '45', 'WIZARD_WORKER_LANE': 'heavy'},
            stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, pass_fds=(45,))
        self.assertNotIn('agent_id', worker.validate(spec))

    def test_cleanup_targets_only_the_job_container_and_fails_closed(self):
        for result, succeeds in ((Mock(returncode=0, stdout='false', stderr=''), True),
                                 (Mock(returncode=1, stdout='', stderr='No such object'), True),
                                 (Mock(returncode=0, stdout='true', stderr=''), False),
                                 (Mock(returncode=1, stdout='', stderr='daemon unavailable'), False)):
            with patch.object(worker.subprocess, 'run', side_effect=[Mock(), result]) as run:
                if succeeds:
                    worker.kill_agent_container(JOB)
                else:
                    with self.assertRaises(RuntimeError):
                        worker.kill_agent_container(JOB)
                self.assertEqual(run.call_args_list[0].args[0], ['/fixture/docker', 'kill', 'wizard-agent-' + JOB])
                self.assertTrue(all(call.kwargs['env'] == {} for call in run.call_args_list))

    def execute_fixture(self, cancel=False):
        spool = self.root / 'spool'
        db = worker.connect(spool)
        spec = {**self.spec, 'timeout_seconds': 1}
        now = time.time()
        db.execute('INSERT INTO jobs(id,spec,state,created,updated,deadline) VALUES(?,?,?,?,?,?)',
                   (JOB, json.dumps(spec), 'running', now, now, now + 60))
        def launch(*_):
            if cancel:
                db.execute('UPDATE jobs SET cancel=1 WHERE id=?', (JOB,))
            return Mock()
        def cleanup(_):
            self.assertIsNone(db.execute('SELECT execution_result FROM jobs WHERE id=?', (JOB,)).fetchone()[0])
        with (self.root / 'lease').open('a') as lease, \
             patch.object(worker.os, 'getpgrp', return_value=os.getpid()), \
             patch.object(worker.os, 'getsid', return_value=os.getpid()), \
             patch.object(worker.os, 'killpg') as killpg, \
             patch.object(worker.time, 'monotonic', side_effect=[0, 0, 2]), \
             patch.object(worker, 'launch_command', side_effect=launch), \
             patch.object(worker, 'kill_agent_container', side_effect=cleanup) as kill:
            worker.execute(spool, JOB, lease.fileno(), lease.fileno())
        kill.assert_called_once_with(JOB)
        killpg.assert_called_once()
        value = json.loads(db.execute('SELECT execution_result FROM jobs WHERE id=?', (JOB,)).fetchone()[0])
        db.close()
        self.assertEqual(value['state'], 'cancelled' if cancel else 'failed')
        self.assertEqual(value['reason'], '' if cancel else 'deadline')

    def test_timeout_kills_container_before_recording_result(self):
        self.execute_fixture()

    def test_cancel_kills_container_before_recording_result(self):
        self.execute_fixture(cancel=True)

    def test_orphan_recovery_cleans_agent_container_before_finalizing(self):
        spool = self.root / 'orphan-spool'
        db = worker.connect(spool)
        now = time.time()
        db.execute('INSERT INTO jobs(id,spec,state,created,updated) VALUES(?,?,?,?,?)',
                   (JOB, json.dumps(self.spec), 'running', now, now))
        def cleanup(_):
            self.assertEqual(db.execute('SELECT state FROM jobs WHERE id=?', (JOB,)).fetchone()[0], 'running')
        with patch.object(worker, 'connect', return_value=db), \
             patch.object(worker, 'kill_agent_container', side_effect=cleanup) as kill:
            worker.dispatch(spool, self.root / 'lock')
        kill.assert_called_once_with(JOB)
        self.assertEqual(db.execute('SELECT state FROM jobs WHERE id=?', (JOB,)).fetchone()[0], 'interrupted')
        db.close()

    def test_orphan_with_unconfirmed_cleanup_remains_nonterminal(self):
        spool = self.root / 'orphan-spool'
        db = worker.connect(spool)
        now = time.time()
        db.execute('INSERT INTO jobs(id,spec,state,created,updated) VALUES(?,?,?,?,?)',
                   (JOB, json.dumps(self.spec), 'running', now, now))
        with patch.object(worker, 'connect', return_value=db), \
             patch.object(worker, 'kill_agent_container', side_effect=RuntimeError('cleanup unconfirmed')):
            with self.assertRaises(RuntimeError):
                worker.dispatch(spool, self.root / 'lock')
        self.assertEqual(db.execute('SELECT state FROM jobs WHERE id=?', (JOB,)).fetchone()[0], 'running')
        db.close()

    @unittest.skipUnless(os.environ.get('WIZARD_HEAVY_TEST_IMAGE'), 'local-image proof is opt-in')
    def test_real_local_image_cannot_read_host_key_env_or_other_agent(self):
        image = os.environ['WIZARD_HEAVY_TEST_IMAGE']
        binary = shutil.which('docker')
        assert binary is not None
        # Fixture parents must be traversable by the unprivileged container uid.
        for folder in (self.root, self.alpha.parent, self.alpha, self.project):
            folder.chmod(0o755)
        probe = '''import json,os,pathlib
assert not pathlib.Path('/etc/alpine-release').exists(), 'use a non-Alpine image'
home = pathlib.Path(os.environ['HOME'])
assert home == pathlib.Path('/work')
assert not (home / '.ssh/fixture-key').exists()
assert not pathlib.Path(HOST_KEY).exists()
assert 'WORKER_FIXTURE_SECRET' not in os.environ
assert not pathlib.Path(OTHER_AGENT).exists()
assert os.getuid() == 10000
assert pathlib.Path.cwd() == pathlib.Path('/work/project')
print(json.dumps({'host_key': False, 'host_env': False, 'other_agent': False}))
'''.replace('HOST_KEY', repr(str(self.home / '.ssh/fixture-key'))).replace('OTHER_AGENT', repr(str(self.beta)))
        with patch.dict(os.environ, {'WIZARD_HEAVY_AGENT_IMAGE': image, 'WIZARD_HEAVY_DOCKER_BIN': binary}):
            command = worker.agent_command({**self.spec, 'argv': ['python3', '-c', probe]}, JOB)
            command[2:2] = ['--label', 's2d-test', '--network', 'none']
            try:
                result = subprocess.run(command, env={}, capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), {'host_key': False, 'host_env': False, 'other_agent': False})
            finally:
                worker.kill_agent_container(JOB)
            checked = subprocess.run([binary, 'container', 'inspect', worker.container_name(JOB)],
                env={}, capture_output=True, text=True, timeout=15)
            self.assertNotEqual(checked.returncode, 0, 'throwaway container must be removed')


if __name__ == '__main__':
    unittest.main()
