import argparse
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import ghcr_image as ci

SHA = 'a' * 40
DIGEST = 'sha256:' + 'b' * 64


class ImageContract(unittest.TestCase):
    def args(self, **kwargs):
        data = dict(image='ghcr.io/humanitylabs-org/wizard-ux', sha=SHA, digest=DIGEST,
                    tag='sha-' + SHA, release='', confirm='', expected_sha='',
                    branch='daily', retry_seconds=0)
        return argparse.Namespace(**(data | kwargs))

    def test_clean_environment_removes_all_credentials(self):
        with patch.dict(os.environ, {'GHCR_TOKEN': 'secret', 'DOCKER_AUTH_CONFIG': 'secret', 'GITHUB_TOKEN': 'secret', 'HOME': '/owner'}, clear=False):
            env = ci.clean_env('/isolated')
        self.assertEqual(env['HOME'], '/isolated')
        self.assertEqual(env['DOCKER_CONFIG'], '/isolated')
        self.assertFalse({'GHCR_TOKEN', 'GITHUB_TOKEN', 'DOCKER_AUTH_CONFIG'} & env.keys())

    def test_missing_architecture_fails(self):
        registry = Mock()
        registry.manifest.return_value = (DIGEST, {'manifests': []})
        with self.assertRaisesRegex(RuntimeError, 'amd64'):
            ci.platform_manifests(registry, DIGEST)

    def test_digest_mismatch_fails(self):
        registry = Mock()
        registry.manifest.return_value = ('wrong', {})
        with self.assertRaisesRegex(RuntimeError, 'digest'):
            ci.platform_manifests(registry, DIGEST)

    def test_pull_request_never_publishes(self):
        with patch.dict(os.environ, {'GITHUB_REF': 'refs/heads/daily', 'GITHUB_EVENT_NAME': 'pull_request'}):
            with self.assertRaisesRegex(RuntimeError, 'trusted branch'):
                ci.publish(self.args())

    def test_other_branch_never_publishes(self):
        with patch.dict(os.environ, {'GITHUB_REF': 'refs/heads/feature/test', 'GITHUB_EVENT_NAME': 'workflow_dispatch'}):
            with self.assertRaisesRegex(RuntimeError, 'trusted branch'):
                ci.publish(self.args())

    def test_release_requires_confirmation_and_exact_sha(self):
        with patch.dict(os.environ, {'GITHUB_REF': 'refs/heads/daily', 'GITHUB_EVENT_NAME': 'workflow_dispatch'}):
            for confirm, sha in [('', SHA), ('0.3.0', ''), ('other', SHA)]:
                with self.subTest(confirm=confirm, sha=sha):
                    with self.assertRaisesRegex(RuntimeError, 'confirm'):
                        ci.publish(self.args(release='0.3.0', confirm=confirm, expected_sha=sha))

    def test_release_not_allowed_on_push(self):
        with patch.dict(os.environ, {'GITHUB_REF': 'refs/heads/daily', 'GITHUB_EVENT_NAME': 'push'}):
            with self.assertRaisesRegex(RuntimeError, 'confirm'):
                ci.publish(self.args(release='0.3.0', confirm='0.3.0', expected_sha=SHA))

    @patch.object(ci, 'docker')
    @patch.object(ci, 'Registry')
    def test_existing_release_fails_without_login_or_overwrite(self, registry, docker):
        registry.return_value.manifest.return_value = (DIGEST, {})
        with tempfile.TemporaryDirectory() as temp:
            env = {'GITHUB_REF': 'refs/heads/daily', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
                   'WIZARD_CI_ROOT': '/Volumes/ThalesMedia/Test',
                   'WIZARD_CI_WORKER_LOCK': temp + '/worker.lock',
                   'GITHUB_ACTOR': 'test', 'GHCR_TOKEN': 'unit-test-only'}
            with patch.dict(os.environ, env), patch.object(ci.tempfile, 'TemporaryDirectory') as directory:
                directory.return_value.__enter__.return_value = temp
                with self.assertRaisesRegex(RuntimeError, 'already exists'):
                    ci.publish(self.args(release='0.3.0', confirm='0.3.0', expected_sha=SHA))
                config = ci.json.loads(Path(temp, 'config.json').read_text())
                self.assertEqual(set(config), {'auths', 'cliPluginsExtraDirs'})
                self.assertIn('ghcr.io', config['auths'])
                self.assertEqual(Path(temp, 'config.json').stat().st_mode & 0o777, 0o600)
        docker.assert_not_called()

    @patch.object(ci, 'Registry')
    def test_private_package_fails_closed(self, registry):
        registry.side_effect = ci.urllib.error.HTTPError('url', 403, 'private', {}, None)
        with self.assertRaisesRegex(RuntimeError, 'must be Public'):
            ci.verify(self.args())
        registry.assert_called_once_with(self.args().image)

    @patch.object(ci, 'docker')
    @patch.object(ci, 'platform_manifests', return_value={'amd64': 'config-amd64', 'arm64': 'config-arm64'})
    @patch.object(ci, 'Registry')
    def test_real_pull_commands_for_digest_and_all_tags(self, registry, platforms, docker):
        registry.return_value.manifest.return_value = (DIGEST, {})
        arch = None
        calls = []
        def run(args, env, **kwargs):
            nonlocal arch
            self.assertNotIn('GHCR_TOKEN', env)
            self.assertEqual(Path(env['DOCKER_CONFIG'], 'config.json').read_text(), '{"auths":{}}')
            if args[0] == 'info':
                return subprocess.CompletedProcess(args, 0, stdout='[["driver-type", "io.containerd.snapshotter.v1"]]')
            if args[0] == 'pull':
                arch = args[2].split('/')[1]
                calls.append((arch, args[3]))
                return subprocess.CompletedProcess(args, 0)
            self.assertIn('--platform', args)
            self.assertEqual(args[3], 'linux/' + arch)
            return subprocess.CompletedProcess(args, 0, stdout=f'{arch} {SHA}\n')
        docker.side_effect = run
        ci.verify(self.args(release='0.3.0-candidate.20261012'))
        self.assertEqual(len(calls), 6)
        self.assertEqual({arch for arch, ref in calls}, ci.PLATFORMS)
        self.assertEqual(len({ref for arch, ref in calls}), 3)

    @patch.object(ci, 'docker')
    @patch.object(ci, 'platform_manifests', return_value={})
    @patch.object(ci, 'Registry')
    def test_tag_digest_mismatch_fails_before_pull(self, registry, platforms, docker):
        registry.return_value.manifest.return_value = ('wrong', {})
        with self.assertRaisesRegex(RuntimeError, 'verification failed'):
            ci.verify(self.args())
        self.assertTrue(all(call.args[0][0] != 'pull' for call in docker.call_args_list))


if __name__ == '__main__':
    unittest.main()
