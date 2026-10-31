"""Bounded Android controller tests: no SDK, build, emulator, or credentials."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT=Path(os.environ.get('ANDROID_HELPER_UNDER_TEST',str(Path(__file__).resolve().parents[1]/'scripts/android-build-thales.py')))

class ForumDefaults(unittest.TestCase):
    def setUp(self):
        env={k:v for k,v in os.environ.items() if not k.startswith(('WIZARD_', 'ANDROID_'))}
        env['WIZARD_HEAVY_ROOT']='/configured/scratch'
        with patch.dict(os.environ,env,clear=True):
            spec=importlib.util.spec_from_file_location('forum_android',SCRIPT)
            assert spec and spec.loader
            self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)

    def test_default_is_linux_forum_not_a_mac_dependency(self):
        self.assertEqual(self.m.HOST,'forum')
        self.assertEqual(self.m.PLATFORM,'linux')
        self.assertEqual(self.m.REMOTE_PYTHON,'/usr/bin/python3')
        self.assertEqual(self.m.MIN_FREE_GB,200)
        self.assertNotIn('homebrew',self.m.SDK)

    def test_control_plane_cannot_run_the_worker(self):
        with patch.object(self.m.sys,'platform','linux'),patch.object(self.m.os,'uname') as uname:
            uname.return_value.nodename='control-plane'
            self.assertFalse(self.m.worker_platform_allowed())
            uname.return_value.nodename='forum'
            self.assertTrue(self.m.worker_platform_allowed())

    def test_macos_remains_explicit_fallback(self):
        with patch.object(self.m,'PLATFORM','darwin'),patch.object(self.m.sys,'platform','darwin'):
            self.assertTrue(self.m.worker_platform_allowed())
        with patch.object(self.m,'PLATFORM','darwin'),patch.object(self.m.sys,'platform','linux'):
            self.assertFalse(self.m.worker_platform_allowed())

    def test_prepared_command_pins_remote_configuration_and_lock(self):
        self.m.LOCK_PATH='/configured/queue/worker.lock'
        cmd=self.m.worker_command('/configured/scratch/AndroidBuilds/jobs/test')
        self.assertIn('WIZARD_BUILD_HOST=forum',cmd)
        self.assertIn('WIZARD_ANDROID_PLATFORM=linux',cmd)
        self.assertIn('WIZARD_ANDROID_WORKER_LOCK=/configured/queue/worker.lock',cmd)
        self.assertIn('/usr/bin/python3',cmd)
        self.assertNotIn('/opt/homebrew/bin/python3',cmd)

    def test_linux_staging_really_creates_private_directories(self):
        with tempfile.TemporaryDirectory() as d:
            self.m.BASE=d
            job=d+'/jobs/probe'
            subprocess.run(['/bin/sh','-c',self.m.remote_stage_command(job)],check=True)
            self.assertEqual(Path(job).stat().st_mode&0o777,0o700)

    def test_non_owner_build_has_no_global_properties(self):
        with tempfile.TemporaryDirectory() as d:
            self.m.install_owner_properties({},d)
            self.assertFalse((Path(d)/'gradle.properties').exists())

    def test_owner_properties_are_private_and_address_only(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'input';target=Path(d)/'gradle';target.mkdir()
            p.write_text('wizardOrigin=https://synthetic.example\n');p.chmod(0o600)
            self.m.install_owner_properties({'owner_config':str(p)},target)
            self.assertEqual((target/'gradle.properties').stat().st_mode&0o777,0o600)
            p.write_text('org.gradle.java.home=/unrelated/cache\n')
            with self.assertRaisesRegex(RuntimeError,'unsupported property'):
                self.m.install_owner_properties({'owner_config':str(p)},target)

    def test_owner_properties_reject_world_readable_and_symlink(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'input';p.write_text('wizardOrigin=https://synthetic.example\n');p.chmod(0o644)
            with self.assertRaises(RuntimeError):self.m.install_owner_properties({'owner_config':str(p)},d)
            p.chmod(0o600);q=Path(d)/'link';q.symlink_to(p)
            with self.assertRaises(RuntimeError):self.m.install_owner_properties({'owner_config':str(q)},d)

if __name__=='__main__':unittest.main()
