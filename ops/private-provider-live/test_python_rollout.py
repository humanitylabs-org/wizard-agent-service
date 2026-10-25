import json
import os
from pathlib import Path
import tempfile
import tarfile
import unittest
from unittest.mock import patch
from python_rollout import Rollout,TARGETS,tree_hash
from provider_adapter import blank_config,OVERRIDE

class RolloutTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.h=Path(self.tmp.name)/'home';self.h.mkdir();self.a='b'*32
  for n in TARGETS:
   p=self.h/n;p.parent.mkdir(parents=True,exist_ok=True)
   if n.endswith('/current'):
    dst=p.parent/'releases/old';dst.mkdir(parents=True);(dst/'old').write_text(n);p.symlink_to(dst)
   elif n=='.local/bin/wam':p.write_text('#!/bin/sh\nexport WAM_PRIVATE_CATALOG=/catalog\ncd "/old/python" && exec /usr/bin/python3 -m wam "$@"\n');p.chmod(0o755)
   elif n.endswith('connection-fork-registry.conf'):p.write_text('[Service]\nWorkingDirectory=/old/api\nExecStart=\nExecStart=/usr/bin/python3 -m wam serve\n')
  ux=self.h/'apps/wizard-os-home/web';ux.mkdir(parents=True);(ux/'index.html').write_text('old public UI')
  self.old=tree_hash(ux);self.r=Rollout(self.h,self.h/'receipts',self.a)
  candidate=self.h/'candidate';candidate.mkdir()
  for n in ['service','runtime','ux']:(candidate/n).mkdir();(candidate/n/'example.py').write_text('new '+n)
  self.archive=self.h/'candidate.tar'
  with tarfile.open(self.archive,'w') as tf:
   for n in ['service','runtime','ux']:tf.add(candidate/n,arcname=n)
  wam=self.h/'wam-source';(wam/'wam').mkdir(parents=True)
  for n in ['cli.py','registry.py']:(wam/'wam'/n).write_text('pass\n')
  self.wa=self.h/'wam.tar'
  with tarfile.open(self.wa,'w') as tf:tf.add(wam/'wam',arcname='wam')
 def prepare(self):
  import hashlib
  self.r.prepare(self.archive,self.wa,{'candidate_sha':'c'*40,'repository':'https://example.com/source','wam_files':{n:hashlib.sha256(b'pass\n').hexdigest() for n in ['wam/cli.py','wam/registry.py']}})
 def test_all_three_selections_and_exact_pointer_rollback(self):
  self.r.snapshot();before={n:(os.readlink(self.h/n) if (self.h/n).is_symlink() else (self.h/n).read_bytes() if (self.h/n).exists() else None) for n in TARGETS}
  self.prepare();self.r.promote(['/usr/bin/python3','/runtime/current/agent_runtime.py','--wam','/old/runtime'])
  new=str(self.h/'.local/share/wam-python/current')
  self.assertIn(new,(self.h/'.local/bin/wam').read_text());self.assertIn(new,(self.h/TARGETS[-1]).read_text());self.assertIn(new,(self.h/TARGETS[-2]).read_text())
  self.assertTrue((self.h/'apps/wizard-os-home/web').is_symlink())
  out=self.r.rollback();self.assertTrue(out['readback'])
  self.assertEqual(tree_hash(self.h/'apps/wizard-os-home/web'),self.old)
  after={n:(os.readlink(self.h/n) if (self.h/n).is_symlink() else (self.h/n).read_bytes() if (self.h/n).exists() else None) for n in TARGETS}
  self.assertEqual(before,after)
 def test_foreign_shell_change_blocks_all_pointer_rollback(self):
  self.r.snapshot();self.prepare();self.r.promote(['python3','/runtime/current/agent_runtime.py','--wam','/old/runtime'])
  ux=self.h/'apps/wizard-os-home/web';ux.unlink();ux.mkdir();(ux/'foreign').write_text('another actor')
  with self.assertRaisesRegex(ValueError,'foreign public UX'):self.r.rollback()
  self.assertEqual((self.h/'.local/share/wam-python/current').resolve().name,self.a)
 def test_dependency_source_hash_drift_refused(self):
  self.r.snapshot()
  with self.assertRaisesRegex(ValueError,'WAM source archive drift'):self.r.prepare(self.archive,self.wa,{'candidate_sha':'c'*40,'repository':'example','wam_files':{'wam/cli.py':'bad'}})
 def test_user_config_only_accepts_empty_comment_templates(self):
  self.assertTrue(blank_config({'dockerCompose':'# generated template\nservices: {}\n','appEnv':'# examples\n'}))
  self.assertFalse(blank_config({'dockerCompose':OVERRIDE,'appEnv':''}))
  self.assertFalse(blank_config({'dockerCompose':'','appEnv':'OTHER=not-ours\n'}))
if __name__=='__main__':unittest.main()
