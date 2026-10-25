"""Source contracts complement actionlint and behavioral publisher tests."""
from pathlib import Path
import re
import unittest


class HostedWorkflow(unittest.TestCase):
    def setUp(self):
        self.workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/publish-image.yml').read_text()

    def job(self, name, following):
        return self.workflow.split('\n  ' + name + ':', 1)[1].split('\n  ' + following + ':', 1)[0]

    def test_same_sha_and_same_release_have_separate_serialization(self):
        top = self.workflow.split('\njobs:', 1)[0]
        self.assertIn('group: public-image-${{ github.repository }}-${{ github.sha }}', top)
        self.assertIn('queue: max', top)
        publish = self.job('finalize', 'anonymous-pull')
        self.assertIn('group: public-release-${{ github.repository }}-${{ inputs.release_tag || github.sha }}', publish)
        self.assertIn('cancel-in-progress: false', publish)
        self.assertIn('queue: max', publish)

    def test_pr_build_exercises_publisher_emulation_without_credentials(self):
        build = self.job('pr-build', 'publish')
        self.assertIn('runner: ubuntu-24.04', build)
        self.assertNotIn('runner: ubuntu-24.04-arm', build)
        self.assertIn('docker/setup-qemu-action@', build)
        self.assertIn('platforms: arm64', build)
        self.assertIn("if: github.event_name == 'pull_request'", build)
        for forbidden in ('secrets.', 'packages: write', 'login-action', '--push', 'cache-to', 'upload-artifact'):
            self.assertNotIn(forbidden, build)
        self.assertIn('platform: amd64', build)
        self.assertIn('platform: arm64', build)

    def test_only_real_builds_create_provenance(self):
        attest = self.job('attest', 'finalize')
        self.assertIn('needs: publish', attest)
        self.assertIn("needs.publish.outputs.built == 'true'", attest)
        self.assertIn('--bundle-from-oci', attest)
        self.assertIn('--source-digest "$GITHUB_SHA"', attest)
        self.assertIn('--source-ref refs/heads/main', attest)

    def test_finalize_waits_for_attestation_or_verified_reuse(self):
        finalize = self.job('finalize', 'anonymous-pull')
        self.assertIn('needs: [publish, attest]', finalize)
        self.assertIn('!cancelled()', finalize)
        self.assertIn("needs.attest.result == 'success'", finalize)
        self.assertIn("needs.publish.outputs.built == 'false'", finalize)
        self.assertIn("needs.attest.result == 'skipped'", finalize)
        self.assertIn('ghcr_image.py finalize', finalize)
        self.assertIn('docker/setup-buildx-action@', finalize)
        anonymous = self.workflow.split('\n  anonymous-pull:', 1)[1]
        self.assertIn('needs: [publish, finalize]', anonymous)
        self.assertIn("needs.finalize.result == 'success'", anonymous)

    def test_attest_uses_default_docker_config(self):
        # actions/attest ignores DOCKER_CONFIG; an isolated config makes login invisible
        # to it ("No credentials found for registry ghcr.io") and blocks every release.
        attest = self.job('attest', 'finalize')
        self.assertIn('docker/login-action@', attest)
        self.assertNotIn('DOCKER_CONFIG', attest)

    def test_every_action_is_pinned_and_no_worker_state(self):
        for action in re.findall(r'uses:\s*(\S+)', self.workflow):
            self.assertRegex(action, r'^[\w-]+/[\w-]+@[0-9a-f]{40}$')
        for forbidden in ('self-hosted', 'WIZARD_CI_WORKER_LOCK', 'WIZARD_CI_ROOT'):
            self.assertNotIn(forbidden, self.workflow)
        for name, following in [('publish', 'attest'), ('attest', 'finalize'),
                                ('finalize', 'anonymous-pull')]:
            job = self.job(name, following)
            for guard in ('github.repository ==', "github.ref == 'refs/heads/main'", "github.event_name == 'push'", "github.event_name == 'workflow_dispatch'"):
                self.assertIn(guard, job)


if __name__ == '__main__':
    unittest.main()
