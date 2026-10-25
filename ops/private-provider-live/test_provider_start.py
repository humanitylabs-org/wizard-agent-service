"""Bounded provider start readiness: fake Runtipi API, synthetic clock only."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from provider_adapter import ensure_running


class RuntipiError(Exception):
    pass


class FakeRuntipi:
    def __init__(self, statuses, start_status='running'):
        self.statuses = list(statuses); self.starts = 0; self.start_status = start_status
    def app(self, urn):
        status = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
        if status == 'missing':
            raise RuntipiError('GET /apps/x -> 404')
        return {'app': {'status': status}}
    def start(self, urn):
        self.starts += 1
        if self.start_status:
            self.statuses = [self.start_status]


class Clock:
    def __init__(self): self.now = 0.0
    def __call__(self): return self.now
    def sleep(self, seconds): self.now += seconds


class EnsureRunningTests(unittest.TestCase):
    def run_with(self, rt, **kw):
        clock = Clock()
        return ensure_running(rt, 'wizard-tinfoil_private:wizardapps', clock=clock, sleep=clock.sleep, **kw), clock

    def test_running_immediately_needs_no_start(self):
        rt = FakeRuntipi(['running'])
        result, _ = self.run_with(rt)
        self.assertEqual(result, {'status': 'running', 'start_requests': 0}); self.assertEqual(rt.starts, 0)

    def test_transient_stopped_settles_without_start(self):
        rt = FakeRuntipi(['installing', 'stopped', 'stopped', 'running'])
        result, _ = self.run_with(rt, grace=15)
        self.assertEqual(result['start_requests'], 0); self.assertEqual(rt.starts, 0)

    def test_persistent_stopped_after_install_is_started_through_api(self):
        rt = FakeRuntipi(['stopped'])
        result, clock = self.run_with(rt, grace=10)
        self.assertEqual(result, {'status': 'running', 'start_requests': 1}); self.assertEqual(rt.starts, 1)
        self.assertGreaterEqual(clock.now, 10)

    def test_start_requests_are_bounded_and_failure_is_explicit(self):
        rt = FakeRuntipi(['stopped'], start_status=None)
        with self.assertRaisesRegex(RuntimeError, r'last status stopped, start requests 2'):
            self.run_with(rt, timeout=120, grace=10, max_starts=2)
        self.assertEqual(rt.starts, 2)

    def test_missing_row_waits_and_never_starts(self):
        rt = FakeRuntipi(['missing'])
        with self.assertRaisesRegex(RuntimeError, 'last status missing'):
            self.run_with(rt, timeout=20)
        self.assertEqual(rt.starts, 0)

    def test_non_api_errors_fail_closed(self):
        class Broken(FakeRuntipi):
            def app(self, urn): raise PermissionError('auth')
        with self.assertRaises(PermissionError):
            self.run_with(Broken(['running']))


if __name__ == '__main__':
    unittest.main()
