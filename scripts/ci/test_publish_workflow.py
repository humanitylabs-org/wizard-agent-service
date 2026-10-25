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
        publish = self.job('publish', 'anonymous-pull')
        self.assertIn('group: public-release-${{ github.repository }}-${{ inputs.release_tag || github.sha }}', publish)
        self.assertIn('cancel-in-progress: false', publish)

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
        attest = self.workflow.split('\n  attest:', 1)[1]
        self.assertIn("needs.publish.outputs.built == 'true'", attest)
        self.assertIn('--bundle-from-oci', attest)
        self.assertIn('--source-digest "$GITHUB_SHA"', attest)
        self.assertIn('--source-ref refs/heads/main', attest)

    def test_every_action_is_pinned_and_no_worker_state(self):
        for action in re.findall(r'uses:\s*(\S+)', self.workflow):
            self.assertRegex(action, r'^[\w-]+/[\w-]+@[0-9a-f]{40}$')
        for forbidden in ('self-hosted', 'WIZARD_CI_WORKER_LOCK', 'WIZARD_CI_ROOT'):
            self.assertNotIn(forbidden, self.workflow)
        for name, following in [('publish', 'anonymous-pull'), ('anonymous-pull', 'attest')]:
            job = self.job(name, following)
            for guard in ('github.repository ==', "github.ref == 'refs/heads/main'", "github.event_name == 'push'", "github.event_name == 'workflow_dispatch'"):
                self.assertIn(guard, job)


if __name__ == '__main__':
    unittest.main()
