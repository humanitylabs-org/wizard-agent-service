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

    def test_verified_release_uses_exact_digest_and_does_not_claim_a_build(self):
        registry = Mock()
        registry.manifest.side_effect = [(fixtures.DIGEST, {}), None, (fixtures.DIGEST, {})]
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, self.helper.env(temp, event='workflow_dispatch'), clear=True), patch.object(ci, 'Registry', return_value=registry), patch.object(ci, 'platform_manifests'), patch.object(ci.subprocess, 'run') as run, patch.object(ci, 'docker') as docker:
            ci.publish(self.helper.args(release='0.3.0', confirm='0.3.0', expected_sha=fixtures.SHA))
            self.assertIn('built=false', Path(temp, 'output').read_text())
            self.assertEqual(docker.call_args.args[0], ['buildx', '--builder', 'isolated-builder', 'imagetools', 'create', '--tag', fixtures.IMAGE + ':0.3.0', fixtures.IMAGE + '@' + fixtures.DIGEST])
            self.assertEqual(run.call_args.args[0][:3], ['gh', 'attestation', 'verify'])

    def test_fresh_build_marks_built_output(self):
        registry = Mock()
        registry.manifest.side_effect = [None, (fixtures.DIGEST, {})]
        def build(command, env, **kwargs):
            Path(command[command.index('--metadata-file') + 1]).write_text(json.dumps({'containerimage.digest': fixtures.DIGEST}))
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, self.helper.env(temp), clear=True), patch.object(ci, 'Registry', return_value=registry), patch.object(ci, 'platform_manifests'), patch.object(ci, 'docker', side_effect=build):
            ci.publish(self.helper.args())
            self.assertIn('built=true', Path(temp, 'output').read_text())


if __name__ == '__main__':
    unittest.main()
