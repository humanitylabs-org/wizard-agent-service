import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import ghcr_image as ci

SHA = 'a' * 40
DIGEST = 'sha256:' + 'b' * 64
IMAGE = 'ghcr.io/humanitylabs-org/' + Path.cwd().name.removeprefix('hosted-')
REPOSITORY = IMAGE.removeprefix('ghcr.io/')


class ImageContract(unittest.TestCase):
    def args(self, **kwargs):
        data = dict(image=IMAGE, sha=SHA, digest=DIGEST, tag='sha-' + SHA,
                    release='', confirm='', expected_sha='', branch='main',
                    builder='isolated-builder', platform='amd64', retry_seconds=0)
        return argparse.Namespace(**(data | kwargs))

    def env(self, temp, event='push', **kwargs):
        data = {'PATH': os.environ['PATH'], 'GITHUB_REPOSITORY': REPOSITORY,
                'GITHUB_REF': 'refs/heads/main', 'GITHUB_EVENT_NAME': event,
                'RUNNER_TEMP': temp, 'DOCKER_CONFIG': temp + '/docker-config',
                'GITHUB_ACTOR': 'test', 'GHCR_TOKEN': 'unit-test-only',
                'GITHUB_OUTPUT': temp + '/output', 'GITHUB_STEP_SUMMARY': temp + '/summary'}
        return data | kwargs

    def test_clean_environment_removes_all_credentials_and_docker_host(self):
        with patch.dict(os.environ, {'PATH': '/bin', 'GHCR_TOKEN': 'secret',
                                     'DOCKER_AUTH_CONFIG': 'secret', 'GITHUB_TOKEN': 'secret',
                                     'DOCKER_HOST': 'owner-socket', 'HOME': '/owner'}, clear=True):
            env = ci.clean_env('/isolated')
        self.assertEqual(env, {'PATH': '/bin', 'HOME': '/isolated', 'DOCKER_CONFIG': '/isolated'})

    def test_hosted_config_must_be_isolated_under_runner_temp(self):
        with tempfile.TemporaryDirectory() as temp:
            for config in (temp, str(Path(temp).parent / 'shared')):
                with self.subTest(config=config), patch.dict(os.environ,
                        {'RUNNER_TEMP': temp, 'DOCKER_CONFIG': config}, clear=True):
                    with self.assertRaisesRegex(RuntimeError, 'RUNNER_TEMP'):
                        ci.hosted_config()
            isolated = temp + '/docker-config'
            with patch.dict(os.environ, {'RUNNER_TEMP': temp, 'DOCKER_CONFIG': isolated}, clear=True):
                self.assertEqual(ci.hosted_config(), Path(isolated))

    def test_missing_architecture_and_digest_mismatch_fail(self):
        registry = Mock()
        registry.manifest.return_value = (DIGEST, {'manifests': []})
        with self.assertRaisesRegex(RuntimeError, 'amd64'):
            ci.platform_manifests(registry, DIGEST)
        registry.manifest.return_value = ('wrong', {})
        with self.assertRaisesRegex(RuntimeError, 'digest'):
            ci.platform_manifests(registry, DIGEST)

    def test_publish_has_independent_repository_event_and_main_guards(self):
        cases = [
            ({'GITHUB_REPOSITORY': 'attacker/fork'}, 'canonical repository'),
            ({'GITHUB_EVENT_NAME': 'pull_request'}, 'event'),
            ({'GITHUB_REF': 'refs/heads/feature/test'}, 'canonical main'),
        ]
        with tempfile.TemporaryDirectory() as temp:
            for changed, message in cases:
                with self.subTest(changed=changed), patch.dict(os.environ,
                        self.env(temp) | changed, clear=True):
                    with self.assertRaisesRegex(RuntimeError, message):
                        ci.publish(self.args())

    def test_release_requires_dispatch_confirmation_exact_sha_and_version(self):
        with tempfile.TemporaryDirectory() as temp:
            for event, release, confirm, expected, message in [
                ('push', '0.3.0', '0.3.0', SHA, 'confirm'),
                ('workflow_dispatch', '0.3.0', 'other', SHA, 'confirm'),
                ('workflow_dispatch', '0.3.0', '0.3.0', 'c' * 40, 'confirm'),
                ('workflow_dispatch', 'latest', 'latest', SHA, 'semantic'),
            ]:
                with self.subTest(event=event, release=release), patch.dict(
                        os.environ, self.env(temp, event=event), clear=True):
                    with self.assertRaisesRegex((RuntimeError, ValueError), message):
                        ci.publish(self.args(release=release, confirm=confirm, expected_sha=expected))

    @patch.object(ci, 'docker')
    @patch.object(ci, 'Registry')
    def test_existing_release_fails_before_build_or_alias_write(self, registry, docker):
        registry.return_value.manifest.side_effect = [None, (DIGEST, {})]
        with tempfile.TemporaryDirectory() as temp, patch.dict(
                os.environ, self.env(temp, event='workflow_dispatch'), clear=True):
            with self.assertRaisesRegex(RuntimeError, 'already exists'):
                ci.publish(self.args(release='0.3.0', confirm='0.3.0', expected_sha=SHA))
        docker.assert_not_called()

    @patch.object(ci, 'docker')
    @patch.object(ci, 'Registry')
    def test_release_never_races_creation_of_sha_tag(self, registry, docker):
        registry.return_value.manifest.side_effect = [None, None]
        with tempfile.TemporaryDirectory() as temp, patch.dict(
                os.environ, self.env(temp, event='workflow_dispatch'), clear=True):
            with self.assertRaisesRegex(RuntimeError, 'existing verified immutable SHA'):
                ci.publish(self.args(release='0.3.0', confirm='0.3.0', expected_sha=SHA))
        docker.assert_not_called()

    @patch.object(ci, 'platform_manifests', return_value={})
    @patch.object(ci, 'docker')
    @patch.object(ci, 'Registry')
    def test_prepare_pushes_by_digest_without_creating_sha_tag(
            self, registry, docker, platforms):
        registry.return_value.manifest.side_effect = [None, (DIGEST, {})]
        def run(command, env, **kwargs):
            self.assertNotIn('GHCR_TOKEN', env)
            self.assertNotIn('DOCKER_HOST', env)
            metadata = Path(command[command.index('--metadata-file') + 1])
            metadata.write_text(json.dumps({'containerimage.digest': DIGEST}))
            return subprocess.CompletedProcess(command, 0)
        docker.side_effect = run
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, self.env(temp), clear=True):
            ci.publish(self.args())
        command = docker.call_args.args[0]
        self.assertEqual(command[command.index('--builder') + 1], 'isolated-builder')
        self.assertIn('--metadata-file', command)
        self.assertIn('--platform', command)
        self.assertIn('linux/amd64,linux/arm64', command)
        self.assertIn('--output', command)
        self.assertIn('type=image,name=' + IMAGE + ',push-by-digest=true,name-canonical=true,push=true', command)
        self.assertNotIn('--tag', command)
        self.assertNotIn(IMAGE + ':sha-' + SHA, command)
        platforms.assert_called_once()


    @patch.object(ci, 'docker')
    @patch.object(ci, 'Registry')
    def test_post_digest_validation_failure_retries_without_immutable_tag(
            self, registry_class, docker):
        registry_class.return_value.manifest.return_value = None
        attempts = 0
        def build(command, env, **kwargs):
            nonlocal attempts
            attempts += 1
            Path(command[command.index('--metadata-file') + 1]).write_text(
                json.dumps({'containerimage.digest': DIGEST}))
            return subprocess.CompletedProcess(command, 0)
        docker.side_effect = build
        with tempfile.TemporaryDirectory() as temp, patch.dict(
                os.environ, self.env(temp), clear=True), patch.object(
                ci, 'platform_manifests',
                side_effect=[RuntimeError('post-digest manifest failure'), {}]):
            with self.assertRaisesRegex(RuntimeError, 'post-digest'):
                ci.publish(self.args())
            ci.publish(self.args())
        self.assertEqual(attempts, 2)
        for call in docker.call_args_list:
            self.assertNotIn('--tag', call.args[0])
            self.assertIn('push-by-digest=true', ' '.join(call.args[0]))
    @patch.object(ci, 'platform_manifests', return_value={})
    @patch.object(ci, 'docker')
    @patch.object(ci, 'Registry')
    @patch.object(ci, 'verify_existing_provenance')
    def test_rerun_reuses_immutable_sha_without_build(self, provenance, registry, docker, platforms):
        registry.return_value.manifest.return_value = (DIGEST, {})
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, self.env(temp), clear=True):
            ci.publish(self.args())
            output = Path(temp, 'output').read_text()
        docker.assert_not_called()
        platforms.assert_called_once_with(registry.return_value, DIGEST, SHA, IMAGE)
        provenance.assert_called_once()
        self.assertIn('digest=' + DIGEST, output)

    @patch.object(ci, 'docker')
    def test_pr_build_is_native_load_only_and_cleanup_is_exact(self, docker):
        def run(command, env, **kwargs):
            self.assertNotIn('GHCR_TOKEN', env)
            self.assertNotIn('--push', command)
            if command[:2] == ['image', 'inspect']:
                return subprocess.CompletedProcess(command, 0, stdout='arm64 ' + SHA + '\n')
            return subprocess.CompletedProcess(command, 0)
        docker.side_effect = run
        with tempfile.TemporaryDirectory() as temp, patch.dict(
                os.environ, self.env(temp, event='pull_request'), clear=True):
            ci.build(self.args(platform='arm64'))
        build = docker.call_args_list[0].args[0]
        self.assertEqual(build[build.index('--builder') + 1], 'isolated-builder')
        self.assertIn('--load', build)
        self.assertEqual(build[build.index('--platform') + 1], 'linux/arm64')
        self.assertEqual(docker.call_args_list[-1].args[0],
                         ['image', 'rm', '--force', 'wizard-pr:arm64-' + SHA])

    def verify_env(self):
        return {'PATH': os.environ['PATH'], 'GITHUB_REPOSITORY': REPOSITORY,
                'GITHUB_EVENT_NAME': 'push', 'GHCR_TOKEN': 'must-not-leak'}

    @patch.object(ci, 'Registry')
    def test_private_package_fails_closed(self, registry):
        registry.side_effect = ci.urllib.error.URLError('private')
        with patch.dict(os.environ, self.verify_env(), clear=True):
            with self.assertRaisesRegex(RuntimeError, 'must be Public'):
                ci.verify(self.args())

    @patch.object(ci, 'docker')
    @patch.object(ci, 'platform_manifests', return_value={'amd64': 'a', 'arm64': 'b'})
    @patch.object(ci, 'Registry')
    def test_anonymous_digest_and_all_tag_pulls_for_both_arches(self, registry, platforms, docker):
        registry.return_value.manifest.return_value = (DIGEST, {})
        arch = None
        pulls = []
        def run(command, env, **kwargs):
            nonlocal arch
            self.assertNotIn('GHCR_TOKEN', env)
            self.assertEqual(Path(env['DOCKER_CONFIG'], 'config.json').read_text(), '{"auths":{}}')
            if command[0] == 'info':
                return subprocess.CompletedProcess(command, 0, stdout='[["driver-type", "io.containerd.snapshotter.v1"]]')
            if command[0] == 'pull':
                arch = command[2].split('/')[1]
                pulls.append((arch, command[3]))
                return subprocess.CompletedProcess(command, 0)
            if command[:2] == ['image', 'rm']:
                return subprocess.CompletedProcess(command, 0)
            return subprocess.CompletedProcess(command, 0, stdout=f'{arch} {SHA}\n')
        docker.side_effect = run
        with patch.dict(os.environ, self.verify_env(), clear=True):
            ci.verify(self.args(release='0.3.0-candidate.20261012'))
        self.assertEqual(len(pulls), 6)
        self.assertEqual({arch for arch, _ in pulls}, ci.PLATFORMS)
        self.assertEqual(len({ref for _, ref in pulls}), 3)

    @patch.object(ci, 'docker')
    @patch.object(ci, 'platform_manifests', return_value={})
    @patch.object(ci, 'Registry')
    def test_tag_digest_mismatch_fails_before_pull(self, registry, platforms, docker):
        registry.return_value.manifest.return_value = ('wrong', {})
        with patch.dict(os.environ, self.verify_env(), clear=True):
            with self.assertRaisesRegex(RuntimeError, 'verification failed'):
                ci.verify(self.args())
        self.assertFalse(any(call.args[0][0] == 'pull' for call in docker.call_args_list))


if __name__ == '__main__':
    unittest.main()
