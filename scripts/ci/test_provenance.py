"""Behavioral regressions from independent review of hosted publication."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import ghcr_image as ci
import test_ghcr_image as fixtures


class ProvenanceContract(unittest.TestCase):
    def setUp(self):
        self.helper = fixtures.ImageContract()

    def test_wrong_revision_or_source_refuses_before_release_alias(self):
        for field, value in [('org.opencontainers.image.revision', 'wrong'),
                             ('org.opencontainers.image.source', 'https://github.com/foreign/repo')]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temp:
                registry = Mock()
                labels = {'org.opencontainers.image.revision': fixtures.SHA,
                          'org.opencontainers.image.source': 'https://github.com/' + fixtures.REPOSITORY}
                labels[field] = value
                child = {'config': {'digest': 'sha256:' + 'c' * 64}}
                def manifest(ref, missing_ok=False):
                    if ref == '0.3.0': return None
                    if ref == fixtures.DIGEST or ref.startswith('sha-'):
                        return fixtures.DIGEST, {'manifests': [
                            {'digest': 'sha256:' + arch[0] * 64, 'platform': {'os': 'linux', 'architecture': arch}}
                            for arch in ['amd64', 'arm64']]}
                    return ref, child
                registry.manifest.side_effect = manifest
                registry.blob.return_value = {'architecture': 'amd64', 'os': 'linux', 'config': {'Labels': labels}}
                with patch.dict(os.environ, self.helper.env(temp, event='workflow_dispatch'), clear=True), patch.object(ci, 'Registry', return_value=registry), patch.object(ci, 'docker') as docker:
                    with self.assertRaisesRegex(RuntimeError, 'source|revision'):
                        ci.publish(self.helper.args(release='0.3.0', confirm='0.3.0', expected_sha=fixtures.SHA))
                    docker.assert_not_called()

    def test_invalid_existing_provenance_prevents_write_once_alias(self):
        registry = Mock()
        registry.manifest.side_effect = [(fixtures.DIGEST, {}), None]
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, self.helper.env(temp, event='workflow_dispatch'), clear=True), patch.object(ci, 'Registry', return_value=registry), patch.object(ci, 'platform_manifests'), patch.object(ci.subprocess, 'run', side_effect=RuntimeError('bad provenance')) as run, patch.object(ci, 'docker') as docker:
            with self.assertRaisesRegex(RuntimeError, 'provenance'):
                ci.publish(self.helper.args(release='0.3.0', confirm='0.3.0', expected_sha=fixtures.SHA))
            docker.assert_not_called()
            command = run.call_args.args[0]
            self.assertIn('--signer-workflow', command)
            self.assertIn(fixtures.REPOSITORY + '/.github/workflows/publish-image.yml', command)
            self.assertIn('--source-digest', command)
            self.assertIn(fixtures.SHA, command)
            self.assertIn('--source-ref', command)
            self.assertIn('refs/heads/main', command)

    def test_verified_release_prepare_does_not_write_alias_or_claim_build(self):
        registry = Mock()
        registry.manifest.side_effect = [(fixtures.DIGEST, {}), None, (fixtures.DIGEST, {})]
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, self.helper.env(temp, event='workflow_dispatch'), clear=True), patch.object(ci, 'Registry', return_value=registry), patch.object(ci, 'platform_manifests'), patch.object(ci.subprocess, 'run') as run, patch.object(ci, 'docker') as docker:
            ci.publish(self.helper.args(release='0.3.0', confirm='0.3.0', expected_sha=fixtures.SHA))
            self.assertIn('built=false', Path(temp, 'output').read_text())
            docker.assert_not_called()
            self.assertEqual(run.call_args.args[0][:3], ['gh', 'attestation', 'verify'])

    def test_fresh_build_marks_built_output(self):
        registry = Mock()
        registry.manifest.side_effect = [None, (fixtures.DIGEST, {})]
        def build(command, env, **kwargs):
            Path(command[command.index('--metadata-file') + 1]).write_text(json.dumps({'containerimage.digest': fixtures.DIGEST}))
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, self.helper.env(temp), clear=True), patch.object(ci, 'Registry', return_value=registry), patch.object(ci, 'platform_manifests'), patch.object(ci, 'docker', side_effect=build):
            ci.publish(self.helper.args())
            self.assertIn('built=true', Path(temp, 'output').read_text())


    @patch.object(ci, 'docker')
    @patch.object(ci, 'Registry')
    def test_finalize_missing_provenance_refuses_all_aliases(self, registry_class, docker):
        registry = registry_class.return_value
        registry.manifest.return_value = None
        with tempfile.TemporaryDirectory() as temp, patch.dict(
                os.environ, self.helper.env(temp), clear=True), patch.object(
                ci, 'platform_manifests'), patch.object(
                ci, 'verify_existing_provenance', side_effect=RuntimeError('missing provenance')):
            with self.assertRaisesRegex(RuntimeError, 'provenance'):
                ci.finalize(self.helper.args())
        docker.assert_not_called()

    @patch.object(ci, 'docker')
    @patch.object(ci, 'Registry')
    def test_finalize_mismatching_sha_refuses_overwrite(self, registry_class, docker):
        registry = registry_class.return_value
        registry.manifest.side_effect = [('sha256:' + 'c' * 64, {}), None]
        with tempfile.TemporaryDirectory() as temp, patch.dict(
                os.environ, self.helper.env(temp), clear=True), patch.object(
                ci, 'platform_manifests'), patch.object(ci, 'verify_existing_provenance'):
            with self.assertRaisesRegex(RuntimeError, 'SHA tag collision'):
                ci.finalize(self.helper.args())
        docker.assert_not_called()

    @patch.object(ci, 'docker')
    @patch.object(ci, 'Registry')
    def test_finalize_existing_exact_sha_creates_version_alias(self, registry_class, docker):
        registry = registry_class.return_value
        registry.manifest.side_effect = [
            (fixtures.DIGEST, {}), None, (fixtures.DIGEST, {}), (fixtures.DIGEST, {})]
        with tempfile.TemporaryDirectory() as temp, patch.dict(
                os.environ, self.helper.env(temp, event='workflow_dispatch'), clear=True), patch.object(
                ci, 'platform_manifests'), patch.object(ci, 'verify_existing_provenance'):
            ci.finalize(self.helper.args(
                release='0.3.0', confirm='0.3.0', expected_sha=fixtures.SHA))
        self.assertEqual(
            [call.args[0] for call in docker.call_args_list],
            [['buildx', '--builder', 'isolated-builder', 'imagetools', 'create',
              '--tag', fixtures.IMAGE + ':0.3.0',
              fixtures.IMAGE + '@' + fixtures.DIGEST]])


    @patch.object(ci, 'docker')
    @patch.object(ci, 'Registry')
    def test_finalize_fresh_digest_creates_sha_alias(self, registry_class, docker):
        registry = registry_class.return_value
        registry.manifest.side_effect = [None, (fixtures.DIGEST, {})]
        with tempfile.TemporaryDirectory() as temp, patch.dict(
                os.environ, self.helper.env(temp), clear=True), patch.object(
                ci, 'platform_manifests'), patch.object(ci, 'verify_existing_provenance'):
            ci.finalize(self.helper.args())
        self.assertEqual(
            docker.call_args.args[0],
            ['buildx', '--builder', 'isolated-builder', 'imagetools', 'create',
             '--tag', fixtures.IMAGE + ':sha-' + fixtures.SHA,
             fixtures.IMAGE + '@' + fixtures.DIGEST])

    @patch.object(ci, 'docker')
    @patch.object(ci, 'Registry')
    def test_finalize_existing_version_refuses_before_alias_write(
            self, registry_class, docker):
        registry = registry_class.return_value
        registry.manifest.side_effect = [
            (fixtures.DIGEST, {}), (fixtures.DIGEST, {})]
        with tempfile.TemporaryDirectory() as temp, patch.dict(
                os.environ, self.helper.env(temp, event='workflow_dispatch'), clear=True), patch.object(
                ci, 'platform_manifests'), patch.object(ci, 'verify_existing_provenance'):
            with self.assertRaisesRegex(RuntimeError, 'release tag already exists'):
                ci.finalize(self.helper.args(
                    release='0.3.0', confirm='0.3.0', expected_sha=fixtures.SHA))
        docker.assert_not_called()

if __name__ == '__main__':
    unittest.main()
